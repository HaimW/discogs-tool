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
use analyzer_cli::{default_ledger_for, execute, plan_only, Options};
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
    /// Backup JSON exported from the web app.
    backup: PathBuf,

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

    /// Scratch space for downloaded audio. Files are deleted as they are used.
    #[arg(long)]
    work_dir: Option<PathBuf>,

    /// yt-dlp binary. Defaults to the bundled one, then to $PATH.
    #[arg(long)]
    yt_dlp: Option<PathBuf>,

    /// Seconds before a stalled download is abandoned.
    #[arg(long, default_value_t = 30, value_name = "SECONDS")]
    timeout: u32,

    /// Lowest BPM the tool will report. Tempos are folded into the one-octave
    /// band from here to twice this, so a track detected at half or a quarter
    /// speed is corrected. Pick it from what you play: 85 suits house and
    /// techno, 90 keeps drum and bass at 174, 70 suits hip hop and dub. Use 0
    /// to report tempos exactly as detected.
    #[arg(long, value_name = "BPM", default_value_t = analyzer_analysis::bpm::DEFAULT_TEMPO_MIN)]
    tempo_min: f64,

    /// Which styles get their tempo cross-checked by a second detector. A
    /// confident first reading is never cross-checked whatever this says.
    /// "auto" checks syncopated styles only (breaks, jungle, drum and bass),
    /// where the first detector is known to miscount. "always" checks every
    /// style: measured on 50 house and techno tracks it confirmed 10 and got
    /// 5 wrong, so it is not recommended. "never" uses one detector only.
    #[arg(long, value_name = "WHEN", default_value = "auto")]
    second_opinion: SecondOpinionArg,
}

#[derive(Clone, Copy, Debug, clap::ValueEnum)]
enum SecondOpinionArg {
    Auto,
    Always,
    Never,
}

impl From<SecondOpinionArg> for analyzer_core::tempo::SecondOpinion {
    fn from(value: SecondOpinionArg) -> Self {
        match value {
            SecondOpinionArg::Auto => analyzer_core::tempo::SecondOpinion::Auto,
            SecondOpinionArg::Always => analyzer_core::tempo::SecondOpinion::Always,
            SecondOpinionArg::Never => analyzer_core::tempo::SecondOpinion::Never,
        }
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

    if args.plan {
        plan_only(&args.backup, args.force, &mut stdout)?;
        return Ok(());
    }

    let yt_dlp = resolve_yt_dlp(args.yt_dlp)?;
    let downloader = YtDlp::new(&yt_dlp).with_timeout(args.timeout);
    // Fail here rather than on the first track: a missing or unrunnable binary
    // is worth knowing about before a long run starts.
    let version = downloader
        .version()
        .map_err(|e| format!("{e}\nPass --yt-dlp to point at a working binary."))?;
    eprintln!("yt-dlp {version}");

    let clock = SystemClock;
    let band = analyzer_analysis::bpm::TempoBand::from_min(args.tempo_min);
    let analyzer =
        FileAnalyzer::new(&clock, ANALYZER_VERSION, band).with_second_opinion(args.second_opinion.into());

    let options = Options {
        ledger: args.ledger.unwrap_or_else(|| default_ledger_for(&args.output)),
        work_dir: args
            .work_dir
            .unwrap_or_else(|| std::env::temp_dir().join("discogs-analyzer")),
        backup: args.backup,
        output: args.output,
        force: args.force,
        limit: args.limit,
        max_attempts: args.max_attempts,
        tempo_min: args.tempo_min,
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
    if outcome.tempo_folded > 0 {
        println!(
            "{} tempo(s) were octave-corrected into the {:.0}-{:.0} BPM band. \
             Each record keeps the original as bpm_folded_from; if many tracks \
             were folded, check --tempo-min suits what you play.",
            outcome.tempo_folded,
            args.tempo_min,
            args.tempo_min * 2.0
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

/// Prefer the binary shipped next to this one, then the repo's vendored copy,
/// then whatever is on `$PATH`.
fn resolve_yt_dlp(explicit: Option<PathBuf>) -> Result<PathBuf, String> {
    if let Some(path) = explicit {
        if !path.exists() {
            return Err(format!("no yt-dlp at {}", path.display()));
        }
        return Ok(path);
    }
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(yt_dlp_name()));
            // Running from `cargo run`, where the binary sits in target/debug.
            candidates.push(dir.join("../../binaries").join(yt_dlp_name()));
            candidates.push(dir.join("../../../binaries").join(yt_dlp_name()));
        }
    }
    candidates.push(PathBuf::from("binaries").join(yt_dlp_name()));
    for candidate in candidates {
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    // Not found locally: fall back to $PATH and let the version check report it.
    Ok(PathBuf::from(yt_dlp_name()))
}

fn yt_dlp_name() -> &'static str {
    if cfg!(windows) {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    }
}
