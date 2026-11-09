//! Fixtures shared by the UI's unit and HTTP tests: a scratch data folder,
//! backups and ledgers in known states, and stub download/analysis steps so a
//! UI run can be driven end to end without yt-dlp or audio.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use analyzer_core::ledger::Ledger;
use analyzer_core::meta::AnalysisResult;
use analyzer_core::pipeline::{Analyzer, Clock, Downloader, StepError};
use analyzer_core::plan::PlannedItem;
use serde_json::json;

use super::state::{run_with, Launch, UiState};
use crate::{settings_hash_for, Options};

/// A scratch folder, removed on drop. Not created: the data folder must only
/// appear on the first write, and tests check that.
pub struct Scratch(pub PathBuf);

impl Scratch {
    pub fn new(name: &str) -> Scratch {
        let dir = std::env::temp_dir().join(format!("analyzer-ui-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        Scratch(dir)
    }
    pub fn join(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn video(id: &str) -> serde_json::Value {
    json!({
        "id": id, "release_id": 1, "title": "Blue Monday", "uri": "u",
        "youtube_id": id.split('_').nth(1).unwrap(), "duration": 200
    })
}

/// Two videos, nothing analysed: what a first-ever run sees.
pub fn first_backup() -> String {
    json!({
        "_app": "VinylCollectionPlayer", "_version": 2,
        "collection": {"releases": [], "tracklist": [], "videos": [video("1_aaa"), video("1_bbb")]},
        "track_meta": []
    })
    .to_string()
}

/// The same two videos, one already analysed by an earlier run.
pub fn analysed_backup() -> String {
    json!({
        "_app": "VinylCollectionPlayer", "_version": 2,
        "collection": {"releases": [], "tracklist": [], "videos": [video("1_aaa"), video("1_bbb")]},
        "track_meta": [
            {"id": "1_aaa", "bpm": 124.0, "key": "8A", "bpm_source": "analysis", "key_source": "analysis"}
        ]
    })
    .to_string()
}

pub fn result() -> AnalysisResult {
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

/// A ledger as a run with `label` ("Always"/"Unsure"/"Never") leaves it, with
/// `done` finished tracks.
pub fn ledger_json(label: &str, done: &[&str]) -> String {
    let mut ledger = Ledger::new(settings_hash_for(label), "2026-09-04T12:00:00Z");
    for id in done {
        ledger.record_success(id, result(), "2026-09-04T12:00:00Z");
    }
    ledger.to_json().unwrap()
}

pub fn write(path: &Path, contents: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
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
        std::fs::write(&path, b"audio").map_err(|e| StepError::retryable(e.to_string()))?;
        Ok(path)
    }
}

struct StubAnalyzer;
impl Analyzer for StubAnalyzer {
    fn analyze(
        &self,
        _path: &Path,
        _hint: analyzer_core::tempo::TempoHint,
    ) -> Result<AnalysisResult, StepError> {
        Ok(result())
    }
}

/// Stands in for the real launcher: the same run-and-finish path, with stub
/// steps instead of yt-dlp and audio analysis.
pub fn stub_launch(state: Arc<UiState>, options: Options, _launch: Launch) {
    run_with(&state, &options, &StubDownloader, &StubAnalyzer, &FixedClock);
}

/// A UI state over `dir` whose runs use the stubs.
pub fn stub_state(dir: &Path) -> Arc<UiState> {
    Arc::new(UiState::with_launcher(dir.to_path_buf(), stub_launch))
}

/// Wait for a started run to finish.
pub fn wait_idle(state: &UiState) -> serde_json::Value {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let snap = state.snapshot();
        if snap["running"] == false {
            return snap;
        }
        assert!(Instant::now() < deadline, "run did not finish: {snap}");
        std::thread::sleep(Duration::from_millis(10));
    }
}
