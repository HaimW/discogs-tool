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
pub mod plan;

use meta::{merge, AnalysisResult, TrackMeta};

/// Version stamped into every record this tool writes, so a later run can tell
/// which algorithm produced a value.
pub const ANALYZER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Build the finished `track_meta` records from analysis results, merged over
/// whatever the backup already held.
///
/// Records are emitted **complete** — the web app's Restore replaces whole
/// records, so a partial one would erase the user's ratings, tags and notes.
pub fn merged_records<'a>(
    backup: &backup::Backup,
    results: impl Iterator<Item = (&'a String, &'a AnalysisResult)>,
    force: bool,
) -> MergeOutcome {
    let existing = backup.meta_by_id();
    let mut outcome = MergeOutcome::default();
    for (id, result) in results {
        let base = existing
            .get(id.as_str())
            .map(|m| (*m).clone())
            .unwrap_or_else(|| TrackMeta::new(id.clone()));
        match merge(&base, result, force) {
            Some(record) => outcome.records.push(record),
            None => outcome.protected.push(id.clone()),
        }
    }
    outcome
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
            analyzed_at: "2026-09-04T12:00:00Z".into(),
            analyzer_version: ANALYZER_VERSION.into(),
        }
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
