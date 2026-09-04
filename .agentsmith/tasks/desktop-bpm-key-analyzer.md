# Desktop BPM/Key Analysis Helper (PROJECT_PLAN.md 3b)
Status: in-progress      Path: complex
Iteration: 1 of 3

## Request
Build the standalone native desktop tool described in docs/PROJECT_PLAN.md
section 3b: a Tauri (Rust) app that takes the JSON from the web app's
`exportFullBackup()`, downloads YouTube audio via a bundled yt-dlp sidecar,
runs BPM detection (aubio) and key detection (libkeyfinder via FFI), and
writes output JSON keyed the same way as `track_meta` so it merges straight
back into the web app's Restore flow. Not a web-app feature — own top-level
directory in this repo (user decision), separate from the JS SPA.

## Acceptance criteria
- New `desktop-analyzer/` dir, self-contained (own Cargo workspace), does not
  touch `src/`, `app.js`, or anything the web app ships.
- Input: a `vinyl-backup-*.json` file matching `exportFullBackup()`'s shape.
- Per video: skip if existing `track_meta` entry has `verified: true` or a
  set `bpm`/`key`; flag videos >10 min or title-mismatched vs `tracklist` for
  manual review instead of auto-analyzing; otherwise download → BPM (aubio)
  → key+scale+strength (libkeyfinder).
- Output: JSON keyed `releaseId_youtubeId`, each record has `bpm`, `key`,
  `confidence`, `verified: false` — same shape the Restore flow already reads.
- Resumable: interrupting and re-running must not redo completed work or
  overwrite `verified: true` / manually-set entries without `--force`.
- Progress UI showing current file / overall progress.
- Core pipeline/parsing logic unit-tested and buildable without the native
  audio libs (isolated in its own crate) — the goal is *something* verifiable
  in this session even before the full native toolchain is available.

## Decisions & constraints
- Stack: pure Rust, Tauri 2.x shell, no Python. Confirmed via `tauri-cli
  2.11.4` available through `npx @tauri-apps/cli`.
- Environment at task start had no rustc/cargo/pkg-config/cmake/libclang/
  libaubio/webkit2gtk/yt-dlp installed, and no passwordless sudo.
  - Installed via rustup (no sudo needed): rustc/cargo 1.98.1 — done.
  - Asked the user to run one `apt-get install` for: pkg-config, cmake,
    clang, libclang-dev, libaubio-dev, libfftw3-dev, libsamplerate0-dev,
    libwebkit2gtk-4.1-dev, libgtk-3-dev, libayatana-appindicator3-dev,
    librsvg2-dev, patchelf, file. Pending confirmation it ran.
  - `libkeyfinder` has no Ubuntu package — build from source (cmake) into a
    local prefix (no sudo), then FFI-wrap it ourselves (bindgen).
  - yt-dlp: bundle the official standalone binary as a Tauri sidecar (per
    plan) rather than requiring a system install.
- User chose: full pipeline with minimal UI as the first slice (not
  BPM-only, not a single-file vertical slice).
- Architecture: split into a Cargo workspace so pipeline/parsing logic is
  independently testable from the native FFI crates:
  - `core` — backup JSON parsing, pipeline/resume state machine, output
    merge logic. Pure Rust, no system deps, unit-testable right now.
  - `analysis` — aubio-rs (BPM) + custom libkeyfinder FFI binding (key).
    Needs the system libs from the apt command above.
  - `src-tauri` — the app binary: Tauri commands, yt-dlp sidecar
    management, progress events; depends on `core` + `analysis`.
  - `frontend/` — plain HTML/JS/CSS, no bundler (matches the main repo's
    no-build-step convention), just a progress view.

## Findings by role
- (orchestrator, acting as implementing engineer directly — no swarm
  specialist fits native Rust/FFI systems work; the tailored swarm only has
  web_app + cross_cutting roles after project-intake pruned backend_heavy/
  embedded. code-reviewer will still review the final diff.)

- **Two spec conflicts found in PROJECT_PLAN 3b, resolved with the user:**
  1. `verified` does NOT mean "bpm/key verified" — it means "YouTube link
     verified" (`src/meta_editor.js:43`), and it is currently **write-only
     dead data**: nothing in the app reads it. The plan's "skip if
     `verified: true`" would have skipped precisely the tracks whose links
     are confirmed good, and writing `verified: false` would have silently
     un-verified the user's links.
  2. Restore uses `os.put(rec)` (`src/backup.js:102`) — a **whole-record
     replace**, not a field merge. The plan's "output JSON keyed the same way,
     no new import code needed" is only safe if the analyzer emits *complete*
     records; a partial `{id,bpm,key}` record would have wiped rating, energy,
     shelf, tags and notes for every analyzed track.
  - **Decision (user):** provenance fields (`bpm_source`/`key_source` =
    manual|analysis, plus `bpm_confidence`/`key_strength`), a new explicit
    `bpm_verified` human-blessing flag, and full merged records on output.
    `verified` is read-only to the analyzer. Rationale: skip-if-filled is a
    one-way door — a bad auto-result could never be corrected by a re-run —
    whereas provenance makes re-runs both idempotent and self-improving while
    keeping manual data untouchable.
