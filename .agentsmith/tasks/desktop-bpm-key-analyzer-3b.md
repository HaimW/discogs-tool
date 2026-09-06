# Section 3b — Desktop BPM/Key Analysis Helper
Status: **Shipped and run over the whole collection** — GUI/distribution deferred      Path: complex
Last worked: 2026-09-06      Branch: `v2-github-pages`

> **2026-09-06 session:** accuracy fixes, portable binary + local web UI, a
> security fix, a concurrent pipeline, and a full 2,891-track run. Narrative
> record, results and the open list: **`docs/analyzer-2026-09-06.md`**.
> Read that first — it supersedes the "What to pick up next" section below.

---

# START HERE (resume point)

## Where this stands in one paragraph

The desktop analyzer **works end to end from the command line**. It reads a web-app
backup, downloads each linked YouTube video with yt-dlp, detects BPM/key/energy,
and writes a JSON file the web app's "Restore from backup" button imports as-is.
All three §3b "Must have" guarantees (resumable, progress UI, never overwrite
your own data without `--force`) are implemented and proven against the real
binary, not just tests. 125 tests pass, clippy is clean, release builds.
What is **not** started: the Tauri GUI shell, yt-dlp sidecar bundling, and
distribution/signing — all deliberately deferred.

## Committed

The work landed on `v2-github-pages` in three commits, all on 2026-09-04:

- `990d768` — core + native analysis crates (§3b phases 1-2)
- `6c209e6` — web-app half: Camelot wheel, `bpm_verified`, provenance chips
- `327910a` — `analyzer-cli` and the systematic tempo-bias fix

(Earlier revisions of this file said nothing was committed — that was true
while the work was in progress, and is not now. Check `git status` for whatever
is in flight on top of those commits rather than trusting this line.)

Verify in one command:

```sh
cd /home/yafim/projects/discogs-tool/desktop-analyzer
source "$HOME/.cargo/env"; export PKG_CONFIG_PATH="$HOME/.local/lib/pkgconfig:$PKG_CONFIG_PATH"
cargo test --workspace && cargo clippy --workspace --all-targets
```
Expect **125 passed, 0 failed** and **zero clippy warnings**.

## How to build and run

The `PKG_CONFIG_PATH` line is required in **every** cargo shell — libkeyfinder
lives in `~/.local`, which is not on the default search path.

```sh
cd /home/yafim/projects/discogs-tool/desktop-analyzer
source "$HOME/.cargo/env"
export PKG_CONFIG_PATH="$HOME/.local/lib/pkgconfig:$PKG_CONFIG_PATH"
cargo build --release
```

Then, with a backup exported from the web app:

```sh
# 1. Dry run. Downloads nothing. Always start here.
./target/release/discogs-analyzer backup.json --plan

# 2. Small real run, to sanity-check the numbers.
./target/release/discogs-analyzer backup.json -o analysis.json --limit 5

# 3. The full run. Ctrl-C is safe; re-run the same command to resume.
./target/release/discogs-analyzer backup.json -o analysis.json
```

Import `analysis.json` with **Restore from backup** in the web app.

Full flag list: `--plan --force --limit N --max-attempts N --ledger PATH
--work-dir PATH --yt-dlp PATH --timeout SECONDS`. See
`desktop-analyzer/README.md`, which documents setup, resume behaviour, the
protection rules, the output contract and the licence position.

## One-time prerequisites (already satisfied on this machine)

```sh
sudo apt install libaubio-dev                      # aubio: tempo
git clone https://github.com/mixxxdj/libkeyfinder  # libkeyfinder: key
cd libkeyfinder
cmake -DCMAKE_INSTALL_PREFIX=$HOME/.local -DBUILD_TESTING=OFF -S . -B build
cmake --build build && cmake --install build
```

`binaries/` is **gitignored**, so yt-dlp is fetched, not vendored. On a fresh
clone you must re-fetch it or the run fails immediately with a clear message:

