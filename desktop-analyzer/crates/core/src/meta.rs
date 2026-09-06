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
    /// The raw 0-1 energy score, kept on the record so a later run can re-rank
    /// the collection without re-downloading it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub energy_score: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bpm_confidence: Option<f64>,
    /// How the tempo was decided when two methods were involved — see the
    /// analysis crate's `TempoMethod`. Absent for the ordinary single-method
    /// case, present and worth reading on syncopated material.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bpm_method: Option<String>,
    /// The independent estimate, when one was taken. A value far from `bpm` is
    /// the tool showing its working on a track it found genuinely ambiguous.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bpm_second_opinion: Option<f64>,
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
            energy_score: None,
            bpm_confidence: None,
            bpm_method: None,
            bpm_second_opinion: None,
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
    /// The continuous 0-1 score behind `energy`. Persisted through the ledger
    /// so a resumed run can still rank every track against every other one,
    /// including the ones analysed hours earlier.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub energy_score: Option<f64>,
    /// How the tempo was arrived at, when more than one method was involved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bpm_method: Option<String>,
    /// An independent tempo estimate, when one was taken.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bpm_second_opinion: Option<f64>,
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
        merged.bpm_method = result.bpm_method.clone();
        merged.bpm_second_opinion = result.bpm_second_opinion;
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
            merged.energy_score = result.energy_score;
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

/// Below this many analysed tracks, deciles say more about the sample than
/// about the music, so the absolute scale is left in place.
pub const MIN_TRACKS_FOR_RANKING: usize = 20;

/// Re-scale analysed energy from an absolute score to a rank within this
/// collection, and report how many records were changed.
///
/// The absolute scale does not work. Energy is 50% loudness, mapped from raw
/// dBFS, and every mastered record sits inside a couple of dB of every other
/// one — so the dominant term barely varies and real collections pile up on 5
/// and 6, using half the scale. Measured on 50 tracks from one collection:
/// 35 of them landed on 5 or 6, and 1, 2, 3, 9 and 10 were never used at all.
///
/// Ranking sidesteps the calibration problem instead of trying to solve it. A
/// DJ reaching for "an 8" wants one of the harder records *they own*, not a
/// reading against some absolute reference, so deciles of the collection are
/// both easier to compute and closer to what the number is used for.
///
/// Two consequences worth knowing:
///
/// - The scale is relative, so a track's energy can shift as the collection
///   grows. That is the intended behaviour, not drift.
/// - Equal scores get equal levels, so a bucket can hold more or fewer than a
///   tenth of the records.
///
/// Only records this tool owns are touched: anything a human typed keeps the
/// value they gave it.
pub fn rank_energy(records: &mut [TrackMeta]) -> EnergyRanking {
    let ours = || {
        records
            .iter()
            .enumerate()
            .filter(|(_, r)| r.energy_source.as_deref() == Some(SOURCE_ANALYSIS))
    };
    let mut scored: Vec<(usize, f64)> = ours()
        .filter_map(|(i, r)| r.energy_score.filter(|s| s.is_finite()).map(|s| (i, s)))
        .collect();
    // Ours, carries a value, but has no score to rank it by: an older record
    // from before the score was persisted, or a track this run could not score.
    // It keeps an absolute-scale number that no longer means the same thing as
    // its neighbours', and the only honest response is to say so.
    let unscored = ours()
        .filter(|(_, r)| r.energy.is_some())
        .filter(|(_, r)| !r.energy_score.is_some_and(|s| s.is_finite()))
        .count();

    if scored.len() < MIN_TRACKS_FOR_RANKING {
        return EnergyRanking { rescaled: 0, unscored };
    }
    scored.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));

    let n = scored.len();
    let mut changed = 0;
    let mut rank = 0;
    while rank < n {
        // Every record sharing this score is one tie group, and the whole group
        // takes the level of the group's first member. Without this, two
        // identical readings could straddle a bucket boundary and be reported
        // as different energies.
        let score = scored[rank].1;
        let mut end = rank + 1;
        while end < n && scored[end].1 == score {
            end += 1;
        }
        let level = (rank * 10 / n + 1).min(10) as u8;
        for (index, _) in &scored[rank..end] {
            let record = &mut records[*index];
            if record.energy != Some(level) {
                record.energy = Some(level);
                changed += 1;
            }
        }
        rank = end;
    }
    EnergyRanking { rescaled: changed, unscored }
}

