# Vinyl Collection Player

A web app that syncs your Discogs vinyl collection and lets you listen to it via YouTube. Browse your crates, filter by genre or folder, and hit shuffle — all from a dark, vinyl-themed interface.

## Features

- **Discogs sync** — imports your full collection with cover art, genres, styles, and formats
- **YouTube playback** — embedded player with queue, auto-advance, and play/pause controls
- **Persistent playback** — music keeps playing as you browse between pages
- **Folder filtering** — uses your Discogs folders (e.g. "House", "Techno") as filters
- **Genre filtering** — filter by genre with one click
- **Search** — find releases by artist or title
- **Shuffle play** — random playlist from your whole collection or filtered subset
- **Setup wizard** — no manual config needed, enter your Discogs token on first boot

## Quick Start (Docker)

```bash
git clone https://github.com/HaimW/discogs-tool.git
cd discogs-tool
docker compose up
```

Open [http://localhost:5000](http://localhost:5000) and follow the setup wizard.

Your database and credentials are stored in `./data/` and persist across restarts.

## Quick Start (Manual)

```bash
git clone https://github.com/HaimW/discogs-tool.git
cd discogs-tool
pip install -r requirements.txt
python app.py
```

Open [http://localhost:5000](http://localhost:5000) and follow the setup wizard.

## Getting a Discogs Token

1. Go to [Discogs Developer Settings](https://www.discogs.com/settings/developers)
2. Click **Generate new token**
3. Copy the token — you'll paste it into the setup wizard

## How It Works

1. **Sync** — click "Sync Collection" to pull your releases from Discogs
2. **Browse** — scroll the grid, search, filter by genre or folder, sort by artist/title/year
3. **Play** — click a release to see its tracklist, click play on any track
4. **Shuffle** — hit "Shuffle Play" on the collection page for a random mix

The first sync fetches video links for each release from the Discogs API. This takes a few minutes for large collections (~1 release/sec due to API rate limits). Subsequent syncs only fetch new additions.

## Tech Stack

- **Backend:** Flask, SQLite, requests
- **Frontend:** Vanilla JS, YouTube IFrame API
- **No build step.** No npm. No bundler. Just Python and a browser.

## Project Structure

```
app.py              Flask routes + entry point
db.py               SQLite schema + query helpers
discogs_sync.py     Three-phase Discogs API sync (folders, collection, videos)
config.py           Env var loader + setup wizard config
static/player.js    YouTube player, queue, state persistence
static/style.css    Dark vinyl theme
templates/          Jinja2 templates (base, index, release, setup)
```

## License

MIT