```sh
mkdir -p binaries
curl -L -o binaries/yt-dlp \
  https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
chmod +x binaries/yt-dlp
```

## §3b spec checklist

| Spec item | Status |
|---|---|
| Pure Rust, no Python | done |
| Download via yt-dlp standalone binary | done — wrapper + failure classification |
| BPM via aubio | done — direct bindgen FFI, not the `aubio-rs` crate |
| Key via libkeyfinder FFI (bindgen + thin C++ shim) | done |
| Input: `exportFullBackup()` JSON | done |
| Skip if already verified / manually set | done — see the `bpm_verified` note below |
| Flag videos >10 min for review | done (`MAX_TRACK_SECONDS = 600`) |
| Flag title mismatches against the tracklist | done |
| BPM + confidence | done — confidence was meaningless, rewritten |
| Key + scale + strength | done |
| Output keyed `releaseId_youtubeId`, Restore-compatible | done, verified against `src/backup.js` |
| **Must have:** resumable | done — proven with a real SIGINT and restart |
| **Must have:** progress UI | done — TTY redraw, plain text when piped |
| **Must have:** never overwrite without `--force` | done — proven end to end |
| Licence check on libkeyfinder | done — GPL-3.0, plus FFTW GPL-2.0-or-later |
| Tauri shell | **NOT STARTED** (deferred by request) |
| yt-dlp bundled as a Tauri sidecar | **NOT STARTED** (needs Tauri) |
| Signed builds / notarization / GitHub Releases | **NOT STARTED** (deferred by request) |

Beyond spec, also built: energy detection, a `--plan` dry run, and 125 tests.

## What to pick up next

1. **Run it on a real full collection.** Sampled at 50 tracks on 2026-09-06
   (~4s/track, so ~3.5h for 3019); the full run has not been done.
   Export a **fresh** backup first: records are emitted whole, so analysing a
   stale export and importing it would replace live records with versions that
   predate any metadata edited since.
2. **Tauri shell** — the GUI. `pipeline::Progress` was designed to drive it, and
   `SystemClock`/`FileLedgerStore` live in `core` (not the CLI) precisely so
   Tauri reuses them. Add `src-tauri` to the workspace `members`.
   ⚠️ It will hit the **same rpath bug** the CLI hit — see "Bug found while
   wiring the CLI" below. Copy `crates/cli/build.rs`.
3. **yt-dlp as a sidecar**, then distribution/signing. Note the licence
   constraint before designing this: GPLv3 rules out the Mac App Store.
4. ~~Reword PROJECT_PLAN.md §3b~~ — **done 2026-09-06.** It said skip on
   `verified: true`, the wrong field (that means "YouTube link verified");
   the correct flag is `bpm_verified`. The code was always right; the plan
   text invited a regression. The output contract and the complete-record
   requirement were corrected in the same pass.
5. Small: `runtime::sync_dir` is a no-op on Windows (TODO in place, harmless
   until a Windows build exists).

## Tauri shell and sidecar — what they mean, and what they cost

Both deferred items are about turning this from *a tool you run in a terminal*
into *an app someone double-clicks*. Neither is started.

### The shell

Tauri is a Rust desktop framework whose UI is HTML/CSS/JS rendered in the
operating system's **own** webview (WebKit on macOS, WebView2 on Windows,
WebKitGTK on Linux) rather than a bundled browser. §3b picked it over Electron
for exactly that reason — the plan's words are "small binary, no bundled
Chromium".

The "shell" is a GUI wrapper around the engine that already exists. Today,
using this tool means: install Rust, install aubio, compile libkeyfinder from
source, fetch yt-dlp, then run terminal commands. §3b's target user is a friend
with a record collection — that is a non-starter for them. With a shell it
becomes: open app → pick your backup file → watch a progress bar → save the
result → import it in the web app.

Concretely: add a `src-tauri` crate to the workspace and write a small
front-end page. The Rust side calls the **same** `pipeline::run` the CLI calls.
That is not a coincidence — it is why the architecture looks the way it does:

