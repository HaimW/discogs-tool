//! Fetching audio with the bundled yt-dlp binary.
//!
//! Two decisions worth knowing about:
//!
//! **No ffmpeg.** The obvious invocation is `-x --audio-format mp3`, but the
//! conversion that implies needs ffmpeg, which would mean bundling a second
//! large binary. Instead we take a container we can decode in-process with
//! symphonia and skip transcoding entirely.
//!
//! That makes the format selector load-bearing rather than incidental. Plain
//! `bestaudio` gets you Opus-in-WebM from YouTube, which symphonia 0.5 cannot
//! decode — the run fails on every single track. So m4a (AAC) is requested
//! explicitly, with fallbacks; YouTube offers it for effectively everything.
//!
//! **Failures are classified, not just counted.** A video that has been deleted
//! will never succeed, so retrying it on every future run wastes minutes per
//! run forever. A network blip, on the other hand, deserves another go. The
//! classification lives in [`classify`] and is the part worth testing.

use std::path::{Path, PathBuf};
use std::process::Command;

use analyzer_core::pipeline::{audio_stem, Downloader, StepError};
use analyzer_core::plan::PlannedItem;

/// yt-dlp format selector, in preference order:
///
/// 1. `bestaudio[ext=m4a]` — AAC in an MP4 container, which symphonia decodes.
///    YouTube serves this for effectively every video (format 140: 128 kbps,
///    44.1 kHz), and it is plenty for tempo and key detection.
/// 2. `bestaudio[acodec^=mp4a]` — the same codec where the extension differs.
/// 3. `bestaudio`/`best` — a last resort. May yield Opus, which currently
///    fails at the decode step and is reported as an unsupported-audio error
///    rather than silently producing nothing.
///
/// Do not simplify this to `bestaudio`: YouTube ranks Opus highest, and every
/// download would then be undecodable.
pub const AUDIO_FORMAT: &str = "bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio/best";

pub struct YtDlp {
    binary: PathBuf,
    /// Passed to yt-dlp as `--socket-timeout`.
    timeout_seconds: u32,
    /// A cookies.txt file, or a browser name to read cookies from.
    ///
    /// One field for both because which one works depends on the machine, and
    /// the difference is visible in the value: anything with a path separator
    /// is a file. Under WSL a browser name is usually useless — Windows Chrome,
    /// Edge and Brave encrypt their cookie stores against the Windows account,
    /// and yt-dlp on the Linux side decrypts none of them ("Extracted 0 cookies
    /// (100 could not be decrypted)"). An exported cookies.txt works anywhere.
    /// Anonymous requests are what get refused: past a certain rate YouTube
    /// starts asking each one to prove it is not automated, and a signed-in
    /// session is tolerated far better. The cost is that the downloads then
    /// belong to that account, which is why this is a setting, not a default.
    cookies: Option<String>,
}

/// A JavaScript engine yt-dlp can use, if this machine has one.
///
/// YouTube extraction without one is deprecated: yt-dlp falls back to a
/// degraded path that finds fewer formats and draws more scrutiny. It only
/// looks for deno by default, so point it at whatever is actually here.
///
/// Looked up once — this runs for every track, and asking the filesystem three
/// thousand times for an answer that cannot change is waste.
fn js_runtime() -> Option<&'static str> {
    use std::sync::OnceLock;
    static FOUND: OnceLock<Option<&'static str>> = OnceLock::new();
    *FOUND.get_or_init(|| {
        ["deno", "node", "bun"].into_iter().find(|name| {
            Command::new(name)
                .arg("--version")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        })
    })
}

impl YtDlp {
    pub fn new(binary: impl Into<PathBuf>) -> YtDlp {
        YtDlp { binary: binary.into(), timeout_seconds: 30, cookies: None }
    }

    pub fn with_timeout(mut self, seconds: u32) -> YtDlp {
        self.timeout_seconds = seconds;
        self
    }

    /// Sign requests, either from a cookies.txt file or from a named browser.
    pub fn with_cookies(mut self, cookies: Option<String>) -> YtDlp {
        self.cookies = cookies.filter(|c| !c.trim().is_empty());
        self
    }

