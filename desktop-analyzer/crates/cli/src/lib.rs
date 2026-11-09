//! The run itself, separated from argument parsing so an end-to-end test can
//! drive it with stub download and analysis steps instead of hitting YouTube.

pub mod adapter;
pub mod datadir;
pub mod progress;
pub mod ui;

use std::io::Write;
use std::path::{Path, PathBuf};

use analyzer_core::backup::{Backup, MetaExport};
use analyzer_core::ledger::{settings_hash, EntryState, Ledger, ResumeOutcome};
use analyzer_core::meta::SOURCE_ANALYSIS;
use analyzer_core::pipeline::{self, Analyzer, Clock, Downloader, Progress, RunOptions, Summary};
use analyzer_core::plan::{Decision, Plan, ReviewReason, SkipReason};
use analyzer_core::runtime::{self, FileLedgerStore};
use analyzer_core::tempo::SecondOpinion;
use analyzer_core::{merged_records, ANALYZER_VERSION};

/// Identifies the analysis algorithm, independently of the package version.
///
/// The ledger discards results produced under different settings, and the point
/// of that is comparability: a run that mixes tempos from two different
/// detectors is worse than one that redoes the work. Bump this whenever a
/// change alters the numbers the detectors produce.
pub const ALGORITHM_TAG: &str = "bpm:beat-grid-v6-body-2nd-nofold;key:libkeyfinder-2.2";

pub struct Options {
    pub backup: PathBuf,
    pub output: PathBuf,
    pub ledger: PathBuf,
    pub work_dir: PathBuf,
    pub force: bool,
    pub limit: Option<usize>,
    pub max_attempts: u32,
    /// Tracks downloaded at the same time. Part of the settings hash only in
    /// spirit: it changes how fast a run goes, never what it produces.
    pub downloads_at_once: usize,
    /// Tracks analysed at the same time.
    pub analysers_at_once: usize,
    /// Keep the downloaded audio in `work_dir` and reuse it next time.
    ///
    /// Not part of the settings hash: it changes what a rerun costs, never
    /// what it produces, so a ledger written with it off resumes fine with it
    /// on and the other way round.
    pub keep_audio: bool,
    /// Recorded in the settings hash: changing when a second detector runs
    /// changes the numbers, so a ledger written under a different policy is
    /// not resumed. Always a [`second_opinion_label`].
    pub second_opinion: String,
}

pub struct Outcome {
    pub summary: Summary,
    /// Records written to the export.
    pub written: usize,
    /// What the energy ranking pass did, and what it could not do.
    pub energy: analyzer_core::meta::EnergyRanking,
    /// Ids left alone because they held a human's data and `--force` was off.
    pub protected: Vec<String>,
    pub interrupted: bool,
}

/// Where to find yt-dlp: an explicit path, then beside the binary, then the
/// `binaries/` directory, then `$PATH`.
///
/// Lives here rather than in `main` because the UI needs it too, and a UI that
/// disagreed with the CLI about which yt-dlp to use would be a memorable bug.
pub fn resolve_yt_dlp(explicit: Option<PathBuf>) -> Result<PathBuf, String> {
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

/// The settings hash a run records in its ledger.
///
/// The one place it is computed: a dry run that hashed differently from the
/// run it predicts would report a discarded ledger the run would resume, or
/// the other way round. `second_opinion` is the label from
/// [`second_opinion_label`].
pub fn settings_hash_for(second_opinion: &str) -> String {
    settings_hash(&[
        ANALYZER_VERSION,
        ALGORITHM_TAG,
        &format!("second-opinion:{second_opinion}"),
    ])
}

/// The label a second-opinion policy is recorded under in the settings hash.
///
/// Both front ends go through this, so the CLI's `--second-opinion always`
/// and the UI's "Always" select cannot drift into hashing "always" against
/// "Always" and discarding each other's ledgers. The labels are what earlier
/// ledgers were written with; changing one discards those ledgers.
pub fn second_opinion_label(policy: SecondOpinion) -> &'static str {
    match policy {
        SecondOpinion::Always => "Always",
        SecondOpinion::Unsure => "Unsure",
        SecondOpinion::Never => "Never",
    }
}

