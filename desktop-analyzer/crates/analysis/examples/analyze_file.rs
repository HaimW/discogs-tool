//! Analyse one audio file and print what the detectors found.
//!
//!   cargo run -p analyzer-analysis --example analyze_file -- path/to/audio.m4a
//!
//! Useful for sanity-checking against tracks whose BPM and key you already
//! know, which synthetic test signals cannot tell you.

fn main() {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: analyze_file <audio file>");
        std::process::exit(2);
    };
    let path = std::path::PathBuf::from(path);

    let started = std::time::Instant::now();
    match analyzer_analysis::analyze_file(&path) {
        Ok(a) => {
            println!("file      : {}", path.display());
            println!("duration  : {:.1}s", a.duration_seconds);
            println!("bpm       : {:.2}  (confidence {:.0}%)", a.bpm, a.bpm_confidence * 100.0);
            println!(
                "key       : {}  ({})  agreement {:.0}% over {} segment(s)",
                a.camelot,
                a.key_musical,
                a.key_strength * 100.0,
                a.key_segments
            );
            match a.energy {
                Some(e) => println!("energy    : {e}/10"),
                None => println!("energy    : (not estimated)"),
            }
            println!("analysed in {:.1}s", started.elapsed().as_secs_f64());
        }
        Err(e) => {
            eprintln!("analysis failed: {e}");
            std::process::exit(1);
        }
    }
}