- **Key format:** the app only parses Camelot (`harmonic.js:parseCamelot`),
  libkeyfinder emits musical keys, so conversion is mandatory. User also asked
  for a colour-coded Camelot wheel so keys read visually. Colours are derived
  (evenly spaced hues; minor deeper, major lighter) rather than copied from any
  DJ product, and live in `camelot.rs` so the web app can share the same map.
- **Scope added by that decision (not yet built):** web-app changes for the
  `bpm_verified` checkbox in the meta editor, and the colour-coded Camelot
  wheel/chips.

## Open risks
- `libkeyfinder` FFI wrapper is hand-written (bindgen against a C++ API) —
  highest-risk part of the whole pipeline, cannot be fully verified until
  the library is built locally.
- Tauri sidecar bundling of yt-dlp not yet verified end-to-end (network
  download + exec permissions).
- No apt access without user's sudo password — full `cargo build` /
  `cargo tauri build` verification blocked until the user runs the command
  above (or confirms it's done).

## Verification log

### Iteration 1 — `analyzer-core` crate (done, verified)
- `cargo test` → **41 unit tests + 1 doc-test pass, 0 failures**.
- `cargo clippy --all-targets` → **0 warnings**.
- Built: `desktop-analyzer/crates/core/` with
  - `backup.rs` — parses the real `exportFullBackup()` shape; emits a
    backup-shaped `track_meta`-only file that the existing Restore flow
    accepts unchanged (verified: `importBackupFile` defaults every absent
    section to `[]`, so no web-side import code is needed).
  - `camelot.rs` — musical key ⇄ Camelot, compatible-key rules matching
    `harmonic.js`, and the derived colour wheel. Tested against the 12
    reference wheel anchors and full round-trip over all 24 positions.
  - `meta.rs` — `TrackMeta` with `#[serde(flatten)] extra`, so unknown/future
    fields round-trip untouched; provenance classification and merge.
  - `plan.rs` — per-video Analyze/Skip/Review decisions, >10 min and
    title-mismatch review flags with noise-tolerant title matching.
  - `ledger.rs` — resume ledger with retry budget, settings-hash
    invalidation, and corruption fallback (never blocks a run from starting).

### Blocked (needs the apt command in "Decisions & constraints")
- `crates/analysis` (aubio BPM + libkeyfinder FFI) — not started; needs
  pkg-config, libaubio-dev, clang/libclang-dev, cmake.
- `src-tauri` + frontend + yt-dlp sidecar — not started; needs webkit2gtk.
- Deliberately kept out of the workspace `members` list until then, so
  `cargo test` stays green on a bare toolchain.

### Iteration 2 — web app side (Phase 5, done, verified)
- `node --check` clean on all five touched JS files.
- Camelot module exercised in node: lookups, chips, wheel generation; the
  generated SVG parses as valid XML (24 paths = 12 outer/major + 12
  inner/minor, 26 text nodes = 24 labels + 2 hub lines).
- Built:
  - `src/camelot.js` — the shared wheel: 24-entry table (colours copied from
    `camelot.rs` via `cargo test --test dump_colors`, so the two cannot drift
    silently), `camelotColor/Musical/Chip`, and `camelotWheelSvg` rendering a
    clickable two-ring wheel. Text colour per swatch is chosen by WCAG
    relative luminance, so labels stay legible on both halves of the wheel.
  - `src/meta_editor.js` — `bpm_verified` checkbox (distinct from the existing
    "YouTube link verified"), the wheel as a visual key picker wired to the
    existing dropdown, a provenance note showing confidence percentages, and
    **provenance stamping on save**.
  - `src/harmonic.js`, `src/setlists.js`, `src/views/release.js` — the three
    `badge-key` spans now render colour-coded chips; analysis-sourced values
    get a dashed border and a `~` so an estimate never reads as confirmed.
  - `style.css` — wheel/chip/provenance styles using the existing variables.
  - `index.html` — loads `src/camelot.js` after `meta.js`.
- **Design note:** saving the editor only stamps `bpm_source`/`key_source` as
  `manual` when the value actually *changed* from what was loaded. Stamping on
  every save would mean editing an unrelated field (a tag, a note) silently
  locks the analyzer out of ever refreshing that track again.

### Iteration 3 — native analysis stack (Phase 2, done, verified)
- System deps installed by the user (note: their first attempt silently did
  nothing — they pasted the `!` prefix from the chat code block, and in bash
  `!` negates the exit status, so `&&` short-circuited and the install half
  never ran).
- `libkeyfinder` 2.2.8 built from source (no Ubuntu package exists) into
  `~/.local`, discoverable via pkg-config.
- Built `crates/analysis`:
  - `build.rs` — pkg-config probes, bindgen over the installed aubio headers
    (necessary: `smpl_t` is float or double depending on the build), `cc`
    compiles the C++ shim, rpath baked in so a user-prefix libkeyfinder
    resolves at run time.
  - `shim/keyfinder_shim.cpp` — flat C surface over libkeyfinder's C++ class
    API; catches all exceptions so none cross the FFI boundary.
  - `bpm.rs` — aubio tempo detection with RAII guards freeing aubio's
    allocations on every path.
  - `key.rs` — libkeyfinder `key_t` → `MusicalKey` → Camelot.
  - `decode.rs` — symphonia decoding (m4a/mp3/ogg/flac/wav) to mono f32, so
    **no ffmpeg dependency**; damaged packets are skipped, not fatal.
- **`cargo test -p analyzer-analysis` → 9 passed, 0 failed**, including real
  DSP against synthetic audio.
- Measured accuracy (`cargo test --test show_values -- --nocapture`):
  - Key: A minor → `8A`, C major → `8B`, E minor → `9A` — **all exact**,
    including the relative major/minor distinction.
  - BPM: 90 → 90.91, 120 → 121.63, 128 → 129.83 — all within ~2.
  - **Known limitation:** 174 → 87.84, a half-time octave error (the classic
    aubio failure mode). Mitigations, none implemented yet: the web app's
    `bpmDelta` already treats double/half as a match, so suggestions still
    work; and the backup carries Discogs `genres`/`styles`, which could bias
    the octave choice (e.g. drum & bass ⇒ expect 160-180). Worth doing before
    this is trusted on a fast-genre collection.

### Iteration 4 — energy + honest confidence (done, verified)
Prompted by the user asking "what about the energy? certainty score?" — which
surfaced one bug and one piece of fakery, both mine.

- **Bug fixed: `bpm_confidence` was rendered as a percentage.** aubio's
  confidence is explicitly unbounded ("the higher the more confidence, `0` if
  no consistent value is found" — tempo.h); measured values were 1.24-1.55, so
  the editor would have shown "155%". Now normalised 0-1 in Rust against a
  documented ceiling, the raw value kept alongside for recalibration, and the
  JS `pct()` helper clamps as a backstop.
- **`key_strength` was a proxy, not a measurement.** It was derived from
  duration — how much audio there was, not how sure the detector was.
  Replaced with **segment consensus**: the track is split into up to 8
  segments of 30 s, each classified independently, and the strength is the
  share agreeing with the whole-track answer. A track that disagrees with
  itself (a mix, a medley) now scores low and can be sent for review. Renamed
  "key agreement" in the UI, since that is what it measures.
- **Energy is now measured, not guessed.** New `energy.rs` estimates the 1-10
  figure from loudness (RMS), brightness (zero-crossing rate) and drive
  (short-window RMS variance) — all time domain, no FFT. Documented as a
  heuristic with uncalibrated weights. Note this partly pre-empts
  PROJECT_PLAN.md **F4**, which proposed estimating energy with an LLM from
  title/style/year: measuring the actual audio is cheaper, offline, needs no
  backend, and cannot hallucinate.
- **Design change: protection is now per-field, not per-record.** Adding
  energy exposed the flaw — a hand-set energy would have blocked BPM/key
  detection entirely. `Protection::of` now classifies bpm, key and energy
  separately: never overwrite a human's value, always fill a gap. A record is
  only skipped when *every* writable field is already a human's. This also
  retired the "a manual half protects the whole record" rule, which
  over-blocked: someone who typed a BPM but no key now gets the key detected.
  `bpm_verified` protects bpm and key (as its label says) but not energy.
- **`cargo test` → 61 passed, 0 failed** (47 core + 13 analysis + diagnostics).
  `cargo clippy --all-targets` → 0 warnings. `node --check` clean.

### Licensing decision
- aubio and libkeyfinder are both GPLv3, so the analyzer workspace is now
  `license = "GPL-3.0"`. The user is not selling this, and the web app is a
  separate program exchanging JSON files, so its licensing is untouched. The
  engine sits behind the `analysis` crate boundary if it ever needs swapping.

### Still not started
- Phase 3: `src-tauri` app shell, yt-dlp sidecar, pipeline wiring.
- Phase 4: minimal progress UI.
- Phase 6 close-out: `desktop-analyzer/README.md`, PROJECT_PLAN.md 3b update,
  `code-reviewer` on the full diff.