/// The ledger a run would start from, and what became of the one on disk.
struct LoadedLedger {
    ledger: Ledger,
    resume: ResumeOutcome,
    /// Tracks finished in a ledger that is being discarded: the work a run
    /// would throw away. 0 when it resumes, when there was none, and when the
    /// discarded file cannot be parsed at all.
    discarded_completed: usize,
}

/// Load the ledger a run with these options would resume, without touching
/// the disk beyond reading it.
///
/// The one place both `execute` and `dry_run` decide resume-or-discard, so the
/// restart guard built on the dry run judges exactly what the run will do.
fn load_ledger(options: &Options, now: &str) -> LoadedLedger {
    let store = FileLedgerStore::new(&options.ledger);
    let raw = store.load();
    let (ledger, resume) = Ledger::resume_or_new(
        raw.as_deref(),
        &settings_hash_for(&options.second_opinion),
        now,
    );
    let discarded_completed = match resume {
        ResumeOutcome::Resumed { .. } | ResumeOutcome::FreshStart => 0,
        ResumeOutcome::DiscardedSettingsChanged
        | ResumeOutcome::DiscardedUnreadable
        | ResumeOutcome::DiscardedOldVersion { .. } => raw
            .as_deref()
            .and_then(|r| Ledger::parse(r).ok())
            .map_or(0, |l| l.completed_count()),
    };
    LoadedLedger { ledger, resume, discarded_completed }
}

/// Which front end a message is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Frontend {
    Cli,
    Ui,
}

/// What a dry run found: the work a real run with the same options would do.
#[derive(Debug, Clone)]
pub struct DryRun {
    pub plan: Plan,
    /// Analyse items the ledger has not finished: the run's real work.
    pub outstanding: usize,
    /// `outstanding`, cut to `--limit` when one is set.
    pub will_run: usize,
    /// Analyse items already done in the ledger. Counted over this plan's
    /// Analyse items only, so `outstanding + done + exhausted` is the plan's
    /// Analyse count; see [`DryRun::completed`] for the ledger-wide figure.
    pub done: usize,
    /// Analyse items that failed `max_attempts` times and will be skipped.
    pub exhausted: usize,
    /// The user's own data: left alone.
    pub skip: usize,
    /// Held back as a likely mix or a title mismatch.
    pub review: usize,
    pub resume: ResumeOutcome,
    pub ledger_path: PathBuf,
    /// Backup records whose BPM or key came from an earlier analysis run.
    /// When there is no ledger to resume, a non-zero count suggests the
    /// earlier run's ledger is under a different name.
    pub analysed_in_backup: usize,
    /// Finished tracks in a resume file the run would discard. 0 unless
    /// `resume` is one of the `Discarded*` outcomes and the file parsed.
    pub discarded_completed: usize,
}

impl DryRun {
    /// True when a run would not resume: the user may be about to redo work.
    pub fn resume_warning(&self) -> bool {
        !matches!(self.resume, ResumeOutcome::Resumed { .. })
    }

    /// True when a run would redo finished work: it would not resume, it has
    /// something to analyse, and there is evidence of earlier progress —
    /// analysed tracks in the backup, or finished tracks in the resume file it
    /// would throw away.
    ///
    /// Both front ends refuse such a run unless told to go ahead (the CLI's
    /// `--fresh`, the UI's confirmation). A first-ever run has neither kind of
    /// evidence and is never refused; nor is a run with nothing outstanding,
    /// which redoes nothing.
    pub fn restart_redoes_work(&self) -> bool {
        self.resume_warning()
            && self.outstanding > 0
            && (self.analysed_in_backup > 0 || self.discarded_completed > 0)
    }

