//! The run itself, separated from argument parsing so an end-to-end test can
//! drive it with stub download and analysis steps instead of hitting YouTube.

pub mod adapter;
pub mod progress;

use std::io::Write;
use std::path::{Path, PathBuf};

use analyzer_core::backup::{Backup, MetaExport};
use analyzer_core::ledger::{settings_hash, Ledger, ResumeOutcome};
use analyzer_core::pipeline::{self, Analyzer, Clock, Downloader, Progress, RunOptions, Summary};
use analyzer_core::plan::{Decision, Plan, ReviewReason, SkipReason};
use analyzer_core::runtime::{self, FileLedgerStore};
use analyzer_core::{merged_records, ANALYZER_VERSION};

/// Identifies the analysis algorithm, independently of the package version.
///
/// The ledger discards results produced under different settings, and the point
/// of that is comparability: a run that mixes tempos from two different
/// detectors is worse than one that redoes the work. Bump this whenever a
/// change alters the numbers the detectors produce.
pub const ALGORITHM_TAG: &str = "bpm:beat-grid-v4-folded-2nd;key:libkeyfinder-2.2";

pub struct Options {
    pub backup: PathBuf,
    pub output: PathBuf,
    pub ledger: PathBuf,
    pub work_dir: PathBuf,
    pub force: bool,
    pub limit: Option<usize>,
    pub max_attempts: u32,
    /// Lower edge of the one-octave band tempos are folded into. Part of the
    /// settings hash: changing it changes the numbers, so a ledger written
    /// under a different band is not resumed.
    pub tempo_min: f64,
    /// Recorded in the settings hash: changing when a second detector runs
    /// changes the numbers, so a ledger written under a different policy is
    /// not resumed.
    pub second_opinion: String,
}

pub struct Outcome {
    pub summary: Summary,
    /// Records written to the export.
    pub written: usize,
    /// What the energy ranking pass did, and what it could not do.
    pub energy: analyzer_core::meta::EnergyRanking,
    /// How many exported tempos were octave-corrected by the `--tempo-min`
    /// band. Worth seeing: a large number means the band may be wrong.
    pub tempo_folded: usize,
    /// Ids left alone because they held a human's data and `--force` was off.
    pub protected: Vec<String>,
    pub interrupted: bool,
}

/// Print what a run would do, without downloading anything.
///
/// Worth having before committing to something that can take hours: it is the
/// only cheap way to notice that a tracklist has not been synced and half the
/// collection is about to be flagged as a title mismatch.
pub fn plan_only(backup_path: &Path, force: bool, out: &mut dyn Write) -> Result<Plan, String> {
    let backup = read_backup(backup_path)?;
    let plan = Plan::build(&backup, force);
    let counts = plan.counts();

    writeln!(out, "{} video(s) in {}", plan.items.len(), backup_path.display()).ok();
    writeln!(out, "  analyse       {}", counts.analyze).ok();
    writeln!(out, "  skip          {}", counts.skip).ok();
    writeln!(out, "  needs review  {}", counts.review).ok();

    let mut shown = 0usize;
    for item in &plan.items {
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
    Ok(plan)
}

/// Run the pipeline and write the export.
///
/// The export is written even when the run is interrupted or every item fails:
/// whatever was analysed is worth keeping, and the ledger means the next run
/// picks up the rest.
#[allow(clippy::too_many_arguments)]
pub fn execute(
    options: &Options,
    downloader: &dyn Downloader,
    analyzer: &dyn Analyzer,
    clock: &dyn Clock,
    should_stop: &dyn Fn() -> bool,
    on_progress: &mut dyn FnMut(Progress),
    out: &mut dyn Write,
) -> Result<Outcome, String> {
    let backup = read_backup(&options.backup)?;
    let plan = Plan::build(&backup, options.force);

    std::fs::create_dir_all(&options.work_dir)
        .map_err(|e| format!("could not create work dir {}: {e}", options.work_dir.display()))?;

    let store = FileLedgerStore::new(&options.ledger);
    let hash = settings_hash(&[
        ANALYZER_VERSION,
        ALGORITHM_TAG,
        &format!("tempo-min:{}", options.tempo_min),
        &format!("second-opinion:{}", options.second_opinion),
    ]);
    let now = clock.now_iso8601();
    let (mut ledger, resumed) = Ledger::resume_or_new(store.load().as_deref(), &hash, &now);
    report_resume(&resumed, &options.ledger, out);

    let run_options = RunOptions {
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
    let tempo_folded = outcome.records.iter().filter(|r| r.bpm_folded_from.is_some()).count();
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
        tempo_folded,
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
