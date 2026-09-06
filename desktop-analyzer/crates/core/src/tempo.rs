//! What a release's Discogs entry says about how far to trust its tempo.
//!
//! This module used to choose an octave window per release, from tables of
//! "fast" and "slow" styles. That machinery was measured over 191 tracks of a
//! real collection and fired on **one** of them, so it has been removed: it was
//! a large, opinionated apparatus doing almost nothing, and on its single
//! firing it made the answer worse.
//!
//! What survives is the smaller and better-supported idea. Discogs' genres do
//! not tell us what a record's tempo *is* — but they do tell us whether the
//! usual assumptions apply. A house record has a four-to-the-floor pulse that
//! two detectors can be expected to agree on; a folk ballad does not, and where
//! they disagree on one, the honest answer is to flag it rather than to pick.
//!
//! So genres feed the *flagging* decision only. They never change a number.

/// Discogs genres whose material a beat tracker can be expected to handle:
/// a steady pulse, usually four to the bar.
const DANCE_GENRES: &[&str] = &["electronic"];

/// Genres that say the opposite, and veto [`DANCE_GENRES`] when both appear.
/// A release tagged "Electronic, Rock" with no dance style among its styles is
/// a rock record with synthesisers on it.
///
/// Note the fragments: Discogs writes "Folk, World, & Country" as a single
/// genre and the backup stores genres comma-separated, so it arrives here
/// already split into three pieces. Matching the pieces is inelegant and is
/// what the data actually looks like.
const NON_DANCE_GENRES: &[&str] = &[
    "rock", "pop", "folk", "world", "& country", "country", "jazz",
    "funk / soul", "funk", "soul", "blues", "classical", "stage & screen",
    "latin", "reggae", "hip hop", "children's", "brass & military", "non-music",
];

/// Styles that mark a release as dance music even when its genre does not.
/// Deliberately short — this is a hint, not a taxonomy.
const DANCE_STYLES: &[&str] = &[
    "house", "deep house", "tech house", "acid house", "progressive house",
    "tribal house", "italo house", "hip-house", "microhouse", "ambient house",
    "garage house", "techno", "dub techno", "deep techno", "minimal techno",
    "minimal", "electro", "acid", "breakbeat", "breaks", "big beat", "disco",
    "nu-disco", "trance", "hard trance", "psy-trance", "progressive trance",
    "drum n bass", "drum and bass", "jungle", "uk garage", "dubstep",
    "footwork", "juke", "hardcore", "eurodance",
];

/// What a release says about how to read its tempo.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct TempoHint {
    /// The release looks like dance music: a steady pulse the detectors can be
    /// held to. When this is false, a disagreement between them is treated as a
    /// disagreement rather than something to resolve automatically.
    pub steady_pulse: bool,
}

/// Read a release's Discogs genres and styles into a [`TempoHint`].
///
/// Styles are consulted first because they are the more specific field: a
/// release tagged "Deep House" is dance music whatever its genre says. Genres
/// only get a say when no style is recognised.
pub fn hint_for_release(genres: &str, styles: &str) -> TempoHint {
    let steady_pulse = if has_any(styles, DANCE_STYLES) {
        true
    } else if has_any(genres, NON_DANCE_GENRES) {
        false
    } else {
        has_any(genres, DANCE_GENRES)
    };
    TempoHint { steady_pulse }
}

fn has_any(field: &str, table: &[&str]) -> bool {
    field
        .split(',')
        .any(|item| table.contains(&item.trim().to_ascii_lowercase().as_str()))
}

/// When to spend a second, independent tempo estimate.
///
/// The default is [`SecondOpinion::Always`], because a beat tracker locked onto
/// the wrong pulse still reports an evenly spaced grid and so stays confident:
/// Physical Therapy's "More Sugar" runs at about 168 and was reported at 85.13
/// with 0.90 confidence. Nothing in the first detector's own output reveals
/// that. Only something that fails differently can, and it costs about 11 ms
/// against 990 ms for a full analysis.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SecondOpinion {
    /// Cross-check every track. The default.
    #[default]
    Always,
    /// Cross-check only where the first reading's own confidence is low. Misses
    /// the confidently-wrong case above, which is the one that matters.
    Unsure,
    /// One detector only.
    Never,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dance_styles_are_recognised() {
        for s in ["Deep House", "Techno, Minimal", "Breakbeat, Jungle", "Tech House"] {
            assert!(hint_for_release("Electronic", s).steady_pulse, "{s}");
        }
    }

    #[test]
    fn a_dance_style_counts_even_under_a_rock_genre() {
        assert!(hint_for_release("Electronic, Rock", "Deep House, Experimental").steady_pulse);
    }

    #[test]
    fn non_dance_records_are_not_assumed_to_have_a_steady_pulse() {
        // Every one of these is a real release from the collection this was
        // measured against, and every one is a track where the two detectors
        // disagreed about which pulse to count.
        let cases = [
            ("Rock, Pop, Folk, World, & Country", "Soft Rock"),
            ("Jazz, Funk / Soul", "Soul-Jazz, Smooth Jazz, Jazz-Funk, Soul"),
            ("Pop", "Vocal, Ballad"),
            ("Hip Hop, Rock, Pop, Stage & Screen", "Soundtrack"),
            ("Electronic, Rock", "Industrial, Experimental, Alternative Rock"),
        ];
        for (genres, styles) in cases {
            assert!(!hint_for_release(genres, styles).steady_pulse, "{genres} / {styles}");
        }
    }

    #[test]
    fn electronic_with_an_unknown_style_still_counts_as_dance() {
        assert!(hint_for_release("Electronic", "Some Style We Invented").steady_pulse);
    }

    #[test]
    fn a_release_with_nothing_recorded_is_not_assumed_steady() {
        assert!(!hint_for_release("", "").steady_pulse);
    }
}
