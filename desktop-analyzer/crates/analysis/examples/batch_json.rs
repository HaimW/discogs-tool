//! Analyse many files and emit one JSON object per line.
//!
//! For comparing this pipeline against another tracker over a corpus: the
//! human-readable example prints prose, which is fine for one file and useless
//! for two hundred.
//!
//! With `--hints FILE`, a JSON object of `{"<file stem>": {"genres": "...",
//! "styles": "..."}}` selects the tempo band per release exactly as the real
//! pipeline does. Without it every file gets the default band, which is not
//! what the tool actually does to a collection.
//!
//!   cargo run --release -p analyzer-analysis --example batch_json -- [--hints H.json] FILE...

use std::collections::HashMap;

use analyzer_analysis::analyze_file_with;
use analyzer_core::tempo::{hint_for_release, SecondOpinion, TempoHint};

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut hints: HashMap<String, (String, String)> = HashMap::new();
    if args.first().map(String::as_str) == Some("--hints") {
        args.remove(0);
        let path = args.remove(0);
        let raw = std::fs::read_to_string(&path).expect("could not read hints");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("hints are not JSON");
        for (k, v) in parsed.as_object().expect("hints must be an object") {
            hints.insert(
                k.clone(),
                (
                    v["genres"].as_str().unwrap_or("").to_string(),
                    v["styles"].as_str().unwrap_or("").to_string(),
                ),
            );
        }
    }
    if args.is_empty() {
        eprintln!("usage: batch_json [--hints hints.json] <audio files...>");
        std::process::exit(2);
    }
    for path in args {
        let p = std::path::Path::new(&path);
        let stem = p.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let hint = match hints.get(&stem) {
            Some((genres, styles)) => hint_for_release(genres, styles),
            None => TempoHint::default(),
        };
        match analyze_file_with(p, SecondOpinion::default(), hint) {
            Ok(a) => println!(
                r#"{{"file":"{}","bpm":{:.2},"bpm_confidence":{:.3},"method":"{}","second_opinion":{},"key":"{}","key_musical":"{}","key_strength":{:.3},"energy":{},"duration":{:.1}}}"#,
                p.file_stem().unwrap_or_default().to_string_lossy(),
                a.bpm,
                a.bpm_confidence,
                a.bpm_method.as_str(),
                a.bpm_second_opinion.map(|v| format!("{v:.2}")).unwrap_or("null".into()),
                a.camelot,
                a.key_musical,
                a.key_strength,
                a.energy.map(|e| e.to_string()).unwrap_or("null".into()),
                a.duration_seconds,
            ),
            Err(e) => println!(
                r#"{{"file":"{}","error":"{}"}}"#,
                p.file_stem().unwrap_or_default().to_string_lossy(),
                e.to_string().replace('"', "'")
            ),
        }
    }
}