    /// Why a run would redo work, with the counts, for a refusal or a
    /// confirmation dialog. Says so plainly when it would not.
    pub fn restart_message(&self) -> String {
        if !self.restart_redoes_work() {
            return "A run would not redo any finished work.".to_string();
        }
        let shown = self.ledger_display_path();
        let path = shown.display();
        let n = self.outstanding;
        let mut msg = match self.resume {
            ResumeOutcome::FreshStart => format!(
                "No resume file at {path}, but the backup already holds {} analysed track(s). \
                 A run would start from scratch and analyse {n} track(s) again.",
                self.analysed_in_backup
            ),
            ResumeOutcome::DiscardedSettingsChanged => format!(
                "The resume file at {path} holds {} finished track(s) but was written with a \
                 different second-detector (cross-check / --second-opinion) setting, so a run \
                 would discard it and analyse {n} track(s) from scratch.",
                self.discarded_completed
            ),
            ResumeOutcome::DiscardedOldVersion { found } => format!(
                "The resume file at {path} holds {} finished track(s) but is from an older \
                 format (v{found}), so a run would discard it and analyse {n} track(s) from \
                 scratch.",
                self.discarded_completed
            ),
            // Unparseable means nothing countable was discarded, so only the
            // backup's analysed tracks can have brought us here.
            ResumeOutcome::DiscardedUnreadable => format!(
                "The resume file at {path} is unreadable and would be discarded, and the backup \
                 already holds {} analysed track(s). A run would analyse {n} track(s) from \
                 scratch.",
                self.analysed_in_backup
            ),
            // Excluded by the guard above; kept total rather than panicking.
            ResumeOutcome::Resumed { .. } => return self.resume_message(),
        };
        if self.discarded_completed > 0 && self.analysed_in_backup > 0 {
            msg.push_str(&format!(
                " The backup also holds {} analysed track(s).",
                self.analysed_in_backup
            ));
        }
        msg
    }

    /// Machine-readable resume status, for the UI.
    pub fn resume_status(&self) -> &'static str {
        match self.resume {
            ResumeOutcome::Resumed { .. } => "resumed",
            ResumeOutcome::FreshStart => "fresh",
            ResumeOutcome::DiscardedSettingsChanged => "discarded_settings",
            ResumeOutcome::DiscardedUnreadable => "discarded_unreadable",
            ResumeOutcome::DiscardedOldVersion { .. } => "discarded_old_version",
        }
    }

    /// Tracks marked done anywhere in a resumed ledger, including ones the
    /// current plan no longer analyses — which is why it can exceed `done`.
    pub fn completed(&self) -> usize {
        match self.resume {
            ResumeOutcome::Resumed { completed } => completed,
            _ => 0,
        }
    }

    /// The resume file's path for display: absolute, because a relative one
    /// is relative to wherever the process was started — for the UI, the
    /// server's directory, which the person reading it cannot see. Display
    /// only: the run itself keeps using the path as given.
    pub fn ledger_display_path(&self) -> PathBuf {
        std::path::absolute(&self.ledger_path).unwrap_or_else(|_| self.ledger_path.clone())
    }

    /// One sentence on what a run would do with the resume file, in the CLI's
    /// terms. See [`DryRun::resume_message_for`].
    pub fn resume_message(&self) -> String {
        self.resume_message_for(Frontend::Cli)
    }

    /// One sentence on what a run would do with the resume file, for the
    /// given front end. Only the advice on finding earlier progress differs:
    /// the CLI picks its resume file by output name, while the UI's paths are
    /// fixed and earlier progress comes in through "Import earlier progress".
    pub fn resume_message_for(&self, frontend: Frontend) -> String {
        let shown = self.ledger_display_path();
        let path = shown.display();
        match self.resume {
            ResumeOutcome::Resumed { completed } => {
                format!("Resuming from {path} ({completed} track(s) done in it).")
            }
            ResumeOutcome::FreshStart => {
                let mut msg =
                    format!("No resume file found at {path} — a run starts from scratch.");
                if self.analysed_in_backup > 0 {
                    let advice = match frontend {
                        Frontend::Cli => {
                            "use the same output name (or resume file) as the run that \
                             produced them."
                        }
                        Frontend::Ui => {
                            "use \"Import earlier progress\" with that run's .ledger.json \
                             file."
                        }
                    };
                    msg.push_str(&format!(
                        " The backup already holds {} analysed track(s), so earlier progress \
                         may be in a different resume file: {advice}",
                        self.analysed_in_backup
                    ));
                }
                msg
            }
            ResumeOutcome::DiscardedSettingsChanged => format!(
                "Warning: the resume file at {path} was written with different analysis \
                 settings and would be discarded — a run starts from scratch. The usual \
                 cause is a different second-detector (cross-check / --second-opinion) \
                 setting from the earlier run."
            ),
            ResumeOutcome::DiscardedUnreadable => format!(
                "Warning: the resume file at {path} is unreadable and would be discarded — \
                 a run starts from scratch."
            ),
            ResumeOutcome::DiscardedOldVersion { found } => format!(
                "Warning: the resume file at {path} is from an older format (v{found}) and \
                 would be discarded — a run starts from scratch."
            ),
        }
    }
}