/// What [`rank_energy`] did, and what it could not do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct EnergyRanking {
    /// Records whose energy was moved onto the collection's own scale.
    pub rescaled: usize,
    /// Records this tool owns that carry an energy it could not rank, and so
    /// are still on the absolute scale. A non-zero count means the exported
    /// energies are not all comparable with each other.
    pub unscored: usize,
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
            energy_score: Some(0.55),
            bpm_method: None,
            bpm_second_opinion: None,
            analyzed_at: "2026-09-04T12:00:00Z".into(),
            analyzer_version: "0.1.0".into(),
        }
    }

    fn from_json(v: Value) -> TrackMeta {
        serde_json::from_value(v).unwrap()
    }

    /// `n` analysed records whose scores climb steadily from 0 to just under 1.
    fn ranked_sample(n: usize) -> Vec<TrackMeta> {
        (0..n)
            .map(|i| {
                let mut m = TrackMeta::new(format!("1_{i}"));
                m.energy = Some(5);
                m.energy_source = Some(SOURCE_ANALYSIS.to_string());
                m.energy_score = Some(i as f64 / n as f64);
                m
            })
            .collect()
    }

    #[test]
    fn ranking_spreads_a_clustered_collection_over_the_whole_scale() {
        let mut records = ranked_sample(100);
        rank_energy(&mut records);
        let levels: std::collections::BTreeSet<u8> = records.iter().filter_map(|r| r.energy).collect();
        assert_eq!(levels, (1..=10).collect(), "every bucket should be used");
    }

    #[test]
    fn the_quietest_track_is_a_one_and_the_loudest_a_ten() {
        let mut records = ranked_sample(50);
        rank_energy(&mut records);
        assert_eq!(records.first().unwrap().energy, Some(1));
        assert_eq!(records.last().unwrap().energy, Some(10));
    }

    #[test]
    fn ranking_follows_the_score_order_not_the_record_order() {
        let mut records = ranked_sample(40);
        records.reverse(); // highest score first
        rank_energy(&mut records);
        assert_eq!(records.first().unwrap().energy, Some(10));
        assert_eq!(records.last().unwrap().energy, Some(1));
    }

    #[test]
    fn identical_scores_get_identical_levels() {
        // Otherwise two readings of exactly the same loudness could be reported
        // as different energies purely because of where the bucket edge fell.
        let mut records = ranked_sample(40);
        for r in records.iter_mut() {
            r.energy_score = Some(0.5);
        }
        rank_energy(&mut records);
        let levels: std::collections::BTreeSet<u8> = records.iter().filter_map(|r| r.energy).collect();
        assert_eq!(levels.len(), 1, "a flat collection has no spread to report");
    }

    #[test]
    fn a_small_sample_keeps_the_absolute_scale() {
        let mut records = ranked_sample(MIN_TRACKS_FOR_RANKING - 1);
        assert_eq!(rank_energy(&mut records).rescaled, 0);
        assert!(records.iter().all(|r| r.energy == Some(5)), "left untouched");
    }

    #[test]
    fn ranking_never_touches_energy_a_human_set() {
        let mut records = ranked_sample(40);
        records[0].energy = Some(9);
        records[0].energy_source = Some(SOURCE_MANUAL.to_string());
        rank_energy(&mut records);
        assert_eq!(records[0].energy, Some(9), "a typed value is not ours to rescale");
        assert_eq!(records[0].energy_source.as_deref(), Some(SOURCE_MANUAL));
    }

    #[test]
    fn records_without_a_score_are_left_alone() {
        // Older records analysed before the score was persisted, and tracks too
        // quiet to score at all.
        let mut records = ranked_sample(40);
        records[0].energy_score = None;
        records[0].energy = Some(4);
        rank_energy(&mut records);
        assert_eq!(records[0].energy, Some(4));
    }

    #[test]
    fn an_unrankable_energy_of_ours_is_reported_not_hidden() {
        // A record we own, carrying a number, with nothing to rank it by. It
        // stays on the absolute scale, so its 6 does not mean what its
        // neighbours' 6 means — and the count is how anyone finds that out.
        let mut records = ranked_sample(40);
        records[0].energy_score = None;
        let ranking = rank_energy(&mut records);
        assert_eq!(ranking.unscored, 1);
        assert!(ranking.rescaled > 0, "the rest still rank");
    }

    #[test]
    fn a_human_set_energy_is_not_counted_as_unrankable() {
        // It has no score and never will, but it is not ours and not on our
        // scale, so it is not a discrepancy to report.
        let mut records = ranked_sample(40);
        records[0].energy_score = None;
        records[0].energy_source = Some(SOURCE_MANUAL.to_string());
        assert_eq!(rank_energy(&mut records).unscored, 0);
    }

    #[test]
    fn ranking_is_idempotent() {
        let mut records = ranked_sample(60);
        rank_energy(&mut records);
        let after_first: Vec<_> = records.iter().map(|r| r.energy).collect();
        assert_eq!(rank_energy(&mut records).rescaled, 0, "second pass changes nothing");
        assert_eq!(records.iter().map(|r| r.energy).collect::<Vec<_>>(), after_first);
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
