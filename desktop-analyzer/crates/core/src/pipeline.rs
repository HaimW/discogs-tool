//! The run loop: walk the outstanding work, download, analyse, record.
//!
//! The interesting behaviour here is what happens when things go wrong — a
//! download fails, the process is killed mid-run, the disk fills. That is
//! exactly the behaviour that is miserable to test against real YouTube, so
//! downloading and analysing are traits and the loop is tested with fakes.
//!
//! The ledger is written after **every** item, not at the end. A run that dies
//! on track 400 of 900 must not lose 399 downloads.

use std::path::{Path, PathBuf};

use crate::ledger::{EntryState, Ledger};
use crate::meta::AnalysisResult;
use crate::tempo::TempoHint;
use crate::plan::{Decision, Plan, PlannedItem, ReviewReason};

/// Fetches audio for one item, returning the file it wrote.
pub trait Downloader {
    fn download(&self, item: &PlannedItem, dest_dir: &Path) -> Result<PathBuf, StepError>;
}

/// Analyses one audio file.
pub trait Analyzer {
    /// `hint` is what the release's Discogs styles say about reading this
    /// track's tempo. It is passed per item rather than held by the analyzer
    /// because one collection can hold both drum and bass and dub, and no
    /// single setting suits both.
    fn analyze(&self, path: &Path, hint: TempoHint) -> Result<AnalysisResult, StepError>;
}

/// Wall-clock time, injected so tests are deterministic.
pub trait Clock {
    fn now_iso8601(&self) -> String;
}

/// Persists the ledger. Called after every item, so implementations should
/// write atomically (temp file + rename) rather than truncating in place.
pub trait LedgerStore {
    fn save(&self, ledger: &Ledger) -> Result<(), String>;
}

/// Whether a failure is worth trying again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepError {
    pub message: String,
    /// Transient problems (network, rate limiting) are retried within the
    /// budget. Permanent ones (deleted video, region block) are not — retrying
    /// them just burns time on every future run.
    pub retryable: bool,
}

impl StepError {
    pub fn retryable(message: impl Into<String>) -> StepError {
        StepError { message: message.into(), retryable: true }
    }

    pub fn permanent(message: impl Into<String>) -> StepError {
        StepError { message: message.into(), retryable: false }
    }
}

impl std::fmt::Display for StepError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// What the run is doing right now, for the progress UI.
#[derive(Debug, Clone, PartialEq)]
pub enum Progress {
    Started { total: usize, already_done: usize },
    Downloading { index: usize, total: usize, item_id: String, title: String },
    Analyzing { index: usize, total: usize, item_id: String, title: String },
    Completed { index: usize, total: usize, item_id: String, bpm: f64, key: String },
    Failed { index: usize, total: usize, item_id: String, error: String, will_retry: bool },
    /// The ledger could not be written.
    ///
    /// This is not a per-item failure — it means the run has stopped being
    /// resumable, because nothing since the last good save would survive a
    /// restart. Silently carrying on would let someone interrupt an hours-long
    /// run believing their progress was safe, so it is surfaced loudly and once
    /// per change of state rather than once per item.
    LedgerUnsaved { message: String },
    /// Saving recovered after a [`Progress::LedgerUnsaved`].
    LedgerSaved,
    Finished(Summary),
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Summary {
    pub analyzed: usize,
    pub failed: usize,
    pub skipped: usize,
    pub needs_review: usize,
}

pub struct RunOptions<'a> {
    pub work_dir: &'a Path,
    /// How many times a retryable failure is attempted across all runs.
    pub max_attempts: u32,
    /// Stop after this many items. `None` runs the lot.
    pub limit: Option<usize>,
}

impl Default for RunOptions<'_> {
    fn default() -> Self {
        RunOptions { work_dir: Path::new("."), max_attempts: 3, limit: None }
    }
}

/// Save the ledger, reporting only when the outcome *changes*.
///
/// A full disk fails on every single item; emitting a warning each time would
/// bury the run's real output. So the first failure is reported, subsequent
/// ones are silent, and a later success reports the recovery.
fn save(
    store: &dyn LedgerStore,
    ledger: &Ledger,
    failing: &mut bool,
    on_progress: &mut dyn FnMut(Progress),
) {
    match store.save(ledger) {
        Ok(()) => {
            if *failing {
                *failing = false;
                on_progress(Progress::LedgerSaved);
            }
        }
        Err(message) => {
            if !*failing {
                *failing = true;
                on_progress(Progress::LedgerUnsaved { message });
            }
        }
    }
}

