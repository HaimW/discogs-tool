//! Tempo detection via aubio.
//!
//! aubio's tempo object is a streaming detector: audio is pushed through it one
//! hop at a time, and it refines a running tempo estimate. We feed the whole
//! track and read the final estimate plus aubio's own confidence value.

use std::ffi::CString;

use crate::ffi;

/// Window and hop sizes aubio's own tempo example uses. Large enough to see a
/// bar or so of context, small enough to track a drifting tempo.
const BUF_SIZE: u32 = 1024;
const HOP_SIZE: u32 = 512;

/// aubio's confidence is unbounded ("the higher the more confidence, `0` if no
/// consistent value is found" — tempo.h). Measured values on clean material sit
/// around 1.2-1.6, so this is where we call it "certain". Anything above simply
/// saturates.
const CONFIDENCE_CEILING: f64 = 1.5;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tempo {
    pub bpm: f64,
    /// Normalised 0-1, safe to render as a percentage.
    pub confidence: f64,
    /// aubio's raw, unbounded score. Kept because the ceiling above is a
    /// judgement call, and recalibrating it later needs the original numbers.
    pub confidence_raw: f64,
}

#[derive(Debug)]
pub enum BpmError {
    /// Not enough audio to fill a single analysis window.
    TooShort { samples: usize },
    /// aubio refused to construct its detector.
    DetectorUnavailable,
    /// aubio produced a tempo outside anything musically plausible.
    Implausible { bpm: f64 },
}

impl std::fmt::Display for BpmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BpmError::TooShort { samples } => {
                write!(f, "audio too short for tempo detection ({samples} samples)")
            }
            BpmError::DetectorUnavailable => write!(f, "aubio could not create a tempo detector"),
            BpmError::Implausible { bpm } => write!(f, "implausible tempo detected ({bpm:.1} BPM)"),
        }
    }
}

impl std::error::Error for BpmError {}

/// Detect the tempo of mono audio.
pub fn detect(samples: &[f32], sample_rate: u32) -> Result<Tempo, BpmError> {
    if samples.len() < BUF_SIZE as usize {
        return Err(BpmError::TooShort { samples: samples.len() });
    }

    // SAFETY: every pointer below comes from aubio's own constructors and is
    // released on all paths by the guards. The input vector's `data` buffer is
    // owned by aubio and only written within its stated length.
    unsafe {
        let method = CString::new("default").expect("no interior nul");
        let tempo = ffi::new_aubio_tempo(method.as_ptr(), BUF_SIZE, HOP_SIZE, sample_rate);
        if tempo.is_null() {
            return Err(BpmError::DetectorUnavailable);
        }
        let _tempo_guard = Guard(|| ffi::del_aubio_tempo(tempo));

        let input = ffi::new_fvec(HOP_SIZE);
        let output = ffi::new_fvec(2);
        if input.is_null() || output.is_null() {
            if !input.is_null() {
                ffi::del_fvec(input);
            }
            if !output.is_null() {
                ffi::del_fvec(output);
            }
            return Err(BpmError::DetectorUnavailable);
        }
        let _in_guard = Guard(|| ffi::del_fvec(input));
        let _out_guard = Guard(|| ffi::del_fvec(output));

        let hop = HOP_SIZE as usize;
        for chunk in samples.chunks_exact(hop) {
            let dst = std::slice::from_raw_parts_mut((*input).data, hop);
            for (d, s) in dst.iter_mut().zip(chunk) {
                *d = *s as ffi::smpl_t;
            }
            ffi::aubio_tempo_do(tempo, input, output);
        }

        let bpm = ffi::aubio_tempo_get_bpm(tempo) as f64;
        let confidence_raw = ffi::aubio_tempo_get_confidence(tempo) as f64;

        // aubio reports 0 when it never locked onto a beat, and anything
        // outside this range is not a tempo any DJ tool should record.
        if !(20.0..=300.0).contains(&bpm) {
            return Err(BpmError::Implausible { bpm });
        }
        Ok(Tempo {
            bpm,
            confidence: (confidence_raw / CONFIDENCE_CEILING).clamp(0.0, 1.0),
            confidence_raw,
        })
    }
}

/// Runs a closure on drop, so an early return still frees aubio's allocations.
struct Guard<F: FnMut()>(F);

impl<F: FnMut()> Drop for Guard<F> {
    fn drop(&mut self) {
        (self.0)()
    }
}
