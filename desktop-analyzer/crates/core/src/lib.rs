//! Core logic for the desktop BPM/key analysis helper: everything that decides
//! *what* to analyse and *what to write back*, with no native audio
//! dependencies so it builds and tests on a bare Rust toolchain.
//!
//! The audio side (aubio for BPM, libkeyfinder for key) lives in the
//! `analyzer-analysis` crate; the app shell and yt-dlp sidecar live in
//! `src-tauri`. Both depend on this crate, not the other way round.
//!
//! ```
//! use analyzer_core::{backup::Backup, plan::Plan};
//!
//! let json = r#"{"_app":"VinylCollectionPlayer","_version":2,
//!   "collection":{"videos":[{"id":"1_abc","release_id":1,"title":"Blue Monday",
//!   "uri":"u","youtube_id":"abc","duration":442}],"tracklist":[],"releases":[]},
//!   "track_meta":[]}"#;
//! let backup = Backup::parse(json).unwrap();
//! let plan = Plan::build(&backup, false);
//! assert_eq!(plan.counts().analyze, 1);
//! ```

pub mod backup;
pub mod camelot;
pub mod ledger;
pub mod meta;
pub mod pipeline;
pub mod plan;
pub mod runtime;
pub mod tempo;

use meta::{merge, AnalysisResult, TrackMeta};

/// Version stamped into every record this tool writes, so a later run can tell
/// which algorithm produced a value.
pub const ANALYZER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Build the finished `track_meta` records from analysis results, merged over
/// whatever the backup already held.
///
/// Records are emitted **complete** — the web app's Restore replaces whole
/// records, so a partial one would erase the user's ratings, tags and notes.
///
/// For a track the user has never edited there is no existing record to merge
/// over, so one is built from scratch — and it has to carry `release_id` and
/// `youtube_id`, exactly as the web app's own editor writes them
/// (`src/meta_editor.js`). `release_id` in particular is indexed
/// (`src/db.js`) and is how the app finds a release's `track_meta` rows to
/// delete when that release leaves the collection (`src/api.js`). A record
/// without it is invisible to that cleanup and becomes permanent orphan data
/// in the user's browser.
pub fn merged_records<'a>(
    backup: &backup::Backup,
    results: impl Iterator<Item = (&'a String, &'a AnalysisResult)>,
    force: bool,
) -> MergeOutcome {
    let existing = backup.meta_by_id();
    let videos: std::collections::HashMap<&str, &backup::Video> = backup
        .collection
        .videos
        .iter()
        .map(|v| (v.id.as_str(), v))
        .collect();
    let mut outcome = MergeOutcome::default();
    for (id, result) in results {
        let base = existing
            .get(id.as_str())
            .map(|m| (*m).clone())
            .unwrap_or_else(|| new_record_for(id, videos.get(id.as_str()).copied()));
        match merge(&base, result, force) {
            Some(record) => outcome.records.push(record),
            None => outcome.protected.push(id.clone()),
        }
    }
    outcome
}

/// A record for a track the user has never touched, stamped with the identity
/// fields the web app expects on every `track_meta` row.
fn new_record_for(id: &str, video: Option<&backup::Video>) -> TrackMeta {
    let mut meta = TrackMeta::new(id.to_string());
    if let Some(video) = video {
        meta.release_id = Some(video.release_id);
        meta.extra.insert(
            "youtube_id".to_string(),
            serde_json::Value::String(video.youtube_id.clone()),
        );
    }
    meta
}

#[derive(Debug, Default)]
pub struct MergeOutcome {
    /// Complete records, ready to export.
    pub records: Vec<TrackMeta>,
    /// Ids left alone because a human's data was there and `--force` was off.
    pub protected: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::Backup;
    use serde_json::json;

    fn backup_with_meta(track_meta: serde_json::Value) -> Backup {
        Backup::parse(
            &json!({
                "_app": "VinylCollectionPlayer", "_version": 2,
                "collection": {"releases": [], "videos": [], "tracklist": []},
                "track_meta": track_meta
            })
            .to_string(),
        )
        .unwrap()
    }

