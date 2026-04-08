# Vinyl Collection Player

A web app that syncs your Discogs vinyl collection and lets you listen to it via YouTube. Browse your crates, filter by genre or folder, and hit shuffle — all from a dark, vinyl-themed interface.

**No install required.** Runs entirely in your browser.

## Try It

Open **[haimw.github.io/discogs-tool](https://haimw.github.io/discogs-tool/)** and enter your Discogs username + token. That's it.

## Features

- **Discogs sync** — imports your full collection with cover art, genres, styles, and formats
- **YouTube playback** — embedded player with queue, auto-advance, and play/pause controls
- **Persistent playback** — music keeps playing as you browse between pages
- **Folder filtering** — uses your Discogs folders (e.g. "House", "Techno") as filters
- **Genre filtering** — filter by genre with one click
- **Search** — find releases by artist or title
- **Shuffle play** — random playlist from your whole collection or filtered subset
- **Zero install** — pure client-side, runs in any modern browser
- **Private** — your token and collection stay in your browser (IndexedDB), never sent to any server

## How It Works

1. Open the app in your browser
2. Enter your Discogs username and [personal access token](https://www.discogs.com/settings/developers)
3. Click **Sync Collection** to pull your releases
4. Browse, search, filter, and play

Your collection is stored locally in your browser's IndexedDB. The app only talks to the Discogs API and YouTube — there is no backend server.

## Getting a Discogs Token

1. Go to [Discogs Developer Settings](https://www.discogs.com/settings/developers)
2. Click **Generate new token**
3. Copy the token and paste it into the app

## Tech Stack

- **Zero dependencies.** No React, no npm, no build step.
- Vanilla JavaScript, IndexedDB, YouTube IFrame API
- Hosted on GitHub Pages (free)

## Running Locally

Just open `index.html` in a browser, or serve it:

```bash
python3 -m http.server 5000
```

## Project Structure

```
index.html    Single page app shell
style.css     Dark vinyl theme
app.js        All logic: Discogs API, IndexedDB, SPA router, YouTube player
```

## v1 (Flask Backend)

The original Flask + SQLite version is on the `main` branch. See its README for Docker and manual setup instructions.

## License

MIT
