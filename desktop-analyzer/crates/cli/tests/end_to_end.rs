//! The whole run, end to end, with stub download and analysis steps.
//!
//! These are the guarantees section 3b calls "must have", so they are asserted
//! against the bytes actually written to disk rather than against intermediate
//! structures: resumability across a restart, and never overwriting a human's
//! BPM/key without `--force`.

use std::sync::Mutex;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use analyzer_cli::{default_ledger_for, execute, Options};
use analyzer_core::meta::AnalysisResult;
use analyzer_core::pipeline::{Analyzer, Clock, Downloader, Progress, StepError};
use analyzer_core::plan::PlannedItem;
use serde_json::{json, Value};

struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> TempDir {
        let dir = std::env::temp_dir().join(format!("analyzer-cli-{name}"));
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

struct FixedClock;
impl Clock for FixedClock {
    fn now_iso8601(&self) -> String {
        "2026-09-04T12:00:00Z".into()
    }
}

struct StubDownloader;
impl Downloader for StubDownloader {
    fn download(&self, item: &PlannedItem, dest: &Path) -> Result<PathBuf, StepError> {
        let path = dest.join(format!("{}.m4a", item.id));
        fs::write(&path, b"audio").map_err(|e| StepError::retryable(e.to_string()))?;
        Ok(path)
    }
}

/// Records which ids it was asked to analyse, so a resumed run can be checked
/// for redoing work.
#[derive(Default)]
struct RecordingAnalyzer {
    seen: Mutex<Vec<String>>,
}

impl Analyzer for RecordingAnalyzer {
    fn analyze(&self, path: &Path, _hint: analyzer_core::tempo::TempoHint) -> Result<AnalysisResult, StepError> {
        let id = path.file_stem().unwrap().to_string_lossy().to_string();
        self.seen.lock().unwrap().push(id);
        Ok(AnalysisResult {
            bpm: 124.0,
            bpm_confidence: 0.97,
            key: "8A".into(),
            key_musical: "A minor".into(),
            key_strength: 0.8,
            energy: Some(7),
            energy_score: None,
            bpm_method: None,
            bpm_second_opinion: None,
            analyzed_at: "2026-09-04T12:00:00Z".into(),
            analyzer_version: "test".into(),
        })
    }
}

fn video(id: &str) -> Value {
    json!({
        "id": id, "release_id": 1, "title": "Blue Monday", "uri": "u",
        "youtube_id": id.split('_').nth(1).unwrap(), "duration": 200
    })
}

/// A collection covering every protection case at once.
fn backup_json() -> String {
    json!({
        "_app": "VinylCollectionPlayer", "_version": 2,
        "collection": {
            "releases": [], "tracklist": [],
            "videos": [video("1_aaa"), video("1_bbb"), video("1_ccc"), video("1_ddd")]
        },
        "track_meta": [
            // Blessed by a human: must never be touched.
            {"id": "1_bbb", "bpm": 100.0, "key": "5A", "energy": 3, "bpm_verified": true},
            // Hand-typed BPM, no key: the key may be filled in, the BPM may not.
            {"id": "1_ccc", "bpm": 99.0},
            // Untouched analysis target that carries user data alongside.
            {"id": "1_ddd", "rating": 5, "notes": "killer", "verified": true}
        ]
    })
    .to_string()
}

struct Fixture {
    dir: TempDir,
    options: Options,
}

impl Fixture {
    fn new(name: &str, force: bool) -> Fixture {
        let dir = TempDir::new(name);
        fs::write(dir.join("backup.json"), backup_json()).unwrap();
        let output = dir.join("analysis.json");
        Fixture {
            options: Options {
                backup: dir.join("backup.json"),
                ledger: default_ledger_for(&output),
                output,
                work_dir: dir.join("work"),
                force,
                limit: None,
                max_attempts: 3,
                downloads_at_once: 1,
                analysers_at_once: 1,
                keep_audio: false,
                second_opinion: "Always".into(),
            },
            dir,
        }
    }

    /// Run, stopping after `stop_after` items when given.
    fn run(&self, analyzer: &RecordingAnalyzer, stop_after: Option<usize>) -> analyzer_cli::Outcome {
        let seen = Mutex::new(0usize);
        let should_stop = || match stop_after {
            None => false,
            Some(n) => {
                let mut s = seen.lock().unwrap();
                if *s >= n {
                    return true;
                }
                *s += 1;
                false
            }
        };
        execute(
            &self.options,
            &StubDownloader,
            analyzer,
            &FixedClock,
            &should_stop,
            &mut |_: Progress| {},
            &mut Vec::new(),
        )
        .expect("run succeeded")
    }

    fn export(&self) -> Value {
        serde_json::from_str(&fs::read_to_string(&self.options.output).unwrap()).unwrap()
    }
}

fn record<'a>(export: &'a Value, id: &str) -> Option<&'a Value> {
    export["track_meta"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == id)
}

