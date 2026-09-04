//! Energy estimation: the 1-10 "how hard does this hit" figure DJs sort by,
//! and which the web app already stores as `energy`.
//!
//! This is measured from the audio rather than guessed from the title, which is
//! what PROJECT_PLAN.md F4 proposed doing with an LLM. Measuring is cheaper
//! (no API, no backend), works offline, and does not hallucinate.
//!
//! It is still a **heuristic**, not a physical quantity — "energy" is a DJ
//! convention, not a unit. Three signals feed it, all computed in the time
//! domain so no FFT is needed:
//!
//! - **Loudness** (RMS): how much level is there, after the fact that quiet
//!   pressings exist.
//! - **Brightness** (zero-crossing rate): hats, distortion and synths push it
//!   up; dubby, bassy material pushes it down.
//! - **Drive** (short-window RMS variance): how percussive and busy it is,
//!   separating a four-to-the-floor banger from a sustained ambient pad at the
//!   same loudness.
//!
//! The weights are a judgement call, chosen so the ordering is sensible; they
//! are not calibrated against a reference corpus. Treat the number as a way to
//! sort a crate, not as truth.

/// Window used for the short-term RMS track, in milliseconds.
const WINDOW_MS: f64 = 50.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Energy {
    /// The 1-10 value the web app stores.
    pub level: u8,
    /// The underlying 0-1 score, before bucketing. Kept because the bucket
    /// boundaries are arbitrary and this is what a future recalibration needs.
    pub score: f64,
    pub loudness: f64,
    pub brightness: f64,
    pub drive: f64,
}

/// Estimate energy from mono samples. Returns `None` for audio too short or
/// too silent to say anything about.
pub fn estimate(samples: &[f32], sample_rate: u32) -> Option<Energy> {
    if samples.is_empty() || sample_rate == 0 {
        return None;
    }
    let window = ((sample_rate as f64) * WINDOW_MS / 1000.0) as usize;
    if samples.len() < window * 4 {
        return None;
    }

    let overall_rms = rms(samples);
    if overall_rms < 1e-5 {
        return None; // effectively silence
    }

    // Loudness: RMS in dBFS, mapped so -30 dB reads as 0 and -6 dB as 1. Most
    // mastered music sits between those.
    let db = 20.0 * overall_rms.log10();
    let loudness = ((db + 30.0) / 24.0).clamp(0.0, 1.0);

    // Brightness: zero crossings per second, mapped so 500/s reads as 0 and
    // 5000/s as 1 — roughly bass-led dub through to bright, hat-heavy material.
    let crossings = samples.windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count();
    let zcr = crossings as f64 / (samples.len() as f64 / sample_rate as f64);
    let brightness = ((zcr - 500.0) / 4500.0).clamp(0.0, 1.0);

    // Drive: how much the short-term level moves around, normalised by the
    // mean level so it measures dynamics rather than loudness again.
    let levels: Vec<f64> = samples.chunks(window).map(rms).collect();
    let mean = levels.iter().sum::<f64>() / levels.len() as f64;
    let drive = if mean > 1e-9 {
        let variance = levels.iter().map(|l| (l - mean).powi(2)).sum::<f64>() / levels.len() as f64;
        (variance.sqrt() / mean).clamp(0.0, 1.0)
    } else {
        0.0
    };

    // Loudness leads because it is what people notice first; brightness and
    // drive separate tracks that are equally loud.
    let score = (0.5 * loudness + 0.3 * brightness + 0.2 * drive).clamp(0.0, 1.0);

    Some(Energy {
        level: to_level(score),
        score,
        loudness,
        brightness,
        drive,
    })
}

/// Map the 0-1 score onto the 1-10 scale the web app's field uses.
fn to_level(score: f64) -> u8 {
    let level = (score * 9.0).round() as i64 + 1;
    level.clamp(1, 10) as u8
}

fn rms(samples: &[f32]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f64 = samples.iter().map(|s| (*s as f64) * (*s as f64)).sum();
    (sum / samples.len() as f64).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    const SR: u32 = 44_100;

    fn sine(freq: f32, amplitude: f32, seconds: f64) -> Vec<f32> {
        let total = (SR as f64 * seconds) as usize;
        (0..total)
            .map(|n| (2.0 * PI * freq * n as f32 / SR as f32).sin() * amplitude)
            .collect()
    }

    /// Deterministic pseudo-noise, so the test does not need a rng dependency.
    fn noise(amplitude: f32, seconds: f64) -> Vec<f32> {
        let total = (SR as f64 * seconds) as usize;
        let mut state: u32 = 0x1234_5678;
        (0..total)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((state >> 8) as f32 / 8_388_608.0 - 1.0) * amplitude
            })
            .collect()
    }

    #[test]
    fn silence_and_tiny_clips_have_no_energy() {
        assert!(estimate(&[], SR).is_none());
        assert!(estimate(&vec![0.0; SR as usize], SR).is_none());
        assert!(estimate(&sine(440.0, 0.5, 0.01), SR).is_none(), "too short to judge");
        assert!(estimate(&sine(440.0, 0.5, 5.0), 0).is_none());
    }

    #[test]
    fn louder_material_reads_as_more_energetic() {
        let quiet = estimate(&sine(440.0, 0.02, 5.0), SR).unwrap();
        let loud = estimate(&sine(440.0, 0.9, 5.0), SR).unwrap();
        assert!(
            loud.level > quiet.level,
            "loud {} should exceed quiet {}",
            loud.level,
            quiet.level
        );
    }

    #[test]
    fn bright_material_reads_as_more_energetic_than_bass_at_equal_level() {
        let bass = estimate(&sine(60.0, 0.6, 5.0), SR).unwrap();
        let bright = estimate(&noise(0.6, 5.0), SR).unwrap();
        assert!(
            bright.brightness > bass.brightness,
            "noise ({:.2}) should be brighter than a 60 Hz sine ({:.2})",
            bright.brightness,
            bass.brightness
        );
        assert!(bright.level >= bass.level);
    }

    #[test]
    fn levels_stay_inside_the_scale_the_web_app_expects() {
        for amp in [0.001, 0.01, 0.1, 0.5, 0.99] {
            for freq in [40.0, 440.0, 8000.0] {
                if let Some(e) = estimate(&sine(freq, amp, 3.0), SR) {
                    assert!(
                        (1..=10).contains(&e.level),
                        "level {} out of range for {amp}@{freq}",
                        e.level
                    );
                    assert!((0.0..=1.0).contains(&e.score));
                }
            }
        }
        assert_eq!(to_level(0.0), 1);
        assert_eq!(to_level(1.0), 10);
    }
}
