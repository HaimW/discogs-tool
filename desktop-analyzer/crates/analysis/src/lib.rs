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
    /// The tempo before octave folding, when folding moved it.
    pub bpm_folded_from: Option<f64>,
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
            bpm_folded_from: self.bpm_folded_from,
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
pub fn analyze_file(path: &Path, band: bpm::TempoBand) -> Result<Analysis, AnalysisError> {
    analyze_file_with(path, band, false)
}

/// Decode and analyse one audio file, optionally taking a second opinion on the
/// tempo. See [`analyze_samples_with`].
pub fn analyze_file_with(
    path: &Path,
    band: bpm::TempoBand,
    syncopated: bool,
) -> Result<Analysis, AnalysisError> {
    let audio = decode::decode_file(path).map_err(AnalysisError::Decode)?;
    analyze_samples_with(&audio.samples, audio.sample_rate, band, syncopated)
}

/// Analyse mono samples that are already in memory.
pub fn analyze_samples(
    samples: &[f32],
    sample_rate: u32,
    band: bpm::TempoBand,
) -> Result<Analysis, AnalysisError> {
    analyze_samples_with(samples, sample_rate, band, false)
}

/// Below this grid agreement, a syncopated track gets a second opinion.
///
/// Set where it is because a causal beat tracker that has locked onto the wrong
/// pulse still reports a *consistent* grid — the confidence stays middling
/// rather than collapsing. The jungle tracks that prompted this scored 0.64 to
/// 0.76 while counting something that was not the beat.
pub const SECOND_OPINION_BELOW: f64 = 0.85;

/// Two tempos this close are the same tempo.
const AGREEMENT_TOLERANCE: f64 = 0.03;

/// Ratios a beat tracker plausibly miscounts by: half and double bars, and the
/// triplet relations that a shuffled break invites.
const METRICAL_RATIOS: &[f64] = &[2.0, 0.5, 1.5, 2.0 / 3.0, 3.0, 1.0 / 3.0, 4.0, 0.25];

/// How convincing the independent estimate must be before it is allowed to
/// overrule a grid it has no musical relation to.
const OVERRULE_STRENGTH: f64 = 0.5;

