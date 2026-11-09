//! Where the UI keeps the files it owns: the uploaded backup, the result, and
//! the resume ledger.
//!
//! A browser cannot hand a server a *path*, only a file's bytes, so the UI
//! stores what it is given under fixed names in one folder of its own. Fixed
//! names are also what makes resuming automatic: the result and its ledger are
//! always the same pair, so a second run finds the first one's progress
//! without anyone having to type a matching output name.
//!
//! The folder follows each platform's convention for per-user application
//! data, and `DISCOGS_ANALYZER_DATA` overrides it (tests, a second
//! collection, or a disk with more room). Nothing here creates it: it is made
//! by the first write, so merely starting the UI leaves no trace.

use std::ffi::OsString;
use std::path::PathBuf;

/// The uploaded backup.
pub const BACKUP_FILE: &str = "backup.json";
/// The run's result, the file the web app restores from.
pub const RESULT_FILE: &str = "analysis.json";
/// The resume ledger: `default_ledger_for(RESULT_FILE)`, so a CLI run pointed
/// at the same folder resumes the same progress.
pub const LEDGER_FILE: &str = "analysis.ledger.json";

/// Downloaded audio, when the UI is asked to keep it. A folder rather than a
/// file: one audio file per track, reused by the next run instead of being
/// downloaded again. Only the UI puts it here; the CLI keeps `--work-dir`.
pub const AUDIO_DIR: &str = "audio";

/// The variable that overrides the platform default.
pub const OVERRIDE_VAR: &str = "DISCOGS_ANALYZER_DATA";

const APP_DIR: &str = "discogs-analyzer";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Os {
    Windows,
    Mac,
    /// Linux and the other Unixes: the XDG convention.
    Other,
}

/// The data folder for this platform, reading the environment through `env`.
///
/// Pure apart from `env`, so tests inject one instead of mutating the
/// process environment (which parallel tests would race on). Empty values are
/// treated as unset: `FOO= cmd` is how a shell clears a variable.
pub fn resolve(env: &dyn Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    resolve_for(current_os(), env)
}

fn current_os() -> Os {
    if cfg!(windows) {
        Os::Windows
    } else if cfg!(target_os = "macos") {
        Os::Mac
    } else {
        Os::Other
    }
}

fn resolve_for(os: Os, env: &dyn Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    let var = |key: &str| env(key).filter(|v| !v.is_empty()).map(PathBuf::from);
    if let Some(dir) = var(OVERRIDE_VAR) {
        return Some(dir);
    }
    match os {
        Os::Windows => var("APPDATA").map(|d| d.join(APP_DIR)),
        Os::Mac => var("HOME").map(|h| h.join("Library/Application Support").join(APP_DIR)),
        Os::Other => {
            // The XDG spec: a relative XDG_DATA_HOME is invalid and ignored.
            let xdg = var("XDG_DATA_HOME").filter(|d| d.is_absolute());
            xdg.or_else(|| var("HOME").map(|h| h.join(".local/share")))
                .map(|d| d.join(APP_DIR))
        }
    }
}

/// The data folder from the real environment, or an explanation of how to set
/// one when there is no home directory to put it in.
pub fn data_dir() -> Result<PathBuf, String> {
    resolve(&|key| std::env::var_os(key)).ok_or_else(|| {
        format!(
            "could not work out where to keep the analyzer's files (no home folder in the \
             environment). Set {OVERRIDE_VAR} to a folder and start it again."
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::default_ledger_for;
    use std::path::Path;

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let pairs: Vec<(String, String)> =
            pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |key| pairs.iter().find(|(k, _)| k == key).map(|(_, v)| OsString::from(v))
    }

    #[test]
    fn the_override_wins_on_every_os() {
        let env = env_of(&[
            ("DISCOGS_ANALYZER_DATA", "/custom/place"),
            ("APPDATA", "C:\\Users\\me\\AppData\\Roaming"),
            ("HOME", "/home/me"),
            ("XDG_DATA_HOME", "/home/me/.data"),
        ]);
        for os in [Os::Windows, Os::Mac, Os::Other] {
            assert_eq!(resolve_for(os, &env), Some(PathBuf::from("/custom/place")), "{os:?}");
        }
    }

    #[test]
    fn an_empty_override_is_ignored() {
        let env = env_of(&[("DISCOGS_ANALYZER_DATA", ""), ("HOME", "/home/me")]);
        assert_eq!(
            resolve_for(Os::Other, &env),
            Some(PathBuf::from("/home/me/.local/share/discogs-analyzer"))
        );
    }

    #[test]
    fn windows_uses_appdata() {
        let env = env_of(&[("APPDATA", "C:\\Users\\me\\AppData\\Roaming"), ("HOME", "/h")]);
        assert_eq!(
            resolve_for(Os::Windows, &env),
            Some(Path::new("C:\\Users\\me\\AppData\\Roaming").join("discogs-analyzer"))
        );
        assert_eq!(resolve_for(Os::Windows, &env_of(&[("APPDATA", "")])), None);
        assert_eq!(resolve_for(Os::Windows, &env_of(&[])), None);
    }

    #[test]
    fn macos_uses_application_support() {
        let env = env_of(&[("HOME", "/Users/me"), ("XDG_DATA_HOME", "/ignored")]);
        assert_eq!(
            resolve_for(Os::Mac, &env),
            Some(PathBuf::from("/Users/me/Library/Application Support/discogs-analyzer"))
        );
        assert_eq!(resolve_for(Os::Mac, &env_of(&[("HOME", "")])), None);
    }

    #[test]
    fn linux_prefers_xdg_data_home_then_local_share() {
        let env = env_of(&[("HOME", "/home/me"), ("XDG_DATA_HOME", "/home/me/.data")]);
        assert_eq!(
            resolve_for(Os::Other, &env),
            Some(PathBuf::from("/home/me/.data/discogs-analyzer"))
        );
        let env = env_of(&[("HOME", "/home/me"), ("XDG_DATA_HOME", "")]);
        assert_eq!(
            resolve_for(Os::Other, &env),
            Some(PathBuf::from("/home/me/.local/share/discogs-analyzer"))
        );
        // The XDG spec says a relative value is invalid and must be ignored.
        let env = env_of(&[("HOME", "/home/me"), ("XDG_DATA_HOME", "relative/dir")]);
        assert_eq!(
            resolve_for(Os::Other, &env),
            Some(PathBuf::from("/home/me/.local/share/discogs-analyzer"))
        );
        assert_eq!(resolve_for(Os::Other, &env_of(&[])), None);
    }

    #[test]
    fn the_public_resolver_follows_this_os() {
        let env = env_of(&[("DISCOGS_ANALYZER_DATA", "/x")]);
        assert_eq!(resolve(&env), Some(PathBuf::from("/x")));
        assert_eq!(
            current_os(),
            if cfg!(windows) {
                Os::Windows
            } else if cfg!(target_os = "macos") {
                Os::Mac
            } else {
                Os::Other
            }
        );
    }

    #[test]
    fn the_ledger_name_is_the_one_a_run_would_derive() {
        assert_eq!(
            default_ledger_for(Path::new(RESULT_FILE)),
            PathBuf::from(LEDGER_FILE)
        );
    }
}
