//! Reading the web app's `exportFullBackup()` file, and writing a file its
//! Restore flow accepts back.
//!
//! Restore (`importBackupFile` in `src/backup.js`) defaults every section it
//! doesn't find to `[]`, so a file carrying nothing but `_app`, `_version` and
//! `track_meta` restores cleanly. That is exactly what this tool emits — no new
//! import code is needed on the web side.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::meta::TrackMeta;

pub const APP_NAME: &str = "VinylCollectionPlayer";
pub const BACKUP_VERSION: u32 = 2;

#[derive(Debug, Clone, Deserialize)]
pub struct Backup {
    #[serde(rename = "_app", default)]
    pub app: Option<String>,
    #[serde(rename = "_version", default)]
    pub version: Option<u32>,
    #[serde(default)]
    pub collection: Collection,
    #[serde(default)]
    pub track_meta: Vec<TrackMeta>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Collection {
    #[serde(default)]
    pub releases: Vec<Release>,
    #[serde(default)]
    pub videos: Vec<Video>,
    #[serde(default)]
    pub tracklist: Vec<TracklistEntry>,
}

/// A YouTube video linked to a release. `id` is already `releaseId_youtubeId`,
/// the same key `track_meta` uses.
#[derive(Debug, Clone, Deserialize)]
pub struct Video {
    pub id: String,
    pub release_id: i64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub uri: String,
    pub youtube_id: String,
    /// Seconds, as Discogs reports it. Often absent.
    #[serde(default)]
    pub duration: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TracklistEntry {
    pub release_id: i64,
    #[serde(default)]
    pub title: String,
    /// Discogs sends "3:45"; kept as text because that is how it is stored.
    #[serde(default)]
    pub duration: String,
    #[serde(rename = "type", default)]
    pub kind: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Release {
    pub id: i64,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub artist: Option<String>,
    /// Discogs' comma-separated styles, e.g. "Deep House, Tech House". Used to
    /// pick a tempo band per release — see [`crate::tempo`].
    #[serde(default)]
    pub styles: Option<String>,
}

#[derive(Debug)]
pub enum BackupError {
    Parse(serde_json::Error),
    NotABackup { found: Option<String> },
}

impl std::fmt::Display for BackupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BackupError::Parse(e) => write!(f, "could not parse backup JSON: {e}"),
            BackupError::NotABackup { found } => write!(
                f,
                "this does not look like a Vinyl Collection Player backup (_app was {})",
                found.as_deref().unwrap_or("missing")
            ),
        }
    }
}

impl std::error::Error for BackupError {}

impl Backup {
    /// Parse and sanity-check a backup file, mirroring the guard the web app's
    /// own Restore flow applies.
    pub fn parse(json: &str) -> Result<Backup, BackupError> {
        let backup: Backup = serde_json::from_str(json).map_err(BackupError::Parse)?;
        if backup.app.as_deref() != Some(APP_NAME) {
            return Err(BackupError::NotABackup { found: backup.app.clone() });
        }
        Ok(backup)
    }

    /// Track metadata indexed by `releaseId_youtubeId`.
    pub fn meta_by_id(&self) -> std::collections::HashMap<&str, &TrackMeta> {
        self.track_meta.iter().map(|m| (m.id.as_str(), m)).collect()
    }

    /// Track titles for one release, in tracklist order, skipping headings and
    /// other non-track rows.
    pub fn tracklist_titles(&self, release_id: i64) -> Vec<&str> {
        self.collection
            .tracklist
            .iter()
            .filter(|t| t.release_id == release_id)
            .filter(|t| t.kind.is_empty() || t.kind == "track")
            .map(|t| t.title.as_str())
            .filter(|t| !t.is_empty())
            .collect()
    }
}

/// A backup-shaped file carrying only `track_meta`, ready for the web app's
/// "Restore from backup" button.
#[derive(Debug, Serialize)]
pub struct MetaExport {
    #[serde(rename = "_app")]
    pub app: &'static str,
    #[serde(rename = "_version")]
    pub version: u32,
    pub exported_at: String,
    /// Provenance for whoever opens the file; the web app ignores unknown keys.
    #[serde(rename = "_generated_by")]
    pub generated_by: String,
    pub track_meta: Vec<TrackMeta>,
}

