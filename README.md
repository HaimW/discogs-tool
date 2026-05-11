# Vinyl Collection Player

A **pure browser-based Discogs companion** for DJs and collectors. Sync your collection and want list, link playable YouTube videos, build setlists, and dig crates with BPM/key filtering and harmonic mixing suggestions.

**No backend. No install. No build step. All data stays in your browser.**

---

## Live App

**[haimw.github.io/discogs-tool](https://haimw.github.io/discogs-tool/)**

---

## Table of Contents

- [Getting Started](#getting-started)
- [Running Locally](#running-locally)
- [Features](#features)
  - [1. Discogs Collection Sync](#1-discogs-collection-sync)
  - [2. Collection Browsing](#2-collection-browsing)
  - [3. All Tracks View](#3-all-tracks-view)
  - [4. Want List](#4-want-list)
  - [5. YouTube Playback](#5-youtube-playback)
  - [6. Crossfade](#6-crossfade)
  - [7. Harmonic Mixing & Suggestions](#7-harmonic-mixing--suggestions)
  - [8. Track Metadata Editor](#8-track-metadata-editor)
  - [9. Setlists](#9-setlists)
  - [10. Visualizer](#10-visualizer)
  - [11. Marketplace Monitoring](#11-marketplace-monitoring)
  - [12. Store & Inventory](#12-store--inventory)
  - [13. Backup & Restore](#13-backup--restore)
- [Data Storage](#data-storage)
- [Project Structure](#project-structure)
- [Tech Stack](#tech-stack)
- [License](#license)

---

## Getting Started

1. Open the [live app](https://haimw.github.io/discogs-tool/) (or [run it locally](#running-locally)).
2. Go to **Setup** and enter your Discogs username and a personal access token.
   - Generate a token at [Discogs Developer Settings](https://www.discogs.com/settings/developers).
3. Click **Sync Collection** — your releases load in two phases (folders first, then full metadata).
4. Browse your collection, play tracks, build setlists, and monitor your want list.

---

## Running Locally

Clone the repo and serve the files with any static server:

```bash
git clone https://github.com/haimw/discogs-tool.git
cd discogs-tool
python3 -m http.server 5000
```

Then open [http://localhost:5000](http://localhost:5000).

No build step or dependencies required.

---

## Features

### 1. Discogs Collection Sync

**How it works:**

- Phase 1 — Downloads all collection folders and release stubs.
- Phase 2 — Fetches full release metadata (cover art, tracklists, genres, formats, styles, country).
- A second pass against Discogs folder `0` ("All") catches any unfiled releases.
- Removes releases (and linked video/track data) that are no longer in your collection.
- After browsable data is ready, fetches YouTube videos and physical tracklists in the background.
- Handles Discogs rate limits (60 req/min authenticated) with automatic retries and backoff.
- Shows live sync progress on screen.

**What gets stored per release:**

| Field | Description |
|---|---|
| Artist / Title / Year | Core release info |
| Format | Vinyl, CD, Cassette, etc. |
| Genres / Styles | From Discogs metadata |
| Country | Country of pressing |
| Folder | Which collection folder it belongs to |
| Quantity | How many copies you own |
| Cover / Thumb | Cover art images |
| Date Added | When added to your collection |
| Videos | YouTube links from the release page |
| Tracklist | Physical side-by-side track listing (A1, B1, etc.) |

---

### 2. Collection Browsing

The **Your Collection** view shows your releases as a card grid.

**Filters:**

| Filter | How to use |
|---|---|
| Search | Type artist or title in the search box |
| Genre | Click a genre pill to filter |
| Folder | Click a folder pill to filter |
| Country | Click a country pill to filter |

**Sort options:** Artist, Title, Year, Date Added

**Pagination:** 48 releases per page

**Each card shows:**
- Cover art (or a vinyl icon if none available)
- Artist, title, year, format
- Video count badge (e.g. "5 videos" or "No Videos")
- Quantity badge (e.g. "×2") if you own multiple copies

**Click any card** to open the release detail page:
- Full metadata and Discogs link
- Physical tracklist (sides A, B, etc.)
- All linked YouTube videos — click any to play
- Metadata badges (BPM, Key, Rating) on each track

---

### 3. All Tracks View

A flat list of every video across your entire collection — ideal for crate digging and DJ prep.

**Filters:**

| Filter | How to use |
|---|---|
| Search | Type title, artist, or release name |
| BPM Range | Enter min and/or max BPM |
| Key | Pick a Camelot key from the dropdown (1A–12B) |
| Min Rating | Click a star pill (1★–5★) |
| Tag | Click a tag pill (e.g. "peak", "floor filler") |

**Sort options:** Artist, Title, Release, Year, BPM, Rating

**Each track row shows:**
- Artist, title, release name
- BPM, Key, Rating, Shelf Location, Tags badges (when filled in)
- Play button, Add-to-Setlist button, Edit Metadata button

---

### 4. Want List

Sync and browse your Discogs want list with marketplace monitoring.

**Sync:** Click **Sync Want List** to download all your wants into the browser.

**Filters:**

| Filter | How to use |
|---|---|
| Search | Type artist or title |
| Genre | Click a genre chip |
| Format | Click a format pill |
| Decade | Click a decade pill (1960s, 1970s, etc.) |
| Country | Click a country pill |
| Availability | Filter to items currently for sale |

**Sort options:** Artist, Title, Year, Date Added, Rating

**Actions:**

| Action | Description |
|---|---|
| Play | Play linked YouTube video if available |
| Shuffle | Shuffle through playable want list items |
| Check Availability | Pull marketplace stats for all want list items |
| Export CSV | Download full want list as a CSV file |
| Dig Deeper | Analyse which genres, styles, and artists are in your want list but not yet in your collection — click any pill to filter |

---

### 5. YouTube Playback

An embedded YouTube player drives all playback. A **Now Playing bar** stays fixed at the bottom of the screen.

**Now Playing bar contains:**
- Cover thumbnail, track title, artist name
- Play/Pause, Previous, Next buttons
- Crossfade toggle and duration input
- Suggestions button (harmonic mixing)
- Queue panel button
- Add to Setlist button
- Go to Release button

**Playback modes:**

| Mode | How to trigger |
|---|---|
| Single track | Click any track row or video entry |
| Play all from release | "Play All" button on a release detail page |
| Play from collection | "Play Collection" on the collection view |
| Shuffle | "Shuffle" button — enter how many tracks (1–9999) |
| Setlist | "Play All" or click a specific track in a setlist |

**Queue panel:**
- Shows the current queue in order
- Remove any track from the queue
- Click a track to jump to it

---

### 6. Crossfade

Automatic volume crossfade between tracks for smooth DJ-style transitions.

**How to enable:**
1. Click the **CF: OFF** button in the Now Playing bar — it toggles to **CF: ON**.
2. Set the fade duration (in seconds) in the input field that appears (default: 5 seconds).

**How it works:**
- A hidden second player silently preloads the next track.
- When the current track reaches `[fade duration + 2]` seconds from its end, the crossfade starts.
- Player 1 fades from 100% → 0% volume while Player 2 fades 0% → 100%.
- After handoff, the next-next track is preloaded for continuous gapless play.
- Crossfade aborts cleanly if the track ends unexpectedly.

**Settings are saved** to IndexedDB and persist across sessions.

---

### 7. Harmonic Mixing & Suggestions

Get a ranked list of compatible next tracks based on key, BPM, and genre.

**How to open:** Click the **Suggestions** button in the Now Playing bar.

**How scoring works:**

| Factor | Points |
|---|---|
| Exact Camelot key match | 100 |
| Adjacent key on Camelot wheel (±1 or relative major/minor) | 70 |
| Genre match | 40 |
| BPM within 6% delta | Up to 100, scaled by closeness |
| Track rating bonus | +2 per star |

**Camelot wheel compatibility:** Same key, one step clockwise, one step counter-clockwise, or the relative major/minor (A↔B same number).

**Panel shows:** Top 20 suggestions with score, BPM, key, artist, title. For each suggestion:
- **Play Next** — inserts it immediately after the current track
- **Queue** — adds it to the end of the queue

> Tip: Add BPM and Key to your tracks via the Metadata Editor for best results. Without them, suggestions fall back to genre matching only.

---

### 8. Track Metadata Editor

Add DJ metadata to any track directly in the app.

**How to open:** Click the **pencil (✎)** icon on any track row in the Tracks view, Release detail, or Setlist detail.

**Editable fields:**

| Field | Type | Notes |
|---|---|---|
| BPM | Number | 40–220 |
| Key | Dropdown | Camelot 1A–12B |
| Rating | Stars | 0–5 stars |
| Energy | Number | 1–10 scale |
| Shelf Location | Text | Physical storage reference (e.g. "A3") |
| Tags | Text | Comma-separated (e.g. "peak, floor filler, closer") |
| Notes | Textarea | Freeform notes |
| Verified | Checkbox | Mark the YouTube link as confirmed correct |

Click **Save** to persist, or **Cancel** to discard. Data is stored per track (indexed by release ID + YouTube ID) and syncs immediately to filters and suggestions.

---

### 9. Setlists

Build and manage DJ setlists (playlists) from your collection.

**How to create a setlist:**
1. Go to **Setlists** in the navigation.
2. Click **New Setlist** and enter a name.

**Adding tracks to a setlist:**
- Click the **+** button on any track row → pick a setlist from the popover.
- Click the **+** button in the Now Playing bar to add the current track.

**Setlist detail page:**

| Action | How |
|---|---|
| Rename | Click the name field and type |
| Reorder tracks | Drag the ⋮ handle up or down |
| Remove a track | Click the × button |
| Add notes | Type in the Notes textarea (venue, vibes, cues, etc.) |
| Play all | Click **Play All** |
| Play from a track | Click that track row |

**Export options:**

| Format | Use case |
|---|---|
| M3U | Import into media players |
| TXT | Plain text track listing |
| CSV | Spreadsheet with BPM, Key, and metadata |

---

### 10. Visualizer

A canvas-based visualizer renders in the Now Playing bar while music plays.

**Switch modes** using the buttons above the canvas:

| Mode | Description |
|---|---|
| Bars | 56 vertical bars in a cyan-to-magenta spectrum with a mirror reflection |
| Wave | 3 overlapping animated sine waves |
| Particles | 180 star-field particles with fade trails |
| Rings | 6 concentric rings pulsing outward from centre |
| Aurora | 5 wavy bands mimicking the northern lights |
| Helix | Twin DNA strands with connecting rungs |
| Lissajous | Mathematical Lissajous curves with glow |
| Tunnel | Receding neon rectangles forming a tunnel |

Visualizer starts and stops automatically with playback.

---

### 11. Marketplace Monitoring

Monitor Discogs marketplace listings for items on your want list.

**How to use:**
1. Sync your want list.
2. Click **Check Availability** on the Want List page — pulls current stats for all wanted items.
3. Background polling re-checks every 30 minutes automatically.

**What gets tracked per item:**
- Number of copies for sale
- Lowest listed price and currency
- Timestamp of last check

**Notifications:**
- A bell icon in the top nav shows an unread badge when new listings appear.
- Click the bell to open the **Notifications panel**:
  - Lists all marketplace alerts with "time ago" timestamps
  - Shows lowest price per alert
  - **Buy** link goes directly to the Discogs marketplace listing
  - **Clear All** removes all notifications

New listings trigger a notification only when a previously-unavailable item becomes available (0 → 1+ copies).

---

### 12. Store & Inventory

Manage a physical record store or selling inventory directly from your collection.

**Serialization:**
- Assign serial numbers to records for inventory tracking (auto-generated or manually entered).
- Group records into **batches** (e.g. by selling event or location).

**Inventory table columns:** Serial, Artist, Title, Year, Country, Style, Format, Min Price, Status, Batch, Actions

**Actions per item:**

| Action | Description |
|---|---|
| Mark as Sold | Records sale date and price received |
| Assign to Batch | Move item into a named batch |
| Refresh Price | Pull current marketplace price from Discogs |
| Open on Discogs | Jump to the listing on Discogs.com |

**Batch management:**
- Create and name batches (selling events, locations, etc.)
- Filter inventory to a single batch
- Print serialised labels for a batch

**Filters:** Free-text search (serial, artist, title), Status (All / Active / Sold), Batch

---

### 13. Backup & Restore

Export and import your complete app data to protect against browser data loss or to migrate between browsers/devices.

**Export (backup):**
1. Go to **Backup & Restore**.
2. Click **Download full backup** — saves a dated JSON file (`vinyl-backup-YYYY-MM-DD.json`).

**What the backup includes:**

- Discogs credentials (token and username)
- Releases, videos, folders, physical tracklists
- Want list and marketplace stats
- Track metadata (BPM, Key, Rating, Energy, Shelf, Tags, Notes)
- Setlists with track order and notes
- Store inventory items and batches
- Notifications and alerts

**Restore:**
1. Click **Choose File** and select a backup JSON.
2. Click **Restore** — data is merged into the current database (existing data is not wiped).
3. A summary reports how many items were restored by type.

> **Important:** All data is stored in your browser's IndexedDB. Clearing browser site data will delete everything. Regular backups are strongly recommended.

---

## Data Storage

All data is stored locally in **IndexedDB** — nothing is sent to any custom backend.

| Store | Contents |
|---|---|
| `config` | Discogs credentials and app settings |
| `releases` | Full release metadata |
| `videos` | YouTube video links per release |
| `folders` | Collection folder structure |
| `tracklist` | Physical track listings (Discogs side/position data) |
| `track_meta` | Editable DJ metadata (BPM, Key, Rating, Energy, Shelf, Tags, Notes) |
| `wants` | Want list items |
| `marketplace_stats` | Price and availability data |
| `setlists` | Setlists with tracks, order, and notes |
| `store_items` | Serialised inventory records |
| `store_batches` | Inventory batch groupings |
| `notifications` | Marketplace alerts |

Session state (currently playing track) is stored in `sessionStorage` so playback context survives page refreshes.

---

## Project Structure

```
discogs-tool/
├── index.html          — SPA shell, navigation, now-playing UI
├── app.js              — App entry point and initialisation
├── style.css           — Visual theme and layout
└── src/
    ├── api.js          — Discogs API client with rate-limit handling
    ├── db.js           — IndexedDB wrapper
    ├── config.js       — App configuration and constants
    ├── init.js         — Startup and credential checks
    ├── router.js       — Client-side routing
    ├── player.js       — YouTube IFrame player wrapper
    ├── player_state.js — Playback state (queue, current track)
    ├── crossfade.js    — Crossfade engine (dual player)
    ├── harmonic.js     — Harmonic mixing and suggestion scoring
    ├── visualizer.js   — Canvas visualizer (8 modes)
    ├── search.js       — Search and filter utilities
    ├── setlists.js     — Setlist CRUD and playback
    ├── marketplace.js  — Marketplace polling and notifications
    ├── backup.js       — Export and restore logic
    ├── meta.js         — Track metadata read/write
    ├── meta_editor.js  — Inline metadata editor UI
    ├── queue.js        — Queue management
    ├── utils.js        — Shared helpers
    ├── store_serial.js — Store serialisation logic
    └── views/
        ├── setup.js        — Credentials setup screen
        ├── collection.js   — Collection grid and release detail
        ├── tracks.js       — All Tracks view
        ├── wantlist.js     — Want List view
        ├── wantlist_sync.js — Want list sync logic
        ├── release.js      — Release detail page
        └── store.js        — Store & inventory view
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Language | Vanilla JavaScript (ES modules) |
| Storage | IndexedDB (via custom wrapper) |
| Music data | [Discogs REST API](https://www.discogs.com/developers/) |
| Video playback | YouTube IFrame API |
| Hosting | GitHub Pages (static) |

No frameworks, no bundler, no server.

---

## License

MIT
