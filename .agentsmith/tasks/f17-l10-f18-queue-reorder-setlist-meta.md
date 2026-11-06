# F17 queue drag reorder + L10 stale queue panel + F18 setlist BPM/key & aligned layout
Status: done             Path: complex (3 items, playback state + crossfade bookkeeping, cross-file UI)
Iteration: 1 of 3

## Request
1. F17: drag-and-drop reorder of queue rows (+ keyboard/touch alternative), playback/crossfade bookkeeping correct, L9 scroll/panel position kept.
2. L10: one helper redraws an open queue panel wherever queue/current track changes (harmonic Play next, setlist play, want-list play); failing test first.
3. F18: setlist rows show BPM/key via queue_meta matcher (metaId -> releaseId_youtubeId -> youtubeId), also in CSV export; aligned table-like setlist layout, responsive at <=480px; screenshots 1280/360.

## Acceptance criteria
- F17: drag handle on each row; dragging a row never moves the panel and header drag never starts row DnD; currentIndex follows the playing track; preloaded crossfade re-done when "next" changes; drops disabled/deferred during 'fading'/'switching'; _savePlayerState after change; no scroll/panel jump; keyboard move up/down with announcement (aria-live); move buttons usable on touch; unit tests for index logic; e2e drag + keyboard.
- L10: single helper (e.g. `_refreshQueuePanel()`), used by harmonic, setlists play, wantlist play, F17 reorder; test that fails before fix.
- F18: rows with metaId null show BPM/key when track_meta matches by release+video or video; CSV export same; fixed columns align across rows incl. empty cells; header row; <=480px drops less important columns, keeps BPM+key; drag reorder in setlist still works; unit + e2e tests (incl. x-alignment of BPM cells); screenshots in scratchpad.
- All: `npm run check` and `npm run test:e2e` green; PROJECT_PLAN F17/F18 entries in §3 (after F16) + L10 status; README updated.

## Decisions & constraints
- No commits/branches. No runtime deps. ES modules deferred. act() for markup handlers; addEventListener ok for DnD (as initSetlistDragDrop). showToast, escHtml, view_state.
- Sequential dispatch (shared files: src/queue.js, src/setlists.js, style.css, PROJECT_PLAN, README): Engineer A = L10 + F17; then Engineer B = F18.
- Note found by orchestrator: playSetlist/playFromSetlist in src/setlists.js drop metaId when building queue items (F18 engineer should carry metaId through).
- Don't silently rewrite stored setlists; filling metaId at save time for new tracks is ok.

## Findings by role
- frontend-engineer (A, L10+F17): refreshQueuePanel(opts) in src/queue.js; called at the end of loadFromQueue (src/player.js), so every track change redraws an open panel once. playSetlist/playFromSetlist unchanged (they go through loadFromQueue) - F18 engineer free to edit them. Reorder: src/queue_order.js (pure), moveQueueItem/_initQueueReorder in src/queue.js; fade policy = refuse moves that break the fading pair, allow others.
- frontend-engineer (B, F18): matching via new `setlistMetaIndex` (src/queue_meta.js; shared `_metaIndex`, queueMetaIndex behaviour unchanged) + `queueItemMeta`, used by renderSetlist and the new pure `setlistCsv` (src/backup.js). `itemMetaId` fills metaId from release+video on addTrackToSetlist / saveQueueAsSetlist only (stored setlists untouched); now-playing + falls back to the queue item's releaseId/metaId; `setlistQueueItems` carries metaId into the queue. Table: `setlistTableHtml` / `setlistMetaCellsHtml` (src/setlists.js), ARIA table roles, header row `.setlist-head` (not .setlist-row, not draggable), one CSS grid template via `--sl-cols`; <=768 px chip loses name/relative key; <=480 px cover/energy/rating/handle hidden (row still draggable), 2-line title clamp. Playing row + drop markers now inset shadows (no 3px shift). Screenshots: scratchpad setlist-{before,after}-{1280,360}.png.

## Open risks
- F18: at 360 px the *page* is still ~910 px wide because of the top nav/header (pre-existing, not the setlist view; the table itself fits, asserted in e2e).
- F18: CSV key column still uses raw `key` (a record with only `key_musical` shows a key in the view but not in CSV) - unchanged by choice.

## Verification log
- A: npm run check 203/203 unit, lint clean; npm run test:e2e 34/34; queue.spec x4 repeat 52/52.
- B (F18): npm run check 211/211 unit, lint clean; npm run test:e2e 38/38; setlists.spec + views.spec x4 repeat 44/44.
- code-reviewer (L10/F17): no will-break. Should-fix: stale _queueDrag after mid-drag redraw lets a foreign drag (file/text) reorder -> gate dragover/drop on private DataTransfer type + clear on dragstart. Nits: focus after mouse drag restored by index (comment or skip); add cfEnabled && to repreload like remove; debounce re-preload timers; comment in loadFromQueue redraw when !playerReady. Decision: apply 1, 2, 3 (and 4 if trivial) after F18 engineer finishes (shared src/queue.js).
- code-reviewer (F18): no will-break. Should-fix: unescaped data-release-id in setlistTableHtml (C1 class, pre-existing line rewritten); setlistCsv release_id/rating not through _csvCell. Nits: possible title collapse 769-900px; energyBadge clamps 0 to 1 (pre-existing, camelot.js, left alone); double blank line. Formula injection in CSV pre-existing, not addressed (out of scope). Decision: fix escaping, CSV cells, 800px layout, blank line.
- frontend-engineer (queue review fixes): all 5 applied (foreign-drag gate, focus follows focused track, cfEnabled gate, debounced _queueRecue, comment); +2 e2e. check 211/211, e2e 40/40.
- frontend-engineer (F18 review fixes): escaped data-release-id and export-menu id; CSV cells via _csvCell; new 900/720/600px breakpoints (title >=160px above 600px); +2 unit, alignment e2e at 1280/800/700/360.
- technical-writer: PROJECT_PLAN F18 breakpoints wording + counts (213 unit / 42 e2e).
- Orchestrator final: npm run check -> lint clean, 213/213 unit; npx playwright test -> 42/42.
## Open risks (final)
- Page-level horizontal overflow (~910px) from top nav below ~910px viewport - pre-existing, not fixed.
- Brief stale highlight at crossfade hand-over until next track plays (pre-existing).
- CSV formula injection (pre-existing).
