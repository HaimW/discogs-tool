# E2E smoke tests, backup authored/derived labelling, M-2 quick wins (F11, F9, relative key)
Status: done      Path: complex
Iteration: 2 of 3

## Request
1. Commit-ready Playwright smoke tests (tests/e2e, `npm run test:e2e`, CI job), from scratchpad pw/smoke.js + pw/smoke_p6.js.
2. Backup v3: authored vs derived, one file; restore reads v1/v2/v3 + analyzer analysis.json; keep M5 marketplace restore + count message.
3a. F11 stats/collection-value view. 3b. F9 per-want max-price alerts. 3c. Relative Camelot key shown next to key.
Hard rules: no commits/branches; serverless; no new browser runtime deps; keep conventions (act(), escHtml, showToast, dateMs, renderPagination); don't touch desktop-analyzer/; `npm run check` + e2e green; code-reviewer on final diff.

## Acceptance criteria
- AC1 `npm run test:e2e` runs Playwright against a tiny static server, all network blocked except a faked api.discogs.com; covers P4 click-through of every view and P6 checks (setup token check, toasts, lazy video). `npm test` does not pick up e2e files. CI job installs chromium and runs e2e. Local chromium override via env var.
- AC2 Export writes `_version: 3` with clearly separated authored/derived sections; restore accepts v1, v2, v3 and analyzer analysis.json (`{_app,_version:2,track_meta}`); M5 marketplace merge + count toast preserved; unit tests cover all.
- AC3a Stats nav link + view: collection value (no automatic bulk fetching; any fetch explicit, rate-limited, resumable), collectability (have/want) if available, genre/decade/country/format breakdowns, plain HTML/CSS bars, accessible. Unit tests for aggregation logic.
- AC3b Per-want max price (+ currency); 0->1+ for-sale alert respects it; also alert on lowest price dropping to <= max while for sale (no repeat spam); currency mismatch handled explicitly; survives want sync and backups (authored). Unit tests.
- AC3c Relative key shown beside every displayed Camelot key (8A<->8B). Unit test.
- Plan + README updated; code-reviewer run.

## Decisions & constraints
- File ownership per wave to avoid concurrent edits: platform-engineer owns package.json/lock, playwright config, tests/e2e/, workflow, eslint.config.js. frontend-engineer owns camelot.js, key-display views, new stats view, index.html, router.js, style.css. backend engineer owns backup.js, marketplace.js, wantlist*.js. docs/PROJECT_PLAN.md + README.md are edited only at the end.
- Backup format is hard to reverse (files live in the wild) -> system-architect consulted before task 2 implementation.
- desktop-analyzer READS the web app backup as input (crates/core/src/backup.rs: `collection.{releases,videos,tracklist}` + top-level `track_meta`, unknown fields ignored, version not checked). A v3 layout that moves those silently breaks the analyzer's input. Must be weighed.