    fn result() -> AnalysisResult {
        AnalysisResult {
            bpm: 124.0,
            bpm_confidence: 0.88,
            key: "8A".into(),
            key_musical: "A minor".into(),
            key_strength: 0.71,
            energy: Some(6),
            energy_score: None,
            bpm_method: None,
            bpm_second_opinion: None,
            analyzed_at: "2026-09-04T12:00:00Z".into(),
            analyzer_version: ANALYZER_VERSION.into(),
        }
    }

    /// A brand-new record must be findable by the web app's `release_id`
    /// index, or it can never be cleaned up when the release leaves the
    /// collection — it just accumulates in IndexedDB forever.
    #[test]
    fn a_brand_new_record_carries_the_identity_fields_the_web_app_indexes() {
        let backup = Backup::parse(
            &json!({
                "_app": "VinylCollectionPlayer", "_version": 2,
                "collection": {
                    "releases": [], "tracklist": [],
                    "videos": [{"id": "42_xyz", "release_id": 42, "title": "t", "uri": "u",
                                "youtube_id": "xyz", "duration": 200}]
                },
                "track_meta": []
            })
            .to_string(),
        )
        .unwrap();
        let id = "42_xyz".to_string();
        let r = result();
        let out = merged_records(&backup, [(&id, &r)].into_iter(), false);

        let rec = &out.records[0];
        assert_eq!(rec.release_id, Some(42), "release_id drives the app's orphan cleanup");
        assert_eq!(rec.extra.get("youtube_id"), Some(&json!("xyz")));
    }

    #[test]
    fn an_existing_records_own_identity_fields_are_left_alone() {
        let backup = backup_with_meta(json!([{"id": "1_abc", "release_id": 1, "youtube_id": "abc"}]));
        let id = "1_abc".to_string();
        let r = result();
        let out = merged_records(&backup, [(&id, &r)].into_iter(), false);
        assert_eq!(out.records[0].release_id, Some(1));
    }

    #[test]
    fn creates_records_for_videos_with_no_metadata_yet() {
        let backup = backup_with_meta(json!([]));
        let id = "1_abc".to_string();
        let r = result();
        let out = merged_records(&backup, [(&id, &r)].into_iter(), false);

        assert_eq!(out.records.len(), 1);
        assert_eq!(out.records[0].id, "1_abc");
        assert_eq!(out.records[0].bpm, Some(124.0));
        assert!(out.protected.is_empty());
    }

    #[test]
    fn keeps_existing_user_data_when_filling_in_an_analysis() {
        let backup = backup_with_meta(json!([{"id": "1_abc", "rating": 5, "notes": "killer"}]));
        let id = "1_abc".to_string();
        let r = result();
        let out = merged_records(&backup, [(&id, &r)].into_iter(), false);

        let rec = &out.records[0];
        assert_eq!(rec.bpm, Some(124.0));
        assert_eq!(rec.extra.get("rating"), Some(&json!(5)));
        assert_eq!(rec.extra.get("notes"), Some(&json!("killer")));
    }

    #[test]
    fn reports_records_it_refused_to_overwrite() {
        // Fully protected: every field this tool writes is already a human's.
        let backup =
            backup_with_meta(json!([{"id": "1_abc", "bpm": 100.0, "key": "5A", "energy": 9}]));
        let id = "1_abc".to_string();
        let r = result();

        let out = merged_records(&backup, [(&id, &r)].into_iter(), false);
        assert!(out.records.is_empty());
        assert_eq!(out.protected, vec!["1_abc"]);

        let out = merged_records(&backup, [(&id, &r)].into_iter(), true);
        assert_eq!(out.records.len(), 1);
        assert_eq!(out.records[0].bpm, Some(124.0));
        assert!(out.protected.is_empty());
    }
}
