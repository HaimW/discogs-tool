//! What the UI knows: the options a run was given, how far it has got, and the
//! log it has produced.
//!
//! A run happens on its own thread and reports through here, so the page can
//! poll `/api/state` and stay responsive while a three-hour job proceeds.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use analyzer_core::pipeline::Progress;
use analyzer_core::runtime::user_path;
use analyzer_core::tempo::SecondOpinion;
use analyzer_download::YtDlp;

use crate::adapter::FileAnalyzer;
use crate::{default_ledger_for, execute, plan_only, resolve_yt_dlp, Options, ANALYZER_VERSION};

/// Lines of log kept for the page. A full run produces one line per track, and
/// three thousand short strings is nothing, but the cap stops a pathological
/// run growing without limit.
const MAX_LOG_LINES: usize = 5_000;

#[derive(Default)]
pub struct UiState {
    inner: Mutex<Inner>,
    stop: AtomicBool,
}

#[derive(Default)]
struct Inner {
    running: bool,
    /// What the run is doing right now, for the progress line.
    activity: String,
    done: usize,
    total: usize,
    analyzed: usize,
    failed: usize,
    log: Vec<String>,
    /// Set when a run finishes, successfully or not.
    result: Option<String>,
    output_path: Option<String>,
}

impl UiState {
    pub fn snapshot(&self) -> serde_json::Value {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        serde_json::json!({
            "running": inner.running,
            "activity": inner.activity,
            "done": inner.done,
            "total": inner.total,
            "analyzed": inner.analyzed,
            "failed": inner.failed,
            "result": inner.result,
            "output": inner.output_path,
            "stopping": self.stop.load(Ordering::Relaxed) && inner.running,
            "log": inner.log,
        })
    }

    pub fn log(&self, line: impl Into<String>) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.log.push(line.into());
        if inner.log.len() > MAX_LOG_LINES {
            let excess = inner.log.len() - MAX_LOG_LINES;
            inner.log.drain(0..excess);
        }
    }

    pub fn request_stop(&self) -> serde_json::Value {
        self.stop.store(true, Ordering::Relaxed);
        self.log("Stopping after the current track. Progress is saved; re-run to resume.");
        serde_json::json!({ "ok": true })
    }

    /// Dry run: what would this backup produce?
    pub fn plan(&self, body: &serde_json::Value) -> serde_json::Value {
        let backup = user_path(body["backup"].as_str().unwrap_or(""));
        if !backup.is_file() {
            return serde_json::json!({ "error": format!("no such file: {}", backup.display()) });
        }
        let force = body["force"].as_bool().unwrap_or(false);
        let mut out = Vec::new();
        match plan_only(&backup, force, &mut out) {
            Ok(plan) => {
                let counts = plan.counts();
                serde_json::json!({
                    "analyze": counts.analyze,
                    "skip": counts.skip,
                    "review": counts.review,
                    "text": String::from_utf8_lossy(&out),
                })
            }
            Err(e) => serde_json::json!({ "error": e }),
        }
    }

    /// Start a run on a background thread. Returns immediately.
    pub fn start_run(self: &Arc<Self>, body: &serde_json::Value) -> serde_json::Value {
        // Claim the run inside the same lock that checks for one. Two requests
        // arriving together — a double click, a retry, or two tabs — would
        // otherwise both see `running == false` and both start, and two
        // pipelines writing one ledger and one export corrupts both.
        {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if inner.running {
                return serde_json::json!({ "error": "a run is already going" });
            }
            *inner = Inner { running: true, ..Default::default() };
        }
        let release_on_error = |state: &Arc<Self>, message: String| {
            let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.running = false;
            serde_json::json!({ "error": message })
        };
        let options = match options_from(body) {
            Ok(o) => o,
            Err(e) => return release_on_error(self, e),
        };
        let yt_dlp = body["yt_dlp"].as_str().filter(|s| !s.is_empty()).map(user_path);
        let timeout = body["timeout"].as_u64().unwrap_or(30) as u32;
        let cookies = body["cookies"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string);

        {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.output_path = Some(options.output.display().to_string());
        }
        self.stop.store(false, Ordering::Relaxed);

        let state = Arc::clone(self);
        std::thread::spawn(move || run(state, options, yt_dlp, timeout, cookies));
        serde_json::json!({ "ok": true })
    }

    fn finish(&self, message: String) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.running = false;
        inner.activity = String::new();
        inner.result = Some(message);
    }
}

