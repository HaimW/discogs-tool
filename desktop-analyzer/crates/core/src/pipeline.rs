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
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Mutex};

use crate::ledger::{EntryState, Ledger};
use crate::meta::AnalysisResult;
use crate::tempo::TempoHint;
use crate::plan::{Decision, Plan, PlannedItem, ReviewReason};

/// Fetches audio for one item, returning the file it wrote.
pub trait Downloader {
    fn download(&self, item: &PlannedItem, dest_dir: &Path) -> Result<PathBuf, StepError>;
}

/// The filename, without extension, that an item's audio is stored under.
///
/// Lives here rather than in the downloader because two things now depend on
/// agreeing about it: the downloader writing the file, and `--keep-audio`
/// looking for it again on a later run. If they disagreed, reuse would silently
/// never fire and every run would re-download.
pub fn audio_stem(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect()
}

/// An already-downloaded file for this item, if `dir` holds one.
///
/// The extension is whatever yt-dlp picked, so the stem is matched and the
/// extension ignored. Empty files are rejected: a run killed mid-download
/// leaves one behind, and handing that to the analyser would turn a resumable
/// interruption into a permanent failure.
fn existing_audio(dir: &Path, id: &str) -> Option<PathBuf> {
    let stem = audio_stem(id);
    let mut found: Option<PathBuf> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.file_stem().and_then(|s| s.to_str()) != Some(stem.as_str()) {
            continue;
        }
        if entry.metadata().is_ok_and(|m| m.is_file() && m.len() > 0) {
            // Deterministic if a stale file from another format is lying
            // around, so a rerun behaves the same way twice.
            if found.as_ref().is_none_or(|best| path < *best) {
                found = Some(path);
            }
        }
    }
    found
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
    /// The failure was about the *run*, not this track: YouTube demanding a
    /// sign-in because too much was asked of it at once, and which every other
    /// track in the queue is about to hit too.
    ///
    /// These do not consume the track's retry budget. A track has three
    /// attempts so that a genuinely broken video is eventually written off;
    /// spending them on a block that says nothing about the video would write
    /// off the whole collection in the couple of minutes it takes to fail three
    /// thousand downloads. Learned the hard way: a 16-wide run tripped the bot
    /// check and produced 310 of these in one burst.
    pub blocked: bool,
}

impl StepError {
    pub fn retryable(message: impl Into<String>) -> StepError {
        StepError { message: message.into(), retryable: true, blocked: false }
    }

    /// A refusal aimed at the run rather than the track. Retryable, and free.
    pub fn blocked(message: impl Into<String>) -> StepError {
        StepError { message: message.into(), retryable: true, blocked: true }
    }

    pub fn permanent(message: impl Into<String>) -> StepError {
        StepError { message: message.into(), retryable: false, blocked: false }
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
    /// `--keep-audio` found this track's file already on disk, so nothing was
    /// downloaded. Reported separately from `Downloading` because saying
    /// "downloading" when no network call happened would misreport the run.
    Reusing { index: usize, total: usize, item_id: String, title: String },
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
    /// The download host is refusing the run — asking every request to prove it
    /// is not automated. The run stops rather than converting the rest of the
    /// queue into failures, and no track is charged for it.
    Blocked { failures: usize },
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
    /// How many tracks to download at the same time.
    ///
    /// Measured on a real collection: one at a time is 3.53 s a track, four is
    /// 0.72, eight is 0.26, and twelve is also 0.26 — it saturates at eight, so
    /// more than that buys nothing and only widens the rate-limiting target.
    pub downloads_at_once: usize,
    /// How many tracks to analyse at the same time.
    ///
    /// Saturates at four (1.16 s a track alone, 0.25 with four, 0.29 with
    /// eight). It is not short of cores — there are usually dozens — it is
    /// memory bandwidth: a decoded track is around half a gigabyte, so more
    /// workers just queue for RAM.
    pub analysers_at_once: usize,
    /// Keep downloaded audio in `work_dir` instead of deleting it after
    /// analysis, and reuse it on later runs.
    ///
    /// Off by default because a decoded collection is enormous. On, it makes
    /// iterating on detection cheap: the second run needs no yt-dlp, no
    /// network, and cannot be rate-limited or bot-checked.
    pub keep_audio: bool,
}

impl RunOptions<'_> {
    fn downloaders(&self) -> usize {
        self.downloads_at_once.max(1)
    }

    fn analysers(&self) -> usize {
        self.analysers_at_once.max(1)
    }
}

