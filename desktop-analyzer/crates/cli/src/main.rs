//! Command-line front end for the desktop BPM/key analyzer.
//!
//! Reads the web app's backup JSON, works out what still needs analysing,
//! downloads each track's audio with the bundled yt-dlp, detects tempo and key,
//! and writes a file the web app's "Restore from backup" button accepts.
//!
//! Long runs are the normal case, so the two things that matter most are that
//! it can be interrupted and resumed, and that it never overwrites something a
//! human entered.

use std::io::IsTerminal;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use analyzer_cli::adapter::FileAnalyzer;
use analyzer_cli::progress::Renderer;
use analyzer_cli::{default_ledger_for, execute, plan_only, Options, resolve_yt_dlp};
use analyzer_core::runtime::user_path;
use analyzer_core::runtime::SystemClock;
use analyzer_core::ANALYZER_VERSION;
use analyzer_download::YtDlp;
use clap::Parser;

#[derive(Parser)]
#[command(
    name = "discogs-analyzer",
    version,
    about = "Detect BPM and musical key for a Vinyl Collection Player backup.",
    after_help = "\
The output file is a backup-shaped document containing only track_meta, so the \
web app's existing \"Restore from backup\" button imports it with no extra step.

Runs are resumable: stop with Ctrl-C and re-run the same command to carry on \
where it left off. Tracks whose BPM or key you entered yourself are never \
overwritten unless you pass --force."
)]
struct Args {
    /// Backup JSON exported from the web app. Not needed with `--ui`, which
    /// asks for it in the page.
    #[arg(required_unless_present = "ui")]
    backup: Option<PathBuf>,

    /// Where to write the analysed track_meta.
    #[arg(short, long, default_value = "analysis.json")]
    output: PathBuf,

    /// Show what would be analysed, then stop without downloading anything.
    #[arg(long)]
    plan: bool,

    /// Re-analyse tracks even when their BPM/key was entered or verified by
    /// hand. This overwrites your own data — the default protects it.
    #[arg(long)]
    force: bool,

    /// Stop after this many tracks. The rest stay queued for the next run.
    #[arg(long, value_name = "N")]
    limit: Option<usize>,

    /// How many times a retryable failure is attempted, across all runs.
    #[arg(long, default_value_t = 3, value_name = "N")]
    max_attempts: u32,

    /// Resume ledger. Defaults to <output>.ledger.json next to the output.
    #[arg(long)]
    ledger: Option<PathBuf>,

    /// Scratch space for downloaded audio. Files are deleted as they are used,
    /// unless --keep-audio is set.
    #[arg(long)]
    work_dir: Option<PathBuf>,

    /// Keep downloaded audio in the work dir, and reuse it on later runs.
    ///
    /// A rerun then needs no network at all, which makes iterating on
    /// detection cheap and immune to rate limits. Costs disk: budget a few
    /// megabytes a track.
    #[arg(long)]
    keep_audio: bool,

    /// yt-dlp binary. Defaults to the bundled one, then to $PATH.
    #[arg(long)]
    yt_dlp: Option<PathBuf>,

    /// Seconds before a stalled download is abandoned.
    #[arg(long, default_value_t = 30, value_name = "SECONDS")]
    timeout: u32,

    /// Sign the downloads in: a cookies.txt file, or a browser name.
    ///
    /// Anonymous requests are what get refused — past a certain rate YouTube
    /// asks each one to prove it is not automated. The downloads then belong to
    /// that account, which is why it is a choice rather than the default.
    ///
    /// A browser name only works where yt-dlp can read that browser's cookie
    /// store. Under WSL it usually cannot: Windows Chrome, Edge and Brave
    /// encrypt theirs against the Windows account. Export a cookies.txt and
    /// pass its path instead.
    #[arg(long, value_name = "FILE_OR_BROWSER")]
    cookies: Option<String>,

    /// How many tracks to download at once.
    ///
    /// Downloading is most of a run's wall time, and it parallelises well: on a
    /// real collection the whole pipeline goes from 7.84 s a track to 1.52 at
    /// eight-wide. Past sixteen there is nothing left to win, and the ceiling is
    /// YouTube's patience rather than the network — a throttled run is worse
    /// than a slightly slower one.
    #[arg(long, default_value_t = 8, value_name = "N")]
    downloads: usize,

    /// How many tracks to analyse at once.
    ///
    /// **This is the setting that can exhaust memory.** A decoded track is
    /// roughly half a gigabyte, so the peak is about that times this number:
    /// measured at 4.0 GB with eight and 7.5 GB with sixteen. Eight is the
    /// default because a machine with 16 GB has room for it; sixteen is a third
    /// faster again if you have the memory to spare.
    #[arg(long, default_value_t = 8, value_name = "N")]
    analysers: usize,

    /// Open the point-and-click interface in a browser instead of running from
    /// the terminal. Every option below is available there.
    #[arg(long)]
    ui: bool,

    /// Port for `--ui`. 0 asks the operating system for a free one.
    #[arg(long, value_name = "PORT", default_value_t = 8733)]
    ui_port: u16,

    /// Do not open a browser window when `--ui` starts.
    #[arg(long)]
    no_open: bool,

    /// Let a web page at this origin drive the analyzer, e.g.
    /// `--allow-origin https://haimw.github.io`. Repeatable.
    ///
    /// Nothing but the analyzer's own page is allowed without this. The check
    /// matters: a browser reaches 127.0.0.1 from the same machine, so being on
    /// loopback proves nothing about *which page* is asking, and these
    /// endpoints read files and start processes.
    #[arg(long, value_name = "URL")]
    allow_origin: Vec<String>,

