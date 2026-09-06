//! Finding and running the oracle, if this machine has one.
//!
//! The oracle is a development tool that lives beside the analyzer, not inside
//! it: it needs Python, PyTorch and several gigabytes of model, none of which
//! belong in something you hand to a friend. So the UI *looks* for it and
//! offers it only when it is there. On a friend's machine the button simply
//! does not appear, and nothing about the analyzer changes.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;

use super::state::UiState;

/// Where an oracle would be, relative to somewhere we might be running from.
fn candidates() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    // Also look up from the binary: `target/release/discogs-analyzer` sits two
    // levels below the crate root during development.
    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors().skip(1).take(4) {
            roots.push(ancestor.to_path_buf());
        }
    }
    roots.into_iter().map(|r| r.join("oracle")).collect()
}

/// An oracle directory that has actually been set up.
fn find() -> Option<PathBuf> {
    candidates().into_iter().find(|dir| {
        dir.join(".venv/bin/python").is_file() && dir.join("bench.sh").is_file()
    })
}

/// What the page needs to decide whether to show the oracle at all.
pub fn describe() -> serde_json::Value {
    match find() {
        Some(dir) => {
            // A corpus already downloaded makes a re-run minutes rather than
            // half an hour, which is worth telling someone before they click.
            let cached = std::fs::read_dir(dir.join("work/wav"))
                .map(|entries| {
                    entries
                        .filter_map(Result::ok)
                        .filter(|e| e.path().extension().is_some_and(|x| x == "wav"))
                        .count()
                })
                .unwrap_or(0);
            serde_json::json!({
                "present": true,
                "path": dir.display().to_string(),
                "cached_tracks": cached,
            })
        }
        None => serde_json::json!({ "present": false }),
    }
}

/// Run the oracle's benchmark, streaming its output into the UI log.
pub fn start(state: &Arc<UiState>, body: &serde_json::Value) -> serde_json::Value {
    let Some(dir) = find() else {
        return serde_json::json!({ "error": "no oracle on this machine" });
    };
    let backup = PathBuf::from(body["backup"].as_str().unwrap_or(""));
    if !backup.is_file() {
        return serde_json::json!({ "error": "pick a backup file first" });
    }
    let count = body["count"].as_u64().unwrap_or(200).clamp(1, 2000);

    let state = Arc::clone(state);
    std::thread::spawn(move || {
        state.log(format!("Cross-checking {count} tracks against the oracle."));
        match spawn_bench(&dir, &backup, count, &state) {
            Ok(0) => state.log("Oracle finished."),
            Ok(code) => state.log(format!("Oracle exited with status {code}.")),
            Err(e) => state.log(format!("Oracle could not run: {e}")),
        }
    });
    serde_json::json!({ "ok": true })
}

fn spawn_bench(
    dir: &Path,
    backup: &Path,
    count: u64,
    state: &Arc<UiState>,
) -> Result<i32, String> {
    let mut child = Command::new("bash")
        .arg(dir.join("bench.sh"))
        .arg(backup)
        .arg(count.to_string())
        .current_dir(dir.parent().unwrap_or(dir))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    // Both streams matter: the fetch reports progress on stdout and yt-dlp
    // complains on stderr, and a silent failure is the worst outcome here.
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            state.log(line);
        }
    }
    if let Some(err) = child.stderr.take() {
        for line in BufReader::new(err).lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
                state.log(line);
            }
        }
    }
    child.wait().map(|s| s.code().unwrap_or(-1)).map_err(|e| e.to_string())
}
