//! Choosing a tempo band from what Discogs says a record is.
//!
//! A tempo detector reports a beat grid, and a grid is only defined up to a
//! factor of two, so the reported figure has to be folded into a one-octave
//! window. Which window is a genre judgement: 87 BPM is a drum and bass track
//! seen at half speed, and it is also simply what a hip hop record runs at.
//!
//! A single window cannot serve a collection holding both. But the backup
//! already carries Discogs' own `styles` for every release, so the collection
//! can answer the question per record instead of once for everything.
//!
//! This is a hint, not a fact. Discogs styles are crowd-entered, often several
//! per release and sometimes wrong, so the table is deliberately small: it
//! names only the styles where the default window is actively harmful, and
//! everything else falls back to whatever the run was given.

/// Band minimum for styles that live above the default window. 90 puts the
/// window at 90-180, which holds drum and bass and jungle at 165-180 while
/// still pulling a half-time reading of 87 back up to 174.
pub const FAST_BAND_MIN: f64 = 90.0;

/// Band minimum for styles that live below it. 70 puts the window at 70-140,
/// so a dub record at 75 stays 75 instead of being doubled to 150.
pub const SLOW_BAND_MIN: f64 = 70.0;

/// Styles played fast enough that the default window would halve them.
const FAST_STYLES: &[&str] = &[
    "drum n bass",
    "drum and bass",
    "drum & bass",
    "drumfunk",
    "jungle",
    "ragga jungle",
    "darkstep",
    "techstep",
    "neurofunk",
    "liquid funk",
    "breakcore",
    "footwork",
    "juke",
    "halftime",
    "hardcore",
    "gabber",
    "speedcore",
    "happy hardcore",
    "jumpstyle",
    "makina",
];

/// Styles that pin a release to the ordinary dance-music tempo range.
///
/// These exist to veto [`SLOW_STYLES`], not to select a band of their own. A
/// record tagged "Techno, Dub, Minimal" is dub *techno* at 120-130, not reggae
/// dub at 75 — the word means something different once there is a four-to-the
/// floor style beside it. Every "Dub" release in the collection this was built
/// against is of exactly that kind, and without this veto each one would have
/// been folded into 70-140, halving anything above 140.
const MID_STYLES: &[&str] = &[
    "house",
    "deep house",
    "tech house",
    "acid house",
    "progressive house",
    "tribal house",
    "italo house",
    "hip-house",
    "microhouse",
    "ambient house",
    "garage house",
    "techno",
    "dub techno",
    "deep techno",
    "minimal techno",
    "minimal",
    "electro",
    "acid",
    "breakbeat",
    "breaks",
    "big beat",
    "disco",
    "italo-disco",
    "nu-disco",
    "boogie",
    "trance",
    "hard trance",
    "psy-trance",
    "progressive trance",
    "neo trance",
    "eurodance",
    "uk garage",
];

/// Styles played slowly enough that the default window would double them.
const SLOW_STYLES: &[&str] = &[
    "hip hop",
    "hip-hop",
    "trip hop",
    "boom bap",
    "gangsta",
    "trap",
    "dub",
    "reggae",
    "roots reggae",
    "dancehall",
    "lovers rock",
    "rocksteady",
    "ska",
    "dubstep",
    "downtempo",
    "trip-hop",
];

/// When to spend a second, independent tempo estimate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SecondOpinion {
    /// Only where it is likely to help: syncopated styles whose beat grid came
    /// out unsure. See the crate README for why this is the default.
    #[default]
    Auto,
    /// Every style, not just the syncopated ones. The confidence gate still
    /// applies — a grid the detector was sure of is never second-guessed.
    ///
    /// Measured on 50 house and techno tracks: 10 readings confirmed, 3 tempos
    /// overruled of which at least 2 were wrong (a 128 BPM house track pushed
    /// to 168), and 2 correct readings disputed down to 0.3 confidence. On
    /// four-to-the-floor material the beat tracker is reliable and the second
    /// estimate adds noise rather than signal.
    Always,
    /// Never. One detector, as the tool behaved before this existed.
    Never,
}

impl SecondOpinion {
    /// Whether this track gets the second estimate.
    pub fn applies_to(&self, hint: TempoHint) -> bool {
        match self {
            SecondOpinion::Auto => hint.syncopated,
            SecondOpinion::Always => true,
            SecondOpinion::Never => false,
        }
    }
}