/// Analyse mono samples, optionally taking a second opinion on the tempo.
///
/// `syncopated` comes from the release's styles: breaks, jungle and their
/// relatives, where the beat tracker is known to lock onto the wrong pulse. The
/// second estimate costs an extra pass over the audio, so it is not taken for
/// the four-to-the-floor material that makes up most of a collection.
pub fn analyze_samples_with(
    samples: &[f32],
    sample_rate: u32,
    band: bpm::TempoBand,
    syncopated: bool,
) -> Result<Analysis, AnalysisError> {
    let tempo = bpm::detect(samples, sample_rate, band).map_err(AnalysisError::Bpm)?;
    let detected = key::detect(samples, sample_rate).map_err(AnalysisError::Key)?;
    // Energy is a nice-to-have: a track we could tempo- and key-detect but not
    // score for energy is still a useful result, so this never fails the run.
    let energy = energy::estimate(samples, sample_rate);

    let second = (syncopated && tempo.confidence < SECOND_OPINION_BELOW)
        .then(|| autocorr::estimate(samples, sample_rate, band))
        .flatten();
    let verdict = reconcile(tempo.bpm, tempo.confidence, second);

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
        bpm_folded_from: tempo.folded_from.map(round2),
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
fn reconcile(grid_bpm: f64, grid_confidence: f64, second: Option<autocorr::Estimate>) -> Verdict {
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

    // They differ by a musical ratio: the grid was counting half-bars or
    // triplets. Keep its precision and move it onto the right pulse.
    for ratio in METRICAL_RATIOS {
        if (second.bpm / (grid_bpm * ratio) - 1.0).abs() <= AGREEMENT_TOLERANCE {
            return Verdict {
                bpm: grid_bpm * ratio,
                confidence: grid_confidence,
                method: TempoMethod::Rescaled,
            };
        }
    }

    // No relation at all. On syncopated material a strong global periodicity is
    // the better bet than a tracker that has already told us it is unsure — but
    // only when it is genuinely strong, and the result is still marked as the
    // guess it is.
    if second.strength >= OVERRULE_STRENGTH {
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
        let v = reconcile(128.0, 0.7, None);
        assert_eq!(v.bpm, 128.0);
        assert_eq!(v.confidence, 0.7);
        assert_eq!(v.method, TempoMethod::BeatGrid);
    }

    #[test]
    fn agreement_keeps_the_precise_figure_and_raises_confidence() {
        // The autocorrelation is the imprecise one, so its number is never the
        // one reported when the two agree.
        let v = reconcile(128.0, 0.7, second(127.5, 0.6));
        assert_eq!(v.bpm, 128.0);
        assert!(v.confidence >= SECOND_OPINION_BELOW);
        assert_eq!(v.method, TempoMethod::Confirmed);
    }

    #[test]
    fn a_grid_counting_half_bars_is_rescaled_not_replaced() {
        // The exact case this exists for: the tracker locked onto every other
        // beat of a 170 BPM break. 85 * 2 = 170, and 170.0 is more precise than
        // the autocorrelation's 168.
        let v = reconcile(85.0, 0.7, second(168.0, 0.6));
        assert!((v.bpm - 170.0).abs() < 1e-9, "got {}", v.bpm);
        assert_eq!(v.method, TempoMethod::Rescaled);
    }

    #[test]
    fn a_triplet_relation_is_recognised_too() {
        let v = reconcile(120.0, 0.6, second(180.0, 0.6));
        assert!((v.bpm - 180.0).abs() < 1e-9, "got {}", v.bpm);
        assert_eq!(v.method, TempoMethod::Rescaled);
    }

    #[test]
    fn an_unrelated_but_strong_estimate_overrules_an_unsure_grid() {
        let v = reconcile(103.0, 0.66, second(165.0, 0.8));
        assert_eq!(v.bpm, 165.0);
        assert_eq!(v.method, TempoMethod::SecondOpinion);
        assert!(v.confidence <= 0.66, "confidence must not rise on a guess");
    }

    #[test]
    fn an_unrelated_weak_estimate_leaves_the_grid_but_says_so() {
        let v = reconcile(103.0, 0.66, second(165.0, 0.2));
        assert_eq!(v.bpm, 103.0, "a weak guess must not overrule the measurement");
        assert_eq!(v.method, TempoMethod::Disputed);
        assert!(v.confidence <= 0.3, "a disputed tempo must read as unreliable");
    }

    #[test]
    fn confidence_never_rises_on_disagreement() {
        for (bpm, strength) in [(165.0, 0.9), (165.0, 0.1), (99.0, 0.55)] {
            let v = reconcile(103.0, 0.5, second(bpm, strength));
            assert!(v.confidence <= 0.5, "{bpm}/{strength} raised confidence");
        }
    }

    #[test]
    fn nonsense_input_falls_back_to_the_grid() {
        assert_eq!(reconcile(128.0, 0.5, second(0.0, 0.9)).method, TempoMethod::BeatGrid);
        assert_eq!(reconcile(0.0, 0.5, second(128.0, 0.9)).method, TempoMethod::BeatGrid);
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
        let tempo = bpm::detect(&audio, SR, bpm::TempoBand::default()).expect("tempo detected");
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
        let tempo = bpm::detect(&audio, SR, bpm::TempoBand::default()).expect("tempo detected");
        let ok = (tempo.bpm - 90.0).abs() < 4.0
            || (tempo.bpm - 45.0).abs() < 4.0
            || (tempo.bpm - 180.0).abs() < 4.0;
        assert!(ok, "expected ~90 BPM (or an octave of it), got {}", tempo.bpm);
    }

    #[test]
    fn rejects_audio_that_is_too_short_to_judge() {
        assert!(matches!(
            bpm::detect(&[0.0; 100], SR, bpm::TempoBand::default()),
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
        let analysis = analyze_samples(&audio, SR, bpm::TempoBand::default()).expect("analysis succeeded");
        assert!(analysis.bpm > 20.0 && analysis.bpm < 300.0);
        assert!(!analysis.camelot.is_empty());

        let result = analysis.into_result("2026-09-04T12:00:00Z", "0.1.0");
        assert_eq!(result.analyzer_version, "0.1.0");
        assert!(analyzer_core::camelot::Camelot::parse(&result.key).is_some());
    }
}