impl MetaExport {
    pub fn new(exported_at: impl Into<String>, generated_by: impl Into<String>, records: Vec<TrackMeta>) -> Self {
        MetaExport {
            app: APP_NAME,
            version: BACKUP_VERSION,
            exported_at: exported_at.into(),
            generated_by: generated_by.into(),
            track_meta: records,
        }
    }

    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }
}

/// Round-trip helper for tests and for anyone wanting the raw document.
pub fn to_value<T: Serialize>(v: &T) -> Value {
    serde_json::to_value(v).expect("serialisable")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> String {
        json!({
            "_version": 2,
            "_app": "VinylCollectionPlayer",
            "exported_at": "2026-09-04T10:00:00Z",
            "config": [{"key": "token", "value": "secret"}],
            "collection": {
                "releases": [{"id": 12345, "title": "Blue Monday", "artist": "New Order"}],
                "videos": [{
                    "id": "12345_abcdefghijk",
                    "release_id": 12345,
                    "title": "New Order - Blue Monday",
                    "uri": "https://www.youtube.com/watch?v=abcdefghijk",
                    "youtube_id": "abcdefghijk",
                    "duration": 442,
                    "position": 1
                }],
                "tracklist": [
                    {"id": "12345_0", "release_id": 12345, "position": "A", "title": "Blue Monday", "duration": "7:29", "type": "track", "index": 0},
                    {"id": "12345_1", "release_id": 12345, "position": "", "title": "Side B", "duration": "", "type": "heading", "index": 1}
                ]
            },
            "wantlist": {"wants": [], "marketplace_stats": []},
            "track_meta": [{"id": "12345_abcdefghijk", "release_id": 12345, "rating": 5, "verified": true}],
            "setlists": [],
            "store": {"items": [], "batches": []},
            "notifications": []
        })
        .to_string()
    }

    #[test]
    fn parses_a_real_backup_shape() {
        let b = Backup::parse(&sample()).unwrap();
        assert_eq!(b.version, Some(2));
        assert_eq!(b.collection.videos.len(), 1);
        assert_eq!(b.collection.videos[0].youtube_id, "abcdefghijk");
        assert_eq!(b.collection.videos[0].duration, Some(442.0));
        assert_eq!(b.track_meta.len(), 1);
        assert!(b.track_meta[0].link_verified());
    }

    #[test]
    fn rejects_files_that_are_not_ours() {
        let err = Backup::parse(r#"{"_app": "SomethingElse"}"#).unwrap_err();
        assert!(matches!(err, BackupError::NotABackup { .. }));
        assert!(Backup::parse("{ not json").is_err());
    }

    #[test]
    fn tracklist_titles_skip_headings() {
        let b = Backup::parse(&sample()).unwrap();
        assert_eq!(b.tracklist_titles(12345), vec!["Blue Monday"]);
        assert!(b.tracklist_titles(999).is_empty());
    }

    #[test]
    fn export_is_shaped_like_a_backup_the_web_app_restores() {
        let mut rec = TrackMeta::new("12345_abcdefghijk");
        rec.bpm = Some(130.0);
        let export = MetaExport::new("2026-09-04T12:00:00Z", "desktop-analyzer 0.1.0", vec![rec]);
        let v = to_value(&export);

        // The two fields importBackupFile actually guards on.
        assert_eq!(v["_app"], json!("VinylCollectionPlayer"));
        assert_eq!(v["_version"], json!(2));
        assert_eq!(v["track_meta"][0]["bpm"], json!(130.0));

        // Sections we omit default to [] on the web side, so they must simply
        // be absent rather than null.
        assert!(v.get("collection").is_none());
        assert!(v.get("config").is_none());
    }

    #[test]
    fn a_parsed_backup_can_be_re_exported_without_losing_fields() {
        let b = Backup::parse(&sample()).unwrap();
        let export = MetaExport::new("now", "test", b.track_meta.clone());
        let v = to_value(&export);
        assert_eq!(v["track_meta"][0]["rating"], json!(5));
        assert_eq!(v["track_meta"][0]["verified"], json!(true));
    }
}