## Findings by role
### system-architect (advisory, adopted)
- Q1 backup v3 = option (b): `track_meta` (top level) and `collection{releases,videos,folders,tracklist}` stay at v2 paths (analyzer-pinned); `authored{setlists, store{items,batches}, price_history, notifications, want_alerts, config}`; `derived{wants, marketplace_stats}`; `_contents` manifest labelling every section incl. the two pinned ones. Restore via pure `_normalizeBackup(raw)` that picks by path, not version. want_alerts applied after wants. Clean split deferred to a v4 after the analyzer reads both paths.
- Q2 notifications = authored. Token excluded by default via config export allowlist `['discogs_username']`. Restoring old token-bearing files: restore token only if no local token; toast says which.
- Q3 F9 = new store `want_alerts` (DB_VERSION 10) `{id: releaseId, max_price, currency, created_at, updated_at}`; removeWantData deletes it; restore drops orphans. Repeat guard `under_max` on marketplace_stats row; baseline_restored/no row -> set guard silently. Currency mismatch -> no price alert, show marker, fall back to plain 0->1+ alert. 0->1+ alert suppressed when lowest > max with same currency.
- Q4 F11 value = one explicit `GET /users/{u}/collection/value`, stored as config `collection_value` (strings verbatim, not exported). Collectability = `community_have/want/fetched_at` captured in existing `/releases/{id}` background fetch (api.js ~291-314), preserved in collection sync (api.js 233-240); explicit resumable cancellable backfill button sharing `_syncRunning`. Keep out of marketplace_stats.
### frontend-engineer — 3c relative key (done)
- camelot.js: camelotCode (codes + musical names incl. flats), camelotRelative, camelotRelativeHtml; chip shows "rel 8B" (title + sr-only text); wheel hub line. tracks.js badge, harmonic.js "Current" line (also escHtml'd ctx.key). style.css: .camelot-rel, .camelot-hub-rel, .sr-only. tests/camelot.test.js (8). npm run check: 45/45 pass. Not browser-checked (e2e will cover views).
### platform-engineer — task 1 e2e (done)
- @playwright/test pinned 1.62.1 (uses chromium build 1234 = local cache; 1.63+ want newer builds). playwright.config.js, tests/e2e/{server.js,fixtures.js,views.spec.js,setup.spec.js,toasts.spec.js,background-video.spec.js}; PW_CHROMIUM_PATH override; eslint.config.js e2e block; workflow e2e job (install --with-deps chromium, artifacts on failure); .gitignore report dirs.
- Nav click-through reads `.nav-link[data-nav]` so the new Stats view is covered automatically. One deliberate 2.5 s wait (proving the video is never requested).
- 12 passed; repeat-each=10 120/120; CI-mode 36/36. Lint was red only on in-progress src/views/stats.js:44 (no-control-regex) — owned by F11 engineer.
### frontend-engineer — F11 stats (done)
- src/views/stats.js (new), api.js applyReleaseCommunity + preservation in syncCollection, router `stats`, index.html nav + script, style.css STATS block, tests/stats.test.js (14). Value = explicit `/users/{u}/collection/value`, strings verbatim, config `collection_value`. Collectability from community have/want captured during release fetch + explicit resumable/cancellable backfill holding `_syncRunning`. Ratio list excludes <5 wants. Breakdowns genre/style/format/country (top10 + Other + Unknown), decade.
- check 85/85 (incl. backend's in-progress tests); browser-checked with seeded data. Stop only on Stats view; backfill continues if you navigate away.
### backend-engineer-web — backup v3 + F9 (done)
- db.js DB_VERSION 10 + `want_alerts`. backup.js: buildBackupPayload (v3 per Q1, token excluded), _normalizeBackup, _configToRestore, _mergeReleases, _restoreMessage, restoreBackup; legend text rewritten. marketplace.js _wantAlertDecision + under_max guard + type on notifications; removeWantData deletes want_alerts. wantlist.js alert panel (wlOpenAlertPanel/wlSaveAlert/wlClearAlert), card line, mismatch marker, _parseMaxPrice; default currency alert -> last stats currency -> USD. tests/backup.test.js (13), tests/want_alerts.test.js (13); data_safety test path updated.
- Beyond brief: 0->1+ already under max raises only under_max alert; setting a max doesn't reset guard; old-file token kept but username from file still upserted (open question — mismatch risk); analyzer restore says "(v2)".
- Not browser-verified: v9->v10 upgrade, alert panel look. No CSS added (suggestions given). Pre-existing: wantlist for-sale badge puts wStats.currency in title="" unescaped.
- Risk noted: restore replaces whole release/want records, wiping local-only fields (video_overrides, country) -> merge for releases.

## Open risks

## Verification log
- 2026-11-06 orchestrator: `npm run check` -> lint clean, 85/85 unit pass. `npm run test:e2e` -> 12/12 pass.

## Review round 1 (code-reviewer) -> Iteration 2
Verdict approve-with-fixes, no blockers. Acting on: M1 username follows token rule (never repoint an existing login); M2 escape wStats.currency/num_for_sale in wantlist badge (restored files make it user-controlled); m3 add crossfade_enabled/crossfade_seconds to export allowlist (authored prefs); m4 per-store key validation in normalize + tx.onabort; m5 _mergeReleases keep newer local community counts, merge video_overrides local-wins, refuse restore while _syncRunning; m6 marketplace poll skips while _syncRunning; m8 wlOpenAlertPanel .catch, Save toast note, backfill captures country.
Accepted, not changed: m7 notification-before-stats write ordering (pre-existing; at worst a duplicate alert after a failed write); price oscillating around max re-alerts on each downward crossing (intended guard semantics); e2e reuseExistingServer locally (nit).

### backend-engineer-web — round 1 fixes (done)
- All listed fixes in; 94/94 unit, 12/12 e2e. Restore checks but does not hold _syncRunning (a sync started mid-restore can still overlap) — accepted. Toast does not mention when the local username was kept.
### technical-writer — plan + README (done); orchestrator added username/crossfade lines afterwards.
- Noted stale README Crossfade text ("fade duration + 2") — out of scope, left.
- 2026-11-06 orchestrator after fixes: `npm run check` 94/94 pass, lint clean; `npm run test:e2e` 12/12 pass.
- Re-review of fixes: clean (one optional minor: restore checks _syncRunning once, not held — accepted).
