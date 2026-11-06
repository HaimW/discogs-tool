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
- [Development and Testing](#development-and-testing)
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
  - [14. Stats](#14-stats)
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

No build step or dependencies required to run the app.

---

## Development and Testing

The checks need Node 20 or newer. None of this is needed to run the app.

```bash
npm install          # dev tools (ESLint, Playwright), once
npm run lint         # ESLint over app.js, src/ and tests/
npm test             # unit tests (node --test tests/*.test.js)
npm run check        # lint + unit tests
npm run test:e2e     # browser smoke tests (Playwright, tests/e2e/)
```

**Browser smoke tests.** `npm run test:e2e` starts a local static server
(`tests/e2e/server.js`) and runs the real app in Chromium. Every request
that does not go to that server is blocked, except `api.discogs.com`, which
is answered with fake data (`tests/e2e/fixtures.js`). No Discogs token or
network access is needed. The tests click through every view in the top
navigation and check the setup token check, toasts and the lazy background
video.

The first time, download the Chromium build that the pinned
`@playwright/test` (1.62.1) expects:

```bash
npx playwright install chromium
```

To use a Chromium or Chrome binary that is already on disk instead:

```bash
PW_CHROMIUM_PATH=/path/to/chrome npm run test:e2e
```

`npm test` does not run the browser tests. GitHub Actions
(`.github/workflows/web-app.yml`) runs lint + unit tests and the browser
tests as two parallel jobs on every push and pull request (changes that
touch only docs or `desktop-analyzer/` are skipped); on a failure the
Playwright report is attached to the run.

Markup is built as strings, so clicks and other events are wired with
`act()` from `src/actions.js` rather than inline `onclick="…"` handlers:
`'<button' + act('click', 'wlRemove', [w.id, w.title]) + '>'`. Values travel
as escaped JSON data and are never run as code. A test fails if an inline
handler comes back or an action names a function that does not exist.
User-facing messages use `showToast(message, 'info' | 'success' | 'error')`
from `src/toast.js`, not `alert()`.

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
| Max-price alert (bell button on a card) | Set the most you would pay for this release; see below |

**Max-price alerts:**

1. Click the **bell** button on a want-list card.
2. Enter a price (`25` or `25.50`) and pick a currency, then click **Save** (or press Enter).
3. The card shows "Alert at or under EUR 25.00". Click the bell again to change the price or **Clear** it.

When a marketplace check finds copies for sale with a lowest price at or under your max, you get a notification. You get it once; it fires again only after the price has gone back above the max or nothing has been for sale. A for-sale alert for a release whose lowest price is above your max is not sent.

> **Currency:** Discogs reports prices in the currency set in your Discogs account, and the app does not convert. The max is compared only when its currency matches the one Discogs lists the release in. If they differ, the card shows a ⚠ "listed in …" marker, no price alert fires, and you get the plain for-sale alert instead. The currency picker starts on the currency Discogs last reported for that release (USD if it has not been checked).

---

### 5. YouTube Playback

An embedded YouTube player drives all playback. A **Now Playing bar** stays fixed at the bottom of the screen.

**Now Playing bar contains:**
- Cover thumbnail, track title, artist name
- Play/Pause, Previous, Next buttons
- Mute button and volume slider (0–100)
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

**Volume:**
- Drag the slider, or focus it and use the arrow keys, Home (0) and End (100). There are no global keyboard shortcuts.
- The mute button silences playback and keeps the slider where it is; unmuting returns to that volume. Moving the slider while muted unmutes.
- Volume and mute are remembered between visits (config keys `player_volume` and `player_muted`) and are included in backups. The default is 100, unmuted.
- Every new track starts at the chosen volume.
- On narrow screens (480 px wide or less) the slider is hidden and only the mute button stays.
- A volume restored from a backup takes effect on the next page load, the same as crossfade settings.

> **Limitation:** volume is set only by the app's slider and mute button. On iOS the page cannot set volume; use the device buttons.

---

### 6. Crossfade

Automatic volume crossfade between tracks for smooth DJ-style transitions.

**How to enable:**
1. Click the **CF: OFF** button in the Now Playing bar — it toggles to **CF: ON**.
2. Set the fade duration (in seconds) in the input field that appears (default: 5 seconds).

**How it works:**
- A hidden second player silently preloads the next track.
- The crossfade starts when the time left in the current track equals the fade length. The fade length is your chosen duration, but at most a third of the current track (a 9 s fade on a 10 s track lasts about 3.3 s). Tracks shorter than 3 seconds get no fade.
- Player 1 fades from your [volume](#5-youtube-playback) to 0 while Player 2 fades from 0 to your volume.
- Moving the volume slider or muting during a fade rescales both players at the current point of the fade.
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

**Relative key:** wherever a key is shown (release page, Tracks view, setlist detail, Suggestions panel), it ends with its relative key, e.g. `8A … rel 8B`. Hover for the full name ("Relative key 8B (C major)"); screen readers read the full name. The Suggestions panel's "Current" line and the centre of the Camelot wheel in the metadata editor show it too.

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

New listings trigger a notification only when a previously-unavailable item becomes available (0 → 1+ copies), or when the lowest price drops to a [max price](#4-want-list) you set. Such alerts also show your max.

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

The file (format version 3) labels each section as *authored* or *derived*.

*Authored* — what you typed, or what built up in this browser over time. Discogs cannot give it back; this is what the backup is for:

- Track metadata (BPM, Key, Rating, Energy, Shelf, Tags, Notes, Verified)
- Setlists with track order and notes
- Store inventory items and batches
- Max-price alerts
- Price history (marketplace readings recorded over time)
- Notifications (marketplace alert history)
- Your Discogs username, crossfade settings, and player volume and mute

*Derived* — copies of Discogs data, so a restore works without a sync; a sync would fetch them again:

- Releases (with your video picks), videos, folders, physical tracklists
- Want list and its latest marketplace stats

**Not included:** your Discogs token, and the collection value from the Stats page. A backup file holds no credential, so it is safe to keep in a cloud folder. After restoring into a fresh browser, go to **Setup** and enter your token again.

A `_contents` entry at the top of the file lists every section and its label. Track metadata and the collection stay where version 2 files had them, because the desktop analyzer reads them there.

**Restore:**
1. Click **Choose backup file…** and select a backup JSON. The restore starts as soon as you pick the file.
2. Data is merged into the current database (existing data is not wiped). Running it twice is safe.
3. A message reports how many items were restored by type.

What restore accepts and how it merges:

- Backups from any version of this page (v1, v2, v3), and the desktop analyzer's `analysis.json` (restores track metadata only).
- Releases are merged field by field: your video picks in this browser win over the file's, fetched details are kept when the file lacks them, and newer have/want counts are kept. Other records from the file replace the local record with the same ID.
- Marketplace stats already in this browser are kept; the file's fill in only what is missing, and do not trigger alerts by themselves.
- Max-price alerts for releases that are in neither your want list nor the file are dropped.
- Older backups (v2 and earlier) contain your token. It is restored only when this browser has no token; otherwise your current token is kept. The message says which happened.
- The file's username is used only together with its token, or when this browser has no login at all, so a restore never pairs one account's token with another account's username.
- Invalid volume or mute values in the file are skipped and the current setting is kept. Volume must be a whole number from 0 to 100; mute must be `true` or `false`.
- Restore is refused while a sync or collectability fetch is running.

> **Important:** All data is stored in your browser's IndexedDB. Clearing browser site data will delete everything. Regular backups are strongly recommended.

---

### 14. Stats

The **Stats** view (top navigation) summarises your collection. It reads the releases stored in this browser, so sync your collection first.

**Collection value:**
- Click **Refresh value** to fetch Discogs' estimate (minimum, median, maximum), based on recent marketplace sales. This takes one request and needs your token and username.
- The figures are shown exactly as Discogs formats them, in the currency of your Discogs account, with the time they were fetched. They are not refreshed automatically, and they are not included in backups.

**Collectability:**
- How many Discogs users have and want each of your releases, with the totals, a **Most wanted** list and a **Highest want/have ratio** list (releases with fewer than 5 wants are left out of the ratio list). Click a release to open it.
- A collection sync records these counts while it fetches release details. Releases synced before this feature have none; the **Fetch collectability (N missing, ~M min)** button fills them in.
- The backfill costs one Discogs request per release. At the authenticated limit of 60 requests a minute, 1,000 releases take about 20 minutes. Collection sync is unavailable while it runs.
- Click **Stop** to end it early. Every fetched release is saved as it arrives, so the next run continues with the ones still missing. It keeps running if you switch to another view. After three failed requests in a row it stops by itself.

**Breakdowns:** bar tables of how many releases fall under each genre, style, decade, country and format, with each one's share of the collection. Decades are all listed, oldest first; for the others the largest 10 are listed and the rest grouped as **Other**, and releases without a value as **Unknown**. A release with several genres, styles or formats counts in each, so those shares can add up to more than 100%. Country arrives with the background video sync; until then a release counts as Unknown.

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
| `price_history` | Marketplace readings recorded over time |
| `want_alerts` | Max-price alerts per want (price and currency) |

The `config` store also keeps the last fetched collection value (`collection_value`).

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
    ├── volume.js       — Master volume + mute (shared by both players and the crossfade)
    ├── harmonic.js     — Harmonic mixing and suggestion scoring
    ├── camelot.js      — Camelot key chips, relative key, key wheel
    ├── visualizer.js   — Canvas visualizer (8 modes)
    ├── search.js       — Search and filter utilities
    ├── setlists.js     — Setlist CRUD and playback
    ├── marketplace.js  — Marketplace polling and notifications
    ├── backup.js       — Export and restore logic
    ├── meta.js         — Track metadata read/write
    ├── meta_editor.js  — Inline metadata editor UI
    ├── queue.js        — Queue management
    ├── utils.js        — Shared helpers (escaping, dates, pagination)
    ├── actions.js      — Delegated event actions: act() instead of inline handlers
    ├── toast.js        — Non-blocking messages: showToast()
    ├── store_serial.js — Store serialisation logic
    └── views/
        ├── setup.js        — Credentials setup screen
        ├── collection.js   — Collection grid and release detail
        ├── tracks.js       — All Tracks view
        ├── wantlist.js     — Want List view
        ├── wantlist_sync.js — Want list sync logic
        ├── release.js      — Release detail page
        ├── stats.js        — Stats view (value, collectability, breakdowns)
        └── store.js        — Store & inventory view
```

Tests live in `tests/` (unit tests, `*.test.js`) and `tests/e2e/` (browser smoke tests, configured in `playwright.config.js`).

---

## Tech Stack

| Layer | Technology |
|---|---|
| Language | Vanilla JavaScript (classic scripts sharing one global scope; see `index.html` for the load order) |
| Storage | IndexedDB (via custom wrapper) |
| Music data | [Discogs REST API](https://www.discogs.com/developers/) |
| Video playback | YouTube IFrame API |
| Hosting | GitHub Pages (static) |

No frameworks, no bundler, no server. ESLint, Node's built-in test runner and Playwright are the only development tools.

---

## License

MIT
