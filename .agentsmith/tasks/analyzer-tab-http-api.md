# Analyzer tab: talk to the desktop analyzer's upload-based HTTP API
Status: done      Path: standard (one view + shared backup helpers; no auth/PII change)
Iteration: 1 of 3

## Request
Rework src/views/analyzer.js (+CSS) for the analyzer's new API: upload the in-browser
backup export, dry run counts/resume line, 409 restart confirmation, ledger import,
polling, load result through Restore's code path, download result, keep-audio/saved audio.
No commits. Do not touch docs/PROJECT_PLAN.md, .claude/, desktop-analyzer/.

## Acceptance criteria
- Send collection (exportFullBackup's payload, not a copy of the format) to POST /api/backup; "Sent: N videos".
- Dry run renders the analyzer page's counts + resume line (textContent; warnings styled).
- Start: 409 restart_needs_confirmation -> dialog (Import earlier progress / Start from scratch / Cancel); confirm resends confirm_restart:true; Cancel sends nothing.
- Ledger import with replace confirm and second-opinion switch.
- Result: Load results (confirm, restore path, toast count) + Download result.
- Keep audio + saved audio size + delete (endpoints are behind the same origin check, so reachable).
- act() delegation only; stale async never draws over a left view.
- Unit + e2e tests (failing first); lint/test/test:e2e green; code-reviewer run.

## Decisions & constraints
- Server endpoints all pass the same Origin check and get CORS echo, so audio endpoints are usable cross-origin.
- Download link is a plain navigation (no Origin header) -> permitted by origin.rs.
- backup.js: extract buildFullBackup() and restoreParsedBackup() so export/restore rules are shared.
- Restart dialog: native <dialog> (three choices); simple yes/no confirms use window.confirm like the rest of the app.
- Tests override ANALYZER_URL global to point at a fake Node server on a random port.

## Findings by role
- code-reviewer: no blockers. Should-fix: (1) callbacks drew into controls removed by the Not-connected card -> added analyzerUiLive (requires #an-run) for all connected-phase callbacks; (2) e2e gaps -> added tests for Esc cancel, keep_audio true, ledger replace confirm + replace=1, audio size/delete; (3) double submit on Send/Start -> in-flight guards + disabled buttons. Nits fixed: reset last-result on a new run, Download link target=_blank, poll tolerates 2 failures before 'Not connected', NaN-safe stats, comment on no renderCurrentView, importBackupFile catch. Not changed: dialog title constant across statuses (matches analyzer page).

## Open risks

## Implementation
- Implementation (orchestrator, inline): src/views/analyzer.js rewritten; src/backup.js gains buildFullBackup()/restoreParsedBackup() (exportFullBackup/importBackupFile now use them); style.css analyzer additions; README one bullet; tests/analyzer.test.js, 2 tests in tests/backup.test.js, tests/e2e/analyzer.spec.js (real fake server, route.continue so real CORS applies).

## Verification log
- Red first: npm test -> 11 new tests failing (functions missing); e2e analyzer spec 4/4 failing.
- Green: npm run lint clean; npm test 225 pass; npx playwright test 47 passed.
- After review: lint clean; npm test 225 pass; npx playwright test 50 passed.
