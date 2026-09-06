//! Deciding, for every video in a backup, whether to analyse it, leave it
//! alone, or hand it to a human.
//!
//! Analysing the wrong audio is worse than analysing nothing: a confident BPM
//! for someone's fan remix silently poisons the harmonic suggestions in the web
//! app. So anything that smells wrong — a video far longer than a track has any
//! right to be, or a title that doesn't resemble the release's tracklist — is
//! flagged for review instead of being auto-analysed.

use crate::backup::{Backup, Video};
use crate::meta::{Protection, TrackMeta};

/// Videos longer than this are almost always DJ mixes, full-album rips or
/// live sets rather than a single track. From PROJECT_PLAN.md 3b.
pub const MAX_TRACK_SECONDS: f64 = 600.0;

/// How much of a tracklist title must appear in the video title for the two to
/// be considered the same track.
const TITLE_MATCH_THRESHOLD: f64 = 0.6;

#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    Analyze,
    Skip(SkipReason),
    Review(ReviewReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    /// A human's bpm/key is already there.
    ManualData,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ReviewReason {
    /// Longer than a single track plausibly is — likely a mix or full album.
    TooLong { seconds: f64 },
    /// The video title doesn't resemble any track on the release.
    TitleMismatch { video_title: String },
}

#[derive(Debug, Clone)]
pub struct PlannedItem {
    /// `releaseId_youtubeId` — the key shared by videos and track_meta.
    pub id: String,
    pub release_id: i64,
    pub youtube_id: String,
    pub video_title: String,
    pub decision: Decision,
    /// What the release's Discogs styles say about reading its tempo.
    pub tempo_hint: crate::tempo::TempoHint,
}

impl PlannedItem {
    pub fn youtube_url(&self) -> String {
        format!("https://www.youtube.com/watch?v={}", self.youtube_id)
    }
}

#[derive(Debug, Clone, Default)]
pub struct Plan {
    pub items: Vec<PlannedItem>,
}

impl Plan {
    /// Work out what to do with every video in the backup.
    ///
    /// `force` ignores the protection on human-entered values, per `--force`.
    pub fn build(backup: &Backup, force: bool) -> Plan {
        let meta = backup.meta_by_id();
        let hints: std::collections::HashMap<i64, crate::tempo::TempoHint> = backup
            .collection
            .releases
            .iter()
            .map(|r| (r.id, crate::tempo::hint_for_styles(r.styles.as_deref().unwrap_or(""))))
            .collect();
        let items = backup
            .collection
            .videos
            .iter()
            .map(|video| {
                let existing = meta.get(video.id.as_str()).copied();
                let decision = decide(backup, video, existing, force);
                PlannedItem {
                    id: video.id.clone(),
                    release_id: video.release_id,
                    youtube_id: video.youtube_id.clone(),
                    video_title: video.title.clone(),
                    decision,
                    tempo_hint: hints.get(&video.release_id).copied().unwrap_or_default(),
                }
            })
            .collect();
        Plan { items }
    }

    pub fn to_analyze(&self) -> impl Iterator<Item = &PlannedItem> {
        self.items.iter().filter(|i| i.decision == Decision::Analyze)
    }

    pub fn needing_review(&self) -> impl Iterator<Item = &PlannedItem> {
        self.items.iter().filter(|i| matches!(i.decision, Decision::Review(_)))
    }

    pub fn counts(&self) -> PlanCounts {
        let mut c = PlanCounts::default();
        for item in &self.items {
            match item.decision {
                Decision::Analyze => c.analyze += 1,
                Decision::Skip(_) => c.skip += 1,
                Decision::Review(_) => c.review += 1,
            }
        }
        c
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PlanCounts {
    pub analyze: usize,
    pub skip: usize,
    pub review: usize,
}

fn decide(backup: &Backup, video: &Video, existing: Option<&TrackMeta>, force: bool) -> Decision {
    // Protected data comes first: never spend a download on a record where
    // every field we could write is already a human's. A record with only
    // *some* fields taken still earns its download — the gaps get filled.
    if let Some(meta) = existing {
        if !Protection::of(meta).has_work() && !force {
            return Decision::Skip(SkipReason::ManualData);
        }
    }

    if let Some(seconds) = video.duration {
        if seconds > MAX_TRACK_SECONDS {
            return Decision::Review(ReviewReason::TooLong { seconds });
        }
    }

    // Only meaningful when the release's tracklist has actually been synced.
    let titles = backup.tracklist_titles(video.release_id);
    if !titles.is_empty() && !title_matches_any(&video.title, &titles) {
        return Decision::Review(ReviewReason::TitleMismatch {
            video_title: video.title.clone(),
        });
    }

    Decision::Analyze
}

/// True when the video title plausibly refers to one of the release's tracks.
///
/// Discogs video titles look like "New Order - Blue Monday (Official Video)",
/// so we ask how much of the *tracklist* title survives in the video title,
/// rather than expecting the two to be equal.
pub fn title_matches_any(video_title: &str, track_titles: &[&str]) -> bool {
    let video_tokens = tokenize(video_title);
    if video_tokens.is_empty() {
        return false;
    }
    track_titles.iter().any(|t| {
        let track_tokens = tokenize(t);
        if track_tokens.is_empty() {
            return false;
        }
        let hits = track_tokens.iter().filter(|tok| video_tokens.contains(*tok)).count();
        hits as f64 / track_tokens.len() as f64 >= TITLE_MATCH_THRESHOLD
    })
}

/// Lowercase alphanumeric words, with the noise Discogs and YouTube titles
/// carry ("official video", "hd", "remastered") thrown away.
fn tokenize(s: &str) -> Vec<String> {
    const NOISE: [&str; 14] = [
        "official", "video", "audio", "hd", "hq", "4k", "remastered", "remaster", "lyrics",
        "lyric", "full", "the", "a", "vinyl",
    ];
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .filter(|w| !NOISE.contains(w))
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn backup_with(videos: Value, tracklist: Value, track_meta: Value) -> Backup {
        Backup::parse(
            &json!({
                "_app": "VinylCollectionPlayer",
                "_version": 2,
                "collection": {"releases": [], "videos": videos, "tracklist": tracklist},
                "track_meta": track_meta
            })
            .to_string(),
        )
        .unwrap()
    }

    use serde_json::Value;

    fn video(id: &str, title: &str, duration: Option<f64>) -> Value {
        json!({
            "id": id,
            "release_id": 1,
            "title": title,
            "uri": "https://youtu.be/x",
            "youtube_id": id.split('_').nth(1).unwrap(),
            "duration": duration
        })
    }

    fn track(title: &str) -> Value {
        json!({"id": "1_0", "release_id": 1, "position": "A", "title": title, "duration": "3:00", "type": "track", "index": 0})
    }

    #[test]
    fn analyses_a_clean_matching_video() {
        let b = backup_with(
            json!([video("1_abc", "New Order - Blue Monday (Official Video)", Some(442.0))]),
            json!([track("Blue Monday")]),
            json!([]),
        );
        let plan = Plan::build(&b, false);
        assert_eq!(plan.items[0].decision, Decision::Analyze);
        assert_eq!(plan.counts(), PlanCounts { analyze: 1, skip: 0, review: 0 });
    }

    #[test]
    fn skips_records_a_human_already_filled_in() {
        let b = backup_with(
            json!([video("1_abc", "New Order - Blue Monday", Some(442.0))]),
            json!([track("Blue Monday")]),
            json!([{"id": "1_abc", "bpm": 130.0, "key": "5A", "energy": 8}]),
        );
        let plan = Plan::build(&b, false);
        assert_eq!(plan.items[0].decision, Decision::Skip(SkipReason::ManualData));

        // --force overrides exactly this case.
        let plan = Plan::build(&b, true);
        assert_eq!(plan.items[0].decision, Decision::Analyze);
    }

    #[test]
    fn a_partially_filled_record_is_still_worth_analysing() {
        // The user typed a bpm but no key or energy — there is work to do.
        let b = backup_with(
            json!([video("1_abc", "New Order - Blue Monday", Some(442.0))]),
            json!([track("Blue Monday")]),
            json!([{"id": "1_abc", "bpm": 130.0}]),
        );
        assert_eq!(Plan::build(&b, false).items[0].decision, Decision::Analyze);
    }

    #[test]
    fn re_analyses_its_own_earlier_results() {
        let b = backup_with(
            json!([video("1_abc", "New Order - Blue Monday", Some(442.0))]),
            json!([track("Blue Monday")]),
            json!([{"id": "1_abc", "bpm": 130.0, "key": "8A",
                    "bpm_source": "analysis", "key_source": "analysis"}]),
        );
        assert_eq!(Plan::build(&b, false).items[0].decision, Decision::Analyze);
    }

    #[test]
    fn flags_long_videos_for_review_instead_of_analysing_them() {
        let b = backup_with(
            json!([video("1_abc", "New Order - Blue Monday", Some(3600.0))]),
            json!([track("Blue Monday")]),
            json!([]),
        );
        let plan = Plan::build(&b, false);
        assert_eq!(
            plan.items[0].decision,
            Decision::Review(ReviewReason::TooLong { seconds: 3600.0 })
        );
        assert_eq!(plan.needing_review().count(), 1);
    }

    #[test]
    fn flags_videos_whose_title_matches_nothing_on_the_release() {
        let b = backup_with(
            json!([video("1_abc", "Some Guy's Bootleg Megamix Vol 3", Some(300.0))]),
            json!([track("Blue Monday")]),
            json!([]),
        );
        let plan = Plan::build(&b, false);
        assert!(matches!(
            plan.items[0].decision,
            Decision::Review(ReviewReason::TitleMismatch { .. })
        ));
    }

    #[test]
    fn protected_data_wins_over_a_review_flag() {
        // No point flagging a human's own record for review — leave it be.
        let b = backup_with(
            json!([video("1_abc", "Unrelated Mix", Some(9999.0))]),
            json!([track("Blue Monday")]),
            json!([{"id": "1_abc", "bpm": 130.0, "key": "5A", "energy": 8}]),
        );
        assert_eq!(
            Plan::build(&b, false).items[0].decision,
            Decision::Skip(SkipReason::ManualData)
        );
    }

    #[test]
    fn an_unsynced_tracklist_does_not_block_analysis() {
        let b = backup_with(
            json!([video("1_abc", "Anything At All", Some(200.0))]),
            json!([]),
            json!([]),
        );
        assert_eq!(Plan::build(&b, false).items[0].decision, Decision::Analyze);
    }

    #[test]
    fn missing_duration_is_not_treated_as_too_long() {
        let b = backup_with(
            json!([video("1_abc", "Blue Monday", None)]),
            json!([track("Blue Monday")]),
            json!([]),
        );
        assert_eq!(Plan::build(&b, false).items[0].decision, Decision::Analyze);
    }

    #[test]
    fn title_matching_tolerates_the_noise_youtube_titles_carry() {
        assert!(title_matches_any(
            "New Order - Blue Monday [Official Video] HD Remastered",
            &["Blue Monday"]
        ));
        assert!(title_matches_any("BLUE MONDAY", &["Blue Monday"]));
        assert!(title_matches_any("Aphex Twin - Xtal", &["Xtal", "Tha"]));
        assert!(!title_matches_any("Totally Different Song", &["Blue Monday"]));
        // A partial match under the threshold is still a mismatch.
        assert!(!title_matches_any("Monday", &["Blue Monday Morning Session"]));
    }

    #[test]
    fn urls_are_built_from_the_youtube_id() {
        let b = backup_with(
            json!([video("1_abc", "Blue Monday", None)]),
            json!([]),
            json!([]),
        );
        assert_eq!(
            Plan::build(&b, false).items[0].youtube_url(),
            "https://www.youtube.com/watch?v=abc"
        );
    }
}