#[test]
fn the_export_matches_the_shape_the_web_apps_restore_accepts() {
    let f = Fixture::new("shape", false);
    f.run(&RecordingAnalyzer::default(), None);
    let export = f.export();

    // importBackupFile() rejects anything without this exact marker.
    assert_eq!(export["_app"], "VinylCollectionPlayer");
    assert_eq!(export["_version"], 2);
    assert!(export["track_meta"].is_array());
    // Every other store must be absent so restore defaults them to [] and
    // clobbers nothing the user has.
    for store in ["collection", "wantlist", "store", "setlists", "config", "notifications"] {
        assert!(export.get(store).is_none(), "export must not carry {store}");
    }
    // Records stay keyed releaseId_youtubeId.
    for r in export["track_meta"].as_array().unwrap() {
        let id = r["id"].as_str().unwrap();
        assert!(id.contains('_'), "id {id} is not releaseId_youtubeId");
    }
}

#[test]
fn a_verified_record_never_reaches_the_export_at_all() {
    let f = Fixture::new("verified", false);
    let analyzer = RecordingAnalyzer::default();
    f.run(&analyzer, None);

    // The strongest form of the guarantee: restore replaces whole records, so
    // the safest thing is for a blessed record not to be in the file.
    assert!(
        record(&f.export(), "1_bbb").is_none(),
        "a bpm_verified record must not appear in the export"
    );
    assert!(
        !analyzer.seen.lock().unwrap().contains(&"1_bbb".to_string()),
        "a protected track should not even be downloaded"
    );
}

#[test]
fn force_overwrites_a_verified_record() {
    let f = Fixture::new("force", true);
    f.run(&RecordingAnalyzer::default(), None);

    let export = f.export();
    let bbb = record(&export, "1_bbb").expect("--force should include it");
    assert_eq!(bbb["bpm"], 124.0, "--force must overwrite the human's BPM");
    assert_eq!(bbb["key"], "8A");
    // The blessing itself survives, so the user can still see they had checked it.
    assert_eq!(bbb["bpm_verified"], true);
}

#[test]
fn a_hand_typed_bpm_survives_while_the_missing_key_is_filled_in() {
    let f = Fixture::new("partial", false);
    f.run(&RecordingAnalyzer::default(), None);

    let export = f.export();
    let ccc = record(&export, "1_ccc").expect("should be analysed for its missing key");
    assert_eq!(ccc["bpm"], 99.0, "the typed BPM must not be overwritten");
    assert_eq!(ccc["bpm_source"], Value::Null, "and must not be relabelled as analysed");
    assert_eq!(ccc["key"], "8A", "the empty key should be filled in");
    assert_eq!(ccc["key_source"], "analysis");
}

#[test]
fn user_data_rides_along_untouched() {
    let f = Fixture::new("userdata", false);
    f.run(&RecordingAnalyzer::default(), None);

    let ddd = record(&f.export(), "1_ddd").cloned().expect("analysed");
    // Restore replaces the whole record, so anything dropped here is destroyed
    // in the user's database.
    assert_eq!(ddd["rating"], 5);
    assert_eq!(ddd["notes"], "killer");
    assert_eq!(ddd["verified"], true, "the YouTube-link flag is not ours to clear");
    assert_eq!(ddd["bpm"], 124.0);
    assert_eq!(ddd["energy"], 7);
}

