//! The `track_meta` record, and the rules for merging analysis results into it
//! without destroying anything a human put there.
//!
//! Two facts about the web app drive every decision in this module:
//!
//! 1. Restore writes with `os.put(rec)` (`src/backup.js`), which **replaces the
//!    whole record**. Emitting `{id, bpm, key}` would therefore wipe the user's
//!    rating, energy, shelf, tags and notes. So we always emit the complete
//!    record, merged over the original — including fields this tool has never
//!    heard of, which is why `extra` exists.
//! 2. `verified` means "YouTube link verified" (`src/meta_editor.js`), not
//!    "BPM verified". This tool never writes it. The separate `bpm_verified`
//!    flag is the human-blessed-the-analysis signal.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Where a bpm/key value came from. Absent on records written before this tool
/// existed, which is why [`Provenance::of`] treats "value present, no source"
/// as manual — those were typed in by hand.
pub const SOURCE_MANUAL: &str = "manual";
pub const SOURCE_ANALYSIS: &str = "analysis";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TrackMeta {
    pub id: String,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_id: Option<i64>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bpm: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// The 1-10 figure the web app's editor exposes. Modelled here (rather than
    /// left in `extra`) because the analyzer now writes it and therefore needs
    /// to know whether a human set it first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub energy: Option<u8>,

    // --- provenance, owned by this tool ---
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bpm_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub energy_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bpm_confidence: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_strength: Option<f64>,
    /// The un-converted key, e.g. "A minor". `key` always holds Camelot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_musical: Option<String>,
    /// A human confirmed the analysed bpm/key. Distinct from `verified`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bpm_verified: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub analyzed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub analyzer_version: Option<String>,

    /// Everything else the web app stores — rating, energy, shelf, tags, notes,
    /// `verified`, `updated_at`, and anything added later. Round-tripped
    /// untouched so a merge can never drop a field this tool doesn't model.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl TrackMeta {
    pub fn new(id: impl Into<String>) -> Self {
        TrackMeta {
            id: id.into(),
            release_id: None,
            bpm: None,
            key: None,
            energy: None,
            bpm_source: None,
            key_source: None,
            energy_source: None,
            bpm_confidence: None,
            key_strength: None,
            key_musical: None,
            bpm_verified: None,
            analyzed_at: None,
            analyzer_version: None,
            extra: Map::new(),
        }
    }

    /// True when the user ticked "YouTube link verified" in the web app. Read
    /// only — this tool never writes it.
    pub fn link_verified(&self) -> bool {
        self.extra.get("verified").and_then(Value::as_bool).unwrap_or(false)
    }
}

/// What we may do with the bpm/key already on a record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provenance {
    /// Nothing there yet — fill it in.
    Empty,
    /// This tool wrote it. A later run may improve on it.
    Analysis,
    /// A human typed it, or blessed it. Never overwrite without `--force`.
    Manual,
}

impl Provenance {
    /// Classify one field from its recorded source and whether it holds a value.
    ///
    /// A value with no recorded source predates this tool, so it can only have
    /// been typed in by hand — treated as manual.
    fn of_field(source: Option<&str>, present: bool) -> Provenance {
        match source {
            _ if !present => Provenance::Empty,
            Some(SOURCE_ANALYSIS) => Provenance::Analysis,
            Some(_) => Provenance::Manual,
            None => Provenance::Manual,
        }
    }

    /// Classify a whole record: manual if *any* field is a human's, so callers
    /// that just want "is there anything of the user's here" get a straight
    /// answer. Deciding what may be *written* is [`Protection::of`]'s job — it
    /// works field by field, because a hand-set energy should not stop us
    /// detecting a missing BPM.
    pub fn of(meta: &TrackMeta) -> Provenance {
        let p = Protection::of(meta);
        if p.bpm == Provenance::Manual || p.key == Provenance::Manual || p.energy == Provenance::Manual {
            Provenance::Manual
        } else if p.bpm == Provenance::Analysis
            || p.key == Provenance::Analysis
            || p.energy == Provenance::Analysis
        {
            Provenance::Analysis
        } else {
            Provenance::Empty
        }
    }

