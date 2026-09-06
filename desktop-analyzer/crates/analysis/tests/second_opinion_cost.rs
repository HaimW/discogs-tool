//! What cross-checking every track actually costs.
//!
//!   cargo test --release -p analyzer-analysis --test second_opinion_cost -- --nocapture

use std::time::Instant;

use analyzer_core::tempo::{SecondOpinion, TempoHint};

const SR: u32 = 44_100;

/// Noisy percussive audio, long enough to be representative of a real track
/// rather than of something that fits in cache.
fn audio(seconds: f64, bpm: f64) -> Vec<f32> {
    let total = (SR as f64 * seconds) as usize;
    let period = (60.0 / bpm * SR as f64) as usize;
    let mut out = vec![0.0f32; total];
    let mut seed = 12345u32;
    for (i, sample) in out.iter_mut().enumerate() {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        let noise = (seed >> 16) as f32 / 32768.0 - 1.0;
        let hit = (1.0 - (i % period) as f32 / (SR as f32 * 0.08)).max(0.0);
        *sample = noise * 0.05 + hit * 0.7;
    }
    out
}

fn median_ms(mut runs: Vec<f64>) -> f64 {
    runs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    runs[runs.len() / 2]
}

#[test]
fn report_the_cost_of_cross_checking_every_track() {
    let samples = audio(300.0, 128.0);
    let reps = 5;

    let time = |policy| {
        median_ms(
            (0..reps)
                .map(|_| {
                    let start = Instant::now();
                    analyzer_analysis::analyze_samples_with(&samples, SR, policy, TempoHint::default())
                        .expect("analysed");
                    start.elapsed().as_secs_f64() * 1000.0
                })
                .collect(),
        )
    };

    let never = time(SecondOpinion::Never);
    let always = time(SecondOpinion::Always);
    let extra = (always - never).max(0.0);

    println!("\n5 minutes of audio, median of {reps} runs:");
    println!("  one detector          {never:>8.0} ms");
    println!("  cross-checked         {always:>8.0} ms");
    println!("  extra                 {extra:>8.1} ms  ({:.1}%)", 100.0 * extra / never);

    // What that means for a whole collection, against the part nobody can
    // optimise away: every track has to be downloaded before it can be read.
    let tracks = 3019.0;
    let download_seconds = 4.0;
    println!("\n  over {tracks:.0} tracks:");
    println!("    extra analysis        {:>8.1} s", extra * tracks / 1000.0);
    println!("    download alone        {:>8.1} h", tracks * download_seconds / 3600.0);
    println!(
        "    extra as a share of the run   {:.3}%",
        100.0 * (extra / 1000.0) / download_seconds
    );
}
