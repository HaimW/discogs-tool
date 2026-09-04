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
            analyzed_at: analyzed_at.into(),
            analyzer_version: version.into(),
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
    let audio = decode::decode_file(path).map_err(AnalysisError::Decode)?;
    analyze_samples(&audio.samples, audio.sample_rate)
}

/// Analyse mono samples that are already in memory.
pub fn analyze_samples(samples: &[f32], sample_rate: u32) -> Result<Analysis, AnalysisError> {
    let tempo = bpm::detect(samples, sample_rate).map_err(AnalysisError::Bpm)?;
    let detected = key::detect(samples, sample_rate).map_err(AnalysisError::Key)?;
    // Energy is a nice-to-have: a track we could tempo- and key-detect but not
    // score for energy is still a useful result, so this never fails the run.
    let energy = energy::estimate(samples, sample_rate);
    Ok(Analysis {
        bpm: round2(tempo.bpm),
        // Three decimals is already finer than these numbers are meaningful to,
        // and it keeps the exported JSON readable.
        bpm_confidence: round3(tempo.confidence),
        camelot: detected.camelot.code(),
        key_musical: detected.musical.name(),
        key_strength: round3(detected.strength),
        key_segments: detected.segments,
        energy: energy.map(|e| e.level),
        duration_seconds: samples.len() as f64 / sample_rate.max(1) as f64,
    })
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
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