    pub fn is_protected(self) -> bool {
        matches!(self, Provenance::Manual)
    }
}

/// Per-field provenance, which is what actually decides each write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Protection {
    pub bpm: Provenance,
    pub key: Provenance,
    pub energy: Provenance,
}

impl Protection {
    pub fn of(meta: &TrackMeta) -> Protection {
        // "BPM/key verified" is a human blessing over both halves of the
        // analysis, but says nothing about energy, which has its own source.
        let blessed = meta.bpm_verified == Some(true);
        let field = |source: Option<&str>, present: bool| {
            if blessed && present {
                Provenance::Manual
            } else {
                Provenance::of_field(source, present)
            }
        };
        Protection {
            bpm: field(meta.bpm_source.as_deref(), meta.bpm.is_some()),
            key: field(meta.key_source.as_deref(), meta.key.is_some()),
            energy: Provenance::of_field(meta.energy_source.as_deref(), meta.energy.is_some()),
        }
    }

    /// True when there is nothing left for an analysis run to write, so the
    /// download can be skipped entirely.
    pub fn is_fully_protected(self) -> bool {
        self.bpm.is_protected() && self.key.is_protected() && self.energy.is_protected()
    }

    /// True when at least one field could still be written.
    pub fn has_work(self) -> bool {
        !self.is_fully_protected()
    }
}

/// A finished analysis for one video. Serialisable because the resume ledger
/// stores it, so an interrupted run can rebuild its output without re-analysing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnalysisResult {
    pub bpm: f64,
    pub bpm_confidence: f64,
    /// Camelot code, e.g. "8A".
    pub key: String,
    /// The musical form, e.g. "A minor".
    pub key_musical: String,
    pub key_strength: f64,
    /// Estimated 1-10 energy, when the audio supported an estimate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub energy: Option<u8>,
    pub analyzed_at: String,
    pub analyzer_version: String,
}

