//! Tempo detection via aubio.
//!
//! aubio's tempo object is a streaming detector: audio is pushed through it one
//! hop at a time and it reports each beat as it passes.
//!
//! **We do not use `aubio_tempo_get_bpm`.** That value is a running estimate
//! derived from recent inter-beat intervals, and it is measurably biased:
//! against click tracks whose tempo is exact by construction it reads high by
//! +0.98% at 90 BPM rising to +1.76% at 150 BPM (mean +1.43%). On a 128 BPM
//! track that is nearly 2 BPM — enough to put a beatmatched transition out by a
//! beat over a 32-bar blend, which is exactly what this tool exists to prevent.
//!
//! Instead we collect the beat positions aubio reports (`aubio_tempo_get_last`,
//! exact in samples) and fit the beat grid ourselves. Fitting a line through
//! several hundred beat positions cancels any constant offset in where a beat
//! is placed, which is what the bias turned out to be: the period was short by
//! a roughly constant ~7 ms regardless of tempo.

use std::ffi::CString;

use crate::ffi;

/// Window and hop sizes aubio's own tempo example uses. Large enough to see a
/// bar or so of context, small enough to track a drifting tempo.
const BUF_SIZE: u32 = 1024;
const HOP_SIZE: u32 = 512;

/// Below this many beats there is not enough of a grid to fit, and we fall back
/// to aubio's own estimate rather than reporting something worse.
const MIN_BEATS_FOR_FIT: usize = 8;

/// An interval this far from the median is a missed or doubled beat, not a
/// tempo change: excluded from the fit, and counted against the confidence.
const INTERVAL_TOLERANCE: f64 = 0.10;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tempo {
    pub bpm: f64,
    /// Normalised 0-1: the share of inter-beat intervals that agree with the
    /// track's median interval to within 10%.
    ///
    /// This is a measured property of the beat grid, not a library score, so it
    /// means something concrete — "94%" is "94% of the gaps between detected
    /// beats were the same length". A steady four-to-the-floor record scores in
    /// the high 90s; a rubato or live-drummed one scores low and is worth
    /// sending for review.
    pub confidence: f64,
    /// aubio's own unbounded confidence score, kept purely as a diagnostic.
    /// Not used to compute [`Tempo::confidence`] — see the module docs.
    pub confidence_raw: f64,
    /// How many beats the grid was fitted through.
    pub beats: usize,
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

    let (beats, aubio_bpm, raw_conf) = collect_beats(samples, sample_rate)?;
    let (bpm, confidence) = match fit_grid(&beats, sample_rate, aubio_bpm) {
        Some(fit) => fit,
        // Too few beats to fit: fall back to aubio's estimate, and say so by
        // reporting no confidence in the grid.
        None => (aubio_bpm, 0.0),
    };

    // aubio reports 0 when it never locked onto a beat, and anything outside
    // this range is not a tempo any DJ tool should record.
    if !(20.0..=300.0).contains(&bpm) {
        return Err(BpmError::Implausible { bpm });
    }
    Ok(Tempo { bpm, confidence, confidence_raw: raw_conf, beats: beats.len() })
}

/// Push the audio through aubio and collect every beat position, in samples.
fn collect_beats(samples: &[f32], sample_rate: u32) -> Result<(Vec<f64>, f64, f64), BpmError> {
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
        let mut beats: Vec<f64> = Vec::new();
        let mut last_recorded = u32::MAX;
        // `chunks_exact` drops a final partial hop of at most 511 samples
        // (~12 ms). That cannot shift a grid fitted over the whole track.
        for chunk in samples.chunks_exact(hop) {
            let dst = std::slice::from_raw_parts_mut((*input).data, hop);
            for (d, s) in dst.iter_mut().zip(chunk) {
                *d = *s as ffi::smpl_t;
            }
            ffi::aubio_tempo_do(tempo, input, output);
            let fired = *std::slice::from_raw_parts((*output).data, 1).first().unwrap_or(&0.0);
            if fired != 0.0 {
                // Exact sample position, not the hop index — the hop grid is
                // 11.6 ms coarse and would blunt the fit.
                let at = ffi::aubio_tempo_get_last(tempo);
                if at != last_recorded {
                    beats.push(at as f64);
                    last_recorded = at;
                }
            }
        }

        Ok((
            beats,
            ffi::aubio_tempo_get_bpm(tempo) as f64,
            ffi::aubio_tempo_get_confidence(tempo) as f64,
        ))
    }
}