fn options_from(body: &serde_json::Value) -> Result<Options, String> {
    // Every path here is one someone typed, so every one goes through
    // `user_path` — a Windows path pasted into WSL is translated, anything else
    // is untouched.
    let backup = user_path(body["backup"].as_str().unwrap_or(""));
    if !backup.is_file() {
        return Err(format!("no such backup file: {}", backup.display()));
    }
    let output = user_path(
        body["output"].as_str().filter(|s| !s.is_empty()).unwrap_or("analysis.json"),
    );
    let ledger = body["ledger"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(user_path)
        .unwrap_or_else(|| default_ledger_for(&output));
    let work_dir = body["work_dir"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(user_path)
        .unwrap_or_else(|| std::env::temp_dir().join("discogs-analyzer"));
    let second_opinion = match body["second_opinion"].as_str().unwrap_or("always") {
        "never" => "Never",
        "unsure" => "Unsure",
        _ => "Always",
    };
    Ok(Options {
        backup,
        output,
        ledger,
        work_dir,
        force: body["force"].as_bool().unwrap_or(false),
        limit: body["limit"].as_u64().map(|n| n as usize).filter(|n| *n > 0),
        max_attempts: body["max_attempts"].as_u64().unwrap_or(3) as u32,
        downloads_at_once: body["downloads"].as_u64().unwrap_or(8).clamp(1, 32) as usize,
        analysers_at_once: body["analysers"].as_u64().unwrap_or(8).clamp(1, 32) as usize,
        second_opinion: second_opinion.to_string(),
    })
}

fn second_opinion_of(options: &Options) -> SecondOpinion {
    match options.second_opinion.as_str() {
        "Never" => SecondOpinion::Never,
        "Unsure" => SecondOpinion::Unsure,
        _ => SecondOpinion::Always,
    }
}

fn run(
    state: Arc<UiState>,
    options: Options,
    yt_dlp: Option<PathBuf>,
    timeout: u32,
    cookies: Option<String>,
) {
    let resolved = match resolve_yt_dlp(yt_dlp) {
        Ok(p) => p,
        Err(e) => {
            state.finish(format!("{e}. Set its path under Advanced."));
            return;
        }
    };
    let downloader = YtDlp::new(&resolved)
        .with_timeout(timeout)
        .with_cookies(cookies);
    match downloader.version() {
        Ok(v) => state.log(format!("yt-dlp {v}")),
        Err(e) => {
            state.finish(format!("yt-dlp could not run: {e}"));
            return;
        }
    }

    let clock = analyzer_core::runtime::SystemClock;
    let analyzer = FileAnalyzer::new(&clock, ANALYZER_VERSION)
        .with_second_opinion(second_opinion_of(&options));

    let progress_state = Arc::clone(&state);
    let mut on_progress = |event: Progress| report(&progress_state, event);
    let stop_state = Arc::clone(&state);
    let should_stop = move || stop_state.stop.load(Ordering::Relaxed);

    let mut sink = Vec::new();
    let outcome = execute(
        &options,
        &downloader,
        &analyzer,
        &clock,
        &should_stop,
        &mut on_progress,
        &mut sink,
    );

    match outcome {
        Ok(o) => {
            let mut message = format!(
                "Wrote {} record(s) to {}.",
                o.written,
                options.output.display()
            );
            if o.interrupted {
                message.push_str(" Stopped early — re-run to carry on.");
            }
            if o.energy.unscored > 0 {
                message.push_str(&format!(
                    " {} record(s) kept an energy this run could not rank.",
                    o.energy.unscored
                ));
            }
            state.finish(message);
        }
        Err(e) => state.finish(format!("Run failed: {e}")),
    }
}

fn report(state: &Arc<UiState>, event: Progress) {
    let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    match event {
        Progress::Started { total, already_done } => {
            inner.total = total;
            inner.activity = "Starting".into();
            if already_done > 0 {
                inner.log.push(format!("Resuming: {already_done} already analysed."));
            }
        }
        Progress::Downloading { index, total, title, .. } => {
            inner.done = index.saturating_sub(1);
            inner.total = total;
            inner.activity = format!("Downloading {title}");
        }
        Progress::Analyzing { index, total, title, .. } => {
            inner.done = index.saturating_sub(1);
            inner.total = total;
            inner.activity = format!("Analysing {title}");
        }
        Progress::Completed { index, bpm, key, item_id, .. } => {
            inner.done = index;
            inner.analyzed += 1;
            inner.log.push(format!("{item_id}  {bpm:.2} BPM  {key}"));
        }
        Progress::Failed { index, item_id, error, will_retry, .. } => {
            inner.done = index;
            inner.failed += 1;
            let suffix = if will_retry { " (will retry)" } else { "" };
            inner.log.push(format!("{item_id}  FAILED: {error}{suffix}"));
        }
        Progress::LedgerUnsaved { message } => {
            inner.log.push(format!("Progress could not be saved: {message}"));
        }
        Progress::Blocked { failures } => {
            inner.log.push(format!(
                "YouTube refused {failures} downloads in a row, asking each to prove it is not \
                 automated. Stopping — none of those tracks were charged an attempt. Wait a \
                 while, then try again with fewer downloads at once, or set a browser to take \
                 cookies from."
            ));
        }
        Progress::LedgerSaved => inner.log.push("Progress saving recovered.".into()),
        Progress::Finished(summary) => {
            inner.analyzed = summary.analyzed;
            inner.failed = summary.failed;
            inner.activity = "Finishing".into();
        }
    }
    if inner.log.len() > MAX_LOG_LINES {
        let excess = inner.log.len() - MAX_LOG_LINES;
        inner.log.drain(0..excess);
    }
}