- `Progress` is an enum of events rather than print statements, so it can be
  streamed to a webview as easily as to a terminal.
- `SystemClock` and `FileLedgerStore` were deliberately put in `core`, **not**
  in the CLI, so Tauri reuses them instead of reimplementing them.
- `should_stop` is a closure, so a Cancel button wires in exactly where Ctrl-C
  does now.

The workspace `Cargo.toml` already carries a comment anticipating this:
"`src-tauri` joins this list once the app shell is scaffolded."

### The sidecar

"Sidecar" is Tauri's term for an **external executable shipped inside the app
bundle**. You declare it in `tauri.conf.json` under `bundle.externalBin`, Tauri
packs it into the `.app`/`.exe`/`.deb`, and gives you an API that resolves the
correct path at runtime. It expects platform-suffixed names such as
`yt-dlp-aarch64-apple-darwin`.

Why it is needed: right now `binaries/` is gitignored and yt-dlp must be
fetched by hand, and `resolve_yt_dlp()` gropes around — next to the executable,
a couple of relative paths, then `$PATH`. Fine for a developer, useless for
someone who has never heard of yt-dlp. §3b chose the standalone yt-dlp build
specifically because it needs no Python install on the friend's machine.

### Three things that will be underestimated

1. **The native libraries are the real work, not the GUI.** libkeyfinder is
   currently a *dynamic* library in `~/.local`, and aubio comes from apt.
   Neither exists on a user's machine. You would have to either statically link
   libkeyfinder + aubio + FFTW, or bundle the `.dylib`/`.so` inside the app and
   set the rpath to `@executable_path/…`. This is the same class of problem as
   the rpath bug the CLI already hit, but harder — and it is the biggest hidden
   cost in "Tauri shell + distribution".
2. **A bundled yt-dlp goes stale.** It exists to survive YouTube's changes, and
   it is updated constantly; a copy frozen at ship time will eventually stop
   working. Pick a plan: ship app updates, let it self-update (`yt-dlp -U`), or
   keep the `--yt-dlp` override as an escape hatch.
3. **GPLv3 constrains how you ship it.** The moment the Tauri binary links the
   analysis crate, the whole shipped app is GPLv3. Notarized distribution via
   GitHub Releases (what §3b plans) is fine; **the Mac App Store is not** — its
   terms conflict with GPLv3. Worth settling before designing the distribution
   path, not after.

## Accuracy — what to expect, and what NOT to re-investigate

- **Tempo: ~0.4% mean error.** Was +1.6% and systematically high; that was a
  real bug and it is fixed. Do not re-open unless numbers drift.
- **Key: about 4 correct in 6.** This is inherent to key detection, **not a
  bug**. Proven: the 24-key synthetic sweep is **24/24 exact**, so the FFI, key
  table and Camelot conversion are all correct. Published references disagree
  with each other on real tracks.
- Re-run the proof any time:
  `cargo run --release -p analyzer-analysis --example key_sweep` → expect 24/24.
  `... --example key_sweep -- 48000 44100` → expect 0/24 (that is the
  fingerprint of a sample-rate bug, for contrast).

## File inventory

**New crate:** `desktop-analyzer/crates/cli/` — `src/main.rs` (clap, Ctrl-C),
`src/lib.rs` (orchestration, export), `src/adapter.rs` (error classification),
`src/progress.rs` (progress UI), `build.rs` (rpath), `tests/end_to_end.rs`.

**New files:** `desktop-analyzer/README.md`,
`crates/core/src/pipeline.rs`, `crates/core/src/runtime.rs`,
`crates/core/tests/resume_from_disk.rs`, `crates/download/` (whole crate),
`crates/analysis/examples/analyze_file.rs`, `crates/analysis/examples/key_sweep.rs`.