/// Derive the beat period from the detected beat positions, returning
/// `(bpm, confidence)`. Returns `None` when there are too few beats.
///
/// The trick that removes the bias is that we work in **differences** between
/// consecutive beat positions. Whatever constant offset aubio applies when it
/// decides where a beat sits cancels exactly in `b[i+1] - b[i]`, so an average
/// of those gaps is unbiased even though aubio's own running estimate is not.
///
/// The complication is that aubio drops beats — on quiet passages, breakdowns
/// and intros it loses lock — which leaves gaps of exactly 2x, 3x or 12x the
/// true period. Averaging those in would stretch the period and report a tempo
/// far too low, so multi-beat gaps have to be excluded rather than averaged.
/// aubio's own estimate is used only to bracket which gaps are single beats;
/// it is close enough for that (within a couple of percent) even though it is
/// not accurate enough to report.
fn fit_grid(beats: &[f64], sample_rate: u32, seed_bpm: f64) -> Option<(f64, f64)> {
    if beats.len() < MIN_BEATS_FOR_FIT {
        return None;
    }
    let intervals: Vec<f64> = beats.windows(2).map(|w| w[1] - w[0]).collect();
    if !(20.0..=300.0).contains(&seed_bpm) {
        return None;
    }
    let seed_period = 60.0 * sample_rate as f64 / seed_bpm;

    // Gaps that plausibly span a single beat. The window is wide because the
    // seed is only approximate; it just has to separate 1x gaps from 2x ones.
    let singles: Vec<f64> = intervals
        .iter()
        .copied()
        .filter(|i| *i > seed_period * 0.5 && *i < seed_period * 1.5)
        .collect();
    if singles.len() < MIN_BEATS_FOR_FIT {
        return None;
    }

    // Median first (immune to the odd straggler), then average the gaps that
    // agree with it. The trimmed mean is what buys back the precision: hundreds
    // of independent gaps average down the per-beat placement jitter.
    let median = median_of(&singles)?;
    if median <= 0.0 {
        return None;
    }
    let kept: Vec<f64> = singles
        .iter()
        .copied()
        .filter(|i| ((*i - median) / median).abs() <= INTERVAL_TOLERANCE)
        .collect();
    if kept.is_empty() {
        return None;
    }
    let period = kept.iter().sum::<f64>() / kept.len() as f64;
    if period <= 0.0 {
        return None;
    }

    // Confidence is measured over EVERY gap, including the dropped-beat ones
    // excluded above — a track aubio kept losing its place in genuinely is a
    // less certain reading, and the number should say so.
    let agreeing = intervals
        .iter()
        .filter(|i| ((*i - period) / period).abs() <= INTERVAL_TOLERANCE)
        .count();
    let confidence = agreeing as f64 / intervals.len() as f64;

    Some((60.0 * sample_rate as f64 / period, confidence))
}

fn median_of(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut v = values.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    Some(v[v.len() / 2])
}

/// Runs a closure on drop, so an early return still frees aubio's allocations.
struct Guard<F: FnMut()>(F);