/// Merge an analysis result over the existing record, producing the **complete**
/// record to hand to the web app's Restore flow.
///
/// Returns `None` when the record is protected and `force` is false, so callers
/// can report a skip rather than silently doing nothing.
pub fn merge(existing: &TrackMeta, result: &AnalysisResult, force: bool) -> Option<TrackMeta> {
    let protection = Protection::of(existing);
    if protection.is_fully_protected() && !force {
        return None;
    }
    let mut merged = existing.clone();

    // Each field is decided on its own: never overwrite what a human set, but
    // always fill a gap. Someone who typed a BPM and never got round to the key
    // ends up with both, and keeps the BPM they trust.
    if force || !protection.bpm.is_protected() {
        merged.bpm = Some(result.bpm);
        merged.bpm_confidence = Some(result.bpm_confidence);
        merged.bpm_source = Some(SOURCE_ANALYSIS.to_string());
    }
    if force || !protection.key.is_protected() {
        merged.key = Some(result.key.clone());
        merged.key_musical = Some(result.key_musical.clone());
        merged.key_strength = Some(result.key_strength);
        merged.key_source = Some(SOURCE_ANALYSIS.to_string());
    }
    // Energy is only claimed when the audio actually supported an estimate, so
    // a quiet or very short file leaves any existing value alone.
    if let Some(energy) = result.energy {
        if force || !protection.energy.is_protected() {
            merged.energy = Some(energy);
            merged.energy_source = Some(SOURCE_ANALYSIS.to_string());
        }
    }
    merged.analyzed_at = Some(result.analyzed_at.clone());
    merged.analyzer_version = Some(result.analyzer_version.clone());
    // `verified`, rating, energy, shelf, tags, notes and friends ride along in
    // `extra` untouched. `bpm_verified` is deliberately left as-is: forcing over
    // a human-blessed record keeps the blessing visible rather than erasing it.
    merged
        .extra
        .insert("updated_at".to_string(), Value::String(result.analyzed_at.clone()));
    Some(merged)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn result() -> AnalysisResult {
        AnalysisResult {
            bpm: 124.5,
            bpm_confidence: 0.9,
            key: "8A".into(),
            key_musical: "A minor".into(),
            key_strength: 0.7,
            energy: Some(6),
            analyzed_at: "2026-09-04T12:00:00Z".into(),
            analyzer_version: "0.1.0".into(),
        }
    }

    fn from_json(v: Value) -> TrackMeta {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn empty_records_are_analysable() {
        let m = from_json(json!({"id": "1_abc"}));
        assert_eq!(Provenance::of(&m), Provenance::Empty);
        assert!(!Provenance::of(&m).is_protected());
    }

    #[test]
    fn legacy_hand_typed_values_are_protected() {
        // Written before this tool existed: a value, but no source recorded.
        let m = from_json(json!({"id": "1_abc", "bpm": 128.0}));
        assert_eq!(Provenance::of(&m), Provenance::Manual);

        let m = from_json(json!({"id": "1_abc", "key": "5A"}));
        assert_eq!(Provenance::of(&m), Provenance::Manual);
    }

    #[test]
    fn our_own_results_may_be_refreshed() {
        let m = from_json(json!({
            "id": "1_abc", "bpm": 120.0, "key": "8A",
            "bpm_source": "analysis", "key_source": "analysis"
        }));
        assert_eq!(Provenance::of(&m), Provenance::Analysis);
        assert!(!Provenance::of(&m).is_protected());
    }

    #[test]
    fn a_human_blessing_protects_even_analysis_values() {
        let m = from_json(json!({
            "id": "1_abc", "bpm": 120.0, "key": "8A",
            "bpm_source": "analysis", "key_source": "analysis",
            "bpm_verified": true
        }));
        assert_eq!(Provenance::of(&m), Provenance::Manual);

        // The blessed bpm/key survive, but an empty energy is still filled in.
        let merged = merge(&m, &result(), false).expect("energy is still writable");
        assert_eq!(merged.bpm, Some(120.0), "blessed bpm untouched");
        assert_eq!(merged.key.as_deref(), Some("8A"), "blessed key untouched");
        assert_eq!(merged.energy, Some(6), "the empty energy was filled");

        // --force overrides the blessing.
        let forced = merge(&m, &result(), true).expect("force writes everything");
        assert_eq!(forced.bpm, Some(124.5));
    }

    #[test]
    fn a_manual_field_is_kept_while_the_rest_is_refreshed() {
        // User typed the key by hand; we had detected the bpm earlier.
        let m = from_json(json!({
            "id": "1_abc", "bpm": 120.0, "key": "8A",
            "bpm_source": "analysis", "key_source": "manual"
        }));
        assert_eq!(Provenance::of(&m), Provenance::Manual);

        let merged = merge(&m, &result(), false).expect("the bpm half is refreshable");
        assert_eq!(merged.key.as_deref(), Some("8A"), "the hand-typed key stays");
        assert_eq!(merged.key_source.as_deref(), Some("manual"));
        assert_eq!(merged.bpm, Some(124.5), "our own earlier bpm is refreshed");
    }

    #[test]
    fn a_gap_beside_a_manual_value_still_gets_filled() {
        // Typed a bpm, never got round to the key.
        let m = from_json(json!({"id": "1_abc", "bpm": 128.0}));
        let merged = merge(&m, &result(), false).expect("the key is writable");
        assert_eq!(merged.bpm, Some(128.0), "the user's bpm is untouched");
        assert_eq!(merged.bpm_source, None, "and stays theirs");
        assert_eq!(merged.key.as_deref(), Some("8A"), "the missing key was detected");
        assert_eq!(merged.key_source.as_deref(), Some("analysis"));
    }

    #[test]
    fn link_verified_does_not_protect_the_analysis() {
        // `verified` is about the YouTube link, not the bpm. An empty record
        // with a verified link is exactly what we most want to analyse.
        let m = from_json(json!({"id": "1_abc", "verified": true}));
        assert!(m.link_verified());
        assert_eq!(Provenance::of(&m), Provenance::Empty);
        assert!(merge(&m, &result(), false).is_some());
    }

    #[test]
    fn merging_preserves_every_user_field() {
        let m = from_json(json!({
            "id": "1_abc",
            "release_id": 1,
            "rating": 4,
            "energy": 7,
            "shelf": "A3",
            "tags": ["peak", "closer"],
            "notes": "big one",
            "verified": true,
            "updated_at": "2026-01-01T00:00:00Z"
        }));
        let merged = merge(&m, &result(), false).unwrap();

        assert_eq!(merged.bpm, Some(124.5));
        assert_eq!(merged.key.as_deref(), Some("8A"));
        assert_eq!(merged.key_musical.as_deref(), Some("A minor"));
        assert_eq!(merged.bpm_source.as_deref(), Some("analysis"));
        assert_eq!(merged.release_id, Some(1));

        // Nothing the user owns was touched, including the link-verified flag.
        assert_eq!(merged.extra.get("rating"), Some(&json!(4)));
        assert_eq!(merged.energy, Some(7), "a hand-set energy is never overwritten");
        assert_eq!(merged.energy_source, None, "and stays marked as the user's");
        assert_eq!(merged.extra.get("shelf"), Some(&json!("A3")));
        assert_eq!(merged.extra.get("tags"), Some(&json!(["peak", "closer"])));
        assert_eq!(merged.extra.get("notes"), Some(&json!("big one")));
        assert_eq!(merged.extra.get("verified"), Some(&json!(true)));
        // ...except updated_at, which should reflect this write.
        assert_eq!(merged.extra.get("updated_at"), Some(&json!("2026-09-04T12:00:00Z")));
    }

    #[test]
    fn a_hand_set_energy_does_not_block_tempo_and_key_detection() {
        let m = from_json(json!({"id": "1_abc", "energy": 9}));
        let merged = merge(&m, &result(), false).expect("bpm/key are still writable");
        assert_eq!(merged.bpm, Some(124.5), "bpm was detected");
        assert_eq!(merged.key.as_deref(), Some("8A"), "key was detected");
        assert_eq!(merged.energy, Some(9), "the user's energy is untouched");
    }

    #[test]
    fn a_hand_set_tempo_does_not_block_energy_estimation() {
        let m = from_json(json!({"id": "1_abc", "bpm": 128.0}));
        let merged = merge(&m, &result(), false).expect("energy is still writable");
        assert_eq!(merged.bpm, Some(128.0), "the user's bpm is untouched");
        assert_eq!(merged.energy, Some(6), "energy was estimated");
        assert_eq!(merged.energy_source.as_deref(), Some("analysis"));
    }

    #[test]
    fn every_analysable_field_being_manual_means_nothing_to_do() {
        let m = from_json(json!({
            "id": "1_abc", "bpm": 128.0, "key": "5A", "energy": 9
        }));
        assert!(!Protection::of(&m).has_work());
        assert!(merge(&m, &result(), false).is_none());
    }

    #[test]
    fn a_record_with_nothing_left_to_write_is_skipped_entirely() {
        let m = from_json(json!({
            "id": "1_abc", "bpm": 128.0, "key": "5A", "energy": 9
        }));
        assert!(Protection::of(&m).is_fully_protected());
        assert!(merge(&m, &result(), false).is_none());
        assert!(merge(&m, &result(), true).is_some(), "--force still overrides");
    }

    #[test]
    fn unknown_future_fields_survive_a_round_trip() {
        let m = from_json(json!({"id": "1_abc", "some_field_added_in_2027": {"nested": [1, 2]}}));
        let merged = merge(&m, &result(), false).unwrap();
        let out = serde_json::to_value(&merged).unwrap();
        assert_eq!(out["some_field_added_in_2027"], json!({"nested": [1, 2]}));
    }

    #[test]
    fn serialised_records_omit_fields_we_never_set() {
        let m = TrackMeta::new("1_abc");
        let out = serde_json::to_value(&m).unwrap();
        assert_eq!(out, json!({"id": "1_abc"}));
    }
}
