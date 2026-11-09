//! What the UI knows: the options a run was given, how far it has got, and the
//! log it has produced.
//!
//! A run happens on its own thread and reports through here, so the page can
//! poll `/api/state` and stay responsive while a three-hour job proceeds.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use analyzer_core::backup::Backup;
use analyzer_core::ledger::{Ledger, LEDGER_VERSION};
use analyzer_core::pipeline::{Analyzer, Clock, Downloader, Progress};
use analyzer_core::runtime::{user_path, write_file_atomically};
use analyzer_core::tempo::SecondOpinion;
use analyzer_download::YtDlp;
use serde_json::json;

use crate::adapter::FileAnalyzer;
use crate::datadir::{AUDIO_DIR, BACKUP_FILE, LEDGER_FILE, RESULT_FILE};
use crate::{
    dry_run, execute, resolve_yt_dlp, second_opinion_label, settings_hash_for, Options,
    ANALYZER_VERSION,
};

/// Lines of log kept for the page. A full run produces one line per track, and
/// three thousand short strings is nothing, but the cap stops a pathological
/// run growing without limit.
const MAX_LOG_LINES: usize = 5_000;

/// The page's Cross-check choices, as posted, and the label each is hashed
/// under. Order is the order `matching_setting` is searched in.
const SECOND_OPINIONS: [(&str, SecondOpinion); 3] = [
    ("always", SecondOpinion::Always),
    ("unsure", SecondOpinion::Unsure),
    ("never", SecondOpinion::Never),
];

/// The run-time knobs that are not `Options`: how to reach YouTube.
pub(crate) struct Launch {
    pub yt_dlp: Option<PathBuf>,
    pub timeout: u32,
    pub cookies: Option<String>,
}

/// Starts a claimed run. The real one resolves yt-dlp and analyses audio;
/// tests swap in stub steps behind the same `run_with`.
pub(crate) type Launcher = fn(Arc<UiState>, Options, Launch);

pub struct UiState {
    inner: Mutex<Inner>,
    stop: AtomicBool,
    /// Where the backup, result and ledger live. See `datadir`.
    data_dir: PathBuf,
    /// The stored backup's video count, keyed by the file's size and mtime so
    /// a file replaced behind our back is recounted rather than served stale.
    backup_info: Mutex<Option<BackupInfo>>,
    launcher: Launcher,
    /// Test hook: make `start_run` panic after claiming, before launching.
    #[cfg(test)]
    pub(crate) panic_before_launch: AtomicBool,
}

#[derive(Clone, Copy)]
struct BackupInfo {
    bytes: u64,
    modified: Option<SystemTime>,
    videos: usize,
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

fn error(code: &str, message: impl Into<String>) -> serde_json::Value {
    json!({ "error": message.into(), "code": code })
}

fn running_error() -> serde_json::Value {
    error("running", "A run is going. Stop it, or wait for it to finish, first.")
}

impl UiState {
    /// A UI over `data_dir`. Nothing is created until something is written.
    pub fn new(data_dir: PathBuf) -> UiState {
        UiState::with_launcher(data_dir, run)
    }