/// What a release's styles say about how to read its tempo.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct TempoHint {
    /// Band minimum implied by the styles, when they imply one.
    pub band_min: Option<f64>,
    /// The rhythm is syncopated enough that a causal beat tracker is likely to
    /// lock onto the wrong pulse — breaks, jungle, footwork and their
    /// relatives. Not the same question as [`TempoHint::band_min`]: breakbeat
    /// sits at an ordinary tempo and still defeats the tracker.
    pub syncopated: bool,
}

/// Styles whose rhythms are built out of syncopated breaks rather than a
/// steady kick, and where a second opinion on the tempo earns its cost.
const SYNCOPATED_STYLES: &[&str] = &[
    "breakbeat",
    "breaks",
    "big beat",
    "jungle",
    "ragga jungle",
    "drum n bass",
    "drum and bass",
    "drum & bass",
    "drumfunk",
    "darkstep",
    "techstep",
    "neurofunk",
    "liquid funk",
    "breakcore",
    "footwork",
    "juke",
    "halftime",
    "idm",
    "glitch",
    "uk garage",
    "2-step",
    "future garage",
    "trip hop",
    "abstract",
];

/// Read a release's Discogs styles into a [`TempoHint`].
pub fn hint_for_styles(styles: &str) -> TempoHint {
    TempoHint {
        band_min: band_min_for_styles(styles),
        syncopated: styles.split(',').any(|style| {
            SYNCOPATED_STYLES.contains(&style.trim().to_ascii_lowercase().as_str())
        }),
    }
}