#[test]
fn an_interrupted_run_resumes_from_the_ledger_without_redoing_work() {
    let f = Fixture::new("resume", false);

    let first_analyzer = RecordingAnalyzer::default();
    let first = f.run(&first_analyzer, Some(1));
    assert_eq!(first.summary.analyzed, 1, "stopped after one item");
    assert!(first.interrupted);
    assert!(f.options.ledger.exists(), "the ledger must be on disk to resume from");

    let first_seen: HashSet<String> = first_analyzer.seen.lock().unwrap().iter().cloned().collect();
    assert_eq!(first_seen.len(), 1);

    // A fresh analyzer stands in for a fresh process: it knows nothing except
    // what the ledger file carries.
    let second_analyzer = RecordingAnalyzer::default();
    let second = f.run(&second_analyzer, None);
    let second_seen: HashSet<String> = second_analyzer.seen.lock().unwrap().iter().cloned().collect();

    assert!(
        first_seen.is_disjoint(&second_seen),
        "the resumed run re-analysed {:?}",
        first_seen.intersection(&second_seen).collect::<Vec<_>>()
    );
    assert_eq!(second.summary.analyzed, 2, "only the remaining items");

    // And the export carries results from BOTH runs, not just the last one.
    let export = f.export();
    let ids: HashSet<String> = export["track_meta"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap().to_string())
        .collect();
    assert!(ids.contains("1_aaa") && ids.contains("1_ccc") && ids.contains("1_ddd"), "got {ids:?}");
}

#[test]
fn the_export_is_written_even_when_the_run_is_interrupted_immediately() {
    let f = Fixture::new("early-stop", false);
    let outcome = f.run(&RecordingAnalyzer::default(), Some(0));
    assert_eq!(outcome.summary.analyzed, 0);
    assert!(
        f.options.output.exists(),
        "an export must still be written so nothing already in the ledger is stranded"
    );
    assert_eq!(f.export()["_app"], "VinylCollectionPlayer");
}

#[test]
fn scratch_audio_is_not_left_behind() {
    let f = Fixture::new("cleanup", false);
    f.run(&RecordingAnalyzer::default(), None);
    let leftovers: Vec<_> = fs::read_dir(f.dir.join("work"))
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name())
        .collect();
    assert!(leftovers.is_empty(), "temp audio left behind: {leftovers:?}");
}

// --- The dry run -----------------------------------------------------------
//
// A dry run is only useful if it predicts what a real run with the same
// options would do, and a real run consults the resume ledger. These pin the
// dry run to that ledger: same path, same settings hash, same retry budget.

use analyzer_cli::{dry_run, settings_hash_for, DryRun, Frontend};
use analyzer_core::ledger::{Ledger, ResumeOutcome};

fn long_video(id: &str) -> Value {
    json!({
        "id": id, "release_id": 1, "title": "Blue Monday", "uri": "u",
        "youtube_id": id.split('_').nth(1).unwrap(), "duration": 3600
    })
}

/// Every ledger state a dry run has to count, plus one of each non-work plan
/// decision.
fn dry_run_backup_json() -> String {
    json!({
        "_app": "VinylCollectionPlayer", "_version": 2,
        "collection": {
            "releases": [], "tracklist": [],
            "videos": [
                video("1_done"),       // done in the ledger
                video("1_retry"),      // failed once: retried
                video("1_spent"),      // failed max_attempts times: skipped
                video("1_new"),        // not in the ledger at all
                video("1_mine"),       // the user's own bpm/key: Skip
                long_video("1_mix")    // an hour long: Review
            ]
        },
        "track_meta": [
            // An earlier run's result, restored into the web app. The plan
            // re-analyses these on purpose; only the ledger stops the re-work.
            {"id": "1_done", "bpm": 124.0, "key": "8A",
             "bpm_source": "analysis", "key_source": "analysis"},
            {"id": "1_mine", "bpm": 100.0, "key": "5A", "energy": 3, "bpm_verified": true}
        ]
    })
    .to_string()
}

fn some_result() -> AnalysisResult {
    AnalysisResult {
        bpm: 124.0,
        bpm_confidence: 0.97,
        key: "8A".into(),
        key_musical: "A minor".into(),
        key_strength: 0.8,
        energy: Some(7),
        energy_score: None,
        bpm_method: None,
        bpm_second_opinion: None,
        analyzed_at: "2026-09-04T12:00:00Z".into(),
        analyzer_version: "test".into(),
    }
}

/// A ledger as a real run with `second_opinion` would have left it.
fn write_ledger(path: &Path, second_opinion: &str) {
    let mut ledger = Ledger::new(settings_hash_for(second_opinion), "2026-09-04T12:00:00Z");
    let at = "2026-09-04T12:00:00Z";
    ledger.record_success("1_done", some_result(), at);
    ledger.record_failure("1_retry", "timeout", at);
    for _ in 0..3 {
        ledger.record_failure("1_spent", "video unavailable", at);
    }
    fs::write(path, ledger.to_json().unwrap()).unwrap();
}

