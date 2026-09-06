//! What the second tempo estimate actually costs, measured rather than assumed.
//!
//! Run with `cargo test --release -p analyzer-analysis --test second_opinion_cost -- --nocapture`.

use std::time::Instant;

const SR: u32 = 44_100;

/// Five minutes of noisy percussive audio — long enough to be representative of
/// a real track rather than of a cache-friendly toy.
fn audio(seconds: f64, bpm: f64) -> Vec<f32> {
    let total = (SR as f64 * seconds) as usize;
    let period = (60.0 / bpm * SR as f64) as usize;
    let mut out = vec![0.0f32; total];
    let mut seed = 12345u32;
    for (i, sample) in out.iter_mut().enumerate() {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        let noise = (seed >> 16) as f32 / 32768.0 - 1.0;
        let phase = i % period;
        let hit = (1.0 - phase as f32 / (SR as f32 * 0.08)).max(0.0);
        *sample = noise * 0.05 + hit * 0.7;
    }
    out
}

#[test]
fn report_the_cost_of_a_second_opinion() {
    let samples = audio(300.0, 128.0);
    let band = analyzer_analysis::bpm::TempoBand::default();

    let start = Instant::now();
    let one = analyzer_analysis::analyze_samples_with(&samples, SR, band, false).expect("analysed");
    let without = start.elapsed();

    let start = Instant::now();
    let two = analyzer_analysis::analyze_samples_with(&samples, SR, band, true).expect("analysed");
    let with = start.elapsed();

    // The gate usually stops the second estimate ever running, which is the
    // point of it — so time the estimator on its own too, to get the cost that
    // a track meeting both conditions actually pays.
    let start = Instant::now();
    let second = analyzer_analysis::autocorr::estimate(&samples, SR, band);
    let alone = start.elapsed();

    println!("5 minutes of audio:");
    println!("  full analysis, gate closed {:>7.0} ms  -> {:.2} BPM ({})", without.as_secs_f64() * 1000.0, one.bpm, one.bpm_method.as_str());
    println!("  full analysis, gate open   {:>7.0} ms  -> {:.2} BPM ({})", with.as_secs_f64() * 1000.0, two.bpm, two.bpm_method.as_str());
    println!("  the second estimate alone  {:>7.0} ms  -> {:?}", alone.as_secs_f64() * 1000.0, second.map(|e| (e.bpm, e.strength)));
    println!("  i.e. {:.1}% on top of a full analysis", 100.0 * alone.as_secs_f64() / without.as_secs_f64().max(1e-9));
}
