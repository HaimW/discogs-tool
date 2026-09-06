//! Where in a track the tempo reading comes from.
//!
//! Intros lie. A track can open beatless, half-time, or on a different loop
//! entirely, and a detector fed the whole file has to reconcile that with the
//! body. This prints what each method says over the whole track and over
//! successive windows, so a disagreement can be attributed rather than guessed
//! at.
//!
//!   cargo run --release -p analyzer-analysis --example tempo_windows -- FILE [WINDOW_SECS]

use analyzer_analysis::{autocorr, bpm, decode, key};

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(path) = args.next() else {
        eprintln!("usage: tempo_windows <audio file> [window seconds]");
        std::process::exit(2);
    };
    let window_secs: f64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(30.0);

    let audio = match decode::decode_file(std::path::Path::new(&path)) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("could not decode: {e}");
            std::process::exit(1);
        }
    };
    let sr = audio.sample_rate;
    let samples = &audio.samples[..];
    let duration = samples.len() as f64 / sr as f64;

    println!("{path}");
    println!("{:.1}s at {sr} Hz\n", duration);

    let report = |label: &str, slice: &[f32]| {
        let grid = bpm::detect(slice, sr);
        let auto = autocorr::estimate(slice, sr);
        let grid_s = match &grid {
            Ok(t) => format!("{:>7.2} c{:.2}", t.bpm, t.confidence),
            Err(_) => "     -".to_string(),
        };
        let auto_s = match auto {
            Some(e) => format!("{:>7.2} s{:.2}", e.bpm, e.strength),
            None => "     -".to_string(),
        };
        // What the two of them would agree on, if anything.
        let ratio = match (&grid, auto) {
            (Ok(t), Some(e)) if t.bpm > 0.0 => format!("{:.3}", e.bpm / t.bpm),
            _ => "-".to_string(),
        };
        let key_s = match key::detect(slice, sr) {
            Ok(k) => format!("{:<4} {:<10} str {:.2}", k.camelot.code(), k.musical.name(), k.strength),
            Err(_) => "-".to_string(),
        };
        println!("  {label:<14} grid {grid_s:<15} auto {auto_s:<15} ratio {ratio:<7} key {key_s}");
    };

    report("whole track", samples);

    // The body only: most electronic tracks are past any intro by 30 seconds
    // and not yet into an outro at the three-quarter mark.
    let from = ((30.0 * sr as f64) as usize).min(samples.len());
    let to = (samples.len() as f64 * 0.75) as usize;
    if to > from {
        report("30s to 75%", &samples[from..to]);
    }

    println!();
    let window = (window_secs * sr as f64) as usize;
    let mut start = 0;
    while start + window <= samples.len() {
        let label = format!("{:>4.0}s - {:>4.0}s", start as f64 / sr as f64, (start + window) as f64 / sr as f64);
        report(&label, &samples[start..start + window]);
        start += window;
    }
}
