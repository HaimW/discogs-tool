//! A second, independent tempo estimate for material the beat tracker struggles
//! with.
//!
//! aubio's tempo object is a *causal beat tracker*: it follows the pulse as the
//! audio streams past, deciding where each beat falls from what it has heard so
//! far. That works well on four-to-the-floor material and badly on syncopated
//! breaks, where it can lock onto a secondary pulse and stay there — reporting
//! a grid that is internally consistent (so the agreement confidence stays
//! respectable) but counts the wrong thing.
//!
//! This module fails differently on purpose. It builds an onset envelope,
//! autocorrelates the whole of it, and asks which period best explains the
//! track *globally*. It never tracks anything, so it cannot follow a wrong
//! pulse; its weakness is the opposite one, poor precision, because its
//! resolution is limited by the frame rate.
//!
//! The two are therefore complementary, and used that way: aubio supplies the
//! precise figure, this supplies the sanity check on which pulse that figure is
//! counting. See `reconcile` in the crate root.

/// Frames per second of the onset envelope: 44.1 kHz over a 512-sample hop is
/// about 86 Hz, matching the tempo detector's own hop so the two see the same
/// time resolution.
const HOP: usize = 512;

/// The search range, before folding. Wider than any band we report into, so the
/// estimate is free to land on a subdivision and be folded afterwards rather
/// than being clamped into a preconception.
const SEARCH_MIN_BPM: f64 = 55.0;
const SEARCH_MAX_BPM: f64 = 220.0;

/// How many multiples of a candidate period are summed. A real beat period
/// shows autocorrelation peaks at 1x, 2x, 3x... its own length; a subdivision
/// only lines up at some of them. Summing across four rewards the period that
/// explains the most structure, which is what stops the estimate settling on
/// double time.
const COMB_TEETH: usize = 4;

/// Tempo resolution of the candidate sweep. Fine enough that the step is never
/// the limiting factor: 0.1 BPM is under a tenth of the precision the beat-grid
/// fit claims, and this estimate exists to pick the right pulse, not to be the
/// figure that gets reported.
const SEARCH_STEP_BPM: f64 = 0.1;

/// Centre of the tempo prior, in BPM.
///
/// A comb filter cannot tell a tempo from half of it: at period 2P the teeth
/// land on 2P, 4P, 6P, 8P, every one of them a real beat, so it scores exactly
/// what period P scores. Something outside the correlation has to break the
/// tie, and "music is usually nearer 125 than 62" is the honest form of that
/// something. It is a weak thumb on the scale, not a decision.
const PRIOR_CENTRE_BPM: f64 = 125.0;

/// Width of the prior in octaves. Wide enough that 170 and 85 are both credible
/// and only the tie is broken, rather than the answer being decided in advance.
const PRIOR_OCTAVES: f64 = 1.1;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Estimate {
    pub bpm: f64,
    /// 0-1. How far the winning period stood above the average candidate —
    /// a flat autocorrelation means no periodicity was found and the figure
    /// below is not worth much.
    pub strength: f64,
}

/// Estimate tempo by autocorrelating an onset envelope.
///
/// Returns `None` when the audio is too short to hold several beats, or when
/// nothing periodic was found at all.
pub fn estimate(samples: &[f32], sample_rate: u32) -> Option<Estimate> {
    if sample_rate == 0 {
        return None;
    }
    let envelope = onset_envelope(samples);
    let frame_rate = sample_rate as f64 / HOP as f64;

    let longest_period = frame_rate * 60.0 / SEARCH_MIN_BPM;
    // Enough envelope for the slowest candidate to be seen by every comb tooth.
    if envelope.len() < (longest_period * COMB_TEETH as f64) as usize {
        return None;
    }
    let acf = autocorrelation(&envelope, (longest_period * COMB_TEETH as f64) as usize + 2);

    // Candidates are swept in tempo rather than in whole frames. Scoring an
    // integer lag and then its integer multiples is what a first attempt did,
    // and it fails: rounding the period to a frame puts the fourth comb tooth
    // most of a frame out of place, so the true tempo scores worse than a 3:2
    // relative whose multiples happen to land squarely. Interpolating a
    // fractional period removes the problem at the root.
    let mut best: Option<(f64, f64)> = None;
    let mut total = 0.0;
    let mut count = 0.0;
    let mut bpm = SEARCH_MIN_BPM;
    while bpm <= SEARCH_MAX_BPM {
        let period = frame_rate * 60.0 / bpm;
        let score = comb_score(&acf, period) * prior(bpm);
        total += score;
        count += 1.0;
        if best.is_none_or(|(_, b)| score > b) {
            best = Some((bpm, score));
        }
        bpm += SEARCH_STEP_BPM;
    }

    let (bpm, score) = best?;
    if !score.is_finite() || score <= 0.0 {
        return None;
    }
    let mean = total / count;
    let strength = if mean.is_finite() && mean > 0.0 {
        ((score - mean) / score).clamp(0.0, 1.0)
    } else {
        0.0
    };
    Some(Estimate { bpm, strength })
}

/// Log-normal weighting over tempo, centred on [`PRIOR_CENTRE_BPM`].
fn prior(bpm: f64) -> f64 {
    let octaves = (bpm / PRIOR_CENTRE_BPM).log2() / PRIOR_OCTAVES;
    (-0.5 * octaves * octaves).exp()
}

/// Unnormalised-by-lag autocorrelation, divided by the overlap at each lag so
/// long lags are not penalised for being measured over less material.
fn autocorrelation(env: &[f64], max_lag: usize) -> Vec<f64> {
    let max_lag = max_lag.min(env.len().saturating_sub(1));
    (0..=max_lag)
        .map(|lag| {
            let overlap = env.len() - lag;
            if overlap == 0 {
                return 0.0;
            }
            let sum: f64 = env[..overlap].iter().zip(&env[lag..]).map(|(a, b)| a * b).sum();
            sum / overlap as f64
        })
        .collect()
}

