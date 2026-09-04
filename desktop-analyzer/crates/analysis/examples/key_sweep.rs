//! Diagnostic: synthesize a I-IV-V-I (or i-iv-v-i) progression in
//! each of the 24 keys and report what key::detect returns.
use analyzer_analysis::key;
use analyzer_core::camelot::{Mode, MusicalKey};
use std::f64::consts::PI;

const SR: u32 = 44_100;
const CHORD_SECONDS: f64 = 3.0;
const REPEATS: usize = 3;

fn midi_freq(m: f64) -> f64 {
    440.0 * 2f64.powf((m - 69.0) / 12.0)
}

/// One chord: each note rendered with 3 harmonic partials.
fn chord(root_midi: f64, intervals: &[f64], seconds: f64, sr: u32, out: &mut Vec<f32>) {
    let n = (seconds * sr as f64) as usize;
    let fade = (0.01 * sr as f64) as usize;
    for i in 0..n {
        let t = i as f64 / sr as f64;
        let mut v = 0.0;
        for iv in intervals {
            let f = midi_freq(root_midi + iv);
            v += (2.0 * PI * f * t).sin();
            v += 0.5 * (2.0 * PI * 2.0 * f * t).sin();
            v += 0.25 * (2.0 * PI * 3.0 * f * t).sin();
        }
        v /= intervals.len() as f64 * 1.75;
        let env = if i < fade {
            i as f64 / fade as f64
        } else if i > n - fade {
            (n - i) as f64 / fade as f64
        } else {
            1.0
        };
        out.push((v * env * 0.7) as f32);
    }
}

/// Tonic pitch class -> a full cadence establishing that key.
pub fn progression(pitch: u8, mode: Mode, sr: u32) -> Vec<f32> {
    // Root in octave 3 (C3 = midi 48), inside libkeyfinder's analysed band.
    let root = 48.0 + pitch as f64;
    let chords: Vec<(f64, Vec<f64>)> = match mode {
        // I  IV  V  I
        Mode::Major => vec![
            (root, vec![0.0, 4.0, 7.0]),
            (root + 5.0, vec![0.0, 4.0, 7.0]),
            (root + 7.0, vec![0.0, 4.0, 7.0]),
            (root, vec![0.0, 4.0, 7.0, 12.0]),
        ],
        // i  iv  v  i   (natural minor: covers the full natural minor scale)
        Mode::Minor => vec![
            (root, vec![0.0, 3.0, 7.0]),
            (root + 5.0, vec![0.0, 3.0, 7.0]),
            (root + 7.0, vec![0.0, 3.0, 7.0]),
            (root, vec![0.0, 3.0, 7.0, 12.0]),
        ],
    };
    let mut out = Vec::new();
    for _ in 0..REPEATS {
        for (r, ivs) in &chords {
            chord(*r, ivs, CHORD_SECONDS, sr, &mut out);
        }
    }
    out
}

fn main() {
    let sr: u32 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(SR);
    let declared: u32 = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(sr);
    let mut hits = 0;
    let mut total = 0;
    println!("synth rate {sr}, declared {declared}, {:.0}s per key\n", CHORD_SECONDS * 4.0 * REPEATS as f64);
    println!("{:<12} {:<8} {:<20} {:<8} offset", "expected", "camelot", "detected", "got");
    for mode in [Mode::Major, Mode::Minor] {
        for pitch in 0..12u8 {
            let expected = MusicalKey::new(pitch, mode);
            let audio = progression(pitch, mode, sr);
            total += 1;
            match key::detect(&audio, declared) {
                Ok(d) => {
                    let ok = d.musical == expected;
                    if ok {
                        hits += 1;
                    }
                    let semis = (d.musical.pitch as i32 - pitch as i32).rem_euclid(12);
                    println!(
                        "{:<12} {:<8} {:<20} {:<8} {:+} {} {}",
                        expected.name(),
                        expected.to_camelot().code(),
                        d.musical.name(),
                        d.camelot.code(),
                        semis,
                        if d.musical.mode == mode { "samemode" } else { "MODEFLIP" },
                        if ok { "OK" } else { "MISS" }
                    );
                }
                Err(e) => println!(
                    "{:<12} {:<8} ERROR {e}",
                    expected.name(),
                    expected.to_camelot().code()
                ),
            }
        }
    }
    println!("\n{hits}/{total} exact");
}