/// Print what a run with these options would do, without downloading
/// anything.
///
/// Worth having before committing to something that can take hours: it is the
/// only cheap way to notice that a tracklist has not been synced and half the
/// collection is about to be flagged as a title mismatch — or that the resume
/// file is not the one the last run wrote, and hours of work are about to be
/// redone.
///
/// Read-only: it reads the backup and the ledger, and writes nothing.
pub fn dry_run(options: &Options, out: &mut dyn Write) -> Result<DryRun, String> {
    let backup = read_backup(&options.backup)?;
    let plan = Plan::build(&backup, options.force);
    let counts = plan.counts();
    // The timestamp only stamps a fresh ledger, which is safe only because the
    // dry run never saves it.
    let LoadedLedger { ledger, resume, discarded_completed } = load_ledger(options, "");

    let outstanding = ledger.outstanding(&plan, options.max_attempts).len();
    let mut done = 0usize;
    let mut exhausted = 0usize;
    for item in plan.items.iter().filter(|i| i.decision == Decision::Analyze) {
        match ledger.entries.get(&item.id) {
            Some(e) if e.state == EntryState::Done => done += 1,
            Some(e) if e.state == EntryState::Failed && e.attempts >= options.max_attempts => {
                exhausted += 1
            }
            _ => {}
        }
    }
    let will_run = options.limit.map_or(outstanding, |l| l.min(outstanding));
    let analysed_in_backup = backup
        .track_meta
        .iter()
        .filter(|m| {
            m.bpm_source.as_deref() == Some(SOURCE_ANALYSIS)
                || m.key_source.as_deref() == Some(SOURCE_ANALYSIS)
        })
        .count();

    let report = DryRun {
        plan,
        outstanding,
        will_run,
        done,
        exhausted,
        skip: counts.skip,
        review: counts.review,
        resume,
        ledger_path: options.ledger.clone(),
        analysed_in_backup,
        discarded_completed,
    };

    writeln!(out, "{} video(s) in {}", report.plan.items.len(), options.backup.display()).ok();
    writeln!(out, "{}", report.resume_message()).ok();
    writeln!(out, "  to analyse        {}", report.outstanding).ok();
    if report.will_run < report.outstanding {
        writeln!(out, "    this run stops after {} (--limit)", report.will_run).ok();
    }
    writeln!(out, "  already analysed  {}", report.done).ok();
    if report.exhausted > 0 {
        writeln!(
            out,
            "  failed too often  {}  (skipped; raise --max-attempts above {} to retry them)",
            report.exhausted, options.max_attempts
        )
        .ok();
    } else {
        writeln!(out, "  failed too often  0").ok();
    }
    writeln!(out, "  already yours     {}", report.skip).ok();
    writeln!(out, "  needs review      {}", report.review).ok();

    let mut shown = 0usize;
    for item in &report.plan.items {
        let note = match &item.decision {
            Decision::Analyze => continue,
            Decision::Skip(SkipReason::ManualData) => "your own bpm/key already there".to_string(),
            Decision::Review(ReviewReason::TooLong { seconds }) => {
                format!("{:.0} min — likely a mix or full album", seconds / 60.0)
            }
            Decision::Review(ReviewReason::TitleMismatch { .. }) => {
                "title does not match the release tracklist".to_string()
            }
        };
        if shown == 0 {
            writeln!(out, "\nNot being analysed:").ok();
        }
        shown += 1;
        // A full collection's worth of these is noise; the counts above are the
        // answer, and this is just enough to see the shape of the problem.
        if shown <= 20 {
            writeln!(out, "  {}  {}  — {note}", item.id, truncate(&item.video_title, 40)).ok();
        }
    }
    if shown > 20 {
        writeln!(out, "  … and {} more", shown - 20).ok();
    }
    Ok(report)
}