/// Record the plan's non-work decisions in the ledger, so the UI can show why
/// a track was left alone and a resumed run does not reconsider it.
pub fn record_plan_decisions(ledger: &mut Ledger, plan: &Plan, clock: &dyn Clock) {
    let now = clock.now_iso8601();
    for item in &plan.items {
        match &item.decision {
            Decision::Analyze => {}
            Decision::Skip(_) => {
                ledger.record_non_work(&item.id, EntryState::Skipped, "already has your own data", &now);
            }
            Decision::Review(reason) => {
                let note = match reason {
                    ReviewReason::TooLong { seconds } => {
                        format!("video is {:.0} minutes — likely a mix or full album", seconds / 60.0)
                    }
                    ReviewReason::TitleMismatch { video_title } => {
                        format!("title \"{video_title}\" does not match the release tracklist")
                    }
                };
                ledger.record_non_work(&item.id, EntryState::NeedsReview, note, &now);
            }
        }
    }
}

/// Run the outstanding work to completion, or until `should_stop` says otherwise.
///
/// Returns a summary; per-item results live in the ledger, which is saved after
/// every item so an interrupted run resumes cleanly.
#[allow(clippy::too_many_arguments)]
pub fn run(
    plan: &Plan,
    ledger: &mut Ledger,
    downloader: &dyn Downloader,
    analyzer: &dyn Analyzer,
    clock: &dyn Clock,
    store: &dyn LedgerStore,
    options: &RunOptions,
    should_stop: &dyn Fn() -> bool,
    on_progress: &mut dyn FnMut(Progress),
) -> Summary {
    record_plan_decisions(ledger, plan, clock);
    // Tracks whether saving is currently broken, so the warning is not repeated
    // for every one of hundreds of items.
    let mut save_failing = false;
    save(store, ledger, &mut save_failing, on_progress);

    let counts = plan.counts();
    let outstanding: Vec<PlannedItem> = ledger
        .outstanding(plan, options.max_attempts)
        .into_iter()
        .cloned()
        .collect();
    let total = options.limit.map_or(outstanding.len(), |l| l.min(outstanding.len()));

    on_progress(Progress::Started {
        total,
        already_done: ledger.completed_count(),
    });

    let mut summary = Summary {
        analyzed: 0,
        failed: 0,
        skipped: counts.skip,
        needs_review: counts.review,
    };

    for (i, item) in outstanding.iter().take(total).enumerate() {
        if should_stop() {
            break;
        }
        let index = i + 1;

        on_progress(Progress::Downloading {
            index,
            total,
            item_id: item.id.clone(),
            title: item.video_title.clone(),
        });

        let audio = match downloader.download(item, options.work_dir) {
            Ok(path) => path,
            Err(e) => {
                record_failure(
                    ledger, item, &e, clock, store, options.max_attempts,
                    &mut save_failing, on_progress,
                );
                on_progress(Progress::Failed {
                    index,
                    total,
                    item_id: item.id.clone(),
                    error: e.message,
                    will_retry: e.retryable && ledger.attempts(&item.id) < options.max_attempts,
                });
                summary.failed += 1;
                continue;
            }
        };

        on_progress(Progress::Analyzing {
            index,
            total,
            item_id: item.id.clone(),
            title: item.video_title.clone(),
        });

        let outcome = analyzer.analyze(&audio, item.tempo_hint);
        // The audio file is scratch space and can be large; drop it either way
        // rather than filling the disk over a long run.
        let _ = std::fs::remove_file(&audio);

        match outcome {
            Ok(result) => {
                let (bpm, key) = (result.bpm, result.key.clone());
                ledger.record_success(&item.id, result, &clock.now_iso8601());
                save(store, ledger, &mut save_failing, on_progress);
                on_progress(Progress::Completed {
                    index,
                    total,
                    item_id: item.id.clone(),
                    bpm,
                    key,
                });
                summary.analyzed += 1;
            }
            Err(e) => {
                record_failure(
                    ledger, item, &e, clock, store, options.max_attempts,
                    &mut save_failing, on_progress,
                );
                on_progress(Progress::Failed {
                    index,
                    total,
                    item_id: item.id.clone(),
                    error: e.message,
                    will_retry: e.retryable && ledger.attempts(&item.id) < options.max_attempts,
                });
                summary.failed += 1;
            }
        }
    }

    on_progress(Progress::Finished(summary));
    summary
}

