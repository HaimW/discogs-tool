//! Decode audio to a mono WAV, using the analyzer's own decode path.
//!
//! Exists so an external tool can be given *exactly* the samples our detectors
//! see. Comparing two beat trackers is only meaningful if the difference
//! between them is the algorithm rather than the decoder, the downmix or the
//! sample rate.
//!
//!   cargo run --release -p analyzer-analysis --example to_wav -- IN.m4a OUT.wav

use std::io::Write;

use analyzer_analysis::decode;

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(input), Some(output)) = (args.next(), args.next()) else {
        eprintln!("usage: to_wav <input audio> <output.wav>");
        std::process::exit(2);
    };

    let audio = match decode::decode_file(std::path::Path::new(&input)) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("could not decode {input}: {e}");
            std::process::exit(1);
        }
    };

    let samples: Vec<i16> = audio
        .samples
        .iter()
        .map(|s| (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
        .collect();
    let data_bytes = (samples.len() * 2) as u32;
    let sr = audio.sample_rate;

    let mut out = Vec::with_capacity(44 + data_bytes as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // PCM header size
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&sr.to_le_bytes());
    out.extend_from_slice(&(sr * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_bytes.to_le_bytes());
    for s in &samples {
        out.extend_from_slice(&s.to_le_bytes());
    }

    match std::fs::File::create(&output).and_then(|mut f| f.write_all(&out)) {
        Ok(()) => println!(
            "{output}: {:.1}s mono at {sr} Hz",
            samples.len() as f64 / sr as f64
        ),
        Err(e) => {
            eprintln!("could not write {output}: {e}");
            std::process::exit(1);
        }
    }
}