**Modified:** workspace `Cargo.toml` (added `crates/cli`),
`crates/analysis/src/bpm.rs` (rewritten — the tempo fix),
`crates/analysis/src/lib.rs` (rounding), `crates/analysis/build.rs` +
`crates/analysis/Cargo.toml` (`links = "keyfinder"` for rpath propagation),
`crates/core/src/lib.rs` (`release_id`/`youtube_id` fix + module declarations).

Scratch test data lived in `/tmp/.../scratchpad/` and **is gone** — recreate a
small backup JSON if you want to re-run the manual checks.

---

# DETAILED RECORD

Everything below is the working record, in the order it happened: why each
decision was made, the evidence behind the accuracy verdict, and the review
findings. Read it if you need the reasoning; the section above is enough to
resume.

**Read it as history, not as current state.** The early sections describe the
tree as it was at the time — e.g. the survey says "there is no binary
anywhere", which was true then and is not now. Where a later section
contradicts an earlier one, the later one wins, and the START HERE section
above wins over both.

## Request
Resume interrupted work on PROJECT_PLAN.md §3b. Verify the uncommitted tree builds
and passes. Judge the e2e accuracy result (115.25 BPM @ 13% conf, key 3A vs expected
~113 BPM / A-flat major). Then drive §3b to its "Must have" bar: resumable across
interruption, progress UI, never overwrite `verified: true` / manual bpm/key without
`--force`. Output stays keyed `releaseId_youtubeId` in the web app's Restore shape.
Scope: `desktop-analyzer/` only. No Tauri shell, no distribution/signing. No commits.

## Acceptance criteria
1. `cargo test --workspace`, `cargo clippy --workspace --all-targets`, `cargo build`
   all green with the documented env (`source ~/.cargo/env`,
   `PKG_CONFIG_PATH=$HOME/.local/lib/pkgconfig:...`).
2. A defensible, evidence-backed verdict on detector accuracy — acceptable /
   tuning problem / real bug — from more than one track with known BPM+key.
3. A runnable end-to-end entry point: backup JSON in -> analysed `track_meta`
   export out, with progress reporting.
4. Resumability proven against a real on-disk ledger (not just test fakes):
   kill mid-run, restart, no repeated work, no lost results.
5. Protection proven: `verified: true` and manually-set bpm/key are never
   overwritten without `--force`.
6. Export validates against the web app's Restore contract (`_app`,
   `_version: 2`, `track_meta[]` of COMPLETE records keyed `releaseId_youtubeId`).

## Decisions & constraints (carried forward — do not re-litigate)
- Emit **complete** `track_meta` records. Verified: `src/backup.js:136` uses
  `_bulkPut('track_meta', ...)` which REPLACES whole records — a partial record
  would erase the user's rating/tags/notes. Non-negotiable.
- `MetaExport` (core/src/backup.rs) already matches Restore: `_app`,
  `_version: 2`, `track_meta[]`; every other store defaults to `[]` in
  `importBackupFile`, so a meta-only file clobbers nothing. Contract confirmed.
- `AUDIO_FORMAT` in download/src/lib.rs must stay
  `bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio/best`. Plain `bestaudio`
  yields Opus-in-WebM which symphonia 0.5 cannot decode. Do not "simplify".
- No ffmpeg. Decode in-process with symphonia; one binary + yt-dlp sidecar.
- `analyzer-core` stays free of native deps so it builds/tests on a bare toolchain.
- Workspace is GPL-3.0 because aubio + libkeyfinder are GPLv3.

## Findings by role
### Orchestrator — survey (baseline, verified myself)
- `cargo test --workspace` GREEN before any of my changes: **64 tests**
  (55 core + 7 download + 1 analysis show_values + 1 core dump_colors).
  The handoff's "7 download tests passing" is accurate but undersells the tree.
- Library layers are complete and genuinely well-tested: `backup`, `plan`,
  `ledger`, `meta` (provenance/protection/merge), `camelot`, `pipeline` (run loop
  with fakes: resume, per-item save, permanent vs transient failure, cleanup).
