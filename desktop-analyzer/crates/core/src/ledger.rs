//! The resume ledger.
//!
//! Downloading and decoding audio is the expensive part of this tool — minutes
//! of network and CPU per track, across a collection that can run to thousands.
//! A run must therefore survive being interrupted at any point and pick up
//! exactly where it left off, which means every outcome is written to disk as
//! it happens, not at the end.
//!
//! The ledger also holds each result, so the final output file can be rebuilt
//! from the ledger alone without re-analysing anything.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::meta::AnalysisResult;
use crate::plan::{Decision, Plan};

pub const LEDGER_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryState {
    Done,
    Failed,
    Skipped,
    NeedsReview,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LedgerEntry {
    pub state: EntryState,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<AnalysisResult>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ledger {
    pub version: u32,
    /// Identifies the analysis settings a run was made under. When it changes,
    /// previous results are no longer comparable and are discarded.
    pub settings_hash: String,
    pub started_at: String,
    #[serde(default)]
    pub entries: BTreeMap<String, LedgerEntry>,
}

impl Ledger {
    pub fn new(settings_hash: impl Into<String>, started_at: impl Into<String>) -> Self {
        Ledger {
            version: LEDGER_VERSION,
            settings_hash: settings_hash.into(),
            started_at: started_at.into(),
            entries: BTreeMap::new(),
        }
    }

    pub fn parse(json: &str) -> Result<Ledger, serde_json::Error> {
        serde_json::from_str(json)
    }

    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }

    /// Load a ledger, falling back to a fresh one when it is missing, corrupt,
    /// from an older format, or was written under different settings. Resuming
    /// is an optimisation — never let it be the reason a run cannot start.
    pub fn resume_or_new(
        existing: Option<&str>,
        settings_hash: &str,
        started_at: &str,
    ) -> (Ledger, ResumeOutcome) {
        let Some(raw) = existing else {
            return (Ledger::new(settings_hash, started_at), ResumeOutcome::FreshStart);
        };
        match Ledger::parse(raw) {
            Ok(ledger) if ledger.version != LEDGER_VERSION => (
                Ledger::new(settings_hash, started_at),
                ResumeOutcome::DiscardedOldVersion { found: ledger.version },
            ),
            Ok(ledger) if ledger.settings_hash != settings_hash => (
                Ledger::new(settings_hash, started_at),
                ResumeOutcome::DiscardedSettingsChanged,
            ),
            Ok(ledger) => {
                let done = ledger.completed_count();
                (ledger, ResumeOutcome::Resumed { completed: done })
            }
            Err(_) => (
                Ledger::new(settings_hash, started_at),
                ResumeOutcome::DiscardedUnreadable,
            ),
        }
    }

    pub fn record_success(&mut self, id: &str, result: AnalysisResult, at: &str) {
        let attempts = self.attempts(id) + 1;
        self.entries.insert(
            id.to_string(),
            LedgerEntry {
                state: EntryState::Done,
                attempts,
                error: None,
                note: None,
                result: Some(result),
                updated_at: at.to_string(),
            },
        );
    }

    pub fn record_failure(&mut self, id: &str, error: impl Into<String>, at: &str) {
        let attempts = self.attempts(id) + 1;
        self.entries.insert(
            id.to_string(),
            LedgerEntry {
                state: EntryState::Failed,
                attempts,
                error: Some(error.into()),
                note: None,
                result: None,
                updated_at: at.to_string(),
            },
        );
    }

    pub fn record_non_work(&mut self, id: &str, state: EntryState, note: impl Into<String>, at: &str) {
        self.entries.insert(
            id.to_string(),
            LedgerEntry {
                state,
                attempts: self.attempts(id),
                error: None,
                note: Some(note.into()),
                result: None,
                updated_at: at.to_string(),
            },
        );
    }

    pub fn attempts(&self, id: &str) -> u32 {
        self.entries.get(id).map_or(0, |e| e.attempts)
    }

    pub fn state(&self, id: &str) -> Option<EntryState> {
        self.entries.get(id).map(|e| e.state)
    }

    pub fn completed_count(&self) -> usize {
        self.entries.values().filter(|e| e.state == EntryState::Done).count()
    }

    /// Results gathered so far, ready to be merged into track_meta records.
    pub fn results(&self) -> impl Iterator<Item = (&String, &AnalysisResult)> {
        self.entries
            .iter()
            .filter_map(|(id, e)| e.result.as_ref().map(|r| (id, r)))
    }

    /// The work still outstanding for this plan: everything marked `Analyze`
    /// that isn't already done, and failures still inside their retry budget.
    ///
    /// Order is preserved so an interrupted run resumes in the same sequence.
    pub fn outstanding<'a>(&'a self, plan: &'a Plan, max_attempts: u32) -> Vec<&'a crate::plan::PlannedItem> {
        plan.items
            .iter()
            .filter(|item| item.decision == Decision::Analyze)
            .filter(|item| match self.entries.get(&item.id) {
                None => true,
                Some(e) => match e.state {
                    EntryState::Done => false,
                    EntryState::Failed => e.attempts < max_attempts,
                    // A plan saying "analyse" overrides a stale skip/review.
                    EntryState::Skipped | EntryState::NeedsReview => true,
                },
            })
            .collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeOutcome {
    FreshStart,
    Resumed { completed: usize },
    DiscardedUnreadable,
    DiscardedSettingsChanged,
    DiscardedOldVersion { found: u32 },
}

/// A stable fingerprint of the settings a run used. Deliberately dependency
/// free — FNV-1a is more than enough to notice "these are different settings".
pub fn settings_hash(parts: &[&str]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for part in parts {
        for byte in part.as_bytes() {
            hash ^= *byte as u64;
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        hash ^= 0xff;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::Backup;
    use serde_json::json;

    fn result(bpm: f64) -> AnalysisResult {
        AnalysisResult {
            bpm,
            bpm_confidence: 0.9,
            key: "8A".into(),
            key_musical: "A minor".into(),
            key_strength: 0.7,
            energy: Some(6),
            analyzed_at: "2026-09-04T12:00:00Z".into(),
            analyzer_version: "0.1.0".into(),
        }
    }

    fn plan_of(ids: &[&str]) -> Plan {
        let videos: Vec<_> = ids
            .iter()
            .map(|id| {
                json!({
                    "id": id, "release_id": 1, "title": "Blue Monday",
                    "uri": "u", "youtube_id": id.split('_').nth(1).unwrap(), "duration": 200
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

    #[test]
    fn outstanding_work_shrinks_as_results_land() {
        let plan = plan_of(&["1_a", "1_b", "1_c"]);
        let mut ledger = Ledger::new("h", "now");
        assert_eq!(ledger.outstanding(&plan, 3).len(), 3);

        ledger.record_success("1_a", result(120.0), "now");
        let left: Vec<_> = ledger.outstanding(&plan, 3).iter().map(|i| i.id.clone()).collect();
        assert_eq!(left, vec!["1_b", "1_c"]);
    }

    #[test]
    fn failures_are_retried_up_to_the_budget_then_dropped() {
        let plan = plan_of(&["1_a"]);
        let mut ledger = Ledger::new("h", "now");

        ledger.record_failure("1_a", "network died", "now");
        assert_eq!(ledger.attempts("1_a"), 1);
        assert_eq!(ledger.outstanding(&plan, 3).len(), 1);

        ledger.record_failure("1_a", "network died", "now");
        ledger.record_failure("1_a", "network died", "now");
        assert_eq!(ledger.attempts("1_a"), 3);
        assert!(ledger.outstanding(&plan, 3).is_empty(), "retry budget should be spent");
    }

    #[test]
    fn a_retry_that_succeeds_clears_the_error() {
        let mut ledger = Ledger::new("h", "now");
        ledger.record_failure("1_a", "timeout", "now");
        ledger.record_success("1_a", result(128.0), "later");

        let entry = &ledger.entries["1_a"];
        assert_eq!(entry.state, EntryState::Done);
        assert_eq!(entry.attempts, 2);
        assert!(entry.error.is_none());
        assert_eq!(entry.result.as_ref().unwrap().bpm, 128.0);
    }

    #[test]
    fn survives_a_round_trip_through_disk() {
        let mut ledger = Ledger::new("h", "now");
        ledger.record_success("1_a", result(120.0), "now");
        ledger.record_failure("1_b", "boom", "now");
        ledger.record_non_work("1_c", EntryState::NeedsReview, "video is 62 minutes", "now");

        let reloaded = Ledger::parse(&ledger.to_json().unwrap()).unwrap();
        assert_eq!(reloaded.entries, ledger.entries);
        assert_eq!(reloaded.completed_count(), 1);
        assert_eq!(reloaded.results().count(), 1);
    }

    #[test]
    fn resumes_a_matching_ledger() {
        let mut ledger = Ledger::new("settings-1", "now");
        ledger.record_success("1_a", result(120.0), "now");
        let raw = ledger.to_json().unwrap();

        let (resumed, outcome) = Ledger::resume_or_new(Some(&raw), "settings-1", "now");
        assert_eq!(outcome, ResumeOutcome::Resumed { completed: 1 });
        assert_eq!(resumed.completed_count(), 1);
    }

    #[test]
    fn starts_over_when_settings_changed_or_the_file_is_junk() {
        let ledger = {
            let mut l = Ledger::new("settings-1", "now");
            l.record_success("1_a", result(120.0), "now");
            l.to_json().unwrap()
        };

        let (fresh, outcome) = Ledger::resume_or_new(Some(&ledger), "settings-2", "now");
        assert_eq!(outcome, ResumeOutcome::DiscardedSettingsChanged);
        assert!(fresh.entries.is_empty());

        let (fresh, outcome) = Ledger::resume_or_new(Some("{ corrupt"), "settings-1", "now");
        assert_eq!(outcome, ResumeOutcome::DiscardedUnreadable);
        assert!(fresh.entries.is_empty());

        let (_, outcome) = Ledger::resume_or_new(None, "settings-1", "now");
        assert_eq!(outcome, ResumeOutcome::FreshStart);
    }

    #[test]
    fn an_interrupted_run_never_repeats_finished_work() {
        let plan = plan_of(&["1_a", "1_b", "1_c"]);
        let mut ledger = Ledger::new("h", "now");

        // Two land, then the process dies mid-third.
        ledger.record_success("1_a", result(120.0), "now");
        ledger.record_success("1_b", result(126.0), "now");
        let persisted = ledger.to_json().unwrap();

        let (resumed, _) = Ledger::resume_or_new(Some(&persisted), "h", "now");
        let left: Vec<_> = resumed.outstanding(&plan, 3).iter().map(|i| i.id.clone()).collect();
        assert_eq!(left, vec!["1_c"], "only the unfinished item should remain");
        assert_eq!(resumed.results().count(), 2, "earlier results are still usable");
    }

    #[test]
    fn settings_hash_is_stable_and_discriminating() {
        assert_eq!(settings_hash(&["a", "b"]), settings_hash(&["a", "b"]));
        assert_ne!(settings_hash(&["a", "b"]), settings_hash(&["a", "c"]));
        // Field boundaries matter: ["ab"] and ["a","b"] must differ.
        assert_ne!(settings_hash(&["ab"]), settings_hash(&["a", "b"]));
    }
}