impl<F: FnMut()> Drop for Guard<F> {
    fn drop(&mut self) {
        (self.0)()
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 44_100;

    /// Beat positions for `count` beats at `bpm`, with an optional constant
    /// offset applied to every beat and an optional set of dropped indices.
    fn grid(bpm: f64, count: usize, offset: f64, drop_every: Option<usize>) -> Vec<f64> {
        let period = 60.0 / bpm * SR as f64;
        (0..count)
            .filter(|i| drop_every.is_none_or(|d| i % d != 0 || *i == 0))
            .map(|i| i as f64 * period + offset)
            .collect()
    }

    #[test]
    fn a_perfect_grid_reports_its_exact_tempo() {
        let (bpm, conf) = fit_grid(&grid(128.0, 200, 0.0, None), SR, 130.0).unwrap();
        assert!((bpm - 128.0).abs() < 0.01, "expected 128, got {bpm}");
        assert!((conf - 1.0).abs() < 1e-9, "a perfect grid is fully consistent, got {conf}");
    }

    /// The bug this module exists to avoid: aubio's own estimate read high by
    /// +1.43% on average because the beat period was short by a roughly constant
    /// ~7 ms. Working in differences must make any such constant offset vanish.
    #[test]
    fn a_constant_placement_offset_does_not_shift_the_tempo() {
        let offset = 0.007 * SR as f64;
        let (bpm, _) = fit_grid(&grid(128.0, 200, offset, None), SR, 130.0).unwrap();
        assert!(
            (bpm - 128.0).abs() < 0.01,
            "a constant offset must cancel in the intervals, got {bpm}"
        );
    }

    /// aubio loses lock in breakdowns and intros, leaving 2x and 3x gaps. Those
    /// must be excluded, not averaged in — averaging them stretches the period
    /// and reports a tempo far too low.
    #[test]
    fn dropped_beats_do_not_drag_the_tempo_down() {
        let beats = grid(128.0, 200, 0.0, Some(4));
        let (bpm, conf) = fit_grid(&beats, SR, 130.0).unwrap();
        assert!((bpm - 128.0).abs() < 0.05, "expected 128 despite gaps, got {bpm}");
        assert!(
            conf < 0.95,
            "a grid this full of holes should not claim near-certainty, got {conf}"
        );
    }

    #[test]
    fn per_beat_jitter_averages_out() {
        let period = 60.0 / 128.0 * SR as f64;
        // Deterministic +/- 3 ms wobble, far larger than real placement jitter.
        let beats: Vec<f64> = (0..300)
            .map(|i| {
                let wobble = if i % 2 == 0 { 0.003 } else { -0.003 } * SR as f64;
                i as f64 * period + wobble
            })
            .collect();
        let (bpm, _) = fit_grid(&beats, SR, 130.0).unwrap();
        assert!((bpm - 128.0).abs() < 0.1, "jitter should average out, got {bpm}");
    }

    #[test]
    fn too_few_beats_is_not_a_fit() {
        assert!(fit_grid(&grid(128.0, 4, 0.0, None), SR, 130.0).is_none());
        assert!(fit_grid(&[], SR, 130.0).is_none());
    }

    #[test]
    fn an_implausible_seed_is_refused_rather_than_trusted() {
        // A seed outside musical range means aubio never locked on; bracketing
        // single-beat gaps against it would be meaningless.
        assert!(fit_grid(&grid(128.0, 200, 0.0, None), SR, 0.0).is_none());
        assert!(fit_grid(&grid(128.0, 200, 0.0, None), SR, 5000.0).is_none());
    }

    #[test]
    fn confidence_falls_when_the_grid_is_irregular() {
        let period = 60.0 / 128.0 * SR as f64;
        // Half the gaps are a completely different length: a medley, not a track.
        let mut beats = vec![0.0];
        for i in 1..200 {
            let step = if i % 2 == 0 { period } else { period * 1.4 };
            beats.push(beats[i - 1] + step);
        }
        let (_, conf) = fit_grid(&beats, SR, 130.0).unwrap();
        assert!(conf < 0.7, "an irregular grid should report low confidence, got {conf}");
    }
}
