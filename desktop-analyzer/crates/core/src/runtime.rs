//! The production implementations of the pipeline's environment traits: real
//! wall-clock time and a real, crash-safe ledger file.
//!
//! These live here rather than in the CLI because the Tauri shell will need
//! exactly the same two things. Everything in this module stays inside `std`,
//! so `analyzer-core` still builds on a bare toolchain with no native
//! dependencies.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::ledger::Ledger;
use crate::pipeline::{Clock, LedgerStore};

/// Wall-clock UTC, formatted the way the web app's records are timestamped
/// (`2026-09-04T12:00:00Z`).
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_iso8601(&self) -> String {
        iso8601_from_unix(unix_seconds_now())
    }
}

fn unix_seconds_now() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_secs() as i64,
        // A clock set before 1970 is absurd, but returning a garbage timestamp
        // is better than panicking in the middle of a four-hour run.
        Err(e) => -(e.duration().as_secs() as i64),
    }
}

/// Format a Unix timestamp as ISO-8601 UTC with second precision.
///
/// Hand-rolled rather than pulling in a date crate: the whole crate's promise
/// is that it builds with no dependencies beyond serde. The civil-date
/// conversion below is the standard days-from-epoch algorithm, with an era of
/// 400 years — the cycle over which the Gregorian leap rules repeat.
pub fn iso8601_from_unix(seconds: i64) -> String {
    let days = seconds.div_euclid(86_400);
    let secs_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let (h, m, s) = (secs_of_day / 3600, (secs_of_day % 3600) / 60, secs_of_day % 60);
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}Z")
}

/// Days since 1970-01-01 to a civil (year, month, day).
///
/// Shifts the year to start in March so the leap day lands at the end of the
/// year and never has to be special-cased.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    // Re-base onto 0000-03-01, the start of an era.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z - era * 146_097; // 0..=146_096
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153; // 0 = March
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = if month_prime < 10 { month_prime + 3 } else { month_prime - 9 };
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// The resume ledger on disk.
///
/// [`pipeline::run`](crate::pipeline::run) saves after **every** item, so this
/// runs hundreds of times per run and each one of those is a chance to be
/// killed mid-write. Writes therefore go to a staging file next to the ledger
/// and are promoted with a rename, which is atomic on every platform we ship
/// to: a crash leaves either the previous ledger or the new one, never half of
/// either.
#[derive(Debug, Clone)]
pub struct FileLedgerStore {
    path: PathBuf,
}