    pub(crate) fn with_launcher(data_dir: PathBuf, launcher: Launcher) -> UiState {
        UiState {
            inner: Mutex::new(Inner::default()),
            stop: AtomicBool::new(false),
            data_dir,
            backup_info: Mutex::new(None),
            launcher,
            #[cfg(test)]
            panic_before_launch: AtomicBool::new(false),
        }
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn backup_path(&self) -> PathBuf {
        self.data_dir.join(BACKUP_FILE)
    }

    pub fn result_path(&self) -> PathBuf {
        self.data_dir.join(RESULT_FILE)
    }

    pub fn ledger_path(&self) -> PathBuf {
        self.data_dir.join(LEDGER_FILE)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn snapshot(&self) -> serde_json::Value {
        let inner = self.lock();
        json!({
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
        let mut inner = self.lock();
        inner.log.push(line.into());
        if inner.log.len() > MAX_LOG_LINES {
            let excess = inner.log.len() - MAX_LOG_LINES;
            inner.log.drain(0..excess);
        }
    }

    pub fn request_stop(&self) -> serde_json::Value {
        self.stop.store(true, Ordering::Relaxed);
        self.log("Stopping after the current track. Progress is saved; re-run to resume.");
        json!({ "ok": true })
    }

    /// What is in the data folder, for the page to show and to enable its
    /// buttons from. Reads only.
    pub fn files(&self) -> serde_json::Value {
        let backup = self.backup_info().map(|b| json!({ "videos": b.videos, "bytes": b.bytes }));
        let ledger = std::fs::read_to_string(self.ledger_path()).ok().map(|raw| {
            match Ledger::parse(&raw) {
                Ok(l) => json!({ "completed": l.completed_count(), "readable": true }),
                Err(_) => json!({ "completed": 0, "readable": false }),
            }
        });
        json!({
            "data_dir": self.data_dir.display().to_string(),
            "backup": backup,
            "result": self.result_path().is_file(),
            "ledger": ledger,
        })
    }

    /// The stored backup's size and video count; counted at most once per
    /// version of the file. `None` when there is no readable, valid backup.
    fn backup_info(&self) -> Option<BackupInfo> {
        let meta = std::fs::metadata(self.backup_path()).ok().filter(|m| m.is_file())?;
        let (bytes, modified) = (meta.len(), meta.modified().ok());
        let mut cache = self.backup_info.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(info) = *cache {
            if info.bytes == bytes && info.modified == modified {
                return Some(info);
            }
        }
        let raw = std::fs::read_to_string(self.backup_path()).ok()?;
        let videos = Backup::parse(&raw).ok()?.collection.videos.len();
        let info = BackupInfo { bytes, modified, videos };
        *cache = Some(info);
        Some(info)
    }

    /// Store an uploaded backup as `<data>/backup.json`.
    ///
    /// Validated before anything is written, so a wrong file never replaces a
    /// good one; written atomically, and only while no run is going — the
    /// check and the write happen under the lock `start_run` claims with, so a
    /// run cannot start between them and read a half-swapped file.
    pub fn upload_backup(&self, bytes: &[u8]) -> serde_json::Value {
        let invalid = |why: String| {
            error("invalid_backup", format!("That file is not a Vinyl Collection Player backup: {why}"))
        };
        let Ok(text) = std::str::from_utf8(bytes) else {
            return invalid("it is not text (UTF-8).".into());
        };
        let backup = match Backup::parse(text) {
            Ok(b) => b,
            Err(e) => return invalid(e.to_string()),
        };
        let videos = backup.collection.videos.len();

        let inner = self.lock();
        if inner.running {
            return running_error();
        }
        if let Err(e) = write_file_atomically(&self.backup_path(), text) {
            return error("write_failed", format!("Could not save the backup: {e}"));
        }
        drop(inner);

        if let Ok(meta) = std::fs::metadata(self.backup_path()) {
            let info = BackupInfo { bytes: meta.len(), modified: meta.modified().ok(), videos };
            *self.backup_info.lock().unwrap_or_else(|e| e.into_inner()) = Some(info);
        }
        json!({ "ok": true, "videos": videos })
    }

    /// Install an earlier run's resume file as `<data>/analysis.ledger.json`.
    ///
    /// Installed even when it was written under a different Cross-check
    /// setting — the reply says so, and which setting resumes it. Refused
    /// while a run is going, and refused when it would replace a ledger that
    /// holds finished work unless `replace` is set.
    pub fn import_ledger(&self, bytes: &[u8], second_opinion: &str, replace: bool) -> serde_json::Value {
        let invalid = |why: &str| {
            error("invalid_ledger", format!("That file is not an analyzer resume file: {why}"))
        };
        let Ok(text) = std::str::from_utf8(bytes) else {
            return invalid("it is not text (UTF-8).");
        };
        let incoming = match Ledger::parse(text) {
            Ok(l) => l,
            Err(e) => return invalid(&e.to_string()),
        };
        // It would parse and then be thrown away by the first run, after
        // replacing whatever was here: refuse it now instead.
        if incoming.version != LEDGER_VERSION {
            return invalid(&format!(
                "it is from an older format (v{}), which this version cannot resume.",
                incoming.version
            ));
        }
        let incoming_completed = incoming.completed_count();
        let wanted = settings_hash_for(second_opinion_label(second_opinion_from(Some(second_opinion))));
        let settings_match = incoming.settings_hash == wanted;
        let matching_setting = SECOND_OPINIONS
            .iter()
            .find(|(_, policy)| settings_hash_for(second_opinion_label(*policy)) == incoming.settings_hash)
            .map(|(name, _)| *name);

        let inner = self.lock();
        if inner.running {
            return running_error();
        }
        let existing_completed = std::fs::read_to_string(self.ledger_path())
            .ok()
            .and_then(|raw| Ledger::parse(&raw).ok())
            .map_or(0, |l| l.completed_count());
        if existing_completed > 0 && !replace {
            return json!({
                "error": format!(
                    "There is already a resume file with {existing_completed} finished track(s). \
                     Replacing it with this one ({incoming_completed} finished) loses that progress."
                ),
                "code": "ledger_exists",
                "existing_completed": existing_completed,
                "incoming_completed": incoming_completed,
                "settings_match": settings_match,
                "matching_setting": matching_setting,
            });
        }
        if let Err(e) = write_file_atomically(&self.ledger_path(), text) {
            return error("write_failed", format!("Could not save the resume file: {e}"));
        }
        drop(inner);
        json!({
            "ok": true,
            "completed": incoming_completed,
            "settings_match": settings_match,
            "matching_setting": matching_setting,
        })
    }

    pub fn audio_path(&self) -> PathBuf {
        self.data_dir.join(AUDIO_DIR)
    }

    /// How much kept audio there is: `{path, files, bytes}`. Reads only, and
    /// never creates the folder; 0/0 when it is absent. Counts regular files
    /// and does not follow symlinks, so the figure is what deleting frees.
    pub fn audio(&self) -> serde_json::Value {
        let path = self.audio_path();
        let mut usage = AudioUsage::default();
        if std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir()) {
            measure_audio(&path, &mut usage);
        }
        json!({
            "path": path.display().to_string(),
            "files": usage.files,
            "bytes": usage.bytes,
        })
    }

    /// Empty `<data>/audio`, keeping the folder itself.
    ///
    /// Refused while a run is going, and done holding the lock `start_run`
    /// claims with, so a run cannot start halfway through and find its cached
    /// audio vanishing. Never follows a symlink: a link inside is removed
    /// as a link, and an `audio` that is itself a link (or not a folder) is
    /// refused, so nothing outside the folder can be reached.
    pub fn delete_audio(&self) -> serde_json::Value {
        let inner = self.lock();
        if inner.running {
            return running_error();
        }
        let path = self.audio_path();
        match std::fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return json!({ "ok": true, "deleted_files": 0, "freed_bytes": 0 });
            }
            Err(e) => return error("delete_failed", format!("Could not read {}: {e}", path.display())),
            Ok(m) if m.file_type().is_symlink() || !m.is_dir() => {
                return error(
                    "unsafe_path",
                    format!(
                        "{} is not a plain folder (it is a link or a file), so it was left alone. \
                         Remove it yourself if you meant to.",
                        path.display()
                    ),
                );
            }
            Ok(_) => {}
        }
        let mut freed = AudioUsage::default();
        let outcome = empty_dir(&path, &mut freed);
        drop(inner);
        match outcome {
            Ok(()) => json!({ "ok": true, "deleted_files": freed.files, "freed_bytes": freed.bytes }),
            Err(e) => json!({
                "error": format!("Some saved audio could not be deleted: {e}"),
                "code": "delete_failed",
                "deleted_files": freed.files,
                "freed_bytes": freed.bytes,
            }),
        }
    }

    /// The result file's bytes, for download. `None` before a run wrote one.
    pub fn result_bytes(&self) -> Option<Vec<u8>> {
        std::fs::read(self.result_path()).ok()
    }

    /// Options for a run over the data folder, or the reason there can be none.
    fn options_for(&self, body: &serde_json::Value) -> Result<Options, serde_json::Value> {
        if !self.backup_path().is_file() {
            return Err(error("no_backup", "Choose a backup file first."));
        }
        Ok(options_from(&self.data_dir, body))
    }

    /// Dry run: what would a run with these options do?
    ///
    /// Built from the same `options_from` a real run uses, so it looks at the
    /// same resume file under the same settings hash and retry budget.
    pub fn plan(&self, body: &serde_json::Value) -> serde_json::Value {
        let options = match self.options_for(body) {
            Ok(o) => o,
            Err(e) => return e,
        };
        let mut out = Vec::new();
        match dry_run(&options, &mut out) {
            Ok(report) => plan_json(&report, &out),
            Err(e) => json!({ "error": e }),
        }
    }

    /// Start a run on a background thread. Returns immediately, with the HTTP
    /// status to send: 409 when the run would redo finished work and
    /// `confirm_restart` is not `true`, 200 otherwise.
    pub fn start_run(self: &Arc<Self>, body: &serde_json::Value) -> (u16, serde_json::Value) {
        // Claim the run inside the same lock that checks for one. Two requests
        // arriving together — a double click, a retry, or two tabs — would
        // otherwise both see `running == false` and both start, and two
        // pipelines writing one ledger and one export corrupts both. The claim
        // also shuts out uploads and imports, which check the same flag under
        // the same lock, so the guard below judges the files the run will use.
        //
        // The claim is released when `claim` drops — on every early return
        // below and on a panic — unless it is disarmed once the run's thread
        // owns it.
        let Some(claim) = RunClaim::take(self) else {
            return (200, error("running", "a run is already going"));
        };
        let options = match self.options_for(body) {
            Ok(o) => o,
            Err(e) => return (200, e),
        };

        // The restart guard: the same dry run, and the same rule, as the CLI.
        let report = match dry_run(&options, &mut std::io::sink()) {
            Ok(r) => r,
            Err(e) => return (200, json!({ "error": e })),
        };
        if report.restart_redoes_work() && body["confirm_restart"] != true {
            return (
                409,
                json!({
                    "error": report.restart_message(),
                    "code": "restart_needs_confirmation",
                    "restart": restart_json(&report),
                }),
            );
        }

        let launch = Launch {
            yt_dlp: body["yt_dlp"].as_str().filter(|s| !s.is_empty()).map(user_path),
            timeout: body["timeout"].as_u64().unwrap_or(30) as u32,
            cookies: body["cookies"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .map(str::to_string),
        };
        {
            // Only now is the previous run's log cleared: a refused start
            // leaves it on screen.
            let mut inner = self.lock();
            *inner = Inner {
                running: true,
                output_path: Some(options.output.display().to_string()),
                ..Default::default()
            };
        }
        self.stop.store(false, Ordering::Relaxed);

        #[cfg(test)]
        if self.panic_before_launch.load(Ordering::Relaxed) {
            panic!("test hook: panic between claim and launch");
        }

        let state = Arc::clone(self);
        let launcher = self.launcher;
        std::thread::spawn(move || launcher(state, options, launch));
        // The run's thread owns `running` now and clears it through `finish`.
        claim.disarm();
        (200, json!({ "ok": true }))
    }

    /// The single funnel every run end goes through — finished, failed, or
    /// stopped.
    fn finish(&self, message: String) {
        {
            let mut inner = self.lock();
            inner.running = false;
            inner.activity = String::new();
            inner.result = Some(message);
        }
        // The workers are gone and their buffers are free, but glibc keeps the
        // arenas. This server stays up long after a run, so give the memory
        // back rather than sitting on gigabytes of it. Outside the lock: it is
        // a syscall's worth of work and no reader needs to wait for it.
        analyzer_core::runtime::release_free_memory();
    }
}

/// `running`, claimed by `start_run`. Dropping it clears the flag, so a
/// refusal, an error or a panic between the claim and the launch cannot leave
/// the server believing a run is going; `disarm` hands the flag to the run.
struct RunClaim<'a> {
    state: &'a UiState,
    armed: bool,
}

impl<'a> RunClaim<'a> {
    /// Set `running` if it was clear. `None` when a run is already going.
    fn take(state: &'a UiState) -> Option<RunClaim<'a>> {
        let mut inner = state.lock();
        if inner.running {
            return None;
        }
        inner.running = true;
        Some(RunClaim { state, armed: true })
    }

    fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for RunClaim<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.state.lock().running = false;
        }
    }
}

/// The page's Cross-check value as a policy. Anything unrecognised is the
/// default, "always".
pub(crate) fn second_opinion_from(value: Option<&str>) -> SecondOpinion {
    SECOND_OPINIONS
        .iter()
        .find(|(name, _)| Some(*name) == value)
        .map_or(SecondOpinion::Always, |(_, policy)| *policy)
}

/// Regular files and their total size.
#[derive(Default)]
struct AudioUsage {
    files: u64,
    bytes: u64,
}

/// Add up the regular files under `dir`, recursing into real folders only.
/// Unreadable entries are skipped: this is a figure for the page, not an audit.
fn measure_audio(dir: &Path, usage: &mut AudioUsage) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        let kind = meta.file_type();
        if kind.is_dir() {
            measure_audio(&path, usage);
        } else if kind.is_file() {
            usage.files += 1;
            usage.bytes += meta.len();
        }
    }
}