- **Central gap: there is no binary anywhere.** `grep '\[\[bin\]\]|fn main'`
  returns only `analysis/build.rs`. Nothing wires backup -> plan -> download ->
  analyze -> ledger -> export. §3b's "Must have" is therefore unproven end to end.
- Traits with no production implementation: `Clock`, `LedgerStore`
  (only test fakes), and `Analyzer` (the analysis crate does not implement the
  pipeline trait — no adapter). `Downloader` IS implemented by `YtDlp`.
- So "resumable" and "progress UI" exist as *design* (Ledger + Progress enum)
  but have never run against a real disk or a real terminal.

## Open risks (as identified at the start — see resolutions further down)
- R1 Key accuracy: detected 3A (B-flat minor) vs expected A-flat major (4B).
  Not Camelot-compatible with 4B, so it is a real miss for DJ use, not a near-miss.
  Note B-flat minor is the ii of A-flat major and shares 6 of 7 notes — the classic
  ii-minor-instead-of-tonic-major confusion. Needs multi-track evidence.
- R2 BPM confidence 13%: `bpm.rs` reads `aubio_tempo_get_confidence` ONCE after
  the final hop. Suspect that is a snapshot of the last hop's local ambiguity
  rather than an aggregate over the track. Hypothesis to test, not yet fact.
- R3 BPM value 115.25 vs 113 expected = +1.99%. Consistent with YouTube
  re-uploads being sped up ~1-2% to evade Content ID. Would NOT explain the key
  miss (+2% speed is +0.34 semitones, far short of a key class change).
- R4 `bpm.rs` uses `chunks_exact(hop)`, silently dropping the tail of the track.
- R5 GPL: workspace already declares GPL-3.0. Needs a concrete distribution note.

## Verification log (baseline, before any changes)
- 2026-09-04 baseline: `cargo test --workspace` -> ok, 64 passed, 0 failed.

### Orchestrator — GPL licence question (§3b "License note"), now concrete
Verified against what is actually installed and linked on this machine, not assumed:

| Component | Version / evidence | Licence |
|---|---|---|
| libkeyfinder | 2.2.8, mixxxdj, `~/.local/lib/libkeyfinder.so.2.2.8`, **dynamically** linked via `build.rs` | **GPL-3.0** (verified from upstream LICENSE header: "Version 3, 29 June 2007") |
| fftw3 | pulled in transitively — `libkeyfinder.pc` declares `Requires.private: fftw3` | **GPL-2.0-or-later**; MIT (the university) sells a separate non-free licence precisely so vendors can avoid the GPL |
| aubio | probed by pkg-config in `build.rs` | GPL-3.0 |

Consequences that matter, in order of how much they cost:
1. **The analyzer binary must be GPL-3.0.** Dynamic linking does not avoid this.
   The workspace `Cargo.toml` already declares `license = "GPL-3.0"` — that was
   the right call and is now confirmed correct rather than precautionary.
   GPL-2.0-or-later (fftw) is compatible with GPL-3.0 via its "or later" clause.
2. **You may sell it, but you cannot sell it closed-source.** GPLv3 permits
   charging money; it does not permit withholding source from anyone you ship the
   binary to, and they may redistribute it. So a paid, proprietary desktop
   analyzer is off the table with this dependency stack.
3. **The planned distribution route survives.** §3b specifies notarized macOS
   builds via GitHub Releases — that is GPLv3-compatible. The **Mac App Store is
   not** (its DRM/usage terms conflict with GPLv3); if App Store distribution
   ever becomes the plan, this stack blocks it.
4. **The Tauri shell inherits GPLv3** once it links the analysis crate. That is
   fine for the web app's MIT code (MIT is one-way compatible into a GPL work),
   but the *combined shipped Tauri binary* would be GPLv3. Worth knowing before
   anyone bundles the web UI and the analyzer into one distributable.
