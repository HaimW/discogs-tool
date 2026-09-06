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
