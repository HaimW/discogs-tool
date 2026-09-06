//! Audio analysis: decode a file, detect its tempo (aubio) and musical key
//! (libkeyfinder), and hand back a result shaped for `analyzer-core`'s merge.
//!
//! This crate is the only place with native dependencies. Everything that
//! decides *what* to analyse and *what to write* lives in `analyzer-core`,
//! which builds without them — so the engine here can be swapped without
//! touching the pipeline.
//!
//! Licensing note: aubio and libkeyfinder are both GPLv3, which is why the
//! analyzer as a whole is GPLv3. The web app is a separate program exchanging
//! JSON files and is unaffected.

pub mod bpm;
pub mod decode;
pub mod autocorr;
pub mod energy;
pub mod key;

#[allow(non_upper_case_globals, non_camel_case_types, non_snake_case, dead_code)]
mod ffi {
    include!(concat!(env!("OUT_DIR"), "/aubio_bindings.rs"));
}

use std::path::Path;

use analyzer_core::meta::AnalysisResult;
use analyzer_core::tempo::{SecondOpinion, TempoHint};

/// Everything we learned about one audio file.
#[derive(Debug, Clone)]
pub struct Analysis {
    pub bpm: f64,
    pub bpm_confidence: f64,
    pub camelot: String,
    pub key_musical: String,
    pub key_strength: f64,
    /// How many segments backed the key's strength figure.
    pub key_segments: usize,
    /// Estimated 1-10 energy, absent when the audio was too short or quiet.
    pub energy: Option<u8>,
    /// The continuous 0-1 energy score behind [`Analysis::energy`]. Carried
    /// separately because the 1-10 bucket is too coarse to rank a collection
    /// by, and ranking is what the figure is finally calibrated against.
    pub energy_score: Option<f64>,
    /// How the reported tempo was arrived at. See [`TempoMethod`].
    pub bpm_method: TempoMethod,
    /// The independent estimate, when one was taken. Kept whether or not it
    /// was believed, because a disagreement is the useful part.
    pub bpm_second_opinion: Option<f64>,
    pub duration_seconds: f64,
}

impl Analysis {
    /// Pair with a timestamp to get the record `analyzer-core` merges.
    pub fn into_result(self, analyzed_at: impl Into<String>, version: impl Into<String>) -> AnalysisResult {
        AnalysisResult {
            bpm: self.bpm,
            bpm_confidence: self.bpm_confidence,
            key: self.camelot,
            key_musical: self.key_musical,
            key_strength: self.key_strength,
            energy: self.energy,
            energy_score: self.energy_score,
            bpm_method: Some(self.bpm_method.as_str().to_string()),
            bpm_second_opinion: self.bpm_second_opinion,
            analyzed_at: analyzed_at.into(),
            analyzer_version: version.into(),
        }
    }
}

/// How a reported tempo was arrived at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TempoMethod {
    /// The beat-grid fit alone. Confidence was good, or the styles gave no
    /// reason to doubt it.
    BeatGrid,
    /// A second, independent estimate agreed, so the grid's precise figure
    /// stands and is better trusted than the confidence alone suggested.
    Confirmed,
    /// The two disagreed by a simple metrical ratio — the grid was counting
    /// half-bars, or triplets. The grid's precision is kept and rescaled.
    Rescaled,
    /// The two disagreed with no musical relation between them, and the
    /// independent estimate was the stronger of the pair, so it was taken.
    SecondOpinion,
    /// They disagreed and neither was convincing. The grid's figure stands,
    /// and the confidence is cut to say the tool does not know.
    Disputed,
}

impl TempoMethod {
    pub fn as_str(&self) -> &'static str {
        match self {
            TempoMethod::BeatGrid => "beat-grid",
            TempoMethod::Confirmed => "beat-grid-confirmed",
            TempoMethod::Rescaled => "beat-grid-rescaled",
            TempoMethod::SecondOpinion => "autocorrelation",
            TempoMethod::Disputed => "disputed",
        }
    }
}

#[derive(Debug)]
pub enum AnalysisError {
    Decode(decode::DecodeError),
    Bpm(bpm::BpmError),
    Key(key::KeyError),
}