5. The web app itself is unaffected while it stays a separate program exchanging
   JSON files — no linking, no combined work. The plan's assumption holds.

**Escape hatch if monetisation ever needs a permissive binary** (not needed now,
cheap to note): all three GPL deps have permissive replacements —
`rustfft` (MIT/Apache) for fftw, a spectral-flux + autocorrelation tempo
estimator for aubio, and a chromagram + Krumhansl-Schmuckler key-profile
correlation for libkeyfinder (which is broadly what libkeyfinder does anyway).
That is real work, but it is bounded and it is the only route to a closed binary.

### Orchestrator — spec ambiguity found in §3b's own wording (resolved correctly in code)
§3b says "skip if `track_meta` already has `verified: true`". Taken literally that
is the WRONG field. Verified in the web app source:
- `src/meta_editor.js:98` — `verified` is the **"YouTube link verified"** checkbox.
- `src/meta_editor.js:99` — `bpm_verified` is the **"BPM/key verified"** checkbox.
- `src/harmonic.js:154` renders a key as "estimated" when
  `key_source === 'analysis' && !bpm_verified` — so `bpm_verified` is the flag
  the rest of the app already treats as "a human blessed this analysis".

Protecting on `verified` would have skipped every track whose YouTube link the
user had merely confirmed — which is most of a curated collection — while leaving
genuinely human-entered BPMs exposed. `crates/core/src/meta.rs` gets this right:
it protects on `bpm_verified`, never writes `verified`, and documents the
distinction. Protection is also **per field**, so a hand-typed BPM does not block
detecting a missing key. PROJECT_PLAN.md §3b should be reworded to say
`bpm_verified`; leaving it as `verified` invites a future regression.


---

## Iteration 2 — after both specialists were killed by a session rate limit

Both subagents died mid-run. Their partial work was left in the tree; I
re-derived everything myself rather than trusting the fragments they had
reported. One fragment was actively misleading: the debugger's last words were
"clear fingerprint for a rate mismatch: uniform +1 semitone", which my own
measurement contradicts flatly (see below). Kept from their work:
`crates/core/src/runtime.rs`, `crates/core/tests/resume_from_disk.rs` and
`crates/analysis/examples/key_sweep.rs`, all reviewed and all passing.

### VERDICT on accuracy: one real bug (tempo), no bug in key detection

**Key detection is correct.** The 24-key synthetic sweep
(`cargo run -p analyzer-analysis --example key_sweep`) returns **24/24 exact**.
There is no constant offset, no mode flip and no table error, so the FFI, the
`KEY_TABLE` ordering and the Camelot conversion are all sound. For contrast, a
deliberate sample-rate mismatch (audio at 48k, declared 44.1k) collapses to
**0/24** with a chaotic mix of +6 and +11 semitone errors — so a rate bug would
be unmistakable and we do not have one. Independently confirmed by duration:
the tool reported 213.1s for a track that is 3:33, which is only possible if
the rate is right.

**Tempo had a real, systematic bug.** All six reference tracks read HIGH, by
+1.1% to +2.0% — six out of six in one direction is not noise. Click tracks whose
tempo is exact by construction confirmed it independently at **+1.43% mean**.
Root cause: `bpm.rs` used `aubio_tempo_get_bpm`, a running estimate whose beat
period is short by a roughly constant ~7 ms regardless of tempo (which is why
the percentage error grew with BPM). Fixed by deriving the tempo from the beat
positions aubio reports (`aubio_tempo_get_last`, exact in samples) and averaging
the gaps between them — a constant placement offset cancels exactly in a
difference, so the result is unbiased by construction.

| track (official upload) | published | before | after | after err |
|---|---|---|---|---|
| Never Gonna Give You Up | 113 | 115.25 | 113.78 | +0.69% |
| Billie Jean | 117 | 118.30 | 117.11 | +0.09% |
| Get Lucky | 116 | 117.80 | 116.16 | +0.14% |
| Somebody That I Used To Know | 129 | 131.23 | 129.29 | +0.22% |
| Levels | 126 | 127.98 | 127.02 | +0.81% |
| Blue Monday 88 | 130 | 132.34 | 130.50 | +0.38% |

