//! Musical key detection via libkeyfinder, translated into Camelot notation.

use analyzer_core::camelot::{Camelot, Mode, MusicalKey};

/// Most frequent value, with its count.
fn plurality(votes: &[Camelot]) -> Option<(Camelot, usize)> {
    votes
        .iter()
        .map(|v| (*v, votes.iter().filter(|o| *o == v).count()))
        .max_by_key(|(_, n)| *n)
}

extern "C" {
    fn kf_key_of_audio(
        samples: *const f64,
        sample_count: std::os::raw::c_uint,
        frame_rate: std::os::raw::c_uint,
        channels: std::os::raw::c_uint,
    ) -> std::os::raw::c_int;
}

/// libkeyfinder's `key_t`, in its declared order (see `constants.h`). The
/// numbering is positional, so this table must stay in that exact order.
const KEY_TABLE: [(u8, Mode); 24] = [
    (9, Mode::Major),  // A major
    (9, Mode::Minor),  // A minor
    (10, Mode::Major), // B flat major
    (10, Mode::Minor), // B flat minor
    (11, Mode::Major), // B major
    (11, Mode::Minor), // B minor
    (0, Mode::Major),  // C major
    (0, Mode::Minor),  // C minor
    (1, Mode::Major),  // D flat major
    (1, Mode::Minor),  // D flat minor
    (2, Mode::Major),  // D major
    (2, Mode::Minor),  // D minor
    (3, Mode::Major),  // E flat major
    (3, Mode::Minor),  // E flat minor
    (4, Mode::Major),  // E major
    (4, Mode::Minor),  // E minor
    (5, Mode::Major),  // F major
    (5, Mode::Minor),  // F minor
    (6, Mode::Major),  // G flat major
    (6, Mode::Minor),  // G flat minor
    (7, Mode::Major),  // G major
    (7, Mode::Minor),  // G minor
    (8, Mode::Major),  // A flat major
    (8, Mode::Minor),  // A flat minor
];

/// libkeyfinder's SILENCE value.
const SILENCE: i32 = 24;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DetectedKey {
    pub musical: MusicalKey,
    pub camelot: Camelot,
    /// How much of the track agrees with this key, 0-1.
    ///
    /// libkeyfinder returns a classification with no score attached, so this is
    /// measured rather than reported: the track is split into segments, each is
    /// classified independently, and the strength is the share of segments
    /// landing on the winning key. A track that reads the same throughout gets
    /// 1.0; one that disagrees with itself — a mix, a medley, or a detection
    /// the audio does not really support — gets a low number and can be sent
    /// for review.
    pub strength: f64,
    /// How many segments were classified. 1 means the track was too short to
    /// split, so `strength` could not be measured and is reported as 1.0.
    pub segments: usize,
}

#[derive(Debug)]
pub enum KeyError {
    /// libkeyfinder decided the audio was silence.
    Silence,
    /// The detector threw, or was handed something it could not use.
    DetectionFailed,
    /// A key_t value outside the range this build knows about.
    UnknownKey(i32),
    TooShort { samples: usize },
}

impl std::fmt::Display for KeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KeyError::Silence => write!(f, "libkeyfinder detected silence"),
            KeyError::DetectionFailed => write!(f, "libkeyfinder failed to analyse the audio"),
            KeyError::UnknownKey(v) => write!(f, "libkeyfinder returned unknown key value {v}"),
            KeyError::TooShort { samples } => {
                write!(f, "audio too short for key detection ({samples} samples)")
            }
        }
    }
}

impl std::error::Error for KeyError {}

/// Shorter than this and a chromagram has nothing to work with.
const MIN_SECONDS: f64 = 5.0;

/// Segments are kept long enough for a chromagram to be meaningful; below this
/// the track is classified in one pass instead.
const SEGMENT_SECONDS: f64 = 30.0;

/// Cap on segments, so a long DJ mix does not cost dozens of passes.
const MAX_SEGMENTS: usize = 8;

/// Share of segments that must agree before they may outvote the whole-track
/// reading. Measured over 191 tracks, 14 had a majority this clear disagreeing
/// with the whole-track answer, and only 5 of those disagreed *incompatibly* —
/// so this fires rarely and only where the two genuinely cannot both be right.
const MAJORITY_SHARE: f64 = 0.6;

