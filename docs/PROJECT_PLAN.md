# Project Plan — Vinyl Collection Player → Paid Product

> Living document. Update statuses as work lands.
> Created 2026-06-12 from a full codebase audit (~5,400 lines JS, no build step, IndexedDB storage).
> **Re-audited 2026-11-06** against the code (~6,400 lines JS in `src/`): every status below was checked in the source, and line references refreshed.

**Status legend:** `[ ]` todo · `[~]` in progress / partly done · `[x]` done · `[-]` won't do

### Where things stand (2026-11-06)

- **Done:** all CRITICAL and HIGH bugs (C1, H1–H4); the desktop BPM/key analyzer (§3b) built and run over the whole collection; plus several features that were never in the plan (see §6).
- **Data-safety bugs M2–M5 fixed and price-history recording (F10) started** on 2026-11-06, with tests.
- **M1 fixed** the same day: all MEDIUM bugs are done.
- **LOW bugs done too** (L1, L2, L4–L9 fixed; L3 closed as not a bug): the whole §1 bug list is now closed.
- **P3/P4/P6 started 2026-11-06:** lint + CI in place, Playwright smoke tests committed and run in CI, all inline handlers replaced (P4 done), toasts, setup token check, lazy background video.
- **Also 2026-11-06:** backup format v3 with authored/derived labelling (§5c), the Stats view (F11), max-price alerts (F9), and the relative key shown beside every key.
- **P6 done 2026-11-06:** loading, empty and error states for every view; `harmonic.js` and `store_serial.js` now tested (found and fixed L7, L8).
- **Queue fixes 2026-11-06:** the queue list and a dragged panel stay put on every redraw (L9), and rows show BPM + key (F16).
- **Next up:** PWA (P5), the barcode scanner (F7, last of M-2), and the B2 YouTube player blocker.
- **Not started:** the backend (B3) and everything that needs it, the track identity refactor (§5c), and the F-features other than F9, F10 (recording only), F11, F15 and F16.

---

## 0. Blockers before charging money

These are not features — they are prerequisites for a paid product.

- [ ] **B1 — Discogs API commercial consent.** The Discogs API is free for *non-commercial* use. Charging requires written consent from Discogs; their image-licensing terms are also strict about cover art. Contact Discogs early — this is the biggest legal blocker.
- [ ] **B2 — YouTube ToS compliance.** Player iframes are still parked off-screen at 1×1 px (`index.html:70-71`, checked 2026-11-06). YouTube requires a visible player ≥ 200×200. Fix: show a small real player in the now-playing bar.
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
- **Status:** [x] Fixed as described (2026-10-13). Verified with a stubbed-player harness: closing mid-fade now stops player 2, and completing a fade over an emptied queue aborts instead of throwing.

#### H2 — "Go to Release" silently bounces to collection (string vs number key)
- **Where:** `src/player.js:174-200` (`playTrack`/`playAll`), `src/setlists.js:241-252` (`gotoNowPlayingRelease`), `src/views/release.js:4`
- **What:** Queue items built from DOM rows store `releaseId` as a **string** (`el.dataset.releaseId`), but IndexedDB release keys are **numbers** → `dbGet('releases', "12345")` returns undefined → `renderRelease` falls through to `navigate('collection')`. Works for setlist/suggestion queues (numeric ids), breaks for the most common path (clicking a track row). Stale string ids also persist via `sessionStorage`.
- **Fix:** `parseInt(el.dataset.releaseId, 10) || null` in `playTrack`/`playAll` (same as `openAddToSetlistPopover` at `setlists.js:153`); defensive `Number(releaseId)` coercion at the top of `renderRelease`.
- **Status:** [x] Fixed as described (2026-10-13); `renderRelease` coerces with `parseInt`, so stale string ids restored from `sessionStorage` also resolve.

#### H3 — Store "Refresh Price" hits the endpoint the codebase documents as CORS-broken
- **Where:** `src/views/store.js:402-440` (`storeRefreshPrice`)
- **What:** Calls `discogsGet('/marketplace/stats/' + id)` with an `Authorization` header — but `api.js:137-141` documents that `/marketplace/stats` doesn't support the CORS preflight the auth header triggers, and `marketplace.js:37-40` deliberately switched to `/releases/{id}` for exactly this reason. Likely fails every time (3 retries + misleading "Network error" banners). Also reads `data.highest_price`, which that endpoint doesn't return, so the price *range* can never render.
- **Fix:** Use `discogsGet('/releases/' + id)` (gives `num_for_sale` + `lowest_price`); drop the phantom `highest_price` or source it from `/marketplace/price_suggestions`.
- **Status:** [x] Premise outdated. Checked live on 2026-10-13: the authenticated `/marketplace/stats` preflight is accepted (204, `authorization` allowed, `ACAO: *`), so the endpoint stays. Switching to `/releases/{id}` would have broken it, because there `lowest_price` is a bare USD number, not `{value, currency}`. Fix: dropped the made-up `highest_price` (always stored as null now). **Follow-up:** `marketplace.js:42` reads `/releases/{id}`'s `lowest_price.value`, which is always undefined, so wantlist and notification prices never show. Tracked as H4.

#### H4 — Wantlist/notification prices never show
- **Where:** `src/marketplace.js:42-43`
- **What:** `/releases/{id}` returns `lowest_price` as a bare number in USD (no currency), but the code reads `.value`/`.currency`, so `lowestPrice` is always null.
- **Fix:** Read the number and label it USD, or pass `curr_abbr`; alternatively use `/marketplace/stats/{id}`, which returns `{value, currency}` and now accepts the auth preflight.
- **Status:** [x] Switched to authenticated `/marketplace/stats/{id}` (2026-10-13). `curr_abbr` is ignored on `/releases/{id}`, so it could not be labelled reliably.