Mean error **+1.60% -> +0.39%**. At 128 BPM that is 2.0 BPM of drift down to
0.5 — the difference between a transition that holds for 32 bars and one that
does not.

The second bug the same fix cured: `bpm_confidence` was
`aubio_tempo_get_confidence` read ONCE after the final hop, i.e. one arbitrary
frame's local ambiguity. It reported **13%** for Never Gonna Give You Up, a
metronomic pop record — not credible, and it would have driven any
"flag low-confidence tracks for review" feature to flag everything. Confidence
is now the share of inter-beat gaps agreeing with the median, which is a
measurable property with an English meaning. The six tracks now score 96-100%,
which is the right answer for six steady 4/4 records.

### On the original 3A vs 4B key question specifically
Not a bug, and not clearly even wrong. The published references **disagree with
each other**: Tunebat reports A#m (= 3A, exactly what we detect) while others
report A-flat. Musically both are defensible — the song is diatonic to A-flat
major and B-flat minor is its heavily-used ii chord, which is the classic thing
a key detector latches onto. Key is a suggestion, not a fact; `key_strength`
exists to say how much of the track backed the answer. 4 of the 6 reference
tracks came out exactly right.

### §3b "Must have" — closed
Was: complete libraries, but no binary anywhere, and `Clock`/`LedgerStore`/
`Analyzer` had test fakes only. Now:
- **New `crates/cli`** with `discogs-analyzer`: clap args, `--plan` dry run,
  progress UI, Ctrl-C, export writing. Split lib/bin so the end-to-end test
  drives the real run with stubs instead of hitting YouTube.
- **Resumable — proven for real.** Ran the actual binary against real YouTube
  with `--limit 2`, then re-ran: "Resuming ... (2 already done)", downloaded
  nothing, export still complete.
- **Protection — proven for real.** A `bpm_verified` track was skipped at plan
  time and is absent from the export entirely, which is stronger than merging
  around it: Restore cannot touch a record that is not in the file.

### Bug found and fixed while wiring the CLI
The release binary died at startup with `libkeyfinder.so.2: cannot open shared
object file`. `cargo:rustc-link-arg` applies only to the crate that emits it and
does **not** propagate to dependents, so the rpath the analysis crate set for
itself never reached the CLI binary. Fixed with `links = "keyfinder"` +
`cargo:rpath` metadata, consumed by a new `crates/cli/build.rs`. This would have
bitten the Tauri shell in exactly the same way.

## Verification log (end of iteration 2)
- baseline `cargo test --workspace` -> ok, 64 passed (before my changes).
- final `cargo test --workspace` -> ok, **117 passed, 0 failed**.
- final `cargo clippy --workspace --all-targets` -> **no warnings**.
- final `cargo build --workspace --release` -> ok.
- real `discogs-analyzer ... --plan` -> correctly skipped a verified track and
  flagged a 90-minute mix for review.
- real `discogs-analyzer ... --limit 2` -> downloaded and analysed 2 real
  YouTube tracks; re-run resumed with 0 work and a complete export.
- `key_sweep` -> 24/24; `key_sweep 48000 44100` -> 0/24 (mismatch fingerprint).

### Real-binary verification (not stubs)
- `--force`: re-analysed a `bpm_verified` track. Wrote bpm 116.88 over the
  user's 117.0, and **kept** `rating: 5`, `notes`, and `bpm_verified: true`.
  Its key came out 11A — the same value the user had entered by hand.
- Graceful SIGINT mid-run: printed "Finishing the current track, then
  stopping. Ctrl-C again to force.", finished the in-flight track, wrote the
  summary and a valid 2-record export, printed "Interrupted — progress is
  saved. Re-run the same command to carry on.", exit code 0.
