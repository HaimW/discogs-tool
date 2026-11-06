# Priority tests (harmonic, store_serial) + P6 loading/empty/error states
Status: done             Path: complex (cross-cutting: router used by every view, IndexedDB open failure, new e2e)
Iteration: 2 of 3

## Request
TASK 1: node:vm unit tests for src/harmonic.js and src/store_serial.js (plan §5a). Real bugs found -> separate fix + failing-then-passing test + new §1 bug entry.
TASK 2: P6 — delayed, accessible loading state for every view in renderCurrentView; consistent empty states with a next step; shared router error wrapper with Retry + console logging; IndexedDB open failure message. Unit + e2e tests.

## Acceptance criteria
- `npm run check` (lint + unit) green; `npm run test:e2e` green.
- harmonic: compatibleKeys (wheel neighbours, 12<->1 wrap, relative maj/min), bpmDelta (half/double; 0/missing = missing, by design per L3), scoreCandidate, ranking.
- store_serial: generation (prefix, next number, gaps, case), isSerialTaken (case/whitespace, excludeId), country parsing ("/" and ","), every other export.
- Loading state: only after a delay (no flash), aria-busy + role=status, prefers-reduced-motion respected, same look in every view.
- Empty states: each says what is happening and offers the next step, existing .empty-state style.
- Errors: one shared router wrapper; failure -> message + Retry + console.error; DB open failure -> helpful message; nothing swallowed.
- e2e: fresh-install empty states, slow-view loading state, error screen + Retry.

## Decisions & constraints
- No commits/branches. Keep the uncommitted docs/PROJECT_PLAN.md change.
- No ES modules, no backend, no runtime deps. act() for handlers, showToast, dateMs, escHtml; new scripts added to index.html in load order.
- Task 1 agent owns PROJECT_PLAN §1 + §5a edits; Task 2 agent owns README and returns P6 text; orchestrator merges P6 text and final P3 counts.
- e2e fixtures fail on console.error: the error-boundary e2e must account for the intentional console.error.

## Findings by role

## Open risks

## Verification log

### frontend-engineer (Task 1) — done
- tests/harmonic.test.js (24), tests/store_serial.test.js (24). Unit total 158.
- Bugs fixed in src/harmonic.js: L7 (Play next drops releaseId -> track suggests itself; queue entries w/o release id not excluded), L8 (tempo bonus non-monotonic 6-9.3%; now 40 - (d-6)*4/3). Failing-then-passing evidence in scratchpad/harmonic_before.tap.
- PROJECT_PLAN §1 L7/L8 + triage rows, §5a note added.
- Open questions (current behaviour tested, not changed): "&" joint countries -> XX; candidate keys not normalised in scoreCandidate; isSerialTaken strict excludeId.
- Cross-task: tests/want_alerts.test.js fails (startViewRender undefined) until Task 2 loads src/view_state.js in that VM — passed to Task 2 owner to resolve.

### frontend-engineer (Task 2) — done
- New src/view_state.js (runViewRender: 250ms delayed loading, aria-busy + #view-status role=status, reduced motion, error screen + Try again, render tokens). router uses it; db.js dbOpenError + shared open request + blocked handling; empty states audited/fixed; init/crossfade catch startup rejections.
- Tests: tests/view_state.test.js (16), tests/e2e/states.spec.js (6). Reported: check 174/174, e2e 21/21.
- Not done: direct re-renders (filter clicks, sync refreshes) race-guarded but not wrapped in error screen; volume.js empty .catch (pre-existing); no e2e for blocked upgrade.
- Orchestrator applied P6 note, P3 counts (174 in 14 files, 21 e2e), "where things stand" to PROJECT_PLAN.

### code-reviewer — approve with nits; check 174/174, e2e 21/21
- Should fix 1: direct re-render superseding a router render clears the loading block -> blank #app; if it rejects, no error screen. ACCEPTED -> fix.
- Should fix 2: background poll renders (marketplace, wantlist_sync, stats, api) can draw over a view left after the router took its token. ACCEPTED (cheap: views also bail when _currentView no longer matches).
- Nit 3 blocked toast not dismissed on failure; nit 4 onclose should only null its own connection. ACCEPTED.
- Nit 6 8-pt cliff at 12% tempo: pre-existing shape (ended at 32 before too) — not changed; noted as a question.
- Nit 10 waitForTimeout(1200) in e2e: accept if cheap to replace.
Iteration: 2 of 3 — sent back to frontend-engineer.

### frontend-engineer (iteration 2) — review fixes 1-5 done
- endViewRender(tok, promise) shared by all 9 async views; renders record owner run/view; router clears loading/shows error only if it owns the screen; viewRenderIsCurrent also checks currentRouteView(); db blocked toast dismissed on failure; onclose/onversionchange per-connection; e2e condition wait.
- +9 unit tests (view_state 25); fail-before evidence in scratchpad view_state_before.txt / db_before.txt. want_alerts test stub adjusted (assertions unchanged).
- Not re-reviewed by code-reviewer after iteration 2.

## Verification log
- 2026-11-06 orchestrator: `npm run check` -> lint clean, 183/183 unit. `npm run test:e2e` -> 21/21.