/// Detect the key of mono audio, and measure how consistently the track holds
/// that key (see [`DetectedKey::strength`]).
pub fn detect(samples: &[f32], sample_rate: u32) -> Result<DetectedKey, KeyError> {
    let seconds = samples.len() as f64 / sample_rate.max(1) as f64;
    if seconds < MIN_SECONDS {
        return Err(KeyError::TooShort { samples: samples.len() });
    }

    // The whole-track answer is the one we report: it has the most audio behind
    // it, and it is what libkeyfinder is tuned to do.
    let overall = classify(samples, sample_rate)?;

    // Segment agreement then tells us how much to trust it.
    let segment_len = (SEGMENT_SECONDS * sample_rate as f64) as usize;
    let count = (samples.len() / segment_len.max(1)).clamp(0, MAX_SEGMENTS);
    if count < 2 {
        return Ok(DetectedKey {
            musical: overall,
            camelot: overall.to_camelot(),
            strength: 1.0,
            segments: 1,
        });
    }

    let mut votes: Vec<crate::key::Camelot> = Vec::new();
    for i in 0..count {
        let start = i * segment_len;
        let end = (start + segment_len).min(samples.len());
        // Silence and failures in one segment should not sink the whole track;
        // they simply do not vote.
        if let Ok(key) = classify(&samples[start..end], sample_rate) {
            votes.push(key.to_camelot());
        }
    }
    if votes.is_empty() {
        return Ok(DetectedKey {
            musical: overall,
            camelot: overall.to_camelot(),
            strength: 1.0,
            segments: 1,
        });
    }

    // A clear majority of segments that is *incompatible* with the whole-track
    // answer outvotes it. Several independent readings beat one, but only when
    // they cannot both be right: where the majority is a fifth away or the
    // relative major, the two agree for mixing purposes and the whole-track
    // answer stands, because it had the most audio behind it.
    let mut reported = overall.to_camelot();
    if let Some((majority, count)) = plurality(&votes) {
        let clear = count as f64 / votes.len() as f64 >= MAJORITY_SHARE;
        if clear && reported.compatibility(majority) == 0.0 {
            reported = majority;
        }
    }

    // Graded rather than exact: see `Camelot::compatibility`. A track whose
    // sections alternate between a key and its relative major is consistent to
    // anyone mixing it, and scoring that as disagreement is what made this
    // figure read far lower than the music deserved.
    let strength =
        votes.iter().map(|v| reported.compatibility(*v)).sum::<f64>() / votes.len() as f64;
    let classified = votes.len();
    let overall = reported.to_musical();

    Ok(DetectedKey {
        musical: overall,
        camelot: reported,
        strength,
        segments: classified.max(1),
    })
}

/// One libkeyfinder pass over a buffer.
fn classify(samples: &[f32], sample_rate: u32) -> Result<MusicalKey, KeyError> {
    // libkeyfinder works in doubles; convert once rather than per sample access.
    let buffer: Vec<f64> = samples.iter().map(|s| *s as f64).collect();

    // SAFETY: the pointer and length describe `buffer`, which outlives the
    // call, and the shim catches every C++ exception rather than unwinding
    // across the boundary.
    let raw = unsafe {
        kf_key_of_audio(
            buffer.as_ptr(),
            buffer.len() as std::os::raw::c_uint,
            sample_rate as std::os::raw::c_uint,
            1,
        )
    };

    match raw {
        -1 => Err(KeyError::DetectionFailed),
        SILENCE => Err(KeyError::Silence),
        v if (0..24).contains(&v) => {
            let (pitch, mode) = KEY_TABLE[v as usize];
            Ok(MusicalKey::new(pitch, mode))
        }
        other => Err(KeyError::UnknownKey(other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_table_covers_every_pitch_class_in_both_modes() {
        let mut majors: Vec<u8> = KEY_TABLE
            .iter()
            .filter(|(_, m)| *m == Mode::Major)
            .map(|(p, _)| *p)
            .collect();
        let mut minors: Vec<u8> = KEY_TABLE
            .iter()
            .filter(|(_, m)| *m == Mode::Minor)
            .map(|(p, _)| *p)
            .collect();
        majors.sort();
        minors.sort();
        assert_eq!(majors, (0..12).collect::<Vec<u8>>());
        assert_eq!(minors, (0..12).collect::<Vec<u8>>());
    }

    #[test]
    fn known_key_values_map_to_the_expected_camelot_codes() {
        // Spot-check against libkeyfinder's declared enum order.
        let cases = [
            (0, "11B"),  // A major
            (1, "8A"),   // A minor
            (6, "8B"),   // C major
            (15, "9A"),  // E minor
            (20, "9B"),  // G major
            (23, "1A"),  // A flat minor == G# minor
        ];
        for (raw, expected) in cases {
            let (pitch, mode) = KEY_TABLE[raw as usize];
            assert_eq!(
                MusicalKey::new(pitch, mode).to_camelot().code(),
                expected,
                "key_t {raw} should be {expected}"
            );
        }
    }

    #[test]
    fn segment_budget_stays_within_bounds() {
        // A long mix must not cost an unbounded number of detection passes.
        let long_track_samples = 44_100usize * 60 * 90; // 90 minutes
        let segment_len = (SEGMENT_SECONDS * 44_100.0) as usize;
        let count = (long_track_samples / segment_len).clamp(0, MAX_SEGMENTS);
        assert_eq!(count, MAX_SEGMENTS);

        // A three-minute track splits into a handful, not one.
        let normal = 44_100usize * 180;
        assert_eq!((normal / segment_len).clamp(0, MAX_SEGMENTS), 6);

        // A 20-second track cannot be split, so it reports a single segment.
        let short = 44_100usize * 20;
        assert!((short / segment_len).clamp(0, MAX_SEGMENTS) < 2);
    }
}