    /// When to cross-check the tempo with a second, independent detector.
    /// "always" (the default) checks every track and costs about 12 ms each.
    /// "unsure" checks only where the first reading's own confidence is low,
    /// which misses the case that matters: a detector locked onto the wrong
    /// pulse reports an evenly spaced grid and stays confident. "never" uses
    /// one detector, as the tool behaved before the second existed.
    #[arg(long, value_name = "WHEN", default_value = "always")]
    second_opinion: SecondOpinionArg,
}

#[derive(Clone, Copy, Debug, clap::ValueEnum)]
enum SecondOpinionArg {
    Always,
    Unsure,
    Never,
}

impl From<SecondOpinionArg> for analyzer_core::tempo::SecondOpinion {
    fn from(value: SecondOpinionArg) -> Self {
        match value {
            SecondOpinionArg::Always => analyzer_core::tempo::SecondOpinion::Always,
            SecondOpinionArg::Unsure => analyzer_core::tempo::SecondOpinion::Unsure,
            SecondOpinionArg::Never => analyzer_core::tempo::SecondOpinion::Never,
        }
    }
}

/// `user_path` for an argument clap has already turned into a `PathBuf`.
fn user_path_of(path: PathBuf) -> PathBuf {
    match path.to_str() {
        Some(text) => user_path(text),
        None => path,
    }
}

fn main() {
    if let Err(message) = run() {
        eprintln!("error: {message}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args = Args::parse();
    let mut stdout = std::io::stdout();

    if args.ui {
        return analyzer_cli::ui::serve(args.ui_port, !args.no_open, args.allow_origin);
    }

    // Clap guarantees this is present unless `--ui` was given, which returned
    // above. Paths go through `user_path` so a Windows path pasted into a WSL
    // shell resolves, the same as in the UI.
    let backup = user_path_of(args.backup.clone().expect("backup is required without --ui"));
    let output = user_path_of(args.output.clone());

    if args.plan {
        plan_only(&backup, args.force, &mut stdout)?;
        return Ok(());
    }

    let yt_dlp = resolve_yt_dlp(args.yt_dlp.clone().map(user_path_of))?;
    let downloader = YtDlp::new(&yt_dlp)
        .with_timeout(args.timeout)
        .with_cookies(args.cookies.clone());
    // Fail here rather than on the first track: a missing or unrunnable binary
    // is worth knowing about before a long run starts.
    let version = downloader
        .version()
        .map_err(|e| format!("{e}\nPass --yt-dlp to point at a working binary."))?;
    eprintln!("yt-dlp {version}");

    let clock = SystemClock;
    let analyzer =
        FileAnalyzer::new(&clock, ANALYZER_VERSION).with_second_opinion(args.second_opinion.into());

    let options = Options {
        ledger: args.ledger.map(user_path_of).unwrap_or_else(|| default_ledger_for(&output)),
        work_dir: args
            .work_dir
            .map(user_path_of)
            .unwrap_or_else(|| std::env::temp_dir().join("discogs-analyzer")),
        backup,
        output: output.clone(),
        force: args.force,
        limit: args.limit,
        max_attempts: args.max_attempts,
        downloads_at_once: args.downloads,
        analysers_at_once: args.analysers,
        keep_audio: args.keep_audio,
        second_opinion: format!("{:?}", args.second_opinion),
    };

    // Ctrl-C sets a flag instead of killing the process, so the current track
    // finishes and the ledger is saved. A second Ctrl-C still hard-kills, which
    // is what someone leaning on it expects.
    let stop = Arc::new(AtomicBool::new(false));
    let handler_flag = Arc::clone(&stop);
    ctrlc::set_handler(move || {
        if handler_flag.swap(true, Ordering::SeqCst) {
            eprintln!("\nInterrupted again — exiting now.");
            std::process::exit(130);
        }
        eprintln!("\nFinishing the current track, then stopping. Ctrl-C again to force.");
    })
    .map_err(|e| format!("could not install the interrupt handler: {e}"))?;

    let interactive = std::io::stderr().is_terminal();
    let mut renderer = Renderer::new(std::io::stderr(), interactive);
    let should_stop = || stop.load(Ordering::SeqCst);

    let outcome = execute(
        &options,
        &downloader,
        &analyzer,
        &clock,
        &should_stop,
        &mut |event| renderer.handle(&event),
        &mut stdout,
    )?;

    println!("Wrote {} record(s) to {}", outcome.written, options.output.display());
    if outcome.energy.rescaled > 0 {
        println!(
            "Energy re-scaled to deciles of your collection ({} record(s)); \
             a track's level can shift as more of the collection is analysed.",
            outcome.energy.rescaled
        );
    }
    if outcome.energy.unscored > 0 {
        println!(
            "{} record(s) kept an energy this run could not rank, so those \
             values are on the old absolute scale and are not comparable with \
             the rest. Re-analyse them with --force to bring them into line.",
            outcome.energy.unscored
        );
    }
    // Protected tracks are dropped at planning time, so they never reach the
    // export at all — which is the strongest form of the guarantee: Restore
    // cannot touch a record that is not in the file.
    let protected = outcome.summary.skipped + outcome.protected.len();
    if protected > 0 {
        println!(
            "Left {protected} track(s) out of the export because you had entered or verified \
             their BPM/key. Re-run with --force to overwrite them."
        );
    }
    if outcome.interrupted {
        println!(
            "Interrupted — progress is saved. Re-run the same command to carry on."
        );
    }
    println!("Import it with \"Restore from backup\" in the web app.");
    Ok(())
}