#[allow(clippy::too_many_arguments)]
fn record_failure(
    ledger: &mut Ledger,
    item: &PlannedItem,
    error: &StepError,
    clock: &dyn Clock,
    store: &dyn LedgerStore,
    max_attempts: u32,
    save_failing: &mut bool,
    on_progress: &mut dyn FnMut(Progress),
) {
    let now = clock.now_iso8601();
    if error.retryable {
        ledger.record_failure(&item.id, &error.message, &now);
    } else {
        // Spend the whole budget at once so no future run retries it.
        for _ in 0..max_attempts {
            ledger.record_failure(&item.id, &error.message, &now);
        }
    }
    save(store, ledger, save_failing, on_progress);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::Backup;
    use serde_json::json;
    use std::cell::RefCell;
    use std::collections::HashMap;

    struct FixedClock;
    impl Clock for FixedClock {
        fn now_iso8601(&self) -> String {
            "2026-09-04T12:00:00Z".to_string()
        }
    }

    /// Records every save, so tests can assert the ledger is persisted per item
    /// rather than once at the end.
    #[derive(Default)]
    struct RecordingStore {
        saves: RefCell<Vec<usize>>,
    }
    impl LedgerStore for RecordingStore {
        fn save(&self, ledger: &Ledger) -> Result<(), String> {
            self.saves.borrow_mut().push(ledger.entries.len());
            Ok(())
        }
    }

    /// Writes a real (empty) file so the pipeline's cleanup has something to
    /// remove, and fails for ids it was told to fail.
    struct FakeDownloader {
        failures: HashMap<String, StepError>,
    }
    impl Downloader for FakeDownloader {
        fn download(&self, item: &PlannedItem, dest: &Path) -> Result<PathBuf, StepError> {
            if let Some(e) = self.failures.get(&item.id) {
                return Err(e.clone());
            }
            let path = dest.join(format!("{}.m4a", item.id));
            std::fs::write(&path, b"audio").map_err(|e| StepError::retryable(e.to_string()))?;
            Ok(path)
        }
    }

    struct FakeAnalyzer {
        failures: HashMap<String, StepError>,
    }
    impl Analyzer for FakeAnalyzer {
        fn analyze(&self, path: &Path, _hint: TempoHint) -> Result<AnalysisResult, StepError> {
            let name = path.file_stem().unwrap().to_string_lossy().to_string();
            if let Some(e) = self.failures.get(&name) {
                return Err(e.clone());
            }
            Ok(AnalysisResult {
                bpm: 124.0,
                bpm_confidence: 0.9,
                key: "8A".into(),
                key_musical: "A minor".into(),
                key_strength: 1.0,
                energy: Some(6),
                energy_score: None,
                bpm_folded_from: None,
                bpm_method: None,
                bpm_second_opinion: None,
                analyzed_at: "2026-09-04T12:00:00Z".into(),
                analyzer_version: "test".into(),
            })
        }
    }

    fn plan_of(ids: &[&str]) -> Plan {
        let videos: Vec<_> = ids
            .iter()
            .map(|id| {
                json!({
                    "id": id, "release_id": 1, "title": "Blue Monday", "uri": "u",
                    "youtube_id": id.split('_').nth(1).unwrap(), "duration": 200
                })
            })
            .collect();
        let backup = Backup::parse(
            &json!({
                "_app": "VinylCollectionPlayer", "_version": 2,
                "collection": {"releases": [], "videos": videos, "tracklist": []},
                "track_meta": []
            })
            .to_string(),
        )
        .unwrap();
        Plan::build(&backup, false)
    }

    struct Harness {
        dir: PathBuf,
        store: RecordingStore,
    }

    impl Harness {
        fn new(name: &str) -> Harness {
            let dir = std::env::temp_dir().join(format!("analyzer-pipeline-{name}"));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Harness { dir, store: RecordingStore::default() }
        }

        #[allow(clippy::too_many_arguments)]
        fn run(
            &self,
            plan: &Plan,
            ledger: &mut Ledger,
            dl_fail: HashMap<String, StepError>,
            an_fail: HashMap<String, StepError>,
            stop_after: Option<usize>,
            events: &mut Vec<Progress>,
        ) -> Summary {
            let downloader = FakeDownloader { failures: dl_fail };
            let analyzer = FakeAnalyzer { failures: an_fail };
            let seen = RefCell::new(0usize);
            let should_stop = || {
                if let Some(n) = stop_after {
                    let mut s = seen.borrow_mut();
                    if *s >= n {
                        return true;
                    }
                    *s += 1;
                }
                false
            };
            let options = RunOptions { work_dir: &self.dir, max_attempts: 3, limit: None };
            run(
                plan,
                ledger,
                &downloader,
                &analyzer,
                &FixedClock,
                &self.store,
                &options,
                &should_stop,
                &mut |p| events.push(p),
            )
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn analyses_everything_and_records_each_result() {
        let h = Harness::new("happy");
        let plan = plan_of(&["1_a", "1_b", "1_c"]);
        let mut ledger = Ledger::new("h", "now");
        let mut events = vec![];

        let summary = h.run(&plan, &mut ledger, HashMap::new(), HashMap::new(), None, &mut events);

        assert_eq!(summary.analyzed, 3);
        assert_eq!(summary.failed, 0);
        assert_eq!(ledger.completed_count(), 3);
        assert_eq!(ledger.results().count(), 3);
        assert!(matches!(events.first(), Some(Progress::Started { total: 3, .. })));
        assert!(matches!(events.last(), Some(Progress::Finished(_))));
    }

    #[test]
    fn saves_the_ledger_after_every_item_not_just_at_the_end() {
        let h = Harness::new("saves");
        let plan = plan_of(&["1_a", "1_b", "1_c"]);
        let mut ledger = Ledger::new("h", "now");
        let mut events = vec![];

        h.run(&plan, &mut ledger, HashMap::new(), HashMap::new(), None, &mut events);

        // One save for the plan decisions, then one per completed item.
        assert!(
            h.store.saves.borrow().len() >= 4,
            "expected a save per item, got {:?}",
            h.store.saves.borrow()
        );
    }

    #[test]
    fn deletes_the_audio_it_downloaded() {
        let h = Harness::new("cleanup");
        let plan = plan_of(&["1_a", "1_b"]);
        let mut ledger = Ledger::new("h", "now");
        let mut events = vec![];

        h.run(&plan, &mut ledger, HashMap::new(), HashMap::new(), None, &mut events);

        let leftovers: Vec<_> = std::fs::read_dir(&h.dir).unwrap().filter_map(|e| e.ok()).collect();
        assert!(leftovers.is_empty(), "temp audio left behind: {leftovers:?}");
    }

    #[test]
    fn cleans_up_even_when_analysis_fails() {
        let h = Harness::new("cleanup-fail");
        let plan = plan_of(&["1_a"]);
        let mut ledger = Ledger::new("h", "now");
        let mut events = vec![];
        let an_fail = HashMap::from([("1_a".to_string(), StepError::permanent("undecodable"))]);

        h.run(&plan, &mut ledger, HashMap::new(), an_fail, None, &mut events);

        let leftovers: Vec<_> = std::fs::read_dir(&h.dir).unwrap().filter_map(|e| e.ok()).collect();
        assert!(leftovers.is_empty(), "temp audio left behind after failure");
    }

    #[test]
    fn a_permanent_failure_is_never_retried_by_a_later_run() {
        let h = Harness::new("permanent");
        let plan = plan_of(&["1_a"]);
        let mut ledger = Ledger::new("h", "now");
        let mut events = vec![];
        let dl_fail = HashMap::from([(
            "1_a".to_string(),
            StepError::permanent("video removed by uploader"),
        )]);

        h.run(&plan, &mut ledger, dl_fail, HashMap::new(), None, &mut events);

        assert_eq!(ledger.state("1_a"), Some(EntryState::Failed));
        assert!(
            ledger.outstanding(&plan, 3).is_empty(),
            "a permanently failed item should not be retried"
        );
    }

    #[test]
    fn a_transient_failure_is_retried_next_run() {
        let h = Harness::new("transient");
        let plan = plan_of(&["1_a"]);
        let mut ledger = Ledger::new("h", "now");
        let mut events = vec![];
        let dl_fail = HashMap::from([("1_a".to_string(), StepError::retryable("network timeout"))]);

        h.run(&plan, &mut ledger, dl_fail, HashMap::new(), None, &mut events);

        assert_eq!(ledger.attempts("1_a"), 1);
        assert_eq!(ledger.outstanding(&plan, 3).len(), 1, "should still be queued");

        // Second run succeeds.
        let mut events2 = vec![];
        h.run(&plan, &mut ledger, HashMap::new(), HashMap::new(), None, &mut events2);
        assert_eq!(ledger.state("1_a"), Some(EntryState::Done));
    }

    #[test]
    fn an_interrupted_run_resumes_where_it_stopped() {
        let h = Harness::new("resume");
        let plan = plan_of(&["1_a", "1_b", "1_c", "1_d"]);
        let mut ledger = Ledger::new("h", "now");

        // Stop after two items.
        let mut events = vec![];
        let first = h.run(&plan, &mut ledger, HashMap::new(), HashMap::new(), Some(2), &mut events);
        assert_eq!(first.analyzed, 2);

        // Round-trip through disk, as a real restart would.
        let reloaded = Ledger::parse(&ledger.to_json().unwrap()).unwrap();
        let mut ledger = reloaded;
        assert_eq!(ledger.completed_count(), 2);

        let mut events2 = vec![];
        let second = h.run(&plan, &mut ledger, HashMap::new(), HashMap::new(), None, &mut events2);

        assert_eq!(second.analyzed, 2, "only the remaining two are done");
        assert_eq!(ledger.completed_count(), 4, "all four are now finished");
    }

    #[test]
    fn plan_decisions_are_recorded_so_the_ui_can_explain_them() {
        let backup = Backup::parse(
            &json!({
                "_app": "VinylCollectionPlayer", "_version": 2,
                "collection": {
                    "releases": [],
                    "videos": [
                        {"id": "1_long", "release_id": 1, "title": "Blue Monday", "uri": "u",
                         "youtube_id": "long", "duration": 4000},
                        {"id": "1_taken", "release_id": 1, "title": "Blue Monday", "uri": "u",
                         "youtube_id": "taken", "duration": 200}
                    ],
                    "tracklist": []
                },
                "track_meta": [{"id": "1_taken", "bpm": 128.0, "key": "5A", "energy": 8}]
            })
            .to_string(),
        )
        .unwrap();
        let plan = Plan::build(&backup, false);
        let mut ledger = Ledger::new("h", "now");

        record_plan_decisions(&mut ledger, &plan, &FixedClock);

        assert_eq!(ledger.state("1_long"), Some(EntryState::NeedsReview));
        assert!(ledger.entries["1_long"].note.as_ref().unwrap().contains("minutes"));
        assert_eq!(ledger.state("1_taken"), Some(EntryState::Skipped));
    }
}

#[cfg(test)]
mod save_reporting_tests {
    use super::*;
    use crate::backup::Backup;
    use serde_json::json;
    use std::cell::RefCell;
    use std::path::PathBuf;

    struct FixedClock;
    impl Clock for FixedClock {
        fn now_iso8601(&self) -> String {
            "2026-09-04T12:00:00Z".to_string()
        }
    }

    /// Fails every save until `heal_after` saves have been attempted.
    struct FlakyStore {
        attempts: RefCell<usize>,
        heal_after: usize,
    }
    impl LedgerStore for FlakyStore {
        fn save(&self, _ledger: &Ledger) -> Result<(), String> {
            let mut n = self.attempts.borrow_mut();
            *n += 1;
            if *n > self.heal_after {
                Ok(())
            } else {
                Err("No space left on device".to_string())
            }
        }
    }

    struct OkDownloader;
    impl Downloader for OkDownloader {
        fn download(&self, item: &PlannedItem, dest: &Path) -> Result<PathBuf, StepError> {
            let path = dest.join(format!("{}.m4a", item.id));
            std::fs::write(&path, b"a").map_err(|e| StepError::retryable(e.to_string()))?;
            Ok(path)
        }
    }

    struct OkAnalyzer;
    impl Analyzer for OkAnalyzer {
        fn analyze(&self, _path: &Path, _hint: TempoHint) -> Result<AnalysisResult, StepError> {
            Ok(AnalysisResult {
                bpm: 124.0,
                bpm_confidence: 0.9,
                key: "8A".into(),
                key_musical: "A minor".into(),
                key_strength: 1.0,
                energy: Some(6),
                energy_score: None,
                bpm_folded_from: None,
                bpm_method: None,
                bpm_second_opinion: None,
                analyzed_at: "2026-09-04T12:00:00Z".into(),
                analyzer_version: "test".into(),
            })
        }
    }

    fn plan_of(ids: &[&str]) -> Plan {
        let videos: Vec<_> = ids
            .iter()
            .map(|id| {
                json!({"id": id, "release_id": 1, "title": "t", "uri": "u",
                       "youtube_id": id.split('_').nth(1).unwrap(), "duration": 200})
            })
            .collect();
        let backup = Backup::parse(
            &json!({"_app": "VinylCollectionPlayer", "_version": 2,
                    "collection": {"releases": [], "videos": videos, "tracklist": []},
                    "track_meta": []})
            .to_string(),
        )
        .unwrap();
        Plan::build(&backup, false)
    }

    fn run_with(store: &dyn LedgerStore, ids: &[&str]) -> Vec<Progress> {
        let dir = std::env::temp_dir().join("analyzer-save-reporting");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let plan = plan_of(ids);
        let mut ledger = Ledger::new("h", "now");
        let mut events = vec![];
        let options = RunOptions { work_dir: &dir, max_attempts: 3, limit: None };
        run(
            &plan,
            &mut ledger,
            &OkDownloader,
            &OkAnalyzer,
            &FixedClock,
            store,
            &options,
            &|| false,
            &mut |p| events.push(p),
        );
        let _ = std::fs::remove_dir_all(&dir);
        events
    }

    /// A run that cannot save is no longer resumable. Saying nothing would let
    /// someone interrupt it believing their progress was safe.
    #[test]
    fn a_ledger_that_cannot_be_saved_is_reported() {
        let store = FlakyStore { attempts: RefCell::new(0), heal_after: usize::MAX };
        let events = run_with(&store, &["1_a", "1_b", "1_c"]);
        let warnings = events
            .iter()
            .filter(|e| matches!(e, Progress::LedgerUnsaved { .. }))
            .count();
        assert_eq!(warnings, 1, "expected exactly one warning, got {warnings}");
    }

    /// ...but a full disk fails on every item, and one warning per item would
    /// bury the run's actual output.
    #[test]
    fn the_warning_is_not_repeated_for_every_item() {
        let store = FlakyStore { attempts: RefCell::new(0), heal_after: usize::MAX };
        let events = run_with(&store, &["1_a", "1_b", "1_c", "1_d", "1_e"]);
        assert_eq!(
            events.iter().filter(|e| matches!(e, Progress::LedgerUnsaved { .. })).count(),
            1
        );
    }

    #[test]
    fn recovery_is_reported_so_the_user_knows_it_is_safe_again() {
        // Fails the plan-decisions save, then succeeds.
        let store = FlakyStore { attempts: RefCell::new(0), heal_after: 1 };
        let events = run_with(&store, &["1_a", "1_b"]);
        let unsaved = events.iter().position(|e| matches!(e, Progress::LedgerUnsaved { .. }));
        let saved = events.iter().position(|e| matches!(e, Progress::LedgerSaved));
        assert!(unsaved.is_some(), "expected a warning first");
        assert!(saved.is_some(), "expected a recovery notice");
        assert!(saved > unsaved, "recovery must come after the warning");
    }

    #[test]
    fn a_healthy_store_produces_no_ledger_noise_at_all() {
        struct Fine;
        impl LedgerStore for Fine {
            fn save(&self, _l: &Ledger) -> Result<(), String> {
                Ok(())
            }
        }
        let events = run_with(&Fine, &["1_a", "1_b"]);
        assert!(!events
            .iter()
            .any(|e| matches!(e, Progress::LedgerUnsaved { .. } | Progress::LedgerSaved)));
    }
}