### MEDIUM

#### M1 — Crossfade silently skips short tracks
- **Where:** `src/crossfade.js:52-54`
- **What:** Guard `duration < cfSeconds + 2` skips crossfade with no feedback; with a long fade (e.g. 9 s) on a 10 s track the fade just doesn't happen. Magic `+2` constant.
- **Fix:** Clamp `cfSeconds` against track duration at fade time, or surface the limit in the UI.
- **Status:** [x] Fixed 2026-11-06. The skip guard is gone; `_effectiveFadeSeconds()` (`src/crossfade.js`) uses the chosen fade but caps it at a third of the track, so a 9 s fade on a 10 s track now crossfades over 3.3 s. Only tracks under 3 s get no fade. The cap is against the *current* track; a *next* track shorter than the fade still ends mid-fade and aborts it, as before. Tested in `tests/crossfade.test.js`.

#### M2 — Orphaned `marketplace_stats` / `notifications` when wants are removed
- **Where:** `src/views/wantlist_sync.js:88-93` (stale-want prune, delete at :91), `src/views/wantlist.js:438` (`wlRemove`)
- **What:** Deleting a want never deletes its `marketplace_stats` row (or its notifications). Orphaned data accumulates and leaks into backups.
- **Fix:** Delete matching `marketplace_stats` (and optionally notifications) alongside each `dbDelete('wants', …)`.
- **Status:** [x] Fixed 2026-11-06. `removeWantData()` (`src/marketplace.js`) deletes a want's `marketplace_stats` row, its notifications and its price history; called from `wlRemove` and from the want-list sync's prune. Tested in `tests/data_safety.test.js`.

#### M3 — Partial sync failure can wipe releases + user-entered track metadata
- **Where:** `src/api.js:188-236` (`syncCollection` fetch, save + prune loops)
- **What:** If a folder fetch throws midway, a half-built `allReleases` map can be persisted, and the prune step deletes every release **not** in the partial map — including its `track_meta` (BPM/key/rating the user typed by hand). A transient network error can destroy data.
- **Fix:** Only run the prune pass after a fully successful fetch of all folders; sanity-check the new map is non-empty/plausible before deleting.
- **Status:** [x] Fixed 2026-11-06. The original mid-fetch case could not happen (a thrown fetch error aborts the sync before any save or prune). The real gap was a sync that *succeeds* with too few items. Both syncs (collection and want list) now go through `syncPruneAllowed()` (`src/api.js`) before deleting anything: removals are skipped when the pages held fewer items than Discogs' `pagination.items`, or when the listing is empty while records are stored; and removing more than 10 records and ≥25% of what is stored asks for confirmation. A release Discogs really dropped is still removed with its data, as before. Tested in `tests/data_safety.test.js`.

#### M4 — Surprise autoplay on tab restore
- **Where:** `src/player_state.js:15-35` (`_restorePlayerState`)
- **What:** State saved every 2 s while playing; on reload the app **auto-plays** from the saved position. Combined with `onversionchange` auto-reload (`db.js:79-84`), opening a second tab can trigger unexpected playback.
- **Fix:** Restore in paused/cued state by default (the cue branch already exists).
- **Status:** [x] Fixed 2026-11-06. `_restorePlayerState` always cues (paused, at the saved position); play resumes from there. The next track is still pre-cued so the crossfade works once play is pressed.