/// Pick a tempo band minimum from a release's Discogs styles.
///
/// `styles` is the comma-separated string the backup stores, e.g.
/// `"Breakbeat, Jungle"`. Returns `None` when nothing in it is decisive, which
/// is the common case and means "use whatever the run was configured with".
///
/// When a release carries styles from both groups — rare, but "Hip Hop, Jungle"
/// exists — fast wins. The asymmetry is deliberate: a drum and bass track
/// reported at half speed is unusable for mixing, while a hip hop track
/// reported at double speed is at least still on the grid.
pub fn band_min_for_styles(styles: &str) -> Option<f64> {
    let mut slow = false;
    let mut mid = false;
    for style in styles.split(',') {
        let style = style.trim().to_ascii_lowercase();
        if style.is_empty() {
            continue;
        }
        // Fast is decided on the spot. It is the safe direction: the 90-180
        // window still contains 128, so tagging a house record as drum and bass
        // costs nothing, while missing a real 174 costs the whole track.
        if FAST_STYLES.contains(&style.as_str()) {
            return Some(FAST_BAND_MIN);
        }
        if SLOW_STYLES.contains(&style.as_str()) {
            slow = true;
        }
        if MID_STYLES.contains(&style.as_str()) {
            mid = true;
        }
    }
    // Slow needs the whole style list read first, because it is the dangerous
    // direction: 70-140 halves anything above 140, so it is only applied when
    // nothing on the release contradicts it.
    (slow && !mid).then_some(SLOW_BAND_MIN)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drum_and_bass_gets_the_fast_band() {
        for s in ["Drum n Bass", "Jungle", "drum & bass", "Halftime"] {
            assert_eq!(band_min_for_styles(s), Some(FAST_BAND_MIN), "{s}");
        }
    }

    #[test]
    fn dub_and_hip_hop_get_the_slow_band() {
        for s in ["Dub", "Hip Hop", "Trip Hop", "Reggae", "Dub, Roots Reggae"] {
            assert_eq!(band_min_for_styles(s), Some(SLOW_BAND_MIN), "{s}");
        }
    }

    #[test]
    fn dub_beside_a_dance_style_is_dub_techno_not_reggae() {
        // Every "Dub" release in the collection this was built against looks
        // like one of these. Reading them as reggae would fold a 145 BPM techno
        // record down to 72.
        for s in [
            "Techno, Dub, Minimal",
            "House, Minimal, Dub",
            "Deep House, Tech House, Minimal, Dub",
            "House, Dub, Minimal, Techno",
        ] {
            assert_eq!(band_min_for_styles(s), None, "{s}");
        }
    }

    #[test]
    fn hip_hop_beside_house_is_a_house_record() {
        for s in ["House, Hip Hop, Downtempo", "Hip Hop, House", "Ambient, Hip Hop, House"] {
            assert_eq!(band_min_for_styles(s), None, "{s}");
        }
    }

    #[test]
    fn house_and_techno_defer_to_the_run() {
        // The bulk of this collection. Nothing here is decisive, so the band
        // stays whatever --tempo-min chose.
        for s in ["Deep House", "Techno", "Tech House, Minimal", "Ambient", ""] {
            assert_eq!(band_min_for_styles(s), None, "{s}");
        }
    }

    #[test]
    fn breakbeat_asks_for_a_second_opinion_without_moving_the_band() {
        // The distinction the two fields exist for: breakbeat runs at an
        // ordinary 125-140, so the band is untouched, but its syncopation is
        // exactly what makes a beat tracker miscount.
        let hint = hint_for_styles("Breakbeat, Techno");
        assert_eq!(hint.band_min, None);
        assert!(hint.syncopated);
    }

    #[test]
    fn jungle_moves_the_band_and_asks_for_a_second_opinion() {
        let hint = hint_for_styles("Jungle, Drum n Bass, Ambient");
        assert_eq!(hint.band_min, Some(FAST_BAND_MIN));
        assert!(hint.syncopated);
    }

    #[test]
    fn four_to_the_floor_needs_neither() {
        for s in ["Deep House", "Techno, Minimal", "Ambient", ""] {
            let hint = hint_for_styles(s);
            assert_eq!(hint.band_min, None, "{s}");
            assert!(!hint.syncopated, "{s}");
        }
    }

    #[test]
    fn breakbeat_is_not_treated_as_drum_and_bass() {
        // 29 releases in this collection are Breakbeat and they run at 125-140,
        // inside the default window. Lumping them in with jungle would double
        // every one of them.
        assert_eq!(band_min_for_styles("Breakbeat"), None);
        assert_eq!(band_min_for_styles("Breaks"), None);
    }

    #[test]
    fn a_multi_style_release_is_read_across_all_of_them() {
        assert_eq!(band_min_for_styles("Breakbeat, Jungle"), Some(FAST_BAND_MIN));
        assert_eq!(band_min_for_styles("Dub, Ambient"), Some(SLOW_BAND_MIN));
    }

    #[test]
    fn the_real_releases_this_was_built_against_land_where_they_should() {
        // Straight from the collection: these are the ones that made the
        // default window wrong, and the ones that looked like they did.
        let cases = [
            ("House, Breakbeat, Drum n Bass, Downtempo, Ambient", Some(FAST_BAND_MIN)),
            ("Breakbeat, Breaks, Techno, Jungle", Some(FAST_BAND_MIN)),
            ("Drum n Bass, Halftime, Jungle", Some(FAST_BAND_MIN)),
            ("Jungle, Drum n Bass, Ambient", Some(FAST_BAND_MIN)),
            ("Downtempo, Future Jazz, Jungle, Ambient", Some(FAST_BAND_MIN)),
            ("Techno, Dub, Minimal", None),
            ("Deep House, Tech House", None),
            ("Ambient", None),
        ];
        for (styles, expected) in cases {
            assert_eq!(band_min_for_styles(styles), expected, "{styles}");
        }
    }

    #[test]
    fn fast_wins_when_a_release_claims_both() {
        assert_eq!(band_min_for_styles("Hip Hop, Jungle"), Some(FAST_BAND_MIN));
        assert_eq!(band_min_for_styles("Jungle, Hip Hop"), Some(FAST_BAND_MIN));
    }

    #[test]
    fn matching_ignores_case_and_padding() {
        assert_eq!(band_min_for_styles("  JUNGLE  "), Some(FAST_BAND_MIN));
        assert_eq!(band_min_for_styles("  dub ,  REGGAE "), Some(SLOW_BAND_MIN));
        // The veto is case-insensitive too, or "DUB" beside "Deep House" would
        // slip through as reggae.
        assert_eq!(band_min_for_styles("DEEP HOUSE,dub"), None);
    }

    #[test]
    fn a_style_that_merely_contains_a_keyword_is_not_a_match() {
        // "Dub Techno" is techno at 120-130, not dub at 75, and this collection
        // has 50 of them. Substring matching would halve every one.
        assert_eq!(band_min_for_styles("Dub Techno"), None);
        assert_eq!(band_min_for_styles("Deep Techno, Dub Techno"), None);
    }
}