    /// Check the binary is present and runnable, so the app can say so up front
    /// rather than failing on the first track.
    pub fn version(&self) -> Result<String, String> {
        let out = Command::new(&self.binary)
            .arg("--version")
            .output()
            .map_err(|e| format!("could not run {}: {e}", self.binary.display()))?;
        if !out.status.success() {
            return Err(format!(
                "{} --version failed: {}",
                self.binary.display(),
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }
}

impl Downloader for YtDlp {
    fn download(&self, item: &PlannedItem, dest_dir: &Path) -> Result<PathBuf, StepError> {
        let template = dest_dir.join(format!("{}.%(ext)s", audio_stem(&item.id)));

        let mut command = Command::new(&self.binary);
        command
            .arg("--no-playlist")
            .arg("--no-warnings")
            .arg("--no-progress")
            // Audio-only and decodable in-process, so no ffmpeg is needed.
            // See AUDIO_FORMAT for why this is not just "bestaudio".
            .arg("-f")
            .arg(AUDIO_FORMAT)
            .arg("--socket-timeout")
            .arg(self.timeout_seconds.to_string());
        if let Some(cookies) = &self.cookies {
            if cookies.contains('/') || cookies.contains('\\') {
                command.arg("--cookies").arg(cookies);
            } else {
                command.arg("--cookies-from-browser").arg(cookies);
            }
        }
        // YouTube extraction without a JavaScript runtime is deprecated and
        // falls back to a degraded path that fetches fewer formats and draws
        // more scrutiny. yt-dlp only looks for deno by default, so point it at
        // whatever this machine has.
        if let Some(runtime) = js_runtime() {
            command.arg("--js-runtimes").arg(runtime);
        }
        command
            .arg("-o")
            .arg(&template)
            // Ask yt-dlp for the path it actually wrote, rather than guessing
            // the extension.
            .arg("--print")
            .arg("after_move:filepath")
            .arg(item.youtube_url());
        let output = command
            .output()
            .map_err(|e| {
                StepError::permanent(format!("could not run {}: {e}", self.binary.display()))
            })?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        if !output.status.success() {
            return Err(classify(&stderr));
        }

        let path = stdout
            .lines()
            .map(str::trim)
            .rfind(|l: &&str| !l.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| StepError::retryable("yt-dlp reported no output file"))?;

        if !path.exists() {
            return Err(StepError::retryable(format!(
                "yt-dlp reported {} but it does not exist",
                path.display()
            )));
        }
        Ok(path)
    }
}

/// Decide whether a yt-dlp failure is worth retrying.
///
/// Matching on message text is unavoidable — yt-dlp exits 1 for everything —
/// so this errs toward retryable: a permanent classification stops us ever
/// trying again, which is the more expensive mistake to get wrong.
pub fn classify(stderr: &str) -> StepError {
    let lower = stderr.to_lowercase();
    let message = first_error_line(stderr);

    const PERMANENT: [&str; 10] = [
        "video unavailable",
        "has been removed",
        "removed by the uploader",
        "private video",
        "members-only",
        "this video is available to this channel's members",
        "account associated with this video has been terminated",
        // Covers both wordings yt-dlp uses: "who has blocked it in your
        // country" and "has not made this video available in your country".
        "in your country",
        "sign in to confirm your age",
        "age-restricted",
    ];
    if PERMANENT.iter().any(|p| lower.contains(p)) {
        return StepError::permanent(message);
    }

    // A refusal aimed at the whole run rather than this video. YouTube starts
    // asking for a sign-in when it decides the traffic looks automated, and
    // every queued track is about to be told the same thing. Charging these to
    // the track's retry budget would write off the entire collection in the
    // time it takes to fail three thousand downloads.
    const BLOCKED: [&str; 5] = [
        "sign in to confirm you're not a bot",
        "sign in to confirm you’re not a bot",
        "confirm you're not a bot",
        "http error 429",
        "too many requests",
    ];
    if BLOCKED.iter().any(|p| lower.contains(p)) {
        return StepError::blocked(message);
    }

    // Everything else — timeouts, 5xx, transient DNS — gets another attempt
    // within the budget.
    StepError::retryable(message)
}

/// yt-dlp prints a stack of lines; the first ERROR line is the useful one.
fn first_error_line(stderr: &str) -> String {
    stderr
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with("ERROR:"))
        .map(|l| l.trim_start_matches("ERROR:").trim().to_string())
        .or_else(|| {
            stderr
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "yt-dlp failed without a message".to_string())
}

/// Ids come from Discogs data, so keep them to characters that are safe in a
/// filename on every platform.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deleted_and_blocked_videos_are_permanent() {
        for stderr in [
            "ERROR: [youtube] abc: Video unavailable",
            "ERROR: [youtube] abc: This video has been removed by the uploader",
            "ERROR: [youtube] abc: Private video. Sign in if you've been granted access",
            "ERROR: [youtube] abc: Join this channel to get access to members-only content",
            "ERROR: The uploader has not made this video available in your country",
            "ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate",
        ] {
            let e = classify(stderr);
            assert!(!e.retryable, "should be permanent: {stderr}");
        }
    }

    #[test]
    fn a_bot_check_is_about_the_run_not_the_track() {
        // The exact wording from a real 16-wide run that tripped YouTube's
        // check, including the curly apostrophe it actually sends.
        let cases = [
            "ERROR: [youtube] Y57q3GU8fNg: Sign in to confirm you\u{2019}re not a bot. Use --cookies-from-browser",
            "ERROR: [youtube] abc: Sign in to confirm you're not a bot",
            "ERROR: [youtube] abc: HTTP Error 429: Too Many Requests",
        ];
        for stderr in cases {
            let e = classify(stderr);
            assert!(e.retryable, "should be retried: {stderr}");
            assert!(e.blocked, "should not cost the track an attempt: {stderr}");
        }
    }

    #[test]
    fn an_age_gate_is_still_about_the_track() {
        // Both mention signing in; only one is about the video itself.
        let e = classify("ERROR: [youtube] abc: Sign in to confirm your age");
        assert!(!e.retryable);
        assert!(!e.blocked);
    }

    #[test]
    fn network_trouble_is_retryable() {
        for stderr in [
            "ERROR: unable to download video data: <urlopen error timed out>",
            "ERROR: [youtube] abc: HTTP Error 503: Service Unavailable",

            "ERROR: Unable to download webpage: <urlopen error [Errno -3] Temporary failure in name resolution>",
        ] {
            let e = classify(stderr);
            assert!(e.retryable, "should be retryable: {stderr}");
        }
    }

    #[test]
    fn an_unrecognised_failure_is_retried_rather_than_written_off() {
        // Erring this way costs a few retries; erring the other way means a
        // track can never be analysed again.
        let e = classify("ERROR: something nobody has seen before");
        assert!(e.retryable);
        assert_eq!(e.message, "something nobody has seen before");
    }

    #[test]
    fn the_first_error_line_becomes_the_message() {
        let stderr = "WARNING: something noisy\nERROR: [youtube] abc: Video unavailable\nTraceback...";
        assert_eq!(classify(stderr).message, "[youtube] abc: Video unavailable");
    }

    #[test]
    fn a_silent_failure_still_produces_a_message() {
        assert_eq!(classify("").message, "yt-dlp failed without a message");
        assert!(classify("").retryable);
    }

    #[test]
    fn a_missing_binary_is_reported_as_permanent() {
        let dl = YtDlp::new("/nonexistent/yt-dlp");
        assert!(dl.version().is_err());

        let item = PlannedItem {
            id: "1_abc".into(),
            release_id: 1,
            youtube_id: "abc".into(),
            video_title: "t".into(),
            decision: analyzer_core::plan::Decision::Analyze,
            tempo_hint: Default::default(),
        };
        let err = dl.download(&item, Path::new("/tmp")).unwrap_err();
        assert!(!err.retryable, "a missing binary will not fix itself");
    }
}
