# L9 queue scroll/drag + F16 BPM/key in queue + second review of view_state/db
Status: done      Path: standard
Iteration: 2 of 3 (task 3 fixes sent back once)

## Request
1. L9: queue panel rebuilds must keep list scrollTop and dragged panel position; scroll current into view only on open, or on a self-driven track change (auto-advance/crossfade/error skip/Next) when the new current row is out of view. ▶/× leave the list where it is. Keep L2 `_cleanup()`.
2. F16: rounded BPM + compact Camelot chip beside `.queue-num` in each queue row, from track_meta (id `releaseId_youtubeId`, fallback by youtube id), filled in after first draw, cached map invalidated on meta save; screen-reader text "124 BPM, key 8A"; nothing shown without data.
3. Second review of round-2 fixes in src/view_state.js / src/db.js + this run's diff.

## Acceptance criteria
- L9 e2e (written failing first): long queue, scroll to middle, ▶ middle row -> scrollTop unchanged; × likewise; drag panel, trigger rebuild -> position kept; auto-advance with next row out of view -> scrolled in; opening queue shows current row.
- F16: unit tests for matching/formatting; e2e rows with and without metadata; whole-collection shuffle stays responsive (no per-row DB reads; draw before data).
- Plan: dated Status note on L9; F16 marked done with dated note; README queue section if present.
- `npm run check` green (lint + unit), `npm run test:e2e` green.

## Decisions & constraints
- No commits/branches/pushes; keep all existing uncommitted work.
- No module conversion, no runtime deps, no backend. act() for handlers, showToast, escHtml, dateMs.
- Baseline snapshot of the tree before this run: scratchpad/baseline (for "this run's diff").

## Findings by role

## Open risks

## Verification log

### code-reviewer (Task 3: view_state.js / db.js round-2 re-review) — baseline check 183/183
- Must 1: slow R1 shows loading, fast R2 supersedes before 250ms -> aria-busy + "Loading..." status stay forever (view_state.js finish/timer). ACCEPTED -> fix with module-level _loadingUp; new run or last-settling current run clears it. Covers should-fix 4 (view-refreshing class).
- Must 2: direct re-render for a view no longer routed (renderRelease after dbPut, renderSetlist) bumps seq, supersedes router run for the new view -> blank #app. ACCEPTED -> startViewRender returns dead token (-1) when not claiming and view != currentRouteView(); no seq bump.
- Should 3: endViewRender stale branch returns raw promise (can reject). ACCEPTED -> catch+log on stale direct token.
- Nit: _dbOpening cleared in .then, closed connection could be handed back in a microtask window. ACCEPTED (cheap). Nit: blocked toast 200ms dismissal window — harmless, not changed. Nit: analyzer/backup startViewRender() without view — fine, not changed.
- Dispatched to debugger (owns view_state.js/db.js only; frontend-engineer owns queue files).

### debugger (Task 3 fixes, round 3) — done
- view_state.js: module-level loading flag cleared by current/new run; dead token for direct render of a view no longer routed; stale endViewRender never rejects. db.js: _dbOpening cleared in onsuccess/onerror. Unit 188/188, lint clean.
- Remaining risk it raised: dead-token check compares view names only -> late renderRelease(A)/renderSetlist(idA) while on B still draws over B. ACCEPTED -> second debugger dispatched for a route-key check (view_state/router/release/setlists only, no e2e).

### frontend-engineer (L9/F16, first attempt) — cut off by usage limit
- Left: tests/e2e/fake_yt.js, tests/e2e/queue.spec.js, volume.spec.js refactored to fake_yt.js, scratchpad/l9_before.txt. queue.js unchanged. Re-dispatched to continue.

### debugger (route-key, round 4) — done
- router.js currentRouteKey(); view_state.js startViewRender(view, key) + key re-check in viewRenderIsCurrent (string compare); release.js / setlists.js pass their id. +2 tests (fail-before 30/32 -> 32/32 in scratchpad/routekey_before.txt). Unit 190/190, lint clean. Accepted residual: release ids must survive parseInt (true for Discogs ids).

### frontend-engineer (L9/F16, continued) — done
- L9: _renderQueuePanel({reveal:'open'|'ifHidden'|false}); carries position, scrollTop, in-progress drag, focus; L2 kept; ended/crossfade/error/Next/Prev = ifHidden; shuffle + wantlist shuffle = open; ▶/×/harmonic = keep. Drag bug REAL (before: x jumped 300px = drag distance; list jumped 137px on ▶; scratchpad/l9_before.txt).
- F16: new src/queue_meta.js (pure match/format, null-proto index, metaId -> trackMetaId -> youtube_id/id suffix), queue.js fills .queue-meta after draw from one dbGetAll per draw, stale results dropped; CSS 32px column; sr label "124 BPM, key 8A". DECISION: no cache (read per draw) -> no invalidation points; accepted (brief allowed either). Column appears only once some queued track has data.
- Tests: queue_meta.test.js 6; e2e queue.spec.js 6 (incl. 3,000-row). check 196/196, e2e 27/27.
- Left: harmonic "Play next", setlists plays, wantlist play don't redraw an open panel (pre-existing, stale rows).

### code-reviewer (this run's diff) — no must/should-fix; check 196/196, queue+states e2e 12/12
- Nit 1 key "estimated" uses bpm_verified: matches app-wide convention (single "BPM/key verified" checkbox in meta_editor; release.js/setlists.js/harmonic.js do the same) — no change.
- Nit 2 track_meta read per draw: accepted; cache only if the store grows large.
- Nit 3 _queueShowsMeta survives queue swap (one frame at most): accepted.
- Nit 4 showViewError doesn't reset _loadingUp: harmless, accepted.

## Open risks
- harmonic "Play next", setlists plays and wantlist play don't redraw an open queue panel (stale rows) — existing behaviour, not in scope.
- Release ids must survive parseInt to match the route key (true for Discogs ids).

## Verification log
- 2026-11-06 orchestrator: `npm test` 196/196; `npx eslint .` clean; `npm run test:e2e` 27/27.
