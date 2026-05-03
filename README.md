# Vinyl Collection Player

Vinyl Collection Player is a **pure browser-based Discogs companion** for DJs and collectors. It syncs your collection and want list, links playable YouTube videos, lets you build setlists, and gives you crate-digging tools like BPM/key notes and harmonic track suggestions.

No backend. No install. No build step.

## Live App

- **GitHub Pages:** [haimw.github.io/discogs-tool](https://haimw.github.io/discogs-tool/)

## What It Does

### 1) Discogs collection sync (2-phase)
- Saves your Discogs token + username locally in IndexedDB.
- Syncs collection folders first, then release metadata.
- Performs a second pass against Discogs folder `0` (“All”) to include unfiled releases.
- De-duplicates and tracks quantity, folder membership, cover/thumb images, styles, formats, date added, and country.
- Removes stale releases (and related videos/track data) that are no longer in your collection.
- Fetches release videos + tracklists in the background after collection data is browse-ready.
- Handles Discogs rate limiting with retries, delay/backoff, and on-screen sync status updates.

### 2) Collection browsing
- Search by artist/title.
- Filter by genre, folder, and country.
- Sort and paginate large libraries.
- Open full release pages with playable track/video entries.
- Shuffle playback from the full collection or current filtered view.

### 3) Tracks-focused view
- Aggregates tracks across releases for crate-style digging.
- Track search + filter support including:
  - BPM min/max
  - Musical key
  - Minimum star rating
  - Freeform tags
- Sort/paginate track-level results.
- Inline metadata editing for each track (BPM, key, rating, tags, notes).

### 4) YouTube playback engine
- Embedded YouTube IFrame player with queue-based playback.
- Play/pause, previous/next controls, and auto-advance.
- “Now Playing” persistent bottom bar while navigating views.
- Release jump from now-playing context.
- Queue panel with remove/reorder/play controls.
- Save current queue as a setlist.

### 5) Crossfade + smart playback helpers
- Optional crossfade mode with configurable fade duration.
- Secondary hidden player for overlap transitions.
- Suggest-next system based on harmonic compatibility and BPM distance.
- One-click play/add of suggested tracks.

### 6) Visualizer modes
The now-playing bar includes a canvas visualizer with switchable modes:
- Bars
- Wave
- Particles
- Rings
- Aurora
- Helix
- Lissajous
- Tunnel

### 7) Want list workflow
- Sync Discogs want list into local IndexedDB.
- Search/filter want list by query, genre, format, decade, and country.
- Sort/paginate results.
- Play want list items when linked videos are available.
- Shuffle through playable want list items.
- Remove items from local want list cache.
- Export want list to CSV.
- “Dig deeper” helper actions for continued exploration.

### 8) Marketplace monitoring + notifications
- Pulls marketplace stats for want list releases.
- Availability check workflow.
- Notification bell + unread badge in top nav.
- Notification panel with timestamps (“time ago”).
- Clear-all notifications action.

### 9) Setlists
- Create, rename, and delete setlists.
- Add tracks from release/queue/now-playing contexts.
- Drag-and-drop reorder + explicit move controls.
- Per-setlist notes.
- Play an entire setlist or start from a chosen track.
- Export setlists as:
  - M3U
  - TXT
  - CSV

### 10) Backup and restore
- Full backup export of app data from IndexedDB.
- Backup import/restore from file.
- Useful for migration between browsers/devices or safety snapshots.

### 11) Local-first persistence
All app data is stored in browser IndexedDB stores:
- `releases`
- `videos`
- `folders`
- `config`
- `track_meta`
- `setlists`
- `tracklist`
- `wants`
- `marketplace_stats`
- `notifications`

Nothing is sent to a custom backend server.

## Getting Started

1. Open the app.
2. Enter your Discogs username and a personal access token from [Discogs Developer Settings](https://www.discogs.com/settings/developers).
3. Click **Sync Collection**.
4. Browse collection/tracks/want list, play music, and build setlists.

## Running Locally

You can open `index.html` directly, or run a simple local server:

```bash
python3 -m http.server 5000
```

Then open <http://localhost:5000>.

## Project Structure

- `index.html` — SPA shell, nav, now-playing UI containers.
- `style.css` — visual theme and layout.
- `app.js` — full app logic: IndexedDB, Discogs sync, views, player, crossfade, setlists, backup, notifications.

## Tech Stack

- Vanilla JavaScript
- IndexedDB
- YouTube IFrame API
- Discogs API
- Static hosting (GitHub Pages)

## License

MIT
