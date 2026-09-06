# Project Plan — Vinyl Collection Player → Paid Product

> Living document. Update statuses as work lands.
> Created 2026-06-12 from a full codebase audit (~5,400 lines JS, no build step, IndexedDB storage).

**Status legend:** `[ ]` todo · `[~]` in progress · `[x]` done · `[-]` won't do

---

## 0. Blockers before charging money

These are not features — they are prerequisites for a paid product.

- [ ] **B1 — Discogs API commercial consent.** The Discogs API is free for *non-commercial* use. Charging requires written consent from Discogs; their image-licensing terms are also strict about cover art. Contact Discogs early — this is the biggest legal blocker.
- [ ] **B2 — YouTube ToS compliance.** Player iframes are parked off-screen at 1×1 px (`index.html:69-70`). YouTube requires a visible player ≥ 200×200. Fix: show a small real player in the now-playing bar.
- [ ] **B3 — Backend.** No server today → nothing to gate payment with, nowhere to keep an AI API key secret, no cloud sync. Plan: thin backend (Cloudflare Workers + D1/KV, or Supabase) for auth, license keys (Stripe / LemonSqueezy), sync, and AI proxying.

---

## 1. Bug list (by severity)

### CRITICAL

#### C1 — Stored XSS + UI breakage via `escJs` in inline handlers
- **Where:** `src/utils.js:9`; call sites: `wantlist.js:277`, `tracks.js:142`, `store.js:128-129,173,201,328-332`, `collection.js:108,118`, `marketplace.js:248`
- **What:** `escJs()` escapes `\` and `'` but **not `"`**. Its output is pasted into double-quoted HTML `onclick="..."` attributes.
  1. *Breaks with normal data:* titles containing `"` (e.g. *Blue Monday 12"*) terminate the attribute mid-string — remove buttons on such cards are broken.
  2. *Stored XSS:* a tag/batch name/release title like `peak" onmouseover="...` injects a live handler. The Discogs token sits in IndexedDB → XSS = token exfiltration = Discogs account takeover.
- **Fix:** Short-term: make every call site attribute-safe (`escHtml(escJs(v))`). Proper: stop building `onclick` strings — put values in `data-*` attributes and use delegated `addEventListener` (kills the whole bug class).
- **Status:** [x] Patched centrally in `escJs()` (JS-escape, then HTML-entity-escape; also handles `\r\n` and U+2028/U+2029). Verified: no single-quoted handler attributes exist, so all 17 call sites are covered. Proper structural fix (event delegation) remains tracked as P4.

### HIGH

#### H1 — Closing the player mid-crossfade leaves hidden audio playing
- **Where:** `src/player.js:128-140` (`hideNowPlaying`), `src/crossfade.js:101-113` (`_completeCrossfade`)
- **What:** `hideNowPlaying()` stops player 1 and clears the queue but never aborts the crossfade. Pressed while `_cfState === 'fading'`: player 2 keeps playing with the bar closed; when the fade completes, `_completeCrossfade()` reads from the now-empty queue → `item` undefined → throws, and player 2 plays forever (only a reload stops it).
- **Fix:** Call `_abortCrossfade()` inside `hideNowPlaying()` before clearing state; defensively bail in `_completeCrossfade()` if `currentQueue[_cfPreloadedIndex]` is missing.
- **Status:** [ ]

#### H2 — "Go to Release" silently bounces to collection (string vs number key)
- **Where:** `src/player.js:174-200` (`playTrack`/`playAll`), `src/setlists.js:241-252` (`gotoNowPlayingRelease`), `src/views/release.js:4`
- **What:** Queue items built from DOM rows store `releaseId` as a **string** (`el.dataset.releaseId`), but IndexedDB release keys are **numbers** → `dbGet('releases', "12345")` returns undefined → `renderRelease` falls through to `navigate('collection')`. Works for setlist/suggestion queues (numeric ids), breaks for the most common path (clicking a track row). Stale string ids also persist via `sessionStorage`.
- **Fix:** `parseInt(el.dataset.releaseId, 10) || null` in `playTrack`/`playAll` (same as `openAddToSetlistPopover` at `setlists.js:153`); defensive `Number(releaseId)` coercion at the top of `renderRelease`.
- **Status:** [ ]

#### H3 — Store "Refresh Price" hits the endpoint the codebase documents as CORS-broken
- **Where:** `src/views/store.js:402-440` (`storeRefreshPrice`)
- **What:** Calls `discogsGet('/marketplace/stats/' + id)` with an `Authorization` header — but `api.js:137-141` documents that `/marketplace/stats` doesn't support the CORS preflight the auth header triggers, and `marketplace.js:37-40` deliberately switched to `/releases/{id}` for exactly this reason. Likely fails every time (3 retries + misleading "Network error" banners). Also reads `data.highest_price`, which that endpoint doesn't return, so the price *range* can never render.
- **Fix:** Use `discogsGet('/releases/' + id)` (gives `num_for_sale` + `lowest_price`); drop the phantom `highest_price` or source it from `/marketplace/price_suggestions`.
- **Status:** [ ]

### MEDIUM

#### M1 — Crossfade silently skips short tracks
- **Where:** `src/crossfade.js:50-54`
- **What:** Guard `duration < cfSeconds + 2` skips crossfade with no feedback; with a long fade (e.g. 9 s) on a 10 s track the fade just doesn't happen. Magic `+2` constant.
- **Fix:** Clamp `cfSeconds` against track duration at fade time, or surface the limit in the UI.
- **Status:** [ ]

#### M2 — Orphaned `marketplace_stats` / `notifications` when wants are removed
- **Where:** `src/views/wantlist_sync.js:88-93` (stale-want prune), `src/views/wantlist.js:438` (`wlRemove`)
- **What:** Deleting a want never deletes its `marketplace_stats` row (or its notifications). Orphaned data accumulates and leaks into backups.
- **Fix:** Delete matching `marketplace_stats` (and optionally notifications) alongside each `dbDelete('wants', …)`.
- **Status:** [ ]

#### M3 — Partial sync failure can wipe releases + user-entered track metadata
- **Where:** `src/api.js:200-234` (`syncCollection` save + prune loops)
- **What:** If a folder fetch throws midway, a half-built `allReleases` map can be persisted, and the prune step deletes every release **not** in the partial map — including its `track_meta` (BPM/key/rating the user typed by hand). A transient network error can destroy data.
- **Fix:** Only run the prune pass after a fully successful fetch of all folders; sanity-check the new map is non-empty/plausible before deleting.
- **Status:** [ ]

#### M4 — Surprise autoplay on tab restore
- **Where:** `src/player_state.js:15-35` (`_restorePlayerState`)
- **What:** State saved every 2 s while playing; on reload the app **auto-plays** from the saved position. Combined with `onversionchange` auto-reload (`db.js:79-84`), opening a second tab can trigger unexpected playback.
- **Fix:** Restore in paused/cued state by default (the cue branch already exists).
- **Status:** [ ]

#### M5 — Marketplace notification baseline edge cases
- **Where:** `src/marketplace.js:48-62`
- **What:** Alerts fire only on a confirmed 0 → 1+ transition. Items already for sale at first check never alert (by design), but `marketplace_stats` restored from an old backup carries a stale `num_for_sale` baseline → spurious or missed alerts after restore.
- **Fix:** Invalidate/refresh `checked_at` baselines on backup restore, or treat restored stats as `prevNum = null`.
- **Status:** [ ]

### LOW

#### L1 — Leaked global timers
- **Where:** `src/init.js:4` (`_saveInterval`), `src/marketplace.js:88` (poll interval)
- **What:** Never cleared. Harmless in a never-torn-down SPA, but technically leaks.
- **Status:** [ ]

#### L2 — Queue panel leaks document-level listeners on every re-render
- **Where:** `src/queue.js:28-33` (`makeDraggable`), `src/queue.js:53-55` (`_renderQueuePanel`)
- **What:** `_renderQueuePanel` removes the old panel with `.remove()` without calling its `_cleanup()`, leaking a `mousemove` + `mouseup` document listener pair per re-render (which happens on every queue action / track change).
- **Fix:** Call `existing._cleanup()` before `existing.remove()`.
- **Status:** [ ]

#### L3 — `bpmDelta` edge cases
- **Where:** `src/harmonic.js:27-33`
- **What:** BPM of `0` treated as missing (falsy); half/double-time computed in overlapping ways. Cosmetic scoring noise.
- **Status:** [ ]

#### L4 — Duplicate/conflicting bg-video scripts; first one throws
- **Where:** `index.html:15-26` (head script) vs `index.html:156-175` (body script)
- **What:** Head script sets `playbackRate = 0.5` and references `#bg-toggle-btn` **before it exists in the DOM** → throws at line 20, its toggle handler never binds. Body script (rate 0.95) is the one that works. Dead/throwing code.
- **Fix:** Delete the head script block.
- **Status:** [ ]

#### L5 — Date handling assumes valid ISO strings
- **Where:** `src/marketplace.js:175-183` (`formatTimeAgo`), ETA math in `api.js`
- **What:** Malformed dates render `NaN`. Cosmetic.
- **Status:** [ ]

#### L6 — Pagination ellipsis glitches
- **Where:** `src/views/collection.js:165-172` (same pattern in `tracks.js`, `wantlist.js`)
- **What:** Certain page counts render doubled `...` or odd gaps. Cosmetic.
- **Status:** [ ]

### Triage table

| ID | Severity | One-line | Effort |
|----|----------|----------|--------|
| C1 | Critical | `escJs` doesn't escape `"` → broken UI + stored XSS → token theft | S (patch) / M (proper) |
| H1 | High | Close-player mid-crossfade = stuck hidden audio + throw | S |
| H2 | High | "Go to release" broken for track-row queues (string vs number id) | S |
| H3 | High | Store price refresh hits CORS-broken endpoint | S |
| M1 | Medium | Crossfade silently skips very short tracks | S |
| M2 | Medium | Orphaned marketplace_stats/notifications on want removal | S |
| M3 | Medium | Partial sync failure can wipe releases + track metadata | M |
| M4 | Medium | Surprise autoplay on tab restore | S |
| M5 | Medium | Notification baseline edge cases after restore | S |
| L1–L6 | Low | Leaked timers/listeners, dead bg script, cosmetics | S each |

---

## 2. Professionalization (the unglamorous 80%)

- [ ] **P1 — Fix C1–H3 first.** With a Discogs token in IndexedDB, XSS is account takeover; can't charge money on top of that.
- [ ] **P2 — Accounts + cloud sync.** "Your data lives only in this browser" is the #1 commercial weakness; flip it into the #1 paid feature ("synced across devices, never lose crate data"). IndexedDB stays as offline cache; sync to backend.
- [ ] **P3 — Engineering hygiene.** ES modules instead of global-scope script soup; TypeScript (or JSDoc + `tsc --checkJs`); ESLint; Playwright smoke tests; GitHub Actions CI.
- [ ] **P4 — Event delegation.** Replace all inline `onclick="..."` string building with `data-*` attributes + delegated listeners (also resolves C1 permanently).
- [ ] **P5 — PWA.** Manifest + service worker → installable, offline crate browsing at record fairs; pairs perfectly with the store/serial feature.
- [ ] **P6 — UX polish.** Proper toast system instead of `alert()` and sync-banner reuse; loading/empty states; error boundaries.
- [ ] **P7 — Landing page + demo mode.** Pricing page, docs, and a demo collection so prospects can try without a Discogs token.

---

## 3. Premium / AI features

All AI calls go through the backend proxy (B3), metered per tier. Collection data is small and structured — ideal LLM input.

- [ ] **F1 — Collection Intelligence Report (flagship).** Feed releases/styles/years/countries/track_meta to an LLM → personal "Rewind": taste profile, era/label/pressing-country clustering, blind spots, fun facts, valuation summary from existing marketplace stats. Shareable → built-in marketing.
- [ ] **F2 — Natural-language crate digging.** "Warm, melodic, 115–125 BPM, sunset opener" → ranked tracks from *your* collection. Embed metadata once, vector-search client-side, optional LLM re-rank. Constrain by key compatibility via existing `harmonic.js`.
- [ ] **F3 — AI setlist generator.** Input: vibe, duration, opening track. Output: full setlist with an energy arc — Camelot scoring as hard constraint, LLM for narrative flow. Exports via existing M3U/CSV.
- [ ] **F4 — AI metadata enrichment.** One-click estimation of BPM/key/energy/mood from title + style + year, marked "estimated" until verified. Directly feeds suggestions, filters, and F3 (the suggestion engine is currently starved by manual-only BPM/key).
- [ ] **F5 — Smart buying advisor.** Deal scoring (listing price vs `price_suggestions`), price-history sparklines, "30% below typical — buy signal", AI want-list recommendations from the taste profile.
- [ ] **F6 — Dealer tools (Store tier).** AI pricing by condition/style/scarcity, sales-velocity insights from sold history, auto-generated listing descriptions, printable QR labels per serial.

### Community-sourced features (from Discogs user complaints/wishlists + companion-app survey)

Sourced from Discogs forum complaints and competing companion apps (CLZ, Vinyly, Discographic, WaxHub, vinyl-shelf-finder). These mostly work with or without the backend.

- [ ] **F7 — Barcode scanner.** Camera → `/database/search?barcode=` → add to collection/wantlist. Most-requested companion-app feature. Browser-only: `BarcodeDetector` API (Chromium) + ZXing-wasm fallback (Safari/Firefox). *Effort: M.*
- [ ] **F8 — Master-based wantlist matching.** Collectors want "any pressing of this album"; Discogs only matches exact releases — their #1 marketplace gap. Resolve each want's `master_id` (1 call, cacheable forever), then extend the existing `marketplace.js` poll to track lowest price across `/masters/{id}/versions`. ⚠️ Needs rate-budget design within the 60 req/min bucket. *Effort: M.*
- [ ] **F9 — Wantlist criteria + smart alerts (max price).** Per-want max-price threshold; notifications respect it. Builds directly on the existing notification engine. ⚠️ **Scope limit:** the Discogs API exposes no per-listing marketplace data (only `num_for_sale` + `lowest_price`), so *min-condition* and *seller-country* filters are **not implementable** client-side — max-price only. *Effort: S–M.*
- [ ] **F10 — Price history snapshots → sparklines.** We already poll every 30 min; start **timestamping and storing snapshots now** so history accrues before the chart feature ships (zero-cost data accrual). Render sparklines later. *Effort: S.*
- [ ] **F11 — Stats / collection-value dashboard (non-AI).** Real-time collection value, have/want collectability (from `community.have`/`community.want` on the release endpoint), genre/decade/country breakdowns. All data is already local; pure rendering. Great free-tier hook; the AI report (F1) becomes the premium layer on top. *Effort: S.*
- [ ] **F12 — Last.fm scrobbling.** The YouTube player already fires track events; POST scrobbles to Last.fm. ⚠️ Signing requires the API shared secret — acceptable embedded client-side for a hobby tool, **not for a paid product**; route through the backend once B3 lands. *Effort: S–M.*
- [ ] **F13 — Visual shelf finder.** The `shelf` field already exists in track_meta; add an ordered shelf-map view to locate records physically. *Effort: M.*
- [ ] **F14 — Daily wantlist email digest.** Replaces Discogs' "unworkable" relisting spam. Requires backend (B3) — bundle with it. *Effort: S once B3 exists.*
- [-] **Nearby record store discovery.** Needs a maps API + store database; weak fit, low differentiation. Skip for now.

---

## 3b. Desktop BPM/Key Analysis Helper

Standalone native tool, separate from the web app. The web app has no way to
download or decode YouTube audio (no CORS access, no local files for
vinyl-only collectors) — this is the only path to real BPM/key data for a
Discogs+YouTube collection, and it keeps the web app 100% serverless.

**Not a web app feature.** Own repo or own top-level dir. Runs once per
collection, occasionally after that for new adds.

**Status: [x] built, shipped and run over the whole collection 2026-09-06**
as `desktop-analyzer/` — 2,891 tracks analysed, median BPM confidence 0.96.
Session record, oracle results and remaining open items:
`docs/analyzer-2026-09-06.md`.
Everything specced below works from the command line — backup JSON in,
Restore-compatible `analysis.json` out, resumable, progress UI, and the
overwrite protection. Deliberately **not** started: the Tauri shell, the
yt-dlp sidecar, and distribution/signing — all three exist only to hand the
tool to someone else, and are not needed to run it yourself. Setup, flags
and accuracy notes: `desktop-analyzer/README.md`. Working record and resume
point: `.agentsmith/tasks/desktop-bpm-key-analyzer-3b.md`.

- **Stack:** pure Rust, no Python. Tauri shell (small binary, no bundled
  Chromium) + native Rust analysis, faster startup and no PyInstaller
  freeze/packaging fragility.
  - **Download:** yt-dlp's official standalone binary, bundled as a Tauri
    sidecar. Still the right tool for surviving YouTube's changes — no
    reason to reimplement it, and the standalone binary needs no Python
    install on the friend's machine.
  - **BPM:** `aubio-rs` (Rust bindings to the aubio C library) — fast,
    proven onset/tempo detection.
  - **Key:** `libkeyfinder` via Rust FFI (bindgen + a thin wrapper) — the
    same algorithm family behind Mixed In Key-style DJ tools, a strong
    fit for this specific use case.
- **Input:** the JSON from `exportFullBackup()` (already exists, no new
  export format).
- **Pipeline per video:** yt-dlp downloads audio → skip if `track_meta`
  already has `bpm_verified: true` or a human-set `bpm`/`key` → flag videos
  >10 min or title-mismatched against `tracklist` for manual review instead
  of auto-analyzing → aubio for BPM + confidence → libkeyfinder for key +
  scale + strength.
  - ⚠️ The skip flag is `bpm_verified`, **not** `verified`. `verified` means
    "YouTube link verified" (`src/meta_editor.js`) — skipping on it would
    skip exactly the tracks whose links are known good. The analyzer treats
    `verified` as read-only and never writes it.
- **Output:** JSON keyed the same way as `track_meta`
  (`releaseId_youtubeId`), each record carrying `bpm`, `key` (Camelot),
  `key_musical`, `energy`, `bpm_confidence`, `key_strength` and per-field
  `*_source` provenance. Same shape the Restore flow already accepts — no
  new import code needed on the web side.
  - Records must be **complete**, not partial: `src/backup.js` restores with
    `_bulkPut`, which replaces whole records, so a partial one would erase
    the user's rating/energy/shelf/tags/notes. Unmodelled fields are
    round-tripped untouched.
- **Must have:** resumable (long runs, must survive interruption),
  progress UI, never overwrite `bpm_verified`/manually-set entries without
  `--force`.
- **Distribution:** signed builds (macOS notarization, ~$99/yr Apple dev
  cert — unsigned macOS builds show a Gatekeeper block screen that kills
  adoption) via GitHub Releases.
- **License note:** check `libkeyfinder`'s license (GPL family) before
  deciding how the helper binary itself is distributed/sold — separate
  concern from the web app, which stays MIT and never bundles this code.
- **Effort:** M (the `libkeyfinder` FFI bindings are the main one-time
  cost; everything else is straightforward wiring).

---

### Proposed tiers

| Tier | Price idea | Contents |
|------|-----------|----------|
| Free | $0 | Everything that exists today, local-only, + stats dashboard (F11) as a hook |
| Pro | ~$6/mo | Cloud sync + accounts, F1–F4, F7–F10, F12, F14, push/email marketplace alerts |
| Dealer | ~$15/mo | Pro + store suite, F5–F6, F13, sales analytics |

---

## 4. Suggested milestones

1. **M-0 Hardening:** C1, H1, H2, H3, L2, L4 — safe to demo publicly. **Also start F10 snapshot recording now** (trivial, and history accrues from day one).
2. **M-1 Data safety:** M2, M3, M4, M5 + backup-format version bump.
3. **M-2 Quick wins (no backend needed):** F11 stats dashboard, F7 barcode scanner, F9 max-price alerts — visible product momentum while foundation work happens.
4. **M-3 Foundation:** B2, B3, P3, P4 — backend, modules, CI.
5. **M-4 Monetization:** B1, P2, P7 + Stripe/license gating.
6. **M-5 AI wave 1:** F1, F4 (highest wow-to-effort ratio).
7. **M-6 AI wave 2 + community features:** F2, F3, F5, F6, F8, F12, F13, F14 + PWA (P5).
8. **M-7 Desktop analysis helper:** section 3b — unblocks real BPM/key data (and F4) for friends/users without a backend.

---

## 5. Approved: Serverless Professionalization Pass

**Status: approved, ready to start.** Scope discussed and greenlit
2026-09-04. Pick this up from the CLI and work top to bottom — each
group is independently shippable.

**Explicitly out of scope:** P2 (accounts + cloud sync). Stays
serverless/local-first. Nothing here should require a backend.

### 5a. Code quality
- [ ] Replace all inline `onclick="..."` handlers (132 across `src/*.js`,
  `src/views/*.js`, `app.js`, `index.html`) with `data-*` attributes +
  delegated `addEventListener`. Also closes the C1 XSS bug class
  structurally (currently only patched at the escaping layer). This is P4.
- [ ] Introduce a build: ES modules (replace global-scope script soup),
  ESLint, Prettier, Vitest. No framework, no heavy bundler lock-in — keep
  it light. This is P3.
- [ ] GitHub Actions CI: lint + test + build on every push. Repo currently
  has no `.github/` at all.
- [ ] Priority test targets: `harmonic.js`, `store_serial.js`,
  `crossfade.js` — pure logic, highest value per hour, currently untested.

### 5b. Portability & polish
- [ ] PWA: `manifest.json` + service worker → installable, works offline.
  This is P5.
- [ ] Replace `alert()` and ad-hoc sync-banner reuse with a proper
  toast/error system. This is part of P6.
- [ ] Onboarding fix (`src/views/setup.js`): validate the Discogs token
  immediately on submit (test API call), show the resolved
  username/avatar back as confirmation, instead of failing silently later
  on the collection screen.
- [ ] Cut the background video cost: `index.html:13`
  (`A_dark_atmospheric_digital_ar.mp4`, 3.3MB, `autoplay`) — add
  `preload="none"` + poster image, or re-encode much smaller. Biggest,
  cheapest first-impression win in the repo.

### 5c. Data model
- [ ] Track identity refactor: `track_meta` currently keys off
  `releaseId_youtubeId` (`src/meta.js:3`, `src/db.js` `videos` store keyed
  on `release_id`), so BPM/key/rating are per (release, video) pair, not
  per track. Same track across multiple pressings/comps gets analyzed
  and rated separately. Introduce a track identity layer; releases
  reference tracks; BPM/key/rating live on the track.
- [ ] Label the backup file, don't split it: keep `exportFullBackup()`
  (`src/backup.js`) as **one** JSON file, but structure it so
  **authored** data (track_meta, setlists, store_items — irreplaceable,
  typed by hand) is clearly separated inside from **derived** data
  (releases, videos, folders, tracklist, marketplace_stats —
  re-fetchable from Discogs by re-syncing). Today both are flattened
  together with no distinction. Needs a backup-format version bump
  (ties into M2/M3/M4/M5 data-safety bugs already in section 1).