#### M5 — Marketplace notification baseline edge cases
- **Where:** `src/marketplace.js:48-62`
- **What:** Alerts fire only on a confirmed 0 → 1+ transition. Items already for sale at first check never alert (by design), but `marketplace_stats` restored from an old backup carries a stale `num_for_sale` baseline → spurious or missed alerts after restore.
- **Fix:** Invalidate/refresh `checked_at` baselines on backup restore, or treat restored stats as `prevNum = null`.
- **Status:** [x] Fixed 2026-11-06. Restore (`_restoreMarketplaceStats` in `src/backup.js`) keeps any local reading (always newer than a backup's) and adds the backup's only where none exists, flagged `baseline_restored` with `checked_at: null`. The poll treats a flagged row as no baseline, records a fresh one silently, and checks it at the next poll. Tested in `tests/data_safety.test.js`.

#### M6 — Time bar freezes at 0:00 after a crossfade
- **Where:** `src/player.js` `onPlayerStateChange` (the `_cfState === 'switching'` branch), `showNowPlaying` → `_resetProgress()`
- **What:** Reported 2026-11-06 with crossfade on: after a song crossfades into the next, the time shows `0:00 / 0:00` and the bar does not move. Finishing a crossfade calls `showNowPlaying()`, whose `_resetProgress()` stops the progress timer; when player 1 then reports PLAYING, the crossfade branch returns early without restarting it. Pause/play brings it back. Tracks that change without a crossfade are fine.
- **Fix:** Restart the progress timer (and check the visualizer) in the crossfade hand-over branch.
- **Status:** [x] Fixed 2026-11-06: the hand-over branch now calls `_startProgressUpdate()` and `startViz()` (both safe to call twice). `tests/player_progress.test.js` plays a crossfade hand-over with a stand-in YouTube player and checks the time bar follows the new track; it failed before the fix.

### LOW

#### L1 — Leaked global timers
- **Where:** `src/init.js:4` (`_saveInterval`), `src/marketplace.js:89` (poll interval)
- **What:** Never cleared. Harmless in a never-torn-down SPA, but technically leaks.
- **Status:** [x] Fixed 2026-11-06. `startPlayerStateSaver`/`stopPlayerStateSaver` (`src/init.js`) and `stopMarketplacePoll` (`src/marketplace.js`); both timers start once and stop on `pagehide` when the page is really unloaded (kept for the back/forward cache). The same handler saves the player position one last time, so a reload no longer resumes up to 2 s back.

#### L2 — Queue panel leaks document-level listeners on every re-render
- **Where:** `src/queue.js:28-33` (`makeDraggable`), `src/queue.js:55` (`_renderQueuePanel`)
- **What:** `_renderQueuePanel` removes the old panel with `.remove()` without calling its `_cleanup()`, leaking a `mousemove` + `mouseup` document listener pair per re-render (which happens on every queue action / track change).
- **Fix:** Call `existing._cleanup()` before `existing.remove()`.
- **Status:** [x] Fixed 2026-11-06. `_renderQueuePanel` calls the old panel's `_cleanup()` before removing it. Tested in `tests/low_bugs.test.js` (listener count stays flat over re-renders, drops to 0 on close).

#### L3 — `bpmDelta` edge cases
- **Where:** `src/harmonic.js:27-33`
- **What:** BPM of `0` treated as missing (falsy); half/double-time computed in overlapping ways. Cosmetic scoring noise.
- **Status:** [-] Won't fix (2026-11-06). On a closer read it is not a bug: 0 BPM is not a real tempo, so treating it as missing is right, and the overlapping half/double-time checks still return the correct smallest difference.

#### L4 — Duplicate/conflicting bg-video scripts; first one throws
- **Where:** `index.html:15-27` (head script) vs `index.html:160-175` (body script)
- **What:** Head script sets `playbackRate = 0.5` and references `#bg-toggle-btn` **before it exists in the DOM** → throws at line 20, its toggle handler never binds. Body script (rate 0.95) is the one that works. Dead/throwing code.
- **Fix:** Delete the head script block.
- **Status:** [x] Fixed 2026-11-06. The head script is deleted; the body script (0.95×, toggle) is unchanged and was the only one doing anything. Nothing else referenced its globals.

#### L5 — Date handling assumes valid ISO strings
- **Where:** `src/marketplace.js:176-184` (`formatTimeAgo`), ETA math in `api.js`
- **What:** Malformed dates render `NaN`. Cosmetic.
- **Status:** [x] Fixed 2026-11-06. New `dateMs()` (`src/utils.js`) returns null for a missing or malformed date. `formatTimeAgo` shows nothing instead of "NaNd ago"; undated alerts sort last; a reading with a bad `checked_at`/`snapshot_at` is treated as due (before, it was never re-checked or snapshotted). The "ETA math in `api.js`" turned out not to parse dates at all. Tested in `tests/low_bugs.test.js`.

#### L6 — Pagination ellipsis glitches
- **Where:** `src/views/collection.js:163-174` (same pattern in `tracks.js`, `wantlist.js`)
- **What:** Certain page counts render doubled `...` or odd gaps. Cosmetic.
- **Status:** [x] Fixed 2026-11-06. One shared `renderPagination()` / `paginationPages()` (`src/utils.js`) replaces the three copies: one "…" per gap, and a single hidden page is shown instead of hidden behind "…". Tested for every page of every size up to 40 in `tests/low_bugs.test.js`.

#### L7 — "Play next" on a suggestion drops the release, so the track suggests itself
- **Where:** `src/harmonic.js` (`playNextSuggestion`, and the queue filter in `openSuggestions`)
- **What:** Found 2026-11-06 while adding `tests/harmonic.test.js`. "Play next" queued the suggestion without its `releaseId` ("Queue" kept it). The suggestions leave out queued tracks by release + video, so with the release missing, opening suggestions again while that track played listed the playing track as its own best match (same key, same tempo). Any queue entry without a release id (e.g. a track row whose id did not parse) had the same gap.
- **Fix:** `playNextSuggestion` keeps `releaseId`, as `addSuggestionToQueue` does; a queue entry with no release id now keeps its video out of the suggestions whatever the release.
- **Status:** [x] Fixed 2026-11-06. Two tests in `tests/harmonic.test.js` failed before the fix and pass after.

#### L8 — Harmonic suggestions rank some further tempos above closer ones
- **Where:** `src/harmonic.js` (`scoreCandidate`, the tempo bonus)
- **What:** Found 2026-11-06 while adding `tests/harmonic.test.js`. The tempo bonus fell from 100 to 40 over the first 6 % of difference, then restarted at 50 for 6–12 %. So a track 6.25 % off scored 49.25 and outranked one 5.5 % off (45), and everything between about 5 % and 9.3 % ranked in the wrong order.
- **Fix:** The 6–12 % band now continues down from 40 (`40 - (delta - 6) * 4/3`), ending at 32 at 12 % as before. Nothing else in the score changed.
- **Status:** [x] Fixed 2026-11-06. `tests/harmonic.test.js` checks the score never rises as the tempo gets further away; it failed before the fix.

#### L9 — Queue list jumps away from where you were browsing
- **Where:** `src/queue.js` `_renderQueuePanel()` (rebuilds the whole panel), called from `playFromQueuePanel`, `removeFromQueuePanel`, `src/player.js` track changes and Next.
- **What:** Reported 2026-11-06: scroll the queue, press ▶ on a track in the middle, and the list jumps so the playing track is the *last* visible row. Every rebuild starts the new list at the top, then `scrollIntoView({ block: 'nearest' })` scrolls just far enough to show the current track. The same jump happens on removing a track, on auto-advance and on Next. A dragged panel likely jumps back to its default position for the same reason (to verify).
- **Fix:** Keep the list's scroll position (and the panel's dragged position) across rebuilds; scroll the current track into view only when the queue opens, or when a track changes on its own and the new one is out of view.
- **Status:** [x] Fixed 2026-11-06. A redraw now carries over the list's scroll position, the panel's dragged position, a drag still under way and the focused row button (`_renderQueuePanel(opts)`, `src/queue.js`). The current track is brought into view only (a) when the panel opens or shows a new shuffled queue (centred if it is out of view) and (b) when playback moves on by itself or by Next/Prev — track ended, crossfade hand-over, unplayable video skipped — and then only if the new row is hidden, scrolling the list just far enough and never the page. ▶ and × on a row, and a suggestion queued, leave the list exactly where it was. The scroll happens straight away instead of 50 ms later, so nothing moves after drawing. The dragged-panel jump was real: before the fix the panel snapped back 300 px to its default corner on the first redraw after a drag. L2 still holds (the old panel's listeners are removed). `tests/e2e/queue.spec.js` (4 tests, two failed before the fix: list moved 137 px on ▶, panel moved 300 px).

#### L10 — An open queue panel can show old rows
- **Where:** harmonic "Play next" (`src/harmonic.js`), setlist play buttons (`src/setlists.js`), want-list play (`src/views/wantlist.js`).
- **What:** Found 2026-11-06 during the L9 work (existed before it): these change the queue or the current track without redrawing an open queue panel, so it shows stale rows until the next redraw.
- **Fix:** Redraw an open queue panel (`_renderQueuePanel({ reveal: 'ifHidden' })`) wherever the queue or current track changes; one helper so no caller can forget.
- **Status:** [ ]

### Triage table

| ID | Severity | One-line | Effort | Status |
|----|----------|----------|--------|--------|
| C1 | Critical | `escJs` doesn't escape `"` → broken UI + stored XSS → token theft | S (patch) / M (proper) | ✅ patched; structural fix = P4 |
| H1 | High | Close-player mid-crossfade = stuck hidden audio + throw | S | ✅ |
| H2 | High | "Go to release" broken for track-row queues (string vs number id) | S | ✅ |
| H3 | High | Store price refresh hits CORS-broken endpoint | S | ✅ (premise outdated) |
| H4 | High | Wantlist/notification prices never show | S | ✅ |
| M1 | Medium | Crossfade silently skips very short tracks | S | ✅ |
| M2 | Medium | Orphaned marketplace_stats/notifications on want removal | S | ✅ |
| M3 | Medium | A sync that returns too few releases prunes releases + track metadata | S–M | ✅ |
| M4 | Medium | Surprise autoplay on tab restore | S | ✅ |
| M5 | Medium | Notification baseline edge cases after restore | S | ✅ |
| L1–L6 | Low | Leaked timers/listeners, dead bg script, cosmetics | S each | ✅ (L3 won't fix) |
| L7 | Low | "Play next" drops the release → the playing track is suggested as its own next match | S | ✅ |
| L8 | Low | Tempo bonus jumps at 6 % → further tempos outrank closer ones | S | ✅ |
| L10 | Low | Open queue panel shows stale rows after Play next / setlist / want-list play | S | open |
| L9 | Low | Queue list (and a dragged panel) jumps on every redraw | S | ✅ |

---

## 2. Professionalization (the unglamorous 80%)

- [x] **P1 — Fix C1–H3 first.** With a Discogs token in IndexedDB, XSS is account takeover; can't charge money on top of that. *Done: C1 and H1–H4 fixed (2026-06-12, 2026-10-13).*
- [ ] **P2 — Accounts + cloud sync.** "Your data lives only in this browser" is the #1 commercial weakness; flip it into the #1 paid feature ("synced across devices, never lose crate data"). IndexedDB stays as offline cache; sync to backend.
- [~] **P3 — Engineering hygiene.** ES modules instead of global-scope script soup; TypeScript (or JSDoc + `tsc --checkJs`); ESLint; Playwright smoke tests; GitHub Actions CI. *2026-11-06: tooling in place — `package.json` (`npm test`, `npm run lint`, `npm run check`), ESLint 10 with a config that collects every file's top-level globals so `no-undef` still catches typos across the shared scope (lint is clean), and `.github/workflows/web-app.yml` running lint + tests on every push and PR. 196 unit tests in 15 files (2026-11-06, after the `harmonic.js`/`store_serial.js` tests, P6 and F16). Playwright smoke tests committed the same day: now 27 tests in `tests/e2e/` (click through every nav view, setup token check, toasts, lazy background video, loading/empty/error states, volume, the queue panel), run with `npm run test:e2e` against a local static server with every request blocked except a faked `api.discogs.com`; `@playwright/test` pinned at 1.62.1; a CI `e2e` job runs them beside lint + unit tests. Still to do: ES modules and type checking — **deferred 2026-11-06** (see §5a).*
- [x] **P4 — Event delegation.** Replace all inline `onclick="..."` string building with `data-*` attributes + delegated listeners (also resolves C1 permanently). *Done 2026-11-06: all 140 inline handlers replaced. `act(type, fnName, args)` (`src/actions.js`) renders `data-on-<type>` + JSON `data-args-<type>`; one listener per event type on `document` (click, change, input, Enter, Escape) calls the function, innermost first, bubbling like inline handlers did. `escJs()` is no longer used. `tests/actions.test.js` fails if an inline handler returns or an action names a missing function; a browser run clicked through every view with no errors.*
- [ ] **P5 — PWA.** Manifest + service worker → installable, offline crate browsing at record fairs; pairs perfectly with the store/serial feature. *No manifest or service worker yet.*
- [x] **P6 — UX polish.** Proper toast system instead of `alert()` and sync-banner reuse; loading/empty states; error boundaries. *2026-11-06: toasts done (`src/toast.js`; 11 of 12 `alert()`s and all 6 one-off sync-banner notices replaced — the one left is the forced reload after another tab's DB upgrade, where a blocking message is the point). Setup token check and lazy background video done (§5b).* *2026-11-06 (later): loading/empty states and error boundaries done. Every view now goes through one wrapper (`src/view_state.js`, used by `renderCurrentView`): "Loading …" only after 250 ms (no flash), `aria-busy` + a `role=status` line, no spinning with reduced motion; a refresh keeps the page dimmed instead of blanking it. Render tokens stop a slow older render from overwriting a newer one. A view that throws or rejects is logged and replaced by a message with Try again. A database that will not open (no IndexedDB, private mode, VersionError, quota) says why instead of a blank page; a blocked upgrade waits with a notice; `openDB` now shares one open request. Empty states checked across all views; fixed the ones that were wrong or had no next step (Tracks on a fresh install, BPM/key filter with no metadata, Store before the first sync, empty setlist, alerts panel). 25 unit (`tests/view_state.test.js`) + 6 e2e (`tests/e2e/states.spec.js`) tests. Re-renders that skip the router (filter clicks, sync and poll refreshes) get no loading delay but share the same guard: they draw only while still the newest render on their own page, and a failure there also ends on the error screen.*
- [ ] **P7 — Landing page + demo mode.** Pricing page, docs, and a demo collection so prospects can try without a Discogs token.

---

## 3. Premium / AI features

All AI calls go through the backend proxy (B3), metered per tier. Collection data is small and structured — ideal LLM input.

- [ ] **F1 — Collection Intelligence Report (flagship).** Feed releases/styles/years/countries/track_meta to an LLM → personal "Rewind": taste profile, era/label/pressing-country clustering, blind spots, fun facts, valuation summary from existing marketplace stats. Shareable → built-in marketing.
- [ ] **F2 — Natural-language crate digging.** "Warm, melodic, 115–125 BPM, sunset opener" → ranked tracks from *your* collection. Embed metadata once, vector-search client-side, optional LLM re-rank. Constrain by key compatibility via existing `harmonic.js`.
- [ ] **F3 — AI setlist generator.** Input: vibe, duration, opening track. Output: full setlist with an energy arc — Camelot scoring as hard constraint, LLM for narrative flow. Exports via existing M3U/CSV.
- [ ] **F4 — AI metadata enrichment.** One-click estimation of BPM/key/energy/mood from title + style + year, marked "estimated" until verified. Directly feeds suggestions, filters, and F3 (the suggestion engine is currently starved by manual-only BPM/key). *2026-11-06: largely overtaken for your own collection — the desktop analyzer (§3b) wrote measured BPM/key for 2,891 tracks. F4 still matters for users who won't run the analyzer; energy/mood estimation is not covered by it.*
- [ ] **F5 — Smart buying advisor.** Deal scoring (listing price vs `price_suggestions`), price-history sparklines, "30% below typical — buy signal", AI want-list recommendations from the taste profile.
- [ ] **F6 — Dealer tools (Store tier).** AI pricing by condition/style/scarcity, sales-velocity insights from sold history, auto-generated listing descriptions, printable QR labels per serial.

### Community-sourced features (from Discogs user complaints/wishlists + companion-app survey)

Sourced from Discogs forum complaints and competing companion apps (CLZ, Vinyly, Discographic, WaxHub, vinyl-shelf-finder). These mostly work with or without the backend.

- [ ] **F7 — Barcode scanner.** Camera → `/database/search?barcode=` → add to collection/wantlist. Most-requested companion-app feature. Browser-only: `BarcodeDetector` API (Chromium) + ZXing-wasm fallback (Safari/Firefox). *Effort: M.*
- [ ] **F8 — Master-based wantlist matching.** Collectors want "any pressing of this album"; Discogs only matches exact releases — their #1 marketplace gap. Resolve each want's `master_id` (1 call, cacheable forever), then extend the existing `marketplace.js` poll to track lowest price across `/masters/{id}/versions`. ⚠️ Needs rate-budget design within the 60 req/min bucket. *Effort: M.*
- [x] **F9 — Wantlist criteria + smart alerts (max price).** Per-want max-price threshold; notifications respect it. Builds directly on the existing notification engine. ⚠️ **Scope limit:** the Discogs API exposes no per-listing marketplace data (only `num_for_sale` + `lowest_price`), so *min-condition* and *seller-country* filters are **not implementable** client-side — max-price only. *Effort: S–M.* *Done 2026-11-06: max price + currency per want, set with the bell button on a want-list card; new `want_alerts` store (DB v10), backed up as authored data, deleted with the want. An alert fires when the lowest price reaches the max while copies are for sale, and not again until the price goes back above it or nothing is for sale (`under_max` guard on the `marketplace_stats` row). The plain 0 → 1+ alert is skipped when the lowest price is above the max. If Discogs lists the release in another currency, the max is not compared: the card shows a ⚠ marker and only the plain for-sale alert fires. Tested in `tests/want_alerts.test.js`.*
- [~] **F10 — Price history snapshots → sparklines.** We already poll every 30 min; start **timestamping and storing snapshots now** so history accrues before the chart feature ships (zero-cost data accrual). Render sparklines later. *Effort: S.* *Recording done 2026-11-06: a new `price_history` store (DB v9) keeps a reading when count, price or currency changes, plus one a day otherwise (not every 30-minute poll); rows are keyed `<release_id>_<checked_at>` so backups merge; included in the backup file and restore. Still to do: the sparklines.*
- [x] **F11 — Stats / collection-value dashboard (non-AI).** Real-time collection value, have/want collectability (from `community.have`/`community.want` on the release endpoint), genre/decade/country breakdowns. All data is already local; pure rendering. Great free-tier hook; the AI report (F1) becomes the premium layer on top. *Effort: S.* *Done 2026-11-06: Stats view (`src/views/stats.js`, nav "Stats"). Value is one `GET /users/{u}/collection/value`, sent only when you press "Refresh value"; Discogs' min/median/max strings are shown as sent (kept in config `collection_value`, not exported). Not real-time. Collectability: have/want are now recorded during a sync's per-release fetch; releases synced before that are filled in by an explicit "Fetch collectability" backfill (one request per release, stoppable, resumes where it stopped, holds the sync lock). Breakdowns by genre, style, decade, country and format as plain HTML/CSS bars. Tested in `tests/stats.test.js`.*
- [ ] **F12 — Last.fm scrobbling.** The YouTube player already fires track events; POST scrobbles to Last.fm. ⚠️ Signing requires the API shared secret — acceptable embedded client-side for a hobby tool, **not for a paid product**; route through the backend once B3 lands. *Effort: S–M.*
- [ ] **F13 — Visual shelf finder.** The `shelf` field already exists in track_meta; add an ordered shelf-map view to locate records physically. *Effort: M.* *(The field is edited in `meta_editor.js` and shown on tracks/release pages; no map view yet.)*
- [ ] **F14 — Daily wantlist email digest.** Replaces Discogs' "unworkable" relisting spam. Requires backend (B3) — bundle with it. *Effort: S once B3 exists.*
- [x] **F15 — Volume control.** Requested 2026-11-06. A volume slider + mute in the now-playing bar, remembered between visits. The crossfade must respect it: today it fades to and resets to volume 100, so a naive slider would be overridden at every track change — fades go between 0 and the chosen volume instead, and moving the slider mid-fade scales both players. *Effort: S–M.* *Done 2026-11-06: mute button + range slider (0–100, default 100; arrow keys/Home/End, no global shortcuts) in the now-playing bar; one master volume (`src/volume.js`) for both YouTube players. Fades run from the chosen volume to 0 and 0 to it; moving the slider or muting mid-fade rescales both players at the current point. New tracks and startup use the chosen volume; mute keeps the slider position. Saved in config (`player_volume`, `player_muted`) and in the backup's config section; a restore skips an invalid volume (not a whole number 0–100) or mute (not true/false) and keeps the current one. Narrow screens: at 768 px and below the now-playing bar no longer overflows the screen (the close button used to be pushed off-screen); at 600 px and below it wraps to two rows; at 480 px and below the slider is hidden and only mute stays. Tested in `tests/volume.test.js` (volume maths) and `tests/e2e/volume.spec.js` (fake YouTube API).*
- [x] **F16 — BPM and key in the queue list.** Requested 2026-11-06. A small BPM value (rounded) and the coloured Camelot key chip beside each track's number in the queue panel, from saved track metadata (analyzer or hand-entered); nothing shown when a track has none. The queue draws at once and the values fill in, so a whole-collection shuffle never waits. *Effort: S.* *Done 2026-11-06: each queue row shows the tempo rounded to a whole number above a compact Camelot chip (no relative key or name), between the row number and the cover; estimates are marked as elsewhere (dimmed number, dashed chip). Screen readers hear one phrase, e.g. "124 BPM, key 8A". A track's record is found by the queue entry's metaId, then release + video, then the video alone (same recording on another release). The panel draws first; track_meta is read once per draw (no cache to go stale), indexed once and filled in one pass, and a result that arrives after a newer draw or after closing is dropped. The column appears only once some queued track has data, then every row reserves it, and filling never changes a row's height or the list's scroll position. Matching/formatting in `src/queue_meta.js`; tested in `tests/queue_meta.test.js` and `tests/e2e/queue.spec.js` (incl. a 3,000-row queue drawn before its data arrives).*
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

Since then: a one-script WSL setup (`a5704ca`, 2026-09-30), and a release
workflow that builds Linux and macOS binaries on an `analyzer-v*` tag
(`.github/workflows/analyzer-release.yml`).

#### Analyzer follow-ups (from `docs/analyzer-2026-09-06.md` §6, re-checked 2026-11-06)
- [x] `--keep-audio` flag: keep and reuse downloaded audio.
- [x] Idle UI process holding gigabytes: `malloc_trim` when a run ends.
- [x] Show the relative key beside the detected one (8A ↔ 8B are the same notes). The Camelot wheel colours relative pairs alike, but no relative key is shown as text. *Done 2026-11-06 in the web app: every key chip (release page, setlist detail, suggestions) and the Tracks key badge end in "rel 8B" (full name on hover and for screen readers); the suggestions "Current" line and the editor's wheel centre show it too. `camelotRelative()` in `src/camelot.js`, tested in `tests/camelot.test.js`.*
- [ ] Investigate the 302 title-mismatch holds: bad YouTube links, or a matcher too strict? Sample 20 by hand.
- [ ] Categorise the 128 failures.
- [ ] Listen to the three high-confidence tracks the oracle disputes (`3sgtB4uusJQ`, `mLTzwrK1VyE`, `-ZonmQZG0GQ`).
- [ ] Multi-profile key cross-checking (designed; blocked on trustworthy ground truth).
- [ ] Prefer autocorrelation on disputed tracks (needs a second reference or 15–20 tracks checked by ear).
- [-] Tauri shell, yt-dlp sidecar bundling, macOS signing — deferred by choice; only needed to hand the tool to someone else.
- [ ] Read backup v3 from its `authored`/`derived` paths as well as the v2 ones (`collection.*`, top-level `track_meta`). *Added 2026-11-06: v3 keeps those two at their v2 paths only because the analyzer reads them there; once it reads both, a v4 can complete the clean split (§5c).*

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

1. **M-0 Hardening:** C1, H1, H2, H3, L2, L4 — safe to demo publicly. **Also start F10 snapshot recording now** (trivial, and history accrues from day one). *2026-11-06: done — C1, H1–H4, L2, L4, and F10 snapshot recording started.*
2. **M-1 Data safety:** M2, M3, M4, M5 + backup-format version bump. *M2–M5 done 2026-11-06 (DB schema v9; backups now carry price history). Backup format bumped to v3 with authored/derived labelling (§5c) the same day: M-1 done.*
3. **M-2 Quick wins (no backend needed):** F11 stats dashboard, F7 barcode scanner, F9 max-price alerts — visible product momentum while foundation work happens. *2026-11-06: F11 and F9 done; F7 open.*
4. **M-3 Foundation:** B2, B3, P3, P4 — backend, modules, CI.
5. **M-4 Monetization:** B1, P2, P7 + Stripe/license gating.
6. **M-5 AI wave 1:** F1, F4 (highest wow-to-effort ratio).
7. **M-6 AI wave 2 + community features:** F2, F3, F5, F6, F8, F12, F13, F14 + PWA (P5).
8. **M-7 Desktop analysis helper:** section 3b — unblocks real BPM/key data (and F4) for friends/users without a backend. *Done out of order, 2026-09-06 — for running it yourself; handing it to others (Tauri, signing) deferred.*

---

## 5. Approved: Serverless Professionalization Pass

**Status: approved; well under way** (2026-11-06: CI, lint, P4 event
delegation, toasts, token check, lazy video, Playwright smoke tests and the backup labelling done; modules, PWA and the track identity refactor open). Scope discussed and greenlit 2026-09-04. Pick this up from the CLI and work top to bottom — each
group is independently shippable.

**Explicitly out of scope:** P2 (accounts + cloud sync). Stays
serverless/local-first. Nothing here should require a backend.

### 5a. Code quality
- [x] Replace all inline `onclick="..."` handlers (140 as of 2026-11-06, was 132; across `src/*.js`,
  `src/views/*.js`, `app.js`, `index.html`) with `data-*` attributes +
  delegated `addEventListener`. Also closes the C1 XSS bug class
  structurally (currently only patched at the escaping layer). This is P4.
- [~] Introduce a build: ES modules (replace global-scope script soup),
  ESLint, Prettier, Vitest. No framework, no heavy bundler lock-in — keep
  it light. This is P3. *2026-11-06: ESLint + Node's built-in test runner in place (no Vitest needed; no Prettier yet). ES modules not started — P4 removed the main blocker (inline handlers needed global functions).* **Deferred 2026-11-06, by decision.** Modules would not make the app faster (no bundler; may even be slightly slower) and add little security now that P4 closed the XSS class; their value is safer change — private names instead of silent clashes, explicit dependencies, no hand-ordered `<script>` tags, and practical type checking. That pays off once the project grows (more features, contributors, or the paid version with a backend). The cost is a ~30-file rewrite plus an explicit action registry for `act()` and reworked tests. Until then, lint (no-undef across the shared scope), 196 unit + 27 browser tests and CI cover most of the day-to-day risk. Revisit with type checking (`tsc --checkJs`) as one project.
- [x] GitHub Actions CI: lint + test + build on every push. The only
  workflow today is `analyzer-release.yml` (desktop analyzer binaries on a
  tag); nothing checks the web app. *Done 2026-11-06: `web-app.yml` runs `npm ci`, lint and tests on every push and PR (skips analyzer/docs-only changes). No build step exists to run yet.*
- [~] Priority test targets: `harmonic.js`, `store_serial.js`,
  `crossfade.js` — pure logic, highest value per hour, currently untested.
  *2026-11-06: testing has started with `tests/video_match.test.js` (11
  passing; `node --test tests/video_match.test.js`, real fixtures) and `tests/data_safety.test.js` (9, M2–M5 and F10). `crossfade.js` now has a first test (`tests/crossfade.test.js`, M1); `harmonic.js` and `store_serial.js` still have none, and the
  crossfade test covers only the fade length.* *2026-11-06 (later): `harmonic.js` and `store_serial.js`
  now have tests. `tests/harmonic.test.js` (24): Camelot neighbours for every
  key incl. the 12↔1 wrap and the relative major/minor, input tidying and bad
  keys; `bpmDelta` straight, half and double time, symmetry, and 0/missing BPM
  as no match (L3, by design); `scoreCandidate` key/genre/tempo/rating parts;
  the suggestion ranking with a stand-in DB (order, queue and zero-score
  exclusion, current-track lookup by release, genre fallback, 20 cap, escaped
  panel); "Queue" and "Play next". They found L7 and L8 (fixed).
  `tests/store_serial.test.js` (24): every country alias, case and space
  handling, two-letter fallback and XX; the prefix (split on "/" and ",",
  dedupe, sort, two-code cap, empty parts); the next serial (padding, gaps not
  filled, own prefix only, case, junk serials, past 999); `isSerialTaken`
  (case, spaces, excluded id); and the bulk serialization. No bugs found there.
  Open question: Discogs' joint countries such as "UK & Europe" are not split
  on "&", so they get the XX prefix, and an unknown part takes a slot in a
  joint prefix ("Unknown / Germany" → DE-XX); the tests record this as current
  behaviour, since changing it changes the prefix of future serials.*

### 5b. Portability & polish
- [ ] PWA: `manifest.json` + service worker → installable, works offline.
  This is P5.
- [x] Replace `alert()` and ad-hoc sync-banner reuse with a proper
  toast/error system. This is part of P6. *Done 2026-11-06 (see P6).*
- [x] Onboarding fix (`src/views/setup.js`): validate the Discogs token
  immediately on submit (test API call), show the resolved
  username/avatar back as confirmation, instead of failing silently later
  on the collection screen. *Done 2026-11-06: `/oauth/identity` checks the token before it is saved; a rejected token, an unreachable Discogs (with "Save without checking"), and a token belonging to another account (one click to use that account) each get a clear message; success shows the avatar and "Connected as …".*
- [x] Cut the background video cost: `index.html:13`
  (`A_dark_atmospheric_digital_ar.mp4`, 3.3MB, `autoplay`, still no `preload`/`poster`) — add
  `preload="none"` + poster image, or re-encode much smaller. Biggest,
  cheapest first-impression win in the repo. *Done 2026-11-06: the video now loads only after the page has (idle time), and never for someone who turned it off (remembered in `localStorage`), prefers reduced motion, or has data saving on. No poster image (no ffmpeg here); the page's dark background shows until it loads. Not re-encoded.*

### 5c. Data model
- [ ] Track identity refactor: `track_meta` currently keys off
  `releaseId_youtubeId` (`src/meta.js:3`, `src/db.js` `videos` store keyed
  on `release_id`), so BPM/key/rating are per (release, video) pair, not
  per track. Same track across multiple pressings/comps gets analyzed
  and rated separately. Introduce a track identity layer; releases
  reference tracks; BPM/key/rating live on the track.
- [x] Label the backup file, don't split it: keep `exportFullBackup()`
  (`src/backup.js`) as **one** JSON file, but structure it so
  **authored** data (track_meta, setlists, store_items — irreplaceable,
  typed by hand) is clearly separated inside from **derived** data
  (releases, videos, folders, tracklist, marketplace_stats —
  re-fetchable from Discogs by re-syncing). Today both are flattened
  together with no distinction. Needs a backup-format version bump
  (ties into M2/M3/M4/M5 data-safety bugs already in section 1).
  *Done 2026-11-06: `exportFullBackup()` writes `_version: 3` with a
  `_contents` manifest labelling every section authored or derived.
  `authored` holds setlists, store, price history, notifications,
  max-price alerts and config; `derived` holds wants and marketplace
  stats. `track_meta` (authored) and `collection` (derived) stay at their
  v2 paths because desktop-analyzer reads them there; the clean split is
  deferred to a v4 once the analyzer reads both (§3b follow-up). The
  Discogs token is no longer exported (config is an allowlist: username +
  crossfade settings); a token in an older file is restored only when the
  browser has none, and the file's username only with its token or into a
  browser with no login. Restore reads v1, v2, v3 and
  the analyzer's `analysis.json`, finding sections by path; releases are
  merged field by field instead of replaced, so local video picks and
  collectability survive. Tested in `tests/backup.test.js`.*

---

## 6. Done outside the plan

Shipped work that no plan item asked for (found in the 2026-11-06 audit):

- [x] **Analyzer page in the web app** (`src/views/analyzer.js`, nav "Analyzer"): drives a locally running desktop analyzer over loopback (`127.0.0.1:8733`) and links to the release downloads when none is running. Stays serverless. (`5fd3424`, PR #48)
- [x] **Colour-coded Camelot wheel + analysis provenance in the track editor** (`src/camelot.js`, `src/meta_editor.js`). (`6c209e6`)
- [x] **BPM/key shown on the release page.** (`730a5f4`, PR #47)
- [x] **Video ↔ track matching** (`src/video_match.js`): picks which of a release's community videos *is* each printed track, folds duplicate uploads, drops mixes/sets/clips; your picks persist as `video_overrides` across re-syncs. First unit-tested module. (`bd13372`)
- [x] **Video lengths shown as minutes on the release page.** (`ad202d7`)


---

## Decisions log

- **2026-11-06:** store serials split joint countries on "&" too ("UK & Europe" → `EU-UK`; future serials only). Harmonic suggestions normalise keys on both sides with `camelotCode()`, so hand-typed "8a", "08A", "Am" now match. The L8 tempo curve is kept as fixed. In the queue, estimated BPM/key stay dimmed/dashed and the BPM/key column appears only once some queued track has data. ES modules deferred (see §5a).