fn dry_fixture(name: &str) -> Fixture {
    let f = Fixture::new(name, false);
    fs::write(f.dir.join("backup.json"), dry_run_backup_json()).unwrap();
    f
}

fn plan(f: &Fixture) -> (DryRun, String) {
    let mut out = Vec::new();
    let report = dry_run(&f.options, &mut out).expect("dry run succeeded");
    (report, String::from_utf8(out).unwrap())
}

#[test]
fn the_settings_hash_matches_a_ledger_the_ui_wrote() {
    // Taken from a real ledger written by the UI with its default "Always".
    // If this moves, every existing ledger is silently discarded on the next
    // run — bump ALGORITHM_TAG on purpose, never by accident.
    assert_eq!(settings_hash_for("Always"), "a91b4430e1237ed4");
    assert_ne!(settings_hash_for("Always"), settings_hash_for("Never"));
}

#[test]
fn a_dry_run_counts_only_what_the_ledger_has_not_finished() {
    let f = dry_fixture("dry-resumed");
    write_ledger(&f.options.ledger, "Always");

    let (report, text) = plan(&f);
    assert_eq!(report.outstanding, 2, "1_retry and 1_new");
    assert_eq!(report.will_run, 2);
    assert_eq!(report.done, 1);
    assert_eq!(report.exhausted, 1);
    assert_eq!(report.skip, 1);
    assert_eq!(report.review, 1);
    assert_eq!(report.resume, ResumeOutcome::Resumed { completed: 1 });
    assert!(!report.resume_warning());
    assert!(text.contains("Resuming from"), "{text}");
    assert!(text.contains(&f.options.ledger.display().to_string()), "{text}");
    assert!(text.contains("max-attempts"), "the way out of 'failed too often': {text}");
}

#[test]
fn a_bigger_retry_budget_brings_exhausted_failures_back() {
    let mut f = dry_fixture("dry-attempts");
    write_ledger(&f.options.ledger, "Always");
    f.options.max_attempts = 5;

    let (report, _) = plan(&f);
    assert_eq!(report.outstanding, 3);
    assert_eq!(report.exhausted, 0);
}

#[test]
fn a_dry_run_reports_where_a_limited_run_stops() {
    let mut f = dry_fixture("dry-limit");
    write_ledger(&f.options.ledger, "Always");
    f.options.limit = Some(1);

    let (report, text) = plan(&f);
    assert_eq!(report.outstanding, 2);
    assert_eq!(report.will_run, 1);
    assert!(text.contains("stops after 1"), "{text}");
}

#[test]
fn without_a_ledger_a_dry_run_reports_a_fresh_start_and_the_full_count() {
    let f = dry_fixture("dry-fresh");

    let (report, text) = plan(&f);
    assert_eq!(report.resume, ResumeOutcome::FreshStart);
    assert_eq!(report.outstanding, 4, "every Analyze item");
    assert_eq!(report.done, 0);
    assert_eq!(report.exhausted, 0);
    assert!(report.resume_warning());
    assert!(text.contains("No resume file found at"), "{text}");
    assert_eq!(report.analysed_in_backup, 1);
    assert!(
        text.contains("different resume file"),
        "the backup holds earlier results, so say where they may be: {text}"
    );
}

#[test]
fn a_ledger_from_other_settings_is_reported_as_discarded() {
    let f = dry_fixture("dry-settings");
    write_ledger(&f.options.ledger, "Never");

    let (report, text) = plan(&f);
    assert_eq!(report.resume, ResumeOutcome::DiscardedSettingsChanged);
    assert_eq!(report.outstanding, 4, "a discarded ledger means a run redoes everything");
    assert_eq!(report.done, 0);
    assert!(report.resume_warning());
    assert!(text.contains("discarded"), "{text}");
    assert!(text.contains("second"), "name the usual cause: {text}");
}

#[test]
fn an_unreadable_ledger_is_reported_as_discarded() {
    let f = dry_fixture("dry-junk");
    fs::write(&f.options.ledger, "{ not json").unwrap();

    let (report, text) = plan(&f);
    assert_eq!(report.resume, ResumeOutcome::DiscardedUnreadable);
    assert_eq!(report.outstanding, 4);
    assert!(report.resume_warning());
    assert!(text.contains("unreadable"), "{text}");
}

