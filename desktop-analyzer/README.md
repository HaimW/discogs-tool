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
| `--tempo-min` | Lowest BPM reported; sets the octave band. Default 85. See below. |

### Tempo bands are chosen per release

`--tempo-min` is the **fallback**. Where a release's Discogs `styles` say
something decisive, they win, because one collection can hold both drum and bass
and dub and no single band suits both:

| Styles | Band | Why |
|---|---|---|
| Drum n Bass, Jungle, Halftime, Footwork, Breakcore, Hardcore | 90-180 | Keeps a real 174 at 174, and lifts a half-time reading of 87 back to it. |
| Hip Hop, Trip Hop, Reggae, Dub, Dancehall, Dubstep | 70-140 | Stops a 75 BPM record being doubled to 150. |
| Anything else | `--tempo-min` | House, techno, ambient and the rest. |

The slow band is vetoed by any house/techno/breakbeat style on the same release.
"Dub" beside "Techno" is dub *techno* at 120-130, not reggae dub at 75 — every
"Dub" release in the collection this was built against is of that kind, and
without the veto each one would have been halved. The fast band has no veto: a
90-180 window still contains 128, so the cost of being wrong is nil in that
direction and the whole track in the other.

### Choosing `--tempo-min`

A tempo detector finds a *beat grid*, and a grid is only defined up to a factor
of two. A 152 BPM record with quiet off-beats gives every other beat and reads
76; one with a buried kick can read 38. The grid is right and the octave is
wrong, so the fix is to fold the answer into a one-octave window.

`--tempo-min` is the bottom of that window, and the top is twice it. **Where the
window sits is a genre judgement the tool cannot make for you** — 76 BPM is half
of 152 in a house collection and simply 76 in a hip hop one.

| You play | Use | Window | Consequence |
|---|---|---|---|
| House, techno, disco, electro | `85` (default) | 85-170 | 174 drum and bass is reported as 87 |
| Drum and bass, jungle, footwork | `90` | 90-180 | 89 BPM half-time is pushed to 178 |
| Hip hop, dub, downtempo | `70` | 70-140 | 152 BPM house is halved to 76 |
| Mixed, or you want the raw reading | `0` | none | Half-time errors are reported as-is |

Changing it changes the numbers, so it is part of the settings the ledger
records: a run with a different `--tempo-min` starts fresh rather than mixing
two conventions in one export.

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

### A second opinion on syncopated material

Tempo normally comes from one detector: aubio tracks the beat as the audio
streams past and the period is fitted to the beat positions it reports. That
works on four-to-the-floor material and fails in a specific way on breaks — a
causal tracker can lock onto a secondary pulse and hold it, producing a grid
that is internally consistent (so its confidence stays middling rather than
collapsing) while counting something that is not the beat.

So when **both** of these hold, a second, independent estimate is taken:

- the release's Discogs styles are syncopated — breakbeat, breaks, jungle, drum
  and bass, footwork, IDM, UK garage and relatives, and
- the beat grid's own agreement is below 0.85.

The second estimate autocorrelates an onset envelope over the whole track and
asks which period best explains it globally. It never tracks anything, so it
cannot follow a wrong pulse; its weakness is the opposite one, poor precision.
The two are combined on exactly that basis — the grid supplies the number, the
autocorrelation supplies the decision about which pulse the number describes:

| `bpm_method` | What happened |
|---|---|
| `beat-grid` | One method. No reason to doubt it. |
| `beat-grid-confirmed` | Both agreed. Confidence raised. |
| `beat-grid-rescaled` | They differed by a musical ratio (half-bars, triplets). The precise figure was moved onto the right pulse. |
| `autocorrelation` | No musical relation, and the independent estimate was strong. It was taken; confidence is capped at its strength. |
| `disputed` | They disagreed and neither convinced. The grid's figure stands and confidence is cut to 0.3 — check this one by ear. |

`bpm_second_opinion` records the independent estimate whether or not it was
believed, because the disagreement is the useful part.

Measured on the jungle and breakbeat releases in the collection this was built
against: of 8 tracks, 3 were rescaled by a 3:2 relation (100.74 to 151.11,
101.03 to 151.54, 106.89 to 160.34, each corroborated to within 0.5% by the
independent estimate), 2 were left alone as already confident, and 3 were marked
disputed. One of those three looks correct and was flagged anyway — the check is
tuned to raise a question rather than to be right.

### Should it just run both every time?

No, and the reason is accuracy rather than cost. `--second-opinion always`
widens the check to every style; run over 50 house and techno tracks from this
collection it produced:

| Outcome | Count |
|---|---|
| Confirmed a reading that was already right | 10 |
| Overruled the tempo | 3 — at least 2 of them wrong (128.28 to 168.10, 120.62 to 160.20 on tracks that are plainly house) |
| Disputed a correct reading down to 0.3 confidence | 2 |
| Untouched (first reading was confident) | 35 |

So five of the fifteen checks made the result worse and ten only confirmed what
was already known. On four-to-the-floor material the beat tracker is reliable,
and a second estimate that cannot see the difference adds noise, not precision.
It earns its place exactly where the tracker is weak, which is what `auto` picks
out. `--second-opinion never` turns it off entirely.

Both gates matter. Measured on the collection this was built against, 60 of 448
releases carry a syncopated style (396 of 3399 videos, 11.7%), and about 30% of
tracks fall below the confidence threshold — so the second estimate runs on
roughly **3.5% of a full pass**. When it does run it costs **12 ms** against
about 990 ms for a full analysis of a five-minute track, or 1.2%. Reproduce
with:

```sh
cargo test --release -p analyzer-analysis --test second_opinion_cost -- --nocapture
```

### Energy is a rank, not a measurement

`energy` is a 1-10 figure, and it is **relative to your own collection**: 10 is
among the hardest tenth of the records you have analysed, not a reading against
some absolute reference.

It works this way because the absolute version did not. Energy is half loudness,
and every mastered record sits within a couple of dB of every other one, so the
dominant term barely varies: on a 50-track sample, 35 landed on 5 or 6 and the
buckets 1, 2, 3, 9 and 10 were never used at all. Ranking uses the whole scale by
construction, and "one of my harder records" is what the number is reached for
anyway.

Two consequences:

- A track's energy can shift as you analyse more of the collection. That is the
  scale recalibrating, not the analysis changing its mind.
- Below 20 analysed tracks there is not enough of a sample to rank, so the
  absolute scale is left in place.

The underlying continuous score is kept as `energy_score`, so a later run can
re-rank the collection without downloading anything again. Energy you typed
yourself is never re-scaled.

## Accuracy

Measured against six commercially released tracks with published BPM values
(official artist uploads, to avoid the pitch-shifted re-uploads that are common
on YouTube):

- **Tempo: within about 0.4% on average**, worst case 0.8%. Good enough to
  beatmatch against. That is accuracy *within* an octave; picking the right
  octave is what `--tempo-min` is for.
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