impl Default for RunOptions<'_> {
    fn default() -> Self {
        RunOptions {
            work_dir: Path::new("."),
            max_attempts: 3,
            limit: None,
            downloads_at_once: 1,
            analysers_at_once: 1,
            keep_audio: false,
        }
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
/// How many refusals in a row before a run gives up. Small, because they arrive
/// in bursts: once the host has decided, the next request is refused too.
const BLOCKED_BEFORE_GIVING_UP: usize = 8;

/// What a worker finished doing. Workers never touch the ledger or report
/// progress themselves — they send one of these and the owning thread does
/// both, which is what keeps a concurrent run as safe as a serial one.
enum Done {
    Downloading { item_id: String, title: String },
    Reusing { item_id: String, title: String },
    Analysing { item_id: String, title: String },
    Analysed { item: PlannedItem, result: AnalysisResult },
    Failed { item: PlannedItem, error: StepError },
}

#[allow(clippy::too_many_arguments)]
pub fn run(
    plan: &Plan,
    ledger: &mut Ledger,
    downloader: &(dyn Downloader + Sync),
    analyzer: &(dyn Analyzer + Sync),
    clock: &(dyn Clock + Sync),
    store: &dyn LedgerStore,
    options: &RunOptions,
    should_stop: &(dyn Fn() -> bool + Sync),
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
    let work: Vec<PlannedItem> = outstanding.into_iter().take(total).collect();

    on_progress(Progress::Started { total, already_done: ledger.completed_count() });

    let mut summary = Summary {
        analyzed: 0,
        failed: 0,
        skipped: counts.skip,
        needs_review: counts.review,
    };

    // Consecutive refusals aimed at the run. Once the host starts asking every
    // request to prove it is not a robot, carrying on just converts the rest of
    // the queue into failures at several a second.
    let mut blocked_in_a_row = 0usize;
    let stop_because_blocked = AtomicBool::new(false);

    // Downloading and analysing overlap, and each runs several at a time. The
    // ledger and the export are touched by exactly one thread — this one — so
    // there is no shared mutable state to get wrong: workers only send `Done`.
    //
    // The audio queue is bounded, so downloads run ahead of analysis by at most
    // a few tracks rather than filling the disk with the whole collection.
    let (audio_tx, audio_rx) = mpsc::sync_channel::<(PlannedItem, PathBuf)>(options.downloaders());
    let (done_tx, done_rx) = mpsc::channel::<Done>();
    let next = AtomicUsize::new(0);
    let audio_rx = Mutex::new(audio_rx);

    std::thread::scope(|scope| {
        for _ in 0..options.downloaders() {
            let audio_tx = audio_tx.clone();
            let done_tx = done_tx.clone();
            let next = &next;
            let work = &work;
            let blocked = &stop_because_blocked;
            let keep_audio = options.keep_audio;
            scope.spawn(move || {
                loop {
                    if should_stop() || blocked.load(Ordering::SeqCst) {
                        break;
                    }
                    let index = next.fetch_add(1, Ordering::SeqCst);
                    let Some(item) = work.get(index) else { break };
                    // Reuse comes before the download so a rerun makes no
                    // network call at all — that is the whole point of the
                    // flag, and it is what makes a rerun immune to rate limits.
                    let cached = keep_audio
                        .then(|| existing_audio(options.work_dir, &item.id))
                        .flatten();
                    let fetched = match cached {
                        Some(path) => {
                            let _ = done_tx.send(Done::Reusing {
                                item_id: item.id.clone(),
                                title: item.video_title.clone(),
                            });
                            Ok(path)
                        }
                        None => {
                            let _ = done_tx.send(Done::Downloading {
                                item_id: item.id.clone(),
                                title: item.video_title.clone(),
                            });
                            downloader.download(item, options.work_dir)
                        }
                    };
                    match fetched {
                        Ok(path) => {
                            // A full queue blocks here, which is the throttle:
                            // downloading stops running ahead of analysis.
                            if audio_tx.send((item.clone(), path)).is_err() {
                                break;
                            }
                        }
                        Err(error) => {
                            let _ = done_tx.send(Done::Failed { item: item.clone(), error });
                        }
                    }
                }
            });
        }
        // The originals must go, or the analysis workers wait for ever on a
        // queue whose senders never all drop.
        drop(audio_tx);

        for _ in 0..options.analysers() {
            let done_tx = done_tx.clone();
            let audio_rx = &audio_rx;
            let keep_audio = options.keep_audio;
            scope.spawn(move || {
                loop {
                    let next = {
                        let rx = audio_rx.lock().unwrap_or_else(|e| e.into_inner());
                        rx.recv()
                    };
                    let Ok((item, audio)) = next else { break };
                    let _ = done_tx.send(Done::Analysing {
                        item_id: item.id.clone(),
                        title: item.video_title.clone(),
                    });
                    let outcome = analyzer.analyze(&audio, item.tempo_hint);
                    // Scratch space, and a decoded track is large; drop it
                    // either way rather than filling the disk over a long run.
                    // Unless the run asked to keep it — then it is not scratch,
                    // it is the corpus for the next run.
                    if !keep_audio {
                        let _ = std::fs::remove_file(&audio);
                    }
                    let _ = match outcome {
                        Ok(result) => done_tx.send(Done::Analysed { item, result }),
                        Err(error) => done_tx.send(Done::Failed { item, error }),
                    };
                }
            });
        }
        drop(done_tx);

        // Everything below happens on one thread: the ledger is never shared.
        let mut finished = 0usize;
        for event in done_rx {
            match event {
                Done::Downloading { item_id, title } => {
                    on_progress(Progress::Downloading { index: finished + 1, total, item_id, title });
                }
                Done::Reusing { item_id, title } => {
                    on_progress(Progress::Reusing { index: finished + 1, total, item_id, title });
                }
                Done::Analysing { item_id, title } => {
                    on_progress(Progress::Analyzing { index: finished + 1, total, item_id, title });
                }
                Done::Analysed { item, result } => {
                    finished += 1;
                    let (bpm, key) = (result.bpm, result.key.clone());
                    ledger.record_success(&item.id, result, &clock.now_iso8601());
                    save(store, ledger, &mut save_failing, on_progress);
                    on_progress(Progress::Completed {
                        index: finished,
                        total,
                        item_id: item.id,
                        bpm,
                        key,
                    });
                    summary.analyzed += 1;
                }
                Done::Failed { item, error } => {
                    finished += 1;
                    let message = error.message.clone();
                    let retryable = error.retryable;
                    if error.blocked {
                        // Nothing is recorded: the track was never really tried.
                        blocked_in_a_row += 1;
                        if blocked_in_a_row >= BLOCKED_BEFORE_GIVING_UP {
                            on_progress(Progress::Blocked { failures: blocked_in_a_row });
                            stop_because_blocked.store(true, Ordering::SeqCst);
                        }
                    } else {
                        blocked_in_a_row = 0;
                        record_failure(
                            ledger, &item, &error, clock, store, options.max_attempts,
                            &mut save_failing, on_progress,
                        );
                    }
                    on_progress(Progress::Failed {
                        index: finished,
                        total,
                        item_id: item.id.clone(),
                        error: message,
                        will_retry: retryable
                            && (error.blocked
                                || ledger.attempts(&item.id) < options.max_attempts),
                    });
                    summary.failed += 1;
                }
            }
        }
    });

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

    #[test]
    fn ids_are_reduced_to_safe_filenames() {
        assert_eq!(audio_stem("12345_dQw4w9WgXcQ"), "12345_dQw4w9WgXcQ");
        // A traversal attempt in an id must not escape the work dir.
        assert_eq!(audio_stem("../../etc/passwd"), "______etc_passwd");
        assert_eq!(audio_stem("a b:c*d"), "a_b_c_d");
    }

    #[test]
    fn a_cached_file_is_found_whatever_extension_it_has() {
        let dir = std::env::temp_dir().join(format!("stem-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("7_abc.opus"), b"audio").unwrap();

        assert_eq!(existing_audio(&dir, "7_abc"), Some(dir.join("7_abc.opus")));
        assert_eq!(existing_audio(&dir, "7_xyz"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_half_written_file_is_not_reused() {
        // A run killed mid-download leaves an empty file. Handing that to the
        // analyser would turn a resumable interruption into a hard failure.
        let dir = std::env::temp_dir().join(format!("stem-empty-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("7_abc.opus"), b"").unwrap();

        assert_eq!(existing_audio(&dir, "7_abc"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
    use super::*;
    use crate::backup::Backup;
    use serde_json::json;
    use std::sync::Mutex;
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
        saves: Mutex<Vec<usize>>,
    }
    impl LedgerStore for RecordingStore {
        fn save(&self, ledger: &Ledger) -> Result<(), String> {
            self.saves.lock().unwrap().push(ledger.entries.len());
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
            let seen = Mutex::new(0usize);
            let should_stop = || {
                if let Some(n) = stop_after {
                    let mut s = seen.lock().unwrap();
                    if *s >= n {
                        return true;
                    }
                    *s += 1;
                }
                false
            };
            let options = RunOptions {
                work_dir: &self.dir,
                max_attempts: 3,
                limit: None,
                downloads_at_once: 1,
                analysers_at_once: 1,
                keep_audio: false,
            };
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
            h.store.saves.lock().unwrap().len() >= 4,
            "expected a save per item, got {:?}",
            h.store.saves.lock().unwrap()
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
    fn keep_audio_keeps_the_files_and_a_rerun_downloads_nothing() {
        // Counts downloads so the second run can be shown to make none — the
        // whole point of the flag is that a rerun never touches the network.
        struct Counting(Mutex<usize>);
        impl Downloader for Counting {
            fn download(&self, item: &PlannedItem, dest: &Path) -> Result<PathBuf, StepError> {
                *self.0.lock().unwrap() += 1;
                let path = dest.join(format!("{}.m4a", audio_stem(&item.id)));
                std::fs::write(&path, b"audio").map_err(|e| StepError::retryable(e.to_string()))?;
                Ok(path)
            }
        }

        let h = Harness::new("keep-audio");
        let plan = plan_of(&["1_a", "1_b"]);
        let downloader = Counting(Mutex::new(0));
        let analyzer = FakeAnalyzer { failures: HashMap::new() };
        let options = RunOptions {
            work_dir: &h.dir,
            max_attempts: 3,
            limit: None,
            downloads_at_once: 1,
            analysers_at_once: 1,
            keep_audio: true,
        };

        let mut first = Ledger::new("h", "now");
        let mut events = vec![];
        run(
            &plan, &mut first, &downloader, &analyzer, &FixedClock, &h.store,
            &options, &|| false, &mut |p| events.push(p),
        );

        assert_eq!(*downloader.0.lock().unwrap(), 2, "both tracks download the first time");
        let kept: Vec<_> = std::fs::read_dir(&h.dir).unwrap().filter_map(|e| e.ok()).collect();
        assert_eq!(kept.len(), 2, "audio should have been kept: {kept:?}");

        // A fresh ledger, so the work is outstanding again and the only thing
        // that can stop a download is the cached file.
        let mut second = Ledger::new("h", "now");
        let mut events = vec![];
        run(
            &plan, &mut second, &downloader, &analyzer, &FixedClock, &h.store,
            &options, &|| false, &mut |p| events.push(p),
        );

        assert_eq!(*downloader.0.lock().unwrap(), 2, "the rerun must not download");
        assert!(
            events.iter().any(|e| matches!(e, Progress::Reusing { .. })),
            "the rerun should report reuse, not a download",
        );
        assert!(!events.iter().any(|e| matches!(e, Progress::Downloading { .. })));
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
    use std::sync::Mutex;
    use std::path::PathBuf;

    struct FixedClock;
    impl Clock for FixedClock {
        fn now_iso8601(&self) -> String {
            "2026-09-04T12:00:00Z".to_string()
        }
    }

    /// Fails every save until `heal_after` saves have been attempted.
    struct FlakyStore {
        attempts: Mutex<usize>,
        heal_after: usize,
    }
    impl LedgerStore for FlakyStore {
        fn save(&self, _ledger: &Ledger) -> Result<(), String> {
            let mut n = self.attempts.lock().unwrap();
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
        let options = RunOptions {
            work_dir: &dir,
            max_attempts: 3,
            limit: None,
            downloads_at_once: 1,
            analysers_at_once: 1,
            keep_audio: false,
        };
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
        let store = FlakyStore { attempts: Mutex::new(0), heal_after: usize::MAX };
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
        let store = FlakyStore { attempts: Mutex::new(0), heal_after: usize::MAX };
        let events = run_with(&store, &["1_a", "1_b", "1_c", "1_d", "1_e"]);
        assert_eq!(
            events.iter().filter(|e| matches!(e, Progress::LedgerUnsaved { .. })).count(),
            1
        );
    }

    #[test]
    fn recovery_is_reported_so_the_user_knows_it_is_safe_again() {
        // Fails the plan-decisions save, then succeeds.
        let store = FlakyStore { attempts: Mutex::new(0), heal_after: 1 };
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
