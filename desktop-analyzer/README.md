# Desktop BPM/Key Analysis Helper

A native helper for [Vinyl Collection Player](../). It reads a backup exported
from the web app, downloads each linked YouTube video's audio, detects tempo,
musical key and energy, and writes a file the web app's **Restore from backup**
button imports directly.

It exists because the web app cannot do this itself: there is no CORS access to
YouTube audio, and vinyl-only collectors have no local files to point at. This
is the only route to real BPM/key data, and it keeps the web app fully
serverless.

The web app is never modified by this tool. The two exchange JSON files.

## Status

Working end to end from the command line. The Tauri shell, signed builds and
distribution are not started yet — see PROJECT_PLAN.md section 3b.

## Build

Needs a Rust toolchain, plus two native libraries.

**aubio** (tempo detection) — from your package manager:

```sh
sudo apt install libaubio-dev        # Debian/Ubuntu
brew install aubio                   # macOS
```

**libkeyfinder** (key detection) — no distro package, so build it into a user
prefix:

```sh
git clone https://github.com/mixxxdj/libkeyfinder
cd libkeyfinder
cmake -DCMAKE_INSTALL_PREFIX=$HOME/.local -DBUILD_TESTING=OFF -S . -B build
cmake --build build && cmake --install build
```

Because that prefix is not on the default search path, **every** cargo command
needs it on `PKG_CONFIG_PATH`:

```sh
source "$HOME/.cargo/env"
export PKG_CONFIG_PATH="$HOME/.local/lib/pkgconfig:$PKG_CONFIG_PATH"
cargo build --release
```

Set `LIBKEYFINDER_PREFIX` if you installed it somewhere else. The library's
directory is baked into the binary as an rpath, so it runs without
`LD_LIBRARY_PATH`.

**yt-dlp** — fetched, not vendored (`binaries/` is gitignored), so grab the
standalone build once:

```sh
mkdir -p binaries
curl -L -o binaries/yt-dlp \
  https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
chmod +x binaries/yt-dlp
```

It needs no Python install. Point somewhere else with `--yt-dlp` if you would
rather use a copy you already have.

## Use

Export a backup from the web app, then:

```sh
# 1. See what would happen. Downloads nothing.
discogs-analyzer backup.json --plan

# 2. Do it.
discogs-analyzer backup.json -o analysis.json
```

Then import `analysis.json` with **Restore from backup** in the web app.

Start with `--limit 5` on a large collection to confirm the results look
sensible before committing to a run that can take hours.

### Options

| Flag | Meaning |
|---|---|
| `--plan` | Print what would be analysed, skipped and flagged; download nothing. |
| `-o, --output` | Where to write the result. Default `analysis.json`. |
| `--force` | Re-analyse tracks whose BPM/key you set or verified yourself. |
| `--limit N` | Stop after N tracks; the rest stay queued for the next run. |
| `--ledger` | Resume file. Defaults to `<output>.ledger.json` beside the output. |
| `--work-dir` | Scratch space for audio. Files are deleted as they are used. |
| `--yt-dlp` | Path to yt-dlp. Defaults to the bundled binary, then `$PATH`. |
| `--max-attempts` | Retries for transient failures, across all runs. Default 3. |
| `--timeout` | Seconds before a stalled download is abandoned. Default 30. |

### Resuming

A full collection can take hours, so every finished track is written to the
ledger immediately. Press Ctrl-C and the current track finishes before the run
stops; re-run the **same command** and it carries on from where it left off.
Nothing is downloaded or analysed twice. A second Ctrl-C exits at once.

The ledger is rewritten atomically (staging file, then rename), so a crash or a
power cut leaves either the previous ledger or the new one — never half of
either.

The ledger is discarded and the run starts over if the analysis algorithm has
changed since it was written, because mixing tempos from two different detectors
is worse than redoing the work.

### What it will not touch

Your own data wins by default. A track is left alone when you have ticked
**BPM/key verified**, or typed a BPM or key yourself. Those records are not
merely skipped — they never enter the export at all, so Restore cannot
overwrite them.

Protection is per field: if you typed a BPM but never got round to the key, the
key is filled in and your BPM is kept.

`--force` overrides this and overwrites your values. The "BPM/key verified" tick
itself is preserved either way, so you can still see what you had checked.

Two things are also held back for you to look at rather than analysed
automatically:

- videos longer than 10 minutes, which are usually a full album or a DJ mix
- videos whose title does not match anything in the release's tracklist, which
  usually means the wrong video is linked

### Output

A backup-shaped document containing only `track_meta`, keyed
`releaseId_youtubeId`. Every other store is absent, so Restore defaults them to
empty and nothing else in your collection is affected.

Records are written **complete**, not as patches: Restore replaces whole
records, so a partial one would erase your ratings, tags and notes. Anything the
tool does not understand is round-tripped untouched.

Analysed values are marked `bpm_source: "analysis"` / `key_source: "analysis"`,
which the web app renders as "estimated" until you tick BPM/key verified.

## Accuracy

Measured against six commercially released tracks with published BPM values
(official artist uploads, to avoid the pitch-shifted re-uploads that are common
on YouTube):

- **Tempo: within about 0.4% on average**, worst case 0.8%. Good enough to
  beatmatch against.
- **Key: 4 of 6 exactly right.** Key detection is genuinely ambiguous on some
  material and published references disagree with each other, so treat it as a
  strong suggestion rather than fact. `key_strength` reports how much of the
  track agreed with the answer — a low number is worth checking by ear.

`bpm_confidence` is the share of gaps between detected beats that were the same
length. A steady four-to-the-floor record scores in the high 90s; anything much
lower usually means rubato, a live drummer, or a track that changes tempo.

Two diagnostics are kept for when a detector is suspected:

```sh
# Does key detection actually agree with known-key audio? Should be 24/24.
cargo run --release -p analyzer-analysis --example key_sweep

# What do the detectors say about one file?
cargo run --release -p analyzer-analysis --example analyze_file -- track.m4a
```

## Layout

| Crate | What it owns |
|---|---|
| `core` | Backup parsing, planning, the resume ledger, provenance-aware merging, Camelot conversion, the run loop. No native dependencies. |
| `analysis` | Decoding (symphonia), tempo (aubio), key (libkeyfinder), energy. The only crate with native dependencies. |
| `download` | The yt-dlp wrapper and its failure classification. |
| `cli` | Argument parsing, progress rendering, and wiring the above together. |

`core` deliberately builds and tests on a bare toolchain, so the logic that
decides what to analyse and what to write back can be tested without aubio or
libkeyfinder present.

### A note on audio formats

yt-dlp is asked for m4a/AAC specifically, not `bestaudio`. YouTube ranks Opus
highest, and symphonia cannot decode Opus — plain `bestaudio` fails on every
single track. See `AUDIO_FORMAT` in `crates/download/src/lib.rs`.

## Licence

**GPL-3.0**, because it links aubio and libkeyfinder (both GPLv3), and
libkeyfinder pulls in FFTW (GPLv2-or-later). This applies to the desktop
analyzer only — the web app is a separate program that exchanges JSON files with
it and keeps its own licence.

You may charge for a GPLv3 binary, but you cannot ship it closed-source, and it
cannot go in the Mac App Store (whose terms conflict with GPLv3). Notarized
direct distribution via GitHub Releases, which is what section 3b plans, is
fine. A permissively licensed build would mean replacing all three dependencies
(`rustfft` for FFTW, and own implementations of tempo and key detection).
