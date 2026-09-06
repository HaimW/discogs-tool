//! Prints what the detectors actually report, so the tolerances in the unit
//! tests can be judged against real numbers rather than trusted blindly.
//!
//!   cargo test -p analyzer-analysis --test show_values -- --nocapture

use std::f32::consts::PI;

const SR: u32 = 44_100;

fn click_track(bpm: f64, seconds: f64) -> Vec<f32> {
    let total = (SR as f64 * seconds) as usize;
    let interval = (60.0 / bpm * SR as f64) as usize;
    let mut out = vec![0.0f32; total];
    let click_len = (SR as usize) / 100;
    let mut pos = 0;
    while pos < total {
        for i in 0..click_len.min(total - pos) {
            let decay = 1.0 - (i as f32 / click_len as f32);
            out[pos + i] = (i as f32 * 0.7).sin() * decay * 0.9;
        }
        pos += interval;
    }
    out
}

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
fn show_detected_values() {
    for target in [90.0, 120.0, 128.0, 174.0] {
        let t = analyzer_analysis::bpm::detect(&click_track(target, 30.0), SR).unwrap();
        println!(
            "click {target:>5.0} BPM -> detected {:>7.2} (confidence {:.3})",
            t.bpm, t.confidence
        );
    }

    let cases: [(&str, &[f32]); 3] = [
        ("A minor (A C E)", &[440.0, 523.25, 659.25]),
        ("C major (C E G)", &[261.63, 329.63, 392.00]),
        ("E minor (E G B)", &[329.63, 392.00, 493.88]),
    ];
    for (label, freqs) in cases {
        let k = analyzer_analysis::key::detect(&chord(freqs, 20.0), SR).unwrap();
        println!("{label:<18} -> {} ({})", k.camelot.code(), k.musical.name());
    }
}