- Resume after that interrupt: "Resuming ... (3 already done). 3 to go",
  re-analysed nothing, final export carried all 6 records.
- Six more real tracks analysed end to end through the actual binary.

Note on two earlier interrupt attempts that looked like a hard kill: both were
harness faults on my side (`setsid` forks so `$!` was the wrong pid, and I
`cat`-ed the log while the run was still going). The mechanism was fine.


## Iteration 3 — code review and fixes

`code-reviewer` returned **request changes**: one real correctness bug and two
durability gaps. All three accepted and fixed; none were disputed.

**CRITICAL (fixed) — new records had no `release_id`, creating permanent orphans.**
`merged_records` built brand-new records with `TrackMeta::new(id)`, leaving
`release_id: None`. I verified the consequence in the web app rather than taking
it on trust: `src/db.js:33` creates a `release_id` index on `track_meta`, and
`src/api.js:229` uses `dbGetByIndex('track_meta', 'release_id', eid)` to delete
a release's meta rows when it leaves the collection. A record without
`release_id` is invisible to that lookup and can never be cleaned up — it
accumulates in the user's IndexedDB forever. `src/meta_editor.js:119` shows the
web app always writes both `release_id` and `youtube_id`, so our records were
genuinely incomplete, which is invariant #1 violated by omission rather than by
a wrong value. Fixed by stamping both from the backup's video list; two
regression tests added. Confirmed in a real export: `release_id: 111`,
`youtube_id: dQw4w9WgXcQ`.

**MAJOR (fixed) — ledger save failures were silently swallowed.** All three
`store.save` calls in `pipeline.rs` were `let _ = ...`. A disk that fills partway
through an hours-long run would stop the run being resumable while it kept
reporting normal progress, so the user could interrupt it believing their work
was safe. Now reported through two new `Progress` variants, on the *transition*
only — one warning when saving breaks, one notice when it recovers, never one
per item (a full disk fails on every item and would bury the real output).
Four tests cover warn-once, no-repeat, recovery ordering, and silence when healthy.

**MAJOR (fixed) — the export was not fsynced, unlike the ledger beside it.**
The CLI had its own weaker copy of the staging+rename dance with no `sync_all`,
so a power cut just after a multi-hour run could land the rename while the data
was still only in the page cache. Consolidated: `runtime::write_file_atomically`
is now the single implementation (staging file, `sync_all`, rename, directory
fsync) and both the ledger and the export go through it. This also removes the
duplication that let the two drift apart in the first place.

**MINOR (accepted, documented not fixed)** — `sync_dir` is a no-op on Windows.
Added a TODO explaining that the rename is still atomic there so no half-written
ledger is possible; only cross-power-cut ordering is weaker. Out of scope until
a Windows build exists.

**MINOR (declined)** — the reviewer suggested `*(*output).data` instead of
`from_raw_parts(...).first().unwrap_or(&0.0)` in `bpm.rs`. Declined: the slice
form makes the length assumption explicit at the read site and cannot become UB
if the fvec size is ever changed. Style preference, no correctness difference.

The reviewer confirmed independently: no leak or UB in the `bpm.rs` unsafe FFI
across any path including the two-fallible-allocation early return; the
civil-date code is a correct transcription of Hinnant's algorithm; and the yt-dlp
wrapper has no command-injection exposure (no shell, args passed as a vector).

Note: the reviewer ran `git checkout --` on `crates/core/src/lib.rs` mid-review
and briefly reverted the working tree. I caught the resulting build break
independently, and confirmed the file was restored correctly and no stashes were
left behind. Worth remembering that a read-only review role with Bash can still
mutate the tree.

## Final verification
- `cargo test --workspace` -> **125 passed, 0 failed**
- `cargo clippy --workspace --all-targets` -> **0 warnings**
- `cargo build --workspace --release` -> ok
- Real binary: plan, analyse, `--force`, SIGINT-and-resume all exercised against
  live YouTube; export contains `release_id` and `youtube_id`.