/// Remove everything inside `dir` without following a symlink, counting the
/// regular files removed into `freed`. Carries on past a failure, so one
/// locked file does not keep the rest, and reports the first one.
fn empty_dir(dir: &Path, freed: &mut AudioUsage) -> std::io::Result<()> {
    let mut first_error = None;
    for entry in std::fs::read_dir(dir)? {
        let outcome = entry.and_then(|entry| {
            let path = entry.path();
            let meta = std::fs::symlink_metadata(&path)?;
            let kind = meta.file_type();
            if kind.is_symlink() {
                // The link, never its target. A link to a folder is a file to
                // Unix but a directory to Windows, which removes it with
                // `remove_dir` — still the link only.
                std::fs::remove_file(&path).or_else(|_| std::fs::remove_dir(&path))
            } else if kind.is_dir() {
                empty_dir(&path, freed)?;
                std::fs::remove_dir(&path)
            } else {
                std::fs::remove_file(&path)?;
                if kind.is_file() {
                    freed.files += 1;
                    freed.bytes += meta.len();
                }
                Ok(())
            }
        });
        if let Err(e) = outcome {
            first_error.get_or_insert(e);
        }
    }
    first_error.map_or(Ok(()), Err)
}

/// A run's options over the data folder. The backup, result and ledger are
/// always the folder's fixed files — the page no longer sends paths for them,
/// and any it does send are ignored. Creates nothing.
fn options_from(data_dir: &Path, body: &serde_json::Value) -> Options {
    // Off unless the page sends a literal `true`: kept audio is gigabytes.
    let keep_audio = body["keep_audio"].as_bool().unwrap_or(false);
    // Kept audio goes to the data folder, where the next run finds it and
    // "Delete saved audio" can reach it; the scratch-space override only
    // applies to audio that is thrown away. A typed path goes through
    // `user_path`: a Windows path pasted into WSL is translated.
    let work_dir = if keep_audio {
        data_dir.join(AUDIO_DIR)
    } else {
        body["work_dir"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(user_path)
            .unwrap_or_else(|| std::env::temp_dir().join("discogs-analyzer"))
    };
    let second_opinion = second_opinion_label(second_opinion_from(body["second_opinion"].as_str()));
    Options {
        backup: data_dir.join(BACKUP_FILE),
        output: data_dir.join(RESULT_FILE),
        ledger: data_dir.join(LEDGER_FILE),
        work_dir,
        force: body["force"].as_bool().unwrap_or(false),
        limit: body["limit"].as_u64().map(|n| n as usize).filter(|n| *n > 0),
        max_attempts: body["max_attempts"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .unwrap_or(3),
        downloads_at_once: body["downloads"].as_u64().unwrap_or(8).clamp(1, 32) as usize,
        analysers_at_once: body["analysers"].as_u64().unwrap_or(8).clamp(1, 32) as usize,
        keep_audio,
        second_opinion: second_opinion.to_string(),
    }
}

/// What the restart guard decided, for the plan and for a 409 refusal.
fn restart_json(report: &crate::DryRun) -> serde_json::Value {
    json!({
        "needed": report.restart_redoes_work(),
        "status": report.resume_status(),
        "analyze": report.outstanding,
        "analysed_in_backup": report.analysed_in_backup,
        "discarded_completed": report.discarded_completed,
        "message": report.restart_message(),
    })
}

/// The dry run's answer as the page reads it. `analyze` is the work a run
/// would actually do, not the raw plan count.
fn plan_json(report: &crate::DryRun, text: &[u8]) -> serde_json::Value {
    // `dry_run` prints the CLI's resume sentence; the UI's differs only in its
    // advice on finding earlier progress, so swap the one for the other.
    let text = String::from_utf8_lossy(text)
        .replace(&report.resume_message(), &report.resume_message_for(crate::Frontend::Ui));
    json!({
        "analyze": report.outstanding,
        "will_run": report.will_run,
        "done": report.done,
        "exhausted": report.exhausted,
        "skip": report.skip,
        "review": report.review,
        "analysed_in_backup": report.analysed_in_backup,
        "resume": {
            "status": report.resume_status(),
            "path": report.ledger_display_path().display().to_string(),
            "completed": report.completed(),
            "warning": report.resume_warning(),
            "message": report.resume_message_for(crate::Frontend::Ui),
        },
        "restart": restart_json(report),
        "text": text,
    })
}

fn second_opinion_of(options: &Options) -> SecondOpinion {
    match options.second_opinion.as_str() {
        "Never" => SecondOpinion::Never,
        "Unsure" => SecondOpinion::Unsure,
        _ => SecondOpinion::Always,
    }
}

/// The real launcher: find yt-dlp, then run with the real steps.
fn run(state: Arc<UiState>, options: Options, launch: Launch) {
    let resolved = match resolve_yt_dlp(launch.yt_dlp) {
        Ok(p) => p,
        Err(e) => {
            state.finish(format!("{e}. Set its path under Advanced."));
            return;
        }
    };
    let downloader = YtDlp::new(&resolved)
        .with_timeout(launch.timeout)
        .with_cookies(launch.cookies);
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
    run_with(&state, &options, &downloader, &analyzer, &clock);
}

/// Execute a claimed run with the given steps and report how it ended.
pub(crate) fn run_with(
    state: &Arc<UiState>,
    options: &Options,
    downloader: &(dyn Downloader + Sync),
    analyzer: &(dyn Analyzer + Sync),
    clock: &(dyn Clock + Sync),
) {
    let progress_state = Arc::clone(state);
    let mut on_progress = |event: Progress| report(&progress_state, event);
    let stop_state = Arc::clone(state);
    let should_stop = move || stop_state.stop.load(Ordering::Relaxed);

    let mut sink = Vec::new();
    let outcome = execute(
        options,
        downloader,
        analyzer,
        clock,
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
        Progress::Reusing { index, total, title, .. } => {
            inner.done = index.saturating_sub(1);
            inner.total = total;
            inner.activity = format!("Cached {title}");
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::datadir::{BACKUP_FILE, LEDGER_FILE, RESULT_FILE};
    use crate::settings_hash_for;
    use crate::ui::test_support::*;
    use serde_json::json;

    #[test]
    fn the_ui_default_hashes_like_the_ledger_it_wrote() {
        let dir = Scratch::new("hash");
        // What the page posts by default, and a body without the field.
        for body in [json!({ "second_opinion": "always" }), json!({})] {
            let options = options_from(&dir.0, &body);
            assert_eq!(settings_hash_for(&options.second_opinion), "a91b4430e1237ed4");
        }
        for (choice, label) in [("unsure", "Unsure"), ("never", "Never")] {
            let body = json!({ "second_opinion": choice });
            assert_eq!(options_from(&dir.0, &body).second_opinion, label);
        }
    }

    #[test]
    fn options_use_the_data_folder_and_ignore_posted_paths() {
        let dir = Scratch::new("paths");
        let body = json!({
            "backup": "/elsewhere/b.json", "output": "/elsewhere/o.json",
            "ledger": "/elsewhere/l.json", "work_dir": dir.join("work"),
        });
        let o = options_from(&dir.0, &body);
        assert_eq!(o.backup, dir.join(BACKUP_FILE));
        assert_eq!(o.output, dir.join(RESULT_FILE));
        assert_eq!(o.ledger, dir.join(LEDGER_FILE));
        assert_eq!(o.work_dir, dir.join("work"), "work dir stays configurable");
        let o = options_from(&dir.0, &json!({}));
        assert_eq!(o.work_dir, std::env::temp_dir().join("discogs-analyzer"));
    }

    #[test]
    fn nothing_is_created_until_something_is_uploaded() {
        let dir = Scratch::new("lazy");
        let state = UiState::new(dir.0.clone());
        let files = state.files();
        assert_eq!(files["data_dir"], dir.0.display().to_string());
        assert_eq!(files["backup"], serde_json::Value::Null);
        assert_eq!(files["result"], false);
        assert_eq!(files["ledger"], serde_json::Value::Null);
        assert_eq!(state.plan(&json!({}))["code"], "no_backup");
        assert!(!dir.0.exists(), "the data folder was created without a write");
    }

    #[test]
    fn a_valid_backup_is_stored_and_counted() {
        let dir = Scratch::new("upload-ok");
        let state = UiState::new(dir.0.clone());
        let reply = state.upload_backup(first_backup().as_bytes());
        assert_eq!(reply["ok"], true, "{reply}");
        assert_eq!(reply["videos"], 2);
        assert_eq!(std::fs::read_to_string(dir.join(BACKUP_FILE)).unwrap(), first_backup());
        assert!(!dir.join("backup.json.tmp").exists(), "staging file left behind");
        let files = state.files();
        assert_eq!(files["backup"]["videos"], 2);
        assert_eq!(files["backup"]["bytes"], first_backup().len());
    }

    #[test]
    fn an_invalid_backup_is_refused_and_the_old_one_kept() {
        let dir = Scratch::new("upload-bad");
        let state = UiState::new(dir.0.clone());
        let reply = state.upload_backup(b"{ not json");
        assert_eq!(reply["code"], "invalid_backup", "{reply}");
        assert!(!dir.0.exists(), "a refused upload wrote something");

        state.upload_backup(first_backup().as_bytes());
        for bad in [&b"{\"_app\":\"SomethingElse\"}"[..], &[0xff, 0xfe, 0x00][..]] {
            let reply = state.upload_backup(bad);
            assert_eq!(reply["code"], "invalid_backup", "{reply}");
        }
        assert_eq!(std::fs::read_to_string(dir.join(BACKUP_FILE)).unwrap(), first_backup());
    }

    #[test]
    fn the_video_count_is_computed_once_for_a_backup_already_on_disk() {
        let dir = Scratch::new("lazy-count");
        write(&dir.join(BACKUP_FILE), &first_backup());
        let state = UiState::new(dir.0.clone());
        assert_eq!(state.files()["backup"]["videos"], 2);
        // A different file under the same name is recounted, not served stale.
        let three = json!({
            "_app": "VinylCollectionPlayer", "_version": 2,
            "collection": {"videos": [
                {"id": "1_a", "release_id": 1, "youtube_id": "a"},
                {"id": "1_b", "release_id": 1, "youtube_id": "b"},
                {"id": "1_c", "release_id": 1, "youtube_id": "c"}
            ]}
        });
        write(&dir.join(BACKUP_FILE), &three.to_string());
        assert_eq!(state.files()["backup"]["videos"], 3);
    }

    #[test]
    fn the_plan_uses_the_uploaded_backup_and_reports_the_restart() {
        let dir = Scratch::new("plan");
        let state = UiState::new(dir.0.clone());
        state.upload_backup(analysed_backup().as_bytes());
        let reply = state.plan(&json!({}));
        assert_eq!(reply["analyze"], 2, "{reply}");
        assert_eq!(reply["resume"]["status"], "fresh");
        assert_eq!(reply["resume"]["path"], dir.join(LEDGER_FILE).display().to_string());
        let restart = &reply["restart"];
        assert_eq!(restart["needed"], true, "{reply}");
        assert_eq!(restart["status"], "fresh");
        assert_eq!(restart["analyze"], 2);
        assert_eq!(restart["analysed_in_backup"], 1);
        assert_eq!(restart["discarded_completed"], 0);
        assert!(restart["message"].as_str().unwrap().contains("No resume file"));
        assert!(!dir.join(LEDGER_FILE).exists(), "the dry run wrote a ledger");
        assert!(!dir.join(RESULT_FILE).exists(), "the dry run wrote a result");
    }

    #[test]
    fn the_plan_points_at_import_rather_than_an_output_name() {
        let dir = Scratch::new("plan-hint");
        let state = UiState::new(dir.0.clone());
        state.upload_backup(analysed_backup().as_bytes());
        let reply = state.plan(&json!({}));
        let message = reply["resume"]["message"].as_str().unwrap();
        assert!(message.contains("Import earlier progress"), "{message}");
        assert!(!message.contains("output name"), "CLI-only advice in the UI: {message}");
        let text = reply["text"].as_str().unwrap();
        assert!(!text.contains("output name"), "CLI-only advice in the UI's plan text: {text}");
        let restart = reply["restart"]["message"].as_str().unwrap();
        assert!(!restart.contains("--"), "CLI flags in the UI's restart message: {restart}");
    }

    #[test]
    fn a_panic_between_claim_and_launch_releases_the_claim() {
        let dir = Scratch::new("claim-panic");
        let state = stub_state(&dir.0);
        state.upload_backup(first_backup().as_bytes());
        state.panic_before_launch.store(true, Ordering::Relaxed);
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            state.start_run(&json!({}))
        }));
        assert!(outcome.is_err(), "the test hook did not panic");
        assert_eq!(state.snapshot()["running"], false, "a panic left the run claimed");

        // And the server is usable again: the next start goes through.
        state.panic_before_launch.store(false, Ordering::Relaxed);
        let (status, reply) = state.start_run(&json!({}));
        assert_eq!(status, 200, "{reply}");
        wait_idle(&state);
    }

    #[test]
    fn a_run_without_a_backup_is_refused() {
        let dir = Scratch::new("run-nobackup");
        let state = stub_state(&dir.0);
        let (_, reply) = state.start_run(&json!({}));
        assert_eq!(reply["code"], "no_backup");
        assert_eq!(state.snapshot()["running"], false);
    }

    #[test]
    fn a_first_ever_run_is_not_guarded_and_writes_the_result() {
        let dir = Scratch::new("run-first");
        let state = stub_state(&dir.0);
        state.upload_backup(first_backup().as_bytes());
        let (status, reply) = state.start_run(&json!({}));
        assert_eq!((status, &reply["ok"]), (200, &json!(true)), "{reply}");
        let snap = wait_idle(&state);
        assert!(snap["result"].as_str().unwrap().starts_with("Wrote 2"), "{snap}");
        assert!(dir.join(RESULT_FILE).is_file());
        assert!(dir.join(LEDGER_FILE).is_file());
        assert_eq!(state.files()["result"], true);
        assert_eq!(state.files()["ledger"]["completed"], 2);
    }

    #[test]
    fn a_fresh_start_over_an_analysed_backup_needs_confirmation() {
        let dir = Scratch::new("guard-fresh");
        let state = stub_state(&dir.0);
        state.upload_backup(analysed_backup().as_bytes());
        let (status, reply) = state.start_run(&json!({}));
        assert_eq!(status, 409);
        assert_eq!(reply["code"], "restart_needs_confirmation", "{reply}");
        assert_eq!(reply["restart"]["status"], "fresh");
        assert_eq!(reply["restart"]["analysed_in_backup"], 1);
        assert!(reply["error"].as_str().unwrap().contains("No resume file"));
        assert_eq!(state.snapshot()["running"], false, "the refused run kept the claim");
        assert!(!dir.join(LEDGER_FILE).exists() && !dir.join(RESULT_FILE).exists());

        // Anything but a literal true is not a confirmation.
        let (status, _) = state.start_run(&json!({ "confirm_restart": "yes" }));
        assert_eq!(status, 409);

        let (status, reply) = state.start_run(&json!({ "confirm_restart": true }));
        assert_eq!(status, 200, "{reply}");
        wait_idle(&state);
        assert!(dir.join(RESULT_FILE).is_file());
    }

    #[test]
    fn a_discarded_ledger_with_finished_work_needs_confirmation() {
        let dir = Scratch::new("guard-discarded");
        let state = stub_state(&dir.0);
        state.upload_backup(first_backup().as_bytes());
        write(&dir.join(LEDGER_FILE), &ledger_json("Never", &["1_aaa"]));
        let (status, reply) = state.start_run(&json!({ "second_opinion": "always" }));
        assert_eq!(status, 409, "{reply}");
        assert_eq!(reply["restart"]["status"], "discarded_settings");
        assert_eq!(reply["restart"]["discarded_completed"], 1);
        assert_eq!(state.snapshot()["running"], false);
        // The matching setting resumes, so it is not guarded.
        let (status, reply) = state.start_run(&json!({ "second_opinion": "never" }));
        assert_eq!(status, 200, "{reply}");
        wait_idle(&state);
    }

    #[test]
    fn resuming_is_not_guarded() {
        let dir = Scratch::new("guard-resume");
        let state = stub_state(&dir.0);
        state.upload_backup(analysed_backup().as_bytes());
        write(&dir.join(LEDGER_FILE), &ledger_json("Always", &["1_aaa"]));
        assert_eq!(state.plan(&json!({}))["restart"]["needed"], false);
        let (status, reply) = state.start_run(&json!({}));
        assert_eq!(status, 200, "{reply}");
        wait_idle(&state);
    }

    #[test]
    fn importing_a_valid_ledger_reports_its_count_and_setting() {
        let dir = Scratch::new("import-ok");
        let state = UiState::new(dir.0.clone());
        let raw = ledger_json("Always", &["1_aaa", "1_bbb"]);
        let reply = state.import_ledger(raw.as_bytes(), "always", false);
        assert_eq!(reply["ok"], true, "{reply}");
        assert_eq!(reply["completed"], 2);
        assert_eq!(reply["settings_match"], true);
        assert_eq!(reply["matching_setting"], "always");
        assert_eq!(std::fs::read_to_string(dir.join(LEDGER_FILE)).unwrap(), raw);
        assert_eq!(state.files()["ledger"]["completed"], 2);
    }

    #[test]
    fn a_hash_mismatch_is_installed_and_names_the_setting_that_resumes_it() {
        let dir = Scratch::new("import-mismatch");
        let state = UiState::new(dir.0.clone());
        let raw = ledger_json("Unsure", &["1_aaa"]);
        let reply = state.import_ledger(raw.as_bytes(), "always", false);
        assert_eq!(reply["ok"], true, "{reply}");
        assert_eq!(reply["settings_match"], false);
        assert_eq!(reply["matching_setting"], "unsure");
        assert!(dir.join(LEDGER_FILE).is_file());

        // A ledger from another algorithm version matches no setting at all.
        let mut other: serde_json::Value = serde_json::from_str(&raw).unwrap();
        other["settings_hash"] = json!("0000000000000000");
        let reply = state.import_ledger(other.to_string().as_bytes(), "always", true);
        assert_eq!(reply["matching_setting"], serde_json::Value::Null, "{reply}");
    }

    #[test]
    fn an_invalid_ledger_is_refused() {
        let dir = Scratch::new("import-bad");
        let state = UiState::new(dir.0.clone());
        for bad in [&b"{ nope"[..], &b"{\"version\":1}"[..], &[0xff][..], first_backup().as_bytes()] {
            let reply = state.import_ledger(bad, "always", false);
            assert_eq!(reply["code"], "invalid_ledger", "{reply}");
        }
        assert!(!dir.0.exists());
    }

    #[test]
    fn a_ledger_with_finished_work_is_only_replaced_when_asked() {
        let dir = Scratch::new("import-replace");
        let state = UiState::new(dir.0.clone());
        let existing = ledger_json("Always", &["1_aaa", "1_bbb"]);
        write(&dir.join(LEDGER_FILE), &existing);
        let incoming = ledger_json("Never", &["1_aaa"]);

        let reply = state.import_ledger(incoming.as_bytes(), "always", false);
        assert_eq!(reply["code"], "ledger_exists", "{reply}");
        assert_eq!(reply["existing_completed"], 2);
        assert_eq!(reply["incoming_completed"], 1);
        assert_eq!(reply["settings_match"], false);
        assert_eq!(reply["matching_setting"], "never");
        assert_eq!(std::fs::read_to_string(dir.join(LEDGER_FILE)).unwrap(), existing);

        let reply = state.import_ledger(incoming.as_bytes(), "always", true);
        assert_eq!(reply["ok"], true, "{reply}");
        assert_eq!(std::fs::read_to_string(dir.join(LEDGER_FILE)).unwrap(), incoming);
    }

    #[test]
    fn an_empty_or_broken_ledger_is_replaced_without_asking() {
        let dir = Scratch::new("import-empty");
        let state = UiState::new(dir.0.clone());
        write(&dir.join(LEDGER_FILE), &ledger_json("Always", &[]));
        let incoming = ledger_json("Always", &["1_aaa"]);
        assert_eq!(state.import_ledger(incoming.as_bytes(), "always", false)["ok"], true);
        write(&dir.join(LEDGER_FILE), "{ junk");
        assert_eq!(state.import_ledger(incoming.as_bytes(), "always", false)["ok"], true);
    }

    #[test]
    fn uploads_and_imports_are_refused_during_a_run() {
        let dir = Scratch::new("busy");
        let state = UiState::new(dir.0.clone());
        state.inner.lock().unwrap().running = true;
        assert_eq!(state.upload_backup(first_backup().as_bytes())["code"], "running");
        let raw = ledger_json("Always", &["1_aaa"]);
        assert_eq!(state.import_ledger(raw.as_bytes(), "always", true)["code"], "running");
        assert!(!dir.0.exists(), "a refused write touched the disk");
    }

    // --- Keep audio (D11) ---------------------------------------------------

    use crate::datadir::AUDIO_DIR;

    /// Regular files under `dir`, recursively, as sorted relative names.
    fn files_under(dir: &Path) -> Vec<String> {
        fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
            for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
                let path = entry.path();
                let meta = std::fs::symlink_metadata(&path).unwrap();
                if meta.is_dir() {
                    walk(root, &path, out);
                } else {
                    out.push(path.strip_prefix(root).unwrap().display().to_string());
                }
            }
        }
        let mut out = Vec::new();
        walk(dir, dir, &mut out);
        out.sort();
        out
    }

    #[test]
    fn keep_audio_is_off_unless_the_body_says_true() {
        let dir = Scratch::new("keep-default");
        for body in [json!({}), json!({ "keep_audio": false }), json!({ "keep_audio": "yes" })] {
            assert!(!options_from(&dir.0, &body).keep_audio, "{body}");
        }
        assert!(options_from(&dir.0, &json!({ "keep_audio": true })).keep_audio);
    }

    #[test]
    fn keeping_audio_puts_it_in_the_data_folder_and_overrides_the_work_dir() {
        let dir = Scratch::new("keep-workdir");
        let body = json!({ "keep_audio": true, "work_dir": dir.join("elsewhere") });
        let o = options_from(&dir.0, &body);
        assert_eq!(o.work_dir, dir.join(AUDIO_DIR), "kept audio lives in <data>/audio");
        let body = json!({ "keep_audio": false, "work_dir": dir.join("elsewhere") });
        assert_eq!(options_from(&dir.0, &body).work_dir, dir.join("elsewhere"));
    }

    #[test]
    fn a_run_that_keeps_audio_leaves_it_in_the_data_folder() {
        let dir = Scratch::new("keep-run");
        let state = stub_state(&dir.0);
        state.upload_backup(first_backup().as_bytes());
        let body = json!({ "keep_audio": true, "work_dir": dir.join("scratch") });
        let (status, reply) = state.start_run(&body);
        assert_eq!(status, 200, "{reply}");
        wait_idle(&state);
        assert_eq!(files_under(&dir.join(AUDIO_DIR)).len(), 2, "both tracks' audio kept");
        assert!(!dir.join("scratch").exists(), "the scratch override was used anyway");
        let audio = state.audio();
        assert_eq!(audio["path"], dir.join(AUDIO_DIR).display().to_string());
        assert_eq!(audio["files"], 2);
        assert_eq!(audio["bytes"], 2 * b"audio".len());
    }

    #[test]
    fn a_run_that_does_not_keep_audio_never_creates_the_audio_folder() {
        let dir = Scratch::new("keep-off-run");
        let state = stub_state(&dir.0);
        state.upload_backup(first_backup().as_bytes());
        let (status, reply) = state.start_run(&json!({ "work_dir": dir.join("scratch") }));
        assert_eq!(status, 200, "{reply}");
        wait_idle(&state);
        assert!(!dir.join(AUDIO_DIR).exists());
        assert!(files_under(&dir.join("scratch")).is_empty(), "scratch audio left behind");
        assert_eq!(state.audio()["files"], 0);
    }

    #[test]
    fn the_audio_size_is_zero_without_creating_anything() {
        let dir = Scratch::new("audio-absent");
        let state = UiState::new(dir.0.clone());
        let audio = state.audio();
        assert_eq!((audio["files"].clone(), audio["bytes"].clone()), (json!(0), json!(0)));
        assert_eq!(audio["path"], dir.join(AUDIO_DIR).display().to_string());
        assert!(!dir.0.exists(), "asking for the size created something");
    }

    #[test]
    fn the_audio_size_counts_regular_files_recursively() {
        let dir = Scratch::new("audio-count");
        write(&dir.join("audio/a.m4a"), "12345");
        write(&dir.join("audio/sub/b.webm"), "123");
        write(&dir.join("backup.json"), "not counted");
        let audio = UiState::new(dir.0.clone()).audio();
        assert_eq!(audio["files"], 2, "{audio}");
        assert_eq!(audio["bytes"], 8);
    }

    #[cfg(unix)]
    #[test]
    fn the_audio_size_does_not_follow_symlinks() {
        let dir = Scratch::new("audio-count-link");
        write(&dir.join("outside/big.bin"), "0123456789");
        write(&dir.join("audio/a.m4a"), "12");
        std::os::unix::fs::symlink(dir.join("outside"), dir.join("audio/dirlink")).unwrap();
        std::os::unix::fs::symlink(dir.join("outside/big.bin"), dir.join("audio/filelink")).unwrap();
        let audio = UiState::new(dir.0.clone()).audio();
        assert_eq!((audio["files"].clone(), audio["bytes"].clone()), (json!(1), json!(2)), "{audio}");
    }

    #[test]
    fn deleting_audio_removes_only_its_contents() {
        let dir = Scratch::new("audio-delete");
        write(&dir.join("audio/a.m4a"), "12345");
        write(&dir.join("audio/sub/b.webm"), "123");
        write(&dir.join(BACKUP_FILE), &first_backup());
        write(&dir.join("sibling.txt"), "keep me");
        let state = UiState::new(dir.0.clone());
        let reply = state.delete_audio();
        assert_eq!(reply["ok"], true, "{reply}");
        assert_eq!(reply["deleted_files"], 2);
        assert_eq!(reply["freed_bytes"], 8);
        assert!(dir.join(AUDIO_DIR).is_dir(), "the audio folder itself is kept");
        assert!(files_under(&dir.join(AUDIO_DIR)).is_empty());
        assert!(std::fs::read_dir(dir.join(AUDIO_DIR)).unwrap().next().is_none(), "subfolder left");
        assert_eq!(std::fs::read_to_string(dir.join("sibling.txt")).unwrap(), "keep me");
        assert!(dir.join(BACKUP_FILE).is_file());
        assert_eq!(state.audio()["files"], 0);
    }

    #[test]
    fn deleting_absent_audio_is_a_no_op_that_creates_nothing() {
        let dir = Scratch::new("audio-delete-absent");
        let reply = UiState::new(dir.0.clone()).delete_audio();
        assert_eq!(reply["ok"], true, "{reply}");
        assert_eq!((reply["deleted_files"].clone(), reply["freed_bytes"].clone()), (json!(0), json!(0)));
        assert!(!dir.0.exists());
    }

    #[cfg(unix)]
    #[test]
    fn deleting_audio_removes_symlinks_but_not_what_they_point_at() {
        let dir = Scratch::new("audio-delete-link");
        write(&dir.join("outside/precious.txt"), "do not touch");
        write(&dir.join("outside/sub/also.txt"), "nor this");
        write(&dir.join("audio/a.m4a"), "12");
        std::os::unix::fs::symlink(dir.join("outside"), dir.join("audio/dirlink")).unwrap();
        std::os::unix::fs::symlink(dir.join("outside/precious.txt"), dir.join("audio/filelink"))
            .unwrap();
        let reply = UiState::new(dir.0.clone()).delete_audio();
        assert_eq!(reply["ok"], true, "{reply}");
        assert_eq!(reply["deleted_files"], 1, "links are removed, not counted as audio");
        assert_eq!(reply["freed_bytes"], 2);
        assert!(std::fs::symlink_metadata(dir.join("audio/dirlink")).is_err(), "dir link kept");
        assert!(std::fs::symlink_metadata(dir.join("audio/filelink")).is_err(), "file link kept");
        assert_eq!(std::fs::read_to_string(dir.join("outside/precious.txt")).unwrap(), "do not touch");
        assert_eq!(std::fs::read_to_string(dir.join("outside/sub/also.txt")).unwrap(), "nor this");
    }

    #[cfg(unix)]
    #[test]
    fn an_audio_folder_that_is_a_symlink_is_refused() {
        let dir = Scratch::new("audio-delete-rootlink");
        write(&dir.join("outside/precious.txt"), "do not touch");
        std::fs::create_dir_all(&dir.0).unwrap();
        std::os::unix::fs::symlink(dir.join("outside"), dir.join(AUDIO_DIR)).unwrap();
        let state = UiState::new(dir.0.clone());
        let reply = state.delete_audio();
        assert_eq!(reply["code"], "unsafe_path", "{reply}");
        assert_eq!(std::fs::read_to_string(dir.join("outside/precious.txt")).unwrap(), "do not touch");
        assert_eq!(state.audio()["files"], 0, "the size does not follow the link");
    }

    #[test]
    fn an_audio_path_that_is_a_file_is_refused() {
        let dir = Scratch::new("audio-delete-file");
        write(&dir.join(AUDIO_DIR), "i am a file");
        let reply = UiState::new(dir.0.clone()).delete_audio();
        assert_eq!(reply["code"], "unsafe_path", "{reply}");
        assert!(dir.join(AUDIO_DIR).is_file());
    }

    #[test]
    fn deleting_audio_is_refused_during_a_run() {
        let dir = Scratch::new("audio-delete-busy");
        write(&dir.join("audio/a.m4a"), "12345");
        let state = UiState::new(dir.0.clone());
        state.inner.lock().unwrap().running = true;
        assert_eq!(state.delete_audio()["code"], "running");
        assert!(dir.join("audio/a.m4a").is_file(), "deleted during a run");
    }

    #[test]
    fn the_result_is_only_there_once_written() {
        let dir = Scratch::new("result");
        let state = UiState::new(dir.0.clone());
        assert!(state.result_bytes().is_none());
        write(&dir.join(RESULT_FILE), "{\"_app\":\"VinylCollectionPlayer\"}");
        assert_eq!(state.result_bytes().unwrap(), b"{\"_app\":\"VinylCollectionPlayer\"}");
    }
}