#[test]
fn a_dry_run_writes_nothing() {
    let f = dry_fixture("dry-readonly");
    plan(&f);
    assert!(!f.options.ledger.exists(), "the dry run created a ledger");
    assert!(!f.options.output.exists(), "the dry run wrote an export");
    assert!(!f.options.work_dir.exists(), "the dry run created the work dir");

    write_ledger(&f.options.ledger, "Always");
    let before = fs::read(&f.options.ledger).unwrap();
    let modified = fs::metadata(&f.options.ledger).unwrap().modified().unwrap();
    plan(&f);
    assert_eq!(fs::read(&f.options.ledger).unwrap(), before, "the dry run rewrote the ledger");
    assert_eq!(fs::metadata(&f.options.ledger).unwrap().modified().unwrap(), modified);
}

#[test]
fn a_dry_run_predicts_exactly_what_the_next_run_analyses() {
    let f = Fixture::new("dry-predicts", false);
    f.run(&RecordingAnalyzer::default(), Some(1));

    let (report, _) = plan(&f);
    let analyzer = RecordingAnalyzer::default();
    f.run(&analyzer, None);
    assert_eq!(analyzer.seen.lock().unwrap().len(), report.outstanding);
}

// --- The restart guard -----------------------------------------------------
//
// A run that would not resume, while earlier work exists (analysed tracks in
// the backup, or a discarded resume file with finished tracks in it), redoes
// hours of work. The guard is the same `dry_run` both front ends use.

/// A backup with no earlier analysis at all: a first-ever run.
fn first_run_backup_json() -> String {
    json!({
        "_app": "VinylCollectionPlayer", "_version": 2,
        "collection": {"releases": [], "tracklist": [], "videos": [video("1_aaa"), video("1_bbb")]},
        "track_meta": []
    })
    .to_string()
}

#[test]
fn a_fresh_start_over_an_analysed_backup_redoes_work() {
    let f = dry_fixture("guard-fresh");
    let (report, _) = plan(&f);
    assert_eq!(report.resume, ResumeOutcome::FreshStart);
    assert_eq!(report.discarded_completed, 0);
    assert!(report.restart_redoes_work());
    let msg = report.restart_message();
    assert!(msg.contains("No resume file"), "{msg}");
    assert!(msg.contains("1 analysed"), "names the analysed count: {msg}");
}

#[test]
fn a_discarded_ledger_with_finished_tracks_redoes_work() {
    let f = Fixture::new("guard-discarded", false);
    fs::write(f.dir.join("backup.json"), first_run_backup_json()).unwrap();
    let mut ledger = Ledger::new(settings_hash_for("Never"), "2026-09-04T12:00:00Z");
    ledger.record_success("1_aaa", some_result(), "2026-09-04T12:00:00Z");
    fs::write(&f.options.ledger, ledger.to_json().unwrap()).unwrap();

    let (report, _) = plan(&f);
    assert_eq!(report.resume, ResumeOutcome::DiscardedSettingsChanged);
    assert_eq!(report.analysed_in_backup, 0);
    assert_eq!(report.discarded_completed, 1);
    assert!(report.restart_redoes_work());
    let msg = report.restart_message();
    assert!(msg.contains("1 finished"), "{msg}");
    assert!(msg.contains("cross-check"), "names the setting that changed: {msg}");
}

#[test]
fn an_unreadable_ledger_counts_nothing_discarded() {
    let f = Fixture::new("guard-junk", false);
    fs::write(f.dir.join("backup.json"), first_run_backup_json()).unwrap();
    fs::write(&f.options.ledger, "{ not json").unwrap();
    let (report, _) = plan(&f);
    assert_eq!(report.discarded_completed, 0);
    assert!(!report.restart_redoes_work(), "nothing finished is known to be lost");
}

#[test]
fn resuming_and_first_ever_runs_are_not_guarded() {
    let f = dry_fixture("guard-resume");
    write_ledger(&f.options.ledger, "Always");
    let (report, _) = plan(&f);
    assert!(matches!(report.resume, ResumeOutcome::Resumed { .. }));
    assert!(!report.restart_redoes_work());

    let f = Fixture::new("guard-first", false);
    fs::write(f.dir.join("backup.json"), first_run_backup_json()).unwrap();
    let (report, _) = plan(&f);
    assert_eq!(report.resume, ResumeOutcome::FreshStart);
    assert!(!report.restart_redoes_work());
}