/// Run the pipeline and write the export.
///
/// The export is written even when the run is interrupted or every item fails:
/// whatever was analysed is worth keeping, and the ledger means the next run
/// picks up the rest.
#[allow(clippy::too_many_arguments)]
pub fn execute(
    options: &Options,
    downloader: &(dyn Downloader + Sync),
    analyzer: &(dyn Analyzer + Sync),
    clock: &(dyn Clock + Sync),
    should_stop: &(dyn Fn() -> bool + Sync),
    on_progress: &mut dyn FnMut(Progress),
    out: &mut dyn Write,
) -> Result<Outcome, String> {
    let backup = read_backup(&options.backup)?;
    let plan = Plan::build(&backup, options.force);

    std::fs::create_dir_all(&options.work_dir)
        .map_err(|e| format!("could not create work dir {}: {e}", options.work_dir.display()))?;

    let store = FileLedgerStore::new(&options.ledger);
    let now = clock.now_iso8601();
    let LoadedLedger { mut ledger, resume: resumed, .. } = load_ledger(options, &now);
    report_resume(&resumed, &options.ledger, out);

    let run_options = RunOptions {
        downloads_at_once: options.downloads_at_once,
        analysers_at_once: options.analysers_at_once,
        keep_audio: options.keep_audio,
        work_dir: &options.work_dir,
        max_attempts: options.max_attempts,
        limit: options.limit,
    };
    let summary = pipeline::run(
        &plan,
        &mut ledger,
        downloader,
        analyzer,
        clock,
        &store,
        &run_options,
        should_stop,
        on_progress,
    );

    // Everything the ledger holds, including results from earlier runs — the
    // export is a complete picture, not a diff of this run.
    let mut outcome = merged_records(&backup, ledger.results(), options.force);
    // Energy is calibrated last, because it is the only figure that depends on
    // the other records: it is a rank within the collection, so it cannot be
    // decided while the collection is still being analysed.
    let energy = analyzer_core::meta::rank_energy(&mut outcome.records);
    let export = MetaExport::new(
        clock.now_iso8601(),
        format!("desktop-analyzer {ANALYZER_VERSION}"),
        outcome.records,
    );
    let json = export.to_json().map_err(|e| format!("could not serialise export: {e}"))?;
    // Same staging + fsync + rename the ledger uses. This is the file the whole
    // run exists to produce; it deserves at least the durability of the
    // bookkeeping beside it.
    runtime::write_file_atomically(&options.output, &json)
        .map_err(|e| format!("could not write {}: {e}", options.output.display()))?;

    Ok(Outcome {
        summary,
        written: export.track_meta.len(),
        energy,
        protected: outcome.protected,
        interrupted: should_stop(),
    })
}

fn report_resume(outcome: &ResumeOutcome, path: &Path, out: &mut dyn Write) {
    let msg = match outcome {
        ResumeOutcome::FreshStart => return,
        ResumeOutcome::Resumed { completed } => {
            format!("Resuming from {} ({completed} already done).", path.display())
        }
        ResumeOutcome::DiscardedUnreadable => {
            format!("Ledger at {} was unreadable — starting fresh.", path.display())
        }
        ResumeOutcome::DiscardedSettingsChanged => {
            "Analysis settings changed since the last run — starting fresh so results are comparable."
                .to_string()
        }
        ResumeOutcome::DiscardedOldVersion { found } => {
            format!("Ledger is from an older format (v{found}) — starting fresh.")
        }
    };
    writeln!(out, "{msg}").ok();
}

fn read_backup(path: &Path) -> Result<Backup, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("could not read {}: {e}", path.display()))?;
    Backup::parse(&raw).map_err(|e| format!("could not parse {}: {e}", path.display()))
}

fn truncate(s: &str, max: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max {
        return s.to_string();
    }
    format!("{}\u{2026}", chars[..max.saturating_sub(1)].iter().collect::<String>())
}

/// Default ledger location for a given export path: next to it, so the two
/// travel together and a second collection in the same directory does not
/// silently resume the first one's ledger.
pub fn default_ledger_for(output: &Path) -> PathBuf {
    let mut name = output.file_stem().unwrap_or_default().to_os_string();
    name.push(".ledger.json");
    output.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ledger_sits_beside_the_export_it_belongs_to() {
        assert_eq!(
            default_ledger_for(Path::new("/tmp/out/analysis.json")),
            PathBuf::from("/tmp/out/analysis.ledger.json")
        );
    }

    #[test]
    fn truncate_counts_characters_not_bytes() {
        assert_eq!(truncate("abc", 10), "abc");
        assert_eq!(truncate(&"é".repeat(50), 5).chars().count(), 5);
    }
}