impl FileLedgerStore {
    pub fn new(path: impl Into<PathBuf>) -> FileLedgerStore {
        FileLedgerStore { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Where a write lands before it is promoted. Public so callers can clean
    /// it up or explain a leftover after a hard kill.
    pub fn staging_path(&self) -> PathBuf {
        let mut name = self.path.file_name().unwrap_or_default().to_os_string();
        name.push(".tmp");
        self.path.with_file_name(name)
    }

    /// The ledger as it is on disk, or `None` when there isn't one to resume
    /// from. Unreadable is reported the same as absent, because
    /// [`Ledger::resume_or_new`](crate::ledger::Ledger::resume_or_new) already
    /// treats "can't resume" as "start fresh" and a broken ledger must never be
    /// the reason a run refuses to start.
    pub fn load(&self) -> Option<String> {
        fs::read_to_string(&self.path).ok()
    }

    /// Write the staging file and flush it to disk. Split out from
    /// [`promote`](Self::promote) so a test can stop between the two, which is
    /// exactly what a crash mid-write is.
    pub fn stage(&self, contents: &str) -> std::io::Result<PathBuf> {
        if let Some(parent) = self.path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }
        let staging = self.staging_path();
        let mut file = fs::File::create(&staging)?;
        file.write_all(contents.as_bytes())?;
        // Without this the rename can be durable while the data behind it is
        // not, which on a power loss gives an empty ledger.
        file.sync_all()?;
        Ok(staging)
    }

    /// Swap the staged file into place.
    pub fn promote(&self, staging: &Path) -> std::io::Result<()> {
        fs::rename(staging, &self.path)?;
        sync_dir(self.path.parent());
        Ok(())
    }

    /// Serialise, stage, promote.
    pub fn write_atomically(&self, contents: &str) -> std::io::Result<()> {
        write_file_atomically(&self.path, contents)
    }
}

impl LedgerStore for FileLedgerStore {
    fn save(&self, ledger: &Ledger) -> Result<(), String> {
        let json = ledger.to_json().map_err(|e| format!("could not serialise ledger: {e}"))?;
        self.write_atomically(&json)
            .map_err(|e| format!("could not write ledger to {}: {e}", self.path.display()))
    }
}

/// Stage, flush, rename: write a file so that a crash leaves either the old
/// contents or the new ones, never a half-written mixture.
///
/// Shared rather than reimplemented per caller, because the easy thing to leave
/// out is the `sync_all`, and without it the rename can be durable while the
/// data behind it is not — which on a power cut gives an empty file that looks
/// intact.
pub fn write_file_atomically(path: &Path, contents: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    let mut staging_name = path.file_name().unwrap_or_default().to_os_string();
    staging_name.push(".tmp");
    let staging = path.with_file_name(staging_name);

    let write = || -> std::io::Result<()> {
        let mut file = fs::File::create(&staging)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()
    };
    if let Err(e) = write() {
        let _ = fs::remove_file(&staging);
        return Err(e);
    }
    match fs::rename(&staging, path) {
        Ok(()) => {
            sync_dir(path.parent());
            Ok(())
        }
        Err(e) => {
            let _ = fs::remove_file(&staging);
            Err(e)
        }
    }
}

/// Best effort: a rename is only durable once the directory entry is flushed
/// too. Unsupported on some platforms and filesystems, and a failure here means
/// "less durable than we hoped", not "the save failed", so it is ignored.
///
/// TODO: this is a no-op on Windows, where flushing a directory handle needs a
/// different call. The rename itself is still atomic there, so a crash cannot
/// produce a half-written ledger; only the ordering guarantee across a power
/// cut is weaker. Worth closing if the Tauri shell ever ships a Windows build.
fn sync_dir(dir: Option<&Path>) {
    #[cfg(unix)]
    if let Some(dir) = dir {
        let dir = if dir.as_os_str().is_empty() { Path::new(".") } else { dir };
        if let Ok(handle) = fs::File::open(dir) {
            let _ = handle.sync_all();
        }
    }
    #[cfg(not(unix))]
    let _ = dir;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::EntryState;
    use crate::meta::AnalysisResult;

    /// A scratch directory that cleans up after itself, so these tests touch a
    /// real filesystem without needing a dependency to do it.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> TempDir {
            let dir = std::env::temp_dir().join(format!("analyzer-runtime-{name}"));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
        fn join(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn result(bpm: f64) -> AnalysisResult {
        AnalysisResult {
            bpm,
            bpm_confidence: 0.9,
            key: "8A".into(),
            key_musical: "A minor".into(),
            key_strength: 0.7,
            energy: Some(6),
            energy_score: None,
            bpm_folded_from: None,
            bpm_method: None,
            bpm_second_opinion: None,
            analyzed_at: "2026-09-04T12:00:00Z".into(),
            analyzer_version: "0.1.0".into(),
        }
    }

    #[test]
    fn formats_known_timestamps() {
        assert_eq!(iso8601_from_unix(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601_from_unix(1), "1970-01-01T00:00:01Z");
        assert_eq!(iso8601_from_unix(1_757_000_000), "2025-09-04T15:33:20Z");
        // Pre-epoch, where naive truncating division goes wrong.
        assert_eq!(iso8601_from_unix(-1), "1969-12-31T23:59:59Z");
        assert_eq!(iso8601_from_unix(-86_400), "1969-12-31T00:00:00Z");
    }

    #[test]
    fn gets_leap_years_and_month_boundaries_right() {
        // 2024 is a leap year: 29 February exists.
        assert_eq!(iso8601_from_unix(1_709_164_800), "2024-02-29T00:00:00Z");
        assert_eq!(iso8601_from_unix(1_709_164_800 + 86_400), "2024-03-01T00:00:00Z");
        // 2100 is not a leap year despite being divisible by four.
        assert_eq!(iso8601_from_unix(4_107_456_000), "2100-02-28T00:00:00Z");
        assert_eq!(iso8601_from_unix(4_107_456_000 + 86_400), "2100-03-01T00:00:00Z");
        // 2000 is, because of the 400-year rule.
        assert_eq!(iso8601_from_unix(951_782_400), "2000-02-29T00:00:00Z");
        // Year and month ends.
        assert_eq!(iso8601_from_unix(1_767_225_599), "2025-12-31T23:59:59Z");
        assert_eq!(iso8601_from_unix(1_767_225_600), "2026-01-01T00:00:00Z");
    }

    #[test]
    fn the_system_clock_produces_a_parseable_recent_timestamp() {
        let now = SystemClock.now_iso8601();
        assert_eq!(now.len(), 20, "unexpected shape: {now}");
        assert!(now.ends_with('Z'));
        let year: i32 = now[..4].parse().expect("a year");
        assert!((2024..2100).contains(&year), "clock produced {now}");
    }

    #[test]
    fn round_trips_a_ledger_through_a_real_directory() {
        let dir = TempDir::new("roundtrip");
        // A path two levels deep, to prove the store creates what it needs.
        let store = FileLedgerStore::new(dir.join("work").join("ledger.json"));
        assert!(store.load().is_none(), "nothing to resume from yet");

        let mut ledger = Ledger::new("hash", "2026-09-04T12:00:00Z");
        ledger.record_success("1_abc", result(124.0), "2026-09-04T12:00:01Z");
        store.save(&ledger).expect("saved");

        let reloaded = Ledger::parse(&store.load().expect("a ledger on disk")).expect("parses");
        assert_eq!(reloaded.state("1_abc"), Some(EntryState::Done));
        assert_eq!(reloaded.results().count(), 1);
        assert_eq!(reloaded.settings_hash, "hash");
    }

    #[test]
    fn leaves_no_staging_file_behind_after_a_successful_save() {
        let dir = TempDir::new("no-litter");
        let store = FileLedgerStore::new(dir.join("ledger.json"));
        store.save(&Ledger::new("hash", "now")).expect("saved");
        assert!(!store.staging_path().exists(), "staging file was not cleaned up");
    }

    #[test]
    fn a_crash_mid_write_leaves_the_previous_ledger_intact() {
        let dir = TempDir::new("crash");
        let store = FileLedgerStore::new(dir.join("ledger.json"));

        let mut ledger = Ledger::new("hash", "now");
        ledger.record_success("1_abc", result(124.0), "now");
        store.save(&ledger).expect("first save");

        // The crash: staged, not promoted — and deliberately half a document,
        // as a killed process would leave.
        let staged = store.stage(r#"{"version": 1, "settings_ha"#).expect("staged");
        assert!(staged.exists());

        let recovered = Ledger::parse(&store.load().expect("the ledger survived")).expect("parses");
        assert_eq!(recovered.state("1_abc"), Some(EntryState::Done));
        assert_eq!(
            recovered.results().next().map(|(_, r)| r.bpm),
            Some(124.0),
            "the completed result survived the crash"
        );

        // And the next save recovers by overwriting the stale staging file.
        ledger.record_success("1_def", result(90.0), "now");
        store.save(&ledger).expect("second save");
        let after = Ledger::parse(&store.load().unwrap()).unwrap();
        assert_eq!(after.completed_count(), 2);
        assert!(!store.staging_path().exists());
    }

    #[test]
    fn an_unreadable_ledger_reads_as_absent_rather_than_failing() {
        let dir = TempDir::new("unreadable");
        let store = FileLedgerStore::new(dir.join("missing").join("ledger.json"));
        assert!(store.load().is_none());
    }
}