/// Sum the autocorrelation at the first [`COMB_TEETH`] multiples of `period`.
///
/// A real beat period lines up with itself at 1x, 2x, 3x and 4x its length; a
/// subdivision or a 3:2 relative only lines up at some of them. Averaging over
/// the teeth is what picks the pulse that explains the most structure.
fn comb_score(acf: &[f64], period: f64) -> f64 {
    if period <= 0.0 {
        return 0.0;
    }
    let mut total = 0.0;
    let mut teeth = 0.0;
    for tooth in 1..=COMB_TEETH {
        let lag = period * tooth as f64;
        if lag as usize + 1 >= acf.len() {
            break;
        }
        total += interpolate(acf, lag);
        teeth += 1.0;
    }
    if teeth == 0.0 {
        0.0
    } else {
        total / teeth
    }
}

/// Linear interpolation into the autocorrelation at a fractional lag.
fn interpolate(acf: &[f64], lag: f64) -> f64 {
    let low = lag.floor() as usize;
    if low + 1 >= acf.len() {
        return *acf.last().unwrap_or(&0.0);
    }
    let fraction = lag - low as f64;
    acf[low] * (1.0 - fraction) + acf[low + 1] * fraction
}

/// A crude onset envelope: how much louder each frame is than the one before.
///
/// Rectified, so only increases count — a beat is where energy arrives, not
/// where it leaves. Computed on frame energy rather than a spectrum because it
/// needs no FFT, and for percussive material the difference is not worth the
/// dependency.
fn onset_envelope(samples: &[f32]) -> Vec<f64> {
    let frames: Vec<f64> = samples
        .chunks(HOP)
        .map(|c| {
            let sum: f64 = c.iter().map(|s| (*s as f64) * (*s as f64)).sum();
            // Log energy: a kick 20 dB above the floor should not swamp the
            // whole envelope the way raw power would.
            (sum / c.len().max(1) as f64 + 1e-12).log10()
        })
        .collect();

    let mut env: Vec<f64> = frames.windows(2).map(|w| (w[1] - w[0]).max(0.0)).collect();
    // Remove slow drift so a long crescendo cannot outweigh the beats. The
    // window has to be several beats wide: averaged over less than a beat, the
    // beats themselves become the drift and get subtracted away.
    subtract_moving_average(&mut env, 128);
    // A gentle blur, so a peak landing a frame either side of where the comb
    // expects it still correlates. Without it the estimate is hostage to the
    // 11.6 ms frame grid.
    smooth(&mut env, 1);
    env
}

fn subtract_moving_average(env: &mut [f64], window: usize) {
    if env.is_empty() || window == 0 {
        return;
    }
    let smoothed: Vec<f64> = (0..env.len())
        .map(|i| {
            let lo = i.saturating_sub(window);
            let hi = (i + window + 1).min(env.len());
            env[lo..hi].iter().sum::<f64>() / (hi - lo) as f64
        })
        .collect();
    for (value, mean) in env.iter_mut().zip(smoothed) {
        *value = (*value - mean).max(0.0);
    }
}

/// Box blur of radius `radius` frames, in place.
fn smooth(env: &mut [f64], radius: usize) {
    if env.is_empty() || radius == 0 {
        return;
    }
    let source = env.to_vec();
    for (i, value) in env.iter_mut().enumerate() {
        let lo = i.saturating_sub(radius);
        let hi = (i + radius + 1).min(source.len());
        *value = source[lo..hi].iter().sum::<f64>() / (hi - lo) as f64;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 44_100;

    /// A click track: one short burst per beat, silence between.
    fn clicks(bpm: f64, seconds: f64) -> Vec<f32> {
        let total = (SR as f64 * seconds) as usize;
        let period = (60.0 / bpm * SR as f64) as usize;
        let mut out = vec![0.0f32; total];
        let mut at = 0;
        while at < total {
            for i in 0..(SR as usize / 100).min(total - at) {
                let decay = 1.0 - i as f32 / (SR as f32 / 100.0);
                out[at + i] = decay * if i % 8 < 4 { 0.8 } else { -0.8 };
            }
            at += period;
        }
        out
    }

    #[test]
    fn a_click_track_is_measured_within_a_couple_of_percent() {
        for target in [90.0, 120.0, 128.0, 140.0] {
            let e = estimate(&clicks(target, 40.0), SR)
                .unwrap_or_else(|| panic!("no estimate at {target}"));
            let error = (e.bpm - target).abs() / target;
            assert!(error < 0.03, "{target} BPM read as {:.2} ({:.1}%)", e.bpm, error * 100.0);
        }
    }

    #[test]
    fn a_fast_click_track_is_not_reported_at_half_speed() {
        // The comb filter exists for this: at 170 the naive peak is often the
        // 2-beat period, because every other onset also lines up there.
        let e = estimate(&clicks(170.0, 40.0), SR).expect("estimate");
        assert!((e.bpm - 170.0).abs() / 170.0 < 0.03, "read {:.2}", e.bpm);
    }

    #[test]
    fn silence_has_no_tempo_worth_reporting() {
        let silence = vec![0.0f32; SR as usize * 30];
        let strength = estimate(&silence, SR).map(|e| e.strength);
        assert!(
            strength.is_none_or(|s| s < 0.5),
            "silence reported strength {strength:?}"
        );
    }

    #[test]
    fn audio_too_short_to_hold_several_beats_is_refused() {
        assert!(estimate(&clicks(120.0, 1.0), SR).is_none());
    }

}