impl std::fmt::Display for AnalysisError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AnalysisError::Decode(e) => write!(f, "{e}"),
            AnalysisError::Bpm(e) => write!(f, "{e}"),
            AnalysisError::Key(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for AnalysisError {}

/// Decode and analyse one audio file.
pub fn analyze_file(path: &Path) -> Result<Analysis, AnalysisError> {
    analyze_file_with(path, SecondOpinion::default(), TempoHint::default())
}

/// Decode and analyse one audio file under a given cross-checking policy.
/// See [`analyze_samples_with`].
pub fn analyze_file_with(
    path: &Path,
    policy: SecondOpinion,
    hint: TempoHint,
) -> Result<Analysis, AnalysisError> {
    let audio = decode::decode_file(path).map_err(AnalysisError::Decode)?;
    analyze_samples_with(&audio.samples, audio.sample_rate, policy, hint)
}

/// Analyse mono samples that are already in memory.
pub fn analyze_samples(samples: &[f32], sample_rate: u32) -> Result<Analysis, AnalysisError> {
    analyze_samples_with(samples, sample_rate, SecondOpinion::default(), TempoHint::default())
}

/// Confidence below which [`SecondOpinion::Unsure`] asks for a cross-check.
///
/// Only consulted under that policy. The default is to cross-check regardless,
/// because a beat tracker locked onto the wrong pulse reports a *consistent*
/// grid and so stays confident — see [`SecondOpinion`].
pub const SECOND_OPINION_BELOW: f64 = 0.85;

/// How much of the front of a track is skipped when reading its tempo.
///
/// Intros lie. They open beatless, or half-time, or on a loop that is not the
/// groove — and a detector fed the whole file has to reconcile that with the
/// body. Measured on one 338-second track: the first 30 seconds read 129.50
/// while every window after it read 168, and the whole-file figure came out at
/// 128.28 with its confidence collapsed to 0.11. Reading the body instead
/// turns that into a coherent answer.
///
/// Proportional rather than fixed, because a 3-minute edit and a 12-minute
/// version do not have intros of the same length, and capped so a long track
/// does not lose minutes of perfectly good groove.
const INTRO_FRACTION: f64 = 0.12;
const INTRO_CAP_SECONDS: f64 = 45.0;

/// The same at the end, for outros that break down or run to silence. Smaller,
/// because an outro usually keeps the groove longer than an intro withholds it.
const OUTRO_FRACTION: f64 = 0.08;
const OUTRO_CAP_SECONDS: f64 = 30.0;

/// Below this much remaining audio the trim is abandoned and the whole track is
/// read. A short edit has no intro to spare, and a bad tempo from too little
/// audio is worse than one contaminated by an intro.
const MIN_BODY_SECONDS: f64 = 60.0;

/// The stretch of a track its tempo should be read from: the body, with any
/// intro and outro trimmed off. Falls back to the whole slice when there is not
/// enough audio to spare.
fn tempo_body(samples: &[f32], sample_rate: u32) -> &[f32] {
    if sample_rate == 0 || samples.is_empty() {
        return samples;
    }
    let rate = sample_rate as f64;
    let duration = samples.len() as f64 / rate;
    let intro = (duration * INTRO_FRACTION).min(INTRO_CAP_SECONDS);
    let outro = (duration * OUTRO_FRACTION).min(OUTRO_CAP_SECONDS);
    if duration - intro - outro < MIN_BODY_SECONDS {
        return samples;
    }
    let from = (intro * rate) as usize;
    let to = samples.len() - (outro * rate) as usize;
    if to <= from {
        return samples;
    }
    &samples[from..to]
}

/// Two tempos this close are the same tempo.
const AGREEMENT_TOLERANCE: f64 = 0.03;

/// Ratios a beat tracker plausibly miscounts by.
///
/// **Octave relations only.** A beat tracker locking onto every other beat, or
/// every fourth, is a real and well-understood failure — Physical Therapy's
/// "More Sugar" is a 170 BPM record read as 85.
///
/// 3:2 and 4:3 were briefly included, and had to be removed. Edward's "Bebe"
/// is a 120 BPM record: the beat grid reports 120.1 to 120.2 in all thirteen
/// windows of it at 0.94 to 0.98 confidence, while the independent estimate
/// reports 159.9 at a strength of only 0.26 to 0.36, and agrees with 120 in the
/// windows where its strength rises. A 4:3 rule promoted that artefact over a
/// solid measurement and reported 160.46.
///
/// The lesson generalises: the autocorrelation finds real periodicities that
/// are not the beat — three-against-four percussion is ordinary in house — so a
/// simple ratio between the two figures is not evidence that the *grid* is the
/// one that is wrong. Only the octave relations are trusted to overrule it, and
/// everything else is reported as a dispute for a human to settle.
const METRICAL_RATIOS: &[f64] = &[2.0, 0.5, 4.0, 0.25];

/// How convincing the independent estimate must be before it is allowed to
/// overrule a grid it has no musical relation to.
const OVERRULE_STRENGTH: f64 = 0.5;

/// Analyse mono samples under a given cross-checking policy.
///
/// Tempo is read from the body of the track — see [`tempo_body`] — while key
/// and energy still see the whole of it. A key is a property of the whole
/// record and an intro is part of it; a tempo is a property of the groove, and
/// an intro that is not the groove is exactly the problem.
pub fn analyze_samples_with(
    samples: &[f32],
    sample_rate: u32,
    policy: SecondOpinion,
    hint: TempoHint,
) -> Result<Analysis, AnalysisError> {
    let body = tempo_body(samples, sample_rate);
    let tempo = bpm::detect(body, sample_rate).map_err(AnalysisError::Bpm)?;
    let detected = key::detect(samples, sample_rate).map_err(AnalysisError::Key)?;
    // Energy is a nice-to-have: a track we could tempo- and key-detect but not
    // score for energy is still a useful result, so this never fails the run.
    let energy = energy::estimate(samples, sample_rate);

    let wanted = match policy {
        SecondOpinion::Always => true,
        SecondOpinion::Unsure => tempo.confidence < SECOND_OPINION_BELOW,
        SecondOpinion::Never => false,
    };
    // Both detectors read the same stretch of audio, or a disagreement between
    // them would just be a disagreement about which part of the track it is.
    let second = wanted.then(|| autocorr::estimate(body, sample_rate)).flatten();
    let verdict = reconcile(tempo.bpm, tempo.confidence, second, hint.steady_pulse);

    Ok(Analysis {
        bpm: round2(verdict.bpm),
        // Three decimals is already finer than these numbers are meaningful to,
        // and it keeps the exported JSON readable.
        bpm_confidence: round3(verdict.confidence),
        camelot: detected.camelot.code(),
        key_musical: detected.musical.name(),
        key_strength: round3(detected.strength),
        key_segments: detected.segments,
        energy: energy.map(|e| e.level),
        energy_score: energy.map(|e| round3(e.score)),
        bpm_method: verdict.method,
        bpm_second_opinion: second.map(|e| round2(e.bpm)),
        duration_seconds: samples.len() as f64 / sample_rate.max(1) as f64,
    })
}

struct Verdict {
    bpm: f64,
    confidence: f64,
    method: TempoMethod,
}

/// Weigh the beat-grid figure against an independent estimate.
///
/// The two detectors have opposite weaknesses, and the rules follow from that.
/// The grid is precise but can count the wrong pulse; the autocorrelation
/// cannot count the wrong pulse but is imprecise. So wherever they can be
/// reconciled, the grid supplies the number and the second estimate supplies
/// only the decision about which pulse that number describes.
fn reconcile(
    grid_bpm: f64,
    grid_confidence: f64,
    second: Option<autocorr::Estimate>,
    steady_pulse: bool,
) -> Verdict {
    let Some(second) = second else {
        return Verdict { bpm: grid_bpm, confidence: grid_confidence, method: TempoMethod::BeatGrid };
    };
    if grid_bpm <= 0.0 || second.bpm <= 0.0 {
        return Verdict { bpm: grid_bpm, confidence: grid_confidence, method: TempoMethod::BeatGrid };
    }

    // They agree: nothing to change but how much we believe it. Two methods
    // that fail differently arriving at the same answer is real evidence, so
    // the confidence rises to at least the threshold that triggered the check.
    if (second.bpm / grid_bpm - 1.0).abs() <= AGREEMENT_TOLERANCE {
        return Verdict {
            bpm: grid_bpm,
            confidence: grid_confidence.max(SECOND_OPINION_BELOW),
            method: TempoMethod::Confirmed,
        };
    }

    // They differ by an octave: the grid was counting every other beat. Keep its
    // precision and move it onto the right pulse — but only on a second opinion
    // strong enough to be worth acting on. Rescaling used to skip that check
    // while overruling required it, which let a 0.30-strength artefact rewrite
    // a reading the grid was 0.97 confident of.
    // On material without a steady pulse — a ballad, a jazz record, anything
    // that is not built on a four-to-the-floor kick — the two detectors
    // disagreeing is not evidence that one of them miscounted an octave. It is
    // evidence that the track has no single obvious pulse, and the useful answer
    // is to say so rather than to pick. Genres feed this decision and nothing
    // else: they never change a number.
    if steady_pulse && second.strength >= OVERRULE_STRENGTH {
        for ratio in METRICAL_RATIOS {
            if (second.bpm / (grid_bpm * ratio) - 1.0).abs() <= AGREEMENT_TOLERANCE {
                return Verdict {
                    bpm: grid_bpm * ratio,
                    confidence: grid_confidence,
                    method: TempoMethod::Rescaled,
                };
            }
        }
    }

    // No relation at all. A strong global periodicity is the better bet than a
    // tracker that has already told us it is unsure — but only then. A grid the
    // detector is confident of is a measurement, and an unrelated periodicity is
    // not evidence against it: Edward's "Bebe" reports 120 at 0.97 confidence in
    // every window, and the 159.9 beside it is percussion, not tempo.
    if steady_pulse && second.strength >= OVERRULE_STRENGTH && grid_confidence < SECOND_OPINION_BELOW {
        return Verdict {
            bpm: second.bpm,
            confidence: grid_confidence.min(second.strength),
            method: TempoMethod::SecondOpinion,
        };
    }

    // Neither is convincing. Keep the grid, and say plainly that the tool does
    // not know: a low number here is the signal to check the track by ear.
    Verdict {
        bpm: grid_bpm,
        confidence: grid_confidence.min(0.3),
        method: TempoMethod::Disputed,
    }
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

#[cfg(test)]
mod reconcile_tests {
    use super::*;

    fn second(bpm: f64, strength: f64) -> Option<autocorr::Estimate> {
        Some(autocorr::Estimate { bpm, strength })
    }

    #[test]
    fn without_a_second_opinion_the_grid_stands_unchanged() {
        let v = reconcile(128.0, 0.7, None, true);
        assert_eq!(v.bpm, 128.0);
        assert_eq!(v.confidence, 0.7);
        assert_eq!(v.method, TempoMethod::BeatGrid);
    }

    #[test]
    fn agreement_keeps_the_precise_figure_and_raises_confidence() {
        // The autocorrelation is the imprecise one, so its number is never the
        // one reported when the two agree.
        let v = reconcile(128.0, 0.7, second(127.5, 0.6), true);
        assert_eq!(v.bpm, 128.0);
        assert!(v.confidence >= SECOND_OPINION_BELOW);
        assert_eq!(v.method, TempoMethod::Confirmed);
    }

    #[test]
    fn a_grid_counting_half_bars_is_rescaled_not_replaced() {
        // The exact case this exists for: the tracker locked onto every other
        // beat of a 170 BPM break. 85 * 2 = 170, and 170.0 is more precise than
        // the autocorrelation's 168.
        let v = reconcile(85.0, 0.7, second(168.0, 0.6), true);
        assert!((v.bpm - 170.0).abs() < 1e-9, "got {}", v.bpm);
        assert_eq!(v.method, TempoMethod::Rescaled);
    }

    #[test]
    fn a_three_against_four_reading_is_disputed_not_acted_on() {
        // Edward's "Bebe" is 120: the grid says so in every window, and the
        // 159.9 is a percussion harmonic. Reporting 161 here was a real bug.
        let v = reconcile(120.79, 0.97, second(159.9, 0.5), true);
        assert_eq!(v.bpm, 120.79, "a 4:3 artefact must not overrule the grid");
        assert_eq!(v.method, TempoMethod::Disputed);
    }

    #[test]
    fn a_weak_second_opinion_cannot_rescale_even_on_an_octave() {
        // Same reasoning as the override path: 0.30 strength is not evidence.
        let v = reconcile(85.23, 0.9, second(170.4, 0.3), true);
        assert_eq!(v.bpm, 85.23);
        assert_eq!(v.method, TempoMethod::Disputed);
    }

    #[test]
    fn a_triplet_relation_is_no_longer_treated_as_a_miscount() {
        // 3:2 used to rescale the grid onto 180. It is no longer a trusted
        // relation, so against a confident grid it is a dispute.
        let v = reconcile(120.0, 0.95, second(180.0, 0.6), true);
        assert_eq!(v.bpm, 120.0);
        assert_eq!(v.method, TempoMethod::Disputed);

        // Against an unsure grid the second opinion may still win, but on the
        // strength of its own evidence rather than on the ratio.
        let v = reconcile(120.0, 0.6, second(180.0, 0.6), true);
        assert_eq!(v.bpm, 180.0);
        assert_eq!(v.method, TempoMethod::SecondOpinion);
    }

    #[test]
    fn the_ratios_cannot_collide_within_the_tolerance() {
        // Two ratios matching the same reading would make the result depend on
        // the order of the list rather than on the music.
        for (i, a) in METRICAL_RATIOS.iter().enumerate() {
            for b in &METRICAL_RATIOS[i + 1..] {
                let apart = (a / b - 1.0).abs();
                assert!(
                    apart > AGREEMENT_TOLERANCE * 2.0,
                    "ratios {a} and {b} are only {:.1}% apart",
                    apart * 100.0
                );
            }
        }
    }

    #[test]
    fn a_confident_grid_is_not_overruled_by_an_unrelated_estimate() {
        // Edward's "Bebe": 120.36 at 0.97 across every window, against a 159.9
        // percussion harmonic. Reporting 160 here was the bug.
        let v = reconcile(120.36, 0.97, second(159.9, 0.6), true);
        assert_eq!(v.bpm, 120.36);
        assert_eq!(v.method, TempoMethod::Disputed);
    }

    #[test]
    fn an_unrelated_but_strong_estimate_overrules_an_unsure_grid() {
        let v = reconcile(103.0, 0.66, second(165.0, 0.8), true);
        assert_eq!(v.bpm, 165.0);
        assert_eq!(v.method, TempoMethod::SecondOpinion);
        assert!(v.confidence <= 0.66, "confidence must not rise on a guess");
    }

    #[test]
    fn an_unrelated_weak_estimate_leaves_the_grid_but_says_so() {
        let v = reconcile(103.0, 0.66, second(165.0, 0.2), true);
        assert_eq!(v.bpm, 103.0, "a weak guess must not overrule the measurement");
        assert_eq!(v.method, TempoMethod::Disputed);
        assert!(v.confidence <= 0.3, "a disputed tempo must read as unreliable");
    }

    #[test]
    fn confidence_never_rises_on_disagreement() {
        for (bpm, strength) in [(165.0, 0.9), (165.0, 0.1), (99.0, 0.55)] {
            let v = reconcile(103.0, 0.5, second(bpm, strength), true);
            assert!(v.confidence <= 0.5, "{bpm}/{strength} raised confidence");
        }
    }

    #[test]
    fn material_without_a_steady_pulse_is_disputed_rather_than_rescaled() {
        // The same reading that would be rescaled on a house record is left
        // alone on a ballad: an octave relation between two detectors is only
        // evidence of a miscount when the music has one obvious pulse.
        let v = reconcile(124.68, 0.89, second(61.22, 0.8), false);
        assert_eq!(v.bpm, 124.68);
        assert_eq!(v.method, TempoMethod::Disputed);

        let v = reconcile(124.68, 0.89, second(61.22, 0.8), true);
        assert_eq!(v.method, TempoMethod::Rescaled);
    }

    #[test]
    fn nonsense_input_falls_back_to_the_grid() {
        assert_eq!(reconcile(128.0, 0.5, second(0.0, 0.9), true).method, TempoMethod::BeatGrid);
        assert_eq!(reconcile(0.0, 0.5, second(128.0, 0.9), true).method, TempoMethod::BeatGrid);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    const SR: u32 = 44_100;

    /// A click track: a short percussive burst every `interval` seconds, which
    /// is about the most unambiguous tempo signal there is.
    fn click_track(bpm: f64, seconds: f64) -> Vec<f32> {
        let total = (SR as f64 * seconds) as usize;
        let interval = (60.0 / bpm * SR as f64) as usize;
        let mut out = vec![0.0f32; total];
        let click_len = (SR as usize) / 100; // 10 ms
        let mut pos = 0;
        while pos < total {
            for i in 0..click_len.min(total - pos) {
                // Decaying burst of noise-ish tone, so onset detection sees an
                // unmistakable transient.
                let decay = 1.0 - (i as f32 / click_len as f32);
                out[pos + i] = (i as f32 * 0.7).sin() * decay * 0.9;
            }
            pos += interval;
        }
        out
    }

    /// Sine tones stacked into a triad, at a fixed root.
    fn chord(freqs: &[f32], seconds: f64) -> Vec<f32> {
        let total = (SR as f64 * seconds) as usize;
        (0..total)
            .map(|n| {
                let t = n as f32 / SR as f32;
                freqs.iter().map(|f| (2.0 * PI * f * t).sin()).sum::<f32>() / freqs.len() as f32 * 0.8
            })
            .collect()
    }

    #[test]
    fn detects_the_tempo_of_a_click_track() {
        let audio = click_track(120.0, 30.0);
        let tempo = bpm::detect(&audio, SR).expect("tempo detected");
        // Octave errors are the classic failure mode, so accept half and double
        // time — the web app's own bpmDelta does the same.
        let ok = (tempo.bpm - 120.0).abs() < 3.0
            || (tempo.bpm - 60.0).abs() < 3.0
            || (tempo.bpm - 240.0).abs() < 3.0;
        assert!(ok, "expected ~120 BPM (or an octave of it), got {}", tempo.bpm);
    }

    #[test]
    fn detects_a_different_tempo_too() {
        let audio = click_track(90.0, 30.0);
        let tempo = bpm::detect(&audio, SR).expect("tempo detected");
        let ok = (tempo.bpm - 90.0).abs() < 4.0
            || (tempo.bpm - 45.0).abs() < 4.0
            || (tempo.bpm - 180.0).abs() < 4.0;
        assert!(ok, "expected ~90 BPM (or an octave of it), got {}", tempo.bpm);
    }

    #[test]
    fn rejects_audio_that_is_too_short_to_judge() {
        assert!(matches!(
            bpm::detect(&[0.0; 100], SR),
            Err(bpm::BpmError::TooShort { .. })
        ));
        assert!(matches!(
            key::detect(&[0.0; 100], SR),
            Err(key::KeyError::TooShort { .. })
        ));
    }

    #[test]
    fn detects_the_key_of_a_sustained_triad() {
        // A minor: A4 440, C5 523.25, E5 659.25.
        let audio = chord(&[440.0, 523.25, 659.25], 20.0);
        let detected = key::detect(&audio, SR).expect("key detected");
        // Pure tones are an easier case than real music, but relative
        // major/minor confusion is still the expected near-miss, so accept the
        // relative major (C major, 8B) alongside A minor (8A).
        let code = detected.camelot.code();
        assert!(
            code == "8A" || code == "8B",
            "expected A minor (8A) or its relative major (8B), got {code} ({})",
            detected.musical.name()
        );
    }

    #[test]
    fn reports_silence_rather_than_inventing_a_key() {
        let silence = vec![0.0f32; SR as usize * 10];
        assert!(matches!(key::detect(&silence, SR), Err(key::KeyError::Silence)));
    }

    #[test]
    fn full_analysis_produces_a_mergeable_result() {
        let mut audio = click_track(128.0, 25.0);
        // Mix a tonal bed under the clicks so both detectors have something.
        for (i, s) in chord(&[440.0, 523.25, 659.25], 25.0).iter().enumerate() {
            if i < audio.len() {
                audio[i] = (audio[i] + s * 0.5).clamp(-1.0, 1.0);
            }
        }
        let analysis = analyze_samples(&audio, SR).expect("analysis succeeded");
        assert!(analysis.bpm > 20.0 && analysis.bpm < 300.0);
        assert!(!analysis.camelot.is_empty());

        let result = analysis.into_result("2026-09-04T12:00:00Z", "0.1.0");
        assert_eq!(result.analyzer_version, "0.1.0");
        assert!(analyzer_core::camelot::Camelot::parse(&result.key).is_some());
    }
}
