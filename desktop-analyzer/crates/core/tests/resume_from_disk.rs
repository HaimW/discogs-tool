//! Resume, proven against a real ledger file rather than an in-memory
//! round-trip.
//!
//! The unit test in `pipeline.rs` reloads the ledger by serialising it in
//! memory, which cannot catch a store that never actually reaches the disk.
//! This one stops a run partway, throws the `Ledger` away entirely, reads the
//! file back with `FileLedgerStore` the way a restarted process would, and
//! checks that nothing is redone and nothing is lost.

use std::cell::RefCell;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use analyzer_core::backup::Backup;
use analyzer_core::ledger::{settings_hash, EntryState, Ledger, ResumeOutcome};
use analyzer_core::meta::AnalysisResult;
use analyzer_core::pipeline::{self, Analyzer, Downloader, Progress, RunOptions, StepError};
use analyzer_core::plan::{Plan, PlannedItem};
use analyzer_core::runtime::{FileLedgerStore, SystemClock};

struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> TempDir {
        let dir = std::env::temp_dir().join(format!("analyzer-resume-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }
    fn join(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Remembers every id it was asked for, which is how "analysed twice" is
/// detected across the two runs.
#[derive(Default)]
struct SpyDownloader {
    seen: RefCell<Vec<String>>,
}

impl Downloader for SpyDownloader {
    fn download(&self, item: &PlannedItem, dest: &Path) -> Result<PathBuf, StepError> {
        self.seen.borrow_mut().push(item.id.clone());
        let path = dest.join(format!("{}.m4a", item.id));
        fs::write(&path, b"audio").map_err(|e| StepError::retryable(e.to_string()))?;
        Ok(path)
    }
}

struct StubAnalyzer;

impl Analyzer for StubAnalyzer {
    fn analyze(&self, path: &Path) -> Result<AnalysisResult, StepError> {
        let id = path.file_stem().unwrap().to_string_lossy().to_string();
        // Encode the id in the bpm so a lost or duplicated result is visible.
        let n = id.rsplit('_').next().unwrap().parse::<f64>().unwrap_or(0.0);
        Ok(AnalysisResult {
            bpm: 100.0 + n,
            bpm_confidence: 0.9,
            key: "8A".into(),
            key_musical: "A minor".into(),
            key_strength: 0.7,
            energy: Some(6),
            analyzed_at: "2026-09-04T12:00:00Z".into(),
            analyzer_version: "test".into(),
        })
    }
}

fn plan_of(count: usize) -> Plan {
    let videos: Vec<_> = (0..count)
        .map(|i| {
            serde_json::json!({
                "id": format!("1_{i}"), "release_id": 1, "title": "Blue Monday",
                "uri": "u", "youtube_id": i.to_string(), "duration": 200
            })
        })
        .collect();
    let backup = Backup::parse(
        &serde_json::json!({
            "_app": "VinylCollectionPlayer", "_version": 2,
            "collection": {"releases": [], "videos": videos, "tracklist": []},
            "track_meta": []
        })
        .to_string(),
    )
    .unwrap();
    Plan::build(&backup, false)
}

/// Run until `stop_after` items have been started, as a Ctrl-C would.
fn run_until(
    plan: &Plan,
    ledger: &mut Ledger,
    downloader: &SpyDownloader,
    store: &FileLedgerStore,
    work_dir: &Path,
    stop_after: Option<usize>,
) -> pipeline::Summary {
    let started = RefCell::new(0usize);
    let should_stop = || match stop_after {
        None => false,
        Some(n) => {
            let mut s = started.borrow_mut();
            if *s >= n {
                true
            } else {
                *s += 1;
                false
            }
        }
    };
    let options = RunOptions { work_dir, max_attempts: 3, limit: None };
    pipeline::run(
        plan,
        ledger,
        downloader,
        &StubAnalyzer,
        &SystemClock,
        store,
        &options,
        &should_stop,
        &mut |_: Progress| {},
    )
}

#[test]
fn a_run_interrupted_halfway_resumes_from_the_ledger_on_disk() {
    let dir = TempDir::new("halfway");
    let work = dir.join("work");
    fs::create_dir_all(&work).unwrap();
    let store = FileLedgerStore::new(dir.join("state").join("ledger.json"));
    let hash = settings_hash(&["0.1.0", "test-format"]);
    let plan = plan_of(6);

    // --- first run, killed after two items ---
    let first_downloader = SpyDownloader::default();
    let (mut ledger, outcome) = Ledger::resume_or_new(store.load().as_deref(), &hash, "start");
    assert_eq!(outcome, ResumeOutcome::FreshStart);
    let first = run_until(&plan, &mut ledger, &first_downloader, &store, &work, Some(2));
    assert_eq!(first.analyzed, 2);
    drop(ledger); // the process is gone; only the file survives.

    // --- second process: everything comes from the file ---
    let raw = store.load().expect("a ledger was written to disk");
    let (mut ledger, outcome) = Ledger::resume_or_new(Some(&raw), &hash, "restart");
    assert_eq!(outcome, ResumeOutcome::Resumed { completed: 2 });

    let second_downloader = SpyDownloader::default();
    let second = run_until(&plan, &mut ledger, &second_downloader, &store, &work, None);
    assert_eq!(second.analyzed, 4, "only the outstanding four are done");

    // Nothing was downloaded twice, across either run.
    let first_ids: HashSet<String> = first_downloader.seen.borrow().iter().cloned().collect();
    let second_ids: HashSet<String> = second_downloader.seen.borrow().iter().cloned().collect();
    assert_eq!(first_ids.len(), 2);
    assert_eq!(second_ids.len(), 4);
    assert!(
        first_ids.is_disjoint(&second_ids),
        "an item was analysed twice: {:?}",
        first_ids.intersection(&second_ids).collect::<Vec<_>>()
    );

    // And every result is present exactly once, first-run ones included.
    let final_ledger = Ledger::parse(&store.load().unwrap()).unwrap();
    assert_eq!(final_ledger.completed_count(), 6);
    let mut ids: Vec<&String> = final_ledger.results().map(|(id, _)| id).collect();
    ids.sort();
    assert_eq!(ids, vec!["1_0", "1_1", "1_2", "1_3", "1_4", "1_5"]);
    for (id, result) in final_ledger.results() {
        let n: f64 = id.rsplit('_').next().unwrap().parse().unwrap();
        assert_eq!(result.bpm, 100.0 + n, "{id} carries the wrong result");
    }

    // A third run has nothing left to do and downloads nothing.
    let third_downloader = SpyDownloader::default();
    let mut ledger = Ledger::parse(&store.load().unwrap()).unwrap();
    let third = run_until(&plan, &mut ledger, &third_downloader, &store, &work, None);
    assert_eq!(third.analyzed, 0);
    assert!(third_downloader.seen.borrow().is_empty(), "a finished item was redone");
}

#[test]
fn the_ledger_is_on_disk_before_the_run_ends() {
    // The guarantee that makes resume worth anything: a process killed without
    // warning at item three still finds items one and two on disk.
    let dir = TempDir::new("during");
    let work = dir.join("work");
    fs::create_dir_all(&work).unwrap();
    let store = FileLedgerStore::new(dir.join("ledger.json"));
    let plan = plan_of(4);
    let mut ledger = Ledger::new("hash", "start");
    let downloader = SpyDownloader::default();

    let options = RunOptions { work_dir: &work, max_attempts: 3, limit: None };
    let mut on_disk_at_item_three = 0usize;
    let seen = RefCell::new(0usize);
    let should_stop = || {
        *seen.borrow_mut() += 1;
        false
    };
    pipeline::run(
        &plan,
        &mut ledger,
        &downloader,
        &StubAnalyzer,
        &SystemClock,
        &store,
        &options,
        &should_stop,
        &mut |p: Progress| {
            if let Progress::Downloading { index: 3, .. } = p {
                let raw = store.load().expect("a ledger exists by item three");
                on_disk_at_item_three = Ledger::parse(&raw).unwrap().completed_count();
            }
        },
    );

    assert_eq!(
        on_disk_at_item_three, 2,
        "the first two results should already be durable when the third starts"
    );
}

#[test]
fn changed_analysis_settings_start_a_clean_ledger_rather_than_mixing_results() {
    let dir = TempDir::new("settings");
    let work = dir.join("work");
    fs::create_dir_all(&work).unwrap();
    let store = FileLedgerStore::new(dir.join("ledger.json"));
    let plan = plan_of(2);

    let mut ledger = Ledger::new(settings_hash(&["0.1.0"]), "start");
    run_until(&plan, &mut ledger, &SpyDownloader::default(), &store, &work, None);
    assert_eq!(ledger.completed_count(), 2);

    let (fresh, outcome) =
        Ledger::resume_or_new(store.load().as_deref(), &settings_hash(&["0.2.0"]), "restart");
    assert_eq!(outcome, ResumeOutcome::DiscardedSettingsChanged);
    assert_eq!(fresh.completed_count(), 0);
    assert_eq!(fresh.state("1_0"), None::<EntryState>);
}