#[test]
fn a_run_with_nothing_outstanding_redoes_nothing() {
    // Earlier analysis in the backup, no resume file — but the only video is
    // held back for review, so a run has nothing to analyse and redoes nothing.
    let f = Fixture::new("guard-nothing-to-do", false);
    let backup = json!({
        "_app": "VinylCollectionPlayer", "_version": 2,
        "collection": {"releases": [], "tracklist": [], "videos": [long_video("1_mix")]},
        "track_meta": [
            {"id": "1_mix", "bpm": 124.0, "key": "8A",
             "bpm_source": "analysis", "key_source": "analysis"}
        ]
    });
    fs::write(f.dir.join("backup.json"), backup.to_string()).unwrap();
    let (report, _) = plan(&f);
    assert_eq!(report.resume, ResumeOutcome::FreshStart);
    assert_eq!(report.analysed_in_backup, 1);
    assert_eq!(report.outstanding, 0);
    assert!(!report.restart_redoes_work(), "nothing to analyse, so nothing is redone");
}

#[test]
fn the_ui_resume_hint_points_at_import_not_at_an_output_name() {
    let f = dry_fixture("resume-hint-ui");
    let (report, _) = plan(&f);
    assert_eq!(report.resume, ResumeOutcome::FreshStart);

    let cli = report.resume_message_for(Frontend::Cli);
    assert_eq!(cli, report.resume_message(), "the CLI wording is the default");
    assert!(cli.contains("same output name"), "{cli}");

    let ui = report.resume_message_for(Frontend::Ui);
    assert!(ui.contains("Import earlier progress"), "{ui}");
    assert!(ui.contains(".ledger.json"), "{ui}");
    assert!(!ui.contains("output name"), "CLI-only advice in the UI: {ui}");
    assert!(ui.contains("1 analysed"), "keeps the count: {ui}");

    // Nothing else changes per front end.
    let f = dry_fixture("resume-hint-ui-resumed");
    write_ledger(&f.options.ledger, "Always");
    let (report, _) = plan(&f);
    assert_eq!(report.resume_message_for(Frontend::Ui), report.resume_message_for(Frontend::Cli));
}

/// Run the built binary with `args`, from inside `dir`.
fn cli(dir: &Path, args: &[&str]) -> std::process::Output {
    std::process::Command::new(env!("CARGO_BIN_EXE_discogs-analyzer"))
        .args(args)
        .current_dir(dir)
        .output()
        .expect("the binary runs")
}

#[test]
fn the_cli_refuses_to_redo_work_without_fresh_and_writes_nothing() {
    let f = dry_fixture("cli-guard");
    let d = |n: &str| f.dir.join(n).display().to_string();
    // A yt-dlp that does not exist: the guard must fire before it is looked for.
    let out = cli(
        &f.dir.0,
        &["backup.json", "-o", &d("analysis.json"), "--work-dir", &d("work"), "--yt-dlp", &d("no-yt-dlp")],
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(!out.status.success(), "should exit non-zero: {stderr}");
    assert!(stderr.contains("--fresh"), "{stderr}");
    assert!(stderr.contains("--plan"), "{stderr}");
    assert!(!stderr.contains("no yt-dlp"), "the guard ran after yt-dlp resolution: {stderr}");
    assert!(!f.dir.join("analysis.json").exists(), "wrote an export");
    assert!(!f.dir.join("analysis.ledger.json").exists(), "wrote a ledger");
    assert!(!f.dir.join("work").exists(), "created the work dir");

    // With --fresh it gets past the guard, to the (missing) yt-dlp.
    let out = cli(
        &f.dir.0,
        &["backup.json", "-o", &d("analysis.json"), "--work-dir", &d("work"), "--yt-dlp", &d("no-yt-dlp"), "--fresh"],
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("no yt-dlp"), "--fresh should pass the guard: {stderr}");
}

#[test]
fn the_cli_does_not_guard_a_first_ever_run() {
    let f = Fixture::new("cli-first", false);
    fs::write(f.dir.join("backup.json"), first_run_backup_json()).unwrap();
    let d = |n: &str| f.dir.join(n).display().to_string();
    let out = cli(
        &f.dir.0,
        &["backup.json", "-o", &d("analysis.json"), "--work-dir", &d("work"), "--yt-dlp", &d("no-yt-dlp")],
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("no yt-dlp"), "a first run is not refused: {stderr}");
}

#[test]
fn fresh_is_documented_in_help() {
    let out = cli(Path::new("."), &["--help"]);
    assert!(String::from_utf8_lossy(&out.stdout).contains("--fresh"));
}
