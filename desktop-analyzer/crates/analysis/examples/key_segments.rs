//! Where key detection actually disagrees with itself.
//!
//! Prints the whole-track key beside each 30-second segment's key, so the shape
//! of the disagreement can be seen rather than guessed at: a segment landing on
//! the relative major is a different problem from one landing a tritone away.
//!
//!   cargo run --release -p analyzer-analysis --example key_segments -- FILE...

use analyzer_analysis::{decode, key};

fn main() {
    for path in std::env::args().skip(1) {
        let p = std::path::Path::new(&path);
        let stem = p.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let Ok(audio) = decode::decode_file(p) else {
            println!(r#"{{"file":"{stem}","error":"decode"}}"#);
            continue;
        };
        let sr = audio.sample_rate;
        let Ok(whole) = key::detect(&audio.samples, sr) else {
            println!(r#"{{"file":"{stem}","error":"key"}}"#);
            continue;
        };

        let seg = (30.0 * sr as f64) as usize;
        let count = (audio.samples.len() / seg.max(1)).min(8);
        let mut codes = Vec::new();
        for i in 0..count {
            let start = i * seg;
            let end = (start + seg).min(audio.samples.len());
            match key::detect(&audio.samples[start..end], sr) {
                Ok(k) => codes.push(format!("\"{}\"", k.camelot.code())),
                Err(_) => codes.push("null".to_string()),
            }
        }
        println!(
            r#"{{"file":"{stem}","whole":"{}","strength":{:.3},"segments":[{}]}}"#,
            whole.camelot.code(),
            whole.strength,
            codes.join(",")
        );
    }
}
