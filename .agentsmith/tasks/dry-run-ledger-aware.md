# Dry run accounts for the resume ledger
Status: done      Path: standard
Iteration: 1 of 3

## Request
Make `discogs-analyzer backup.json --plan` and the UI "Dry run" report only the work a real
run would do (ledger-aware), with breakdown + resume status. No commit/push. No `src/` or `.claude/`.

## Acceptance criteria
- Dry run uses same ledger path, settings hash, max_attempts as a real run (shared helpers).
- Read-only: never writes ledger/output/work dir, never needs yt-dlp.
- Headline = ledger.outstanding(plan, max_attempts).len(); breakdown done / exhausted / skip / review; limit noted.
- Resume status line: resumed / fresh (+ hint if backup has analysis-sourced meta) / discarded (settings, unreadable, old version) as warning.
- UI JSON + page.html updated; paths via textContent.
- Tests first; README updated; real-data check: 201 / 2891 / 116 / 0 / 416, resumed; default output -> no-resume warning; ledger mtime unchanged.

## Decisions & constraints
- Keep plan.rs re-analysing tool-sourced records as Analyze; ledger prevents re-work.
- Second-opinion label goes through one shared fn (`second_opinion_label`) for CLI and UI.
- `dry_run(&Options, out)` replaces `plan_only`; CLI builds Options before the --plan branch.

## Findings by role
- Implementation (orchestrator, inline): `dry_run(&Options)` + `settings_hash_for` + `second_opinion_label` + private `load_ledger` in cli/lib.rs; execute uses load_ledger. main.rs `options_from_args` before --plan. UI plan uses options_from + plan_json. page.html planline built from DOM nodes, resume line via textContent. README updated.

- code-reviewer: approve with nits, no blockers. Applied: warning styling driven by analysed_in_backup (fresh+earlier analysis -> banner err), absolute display path (std::path::absolute, display only), resume message "N track(s) done in it", DryRun::completed() accessor, max_attempts u32::try_from, doc on `done` scope. Deferred: unreadable-for-permissions ledger treated as FreshStart (pre-existing, separate ticket).

## Open risks
- Pre-existing: FileLedgerStore::load maps any read error (e.g. EACCES) to None -> FreshStart; a run would overwrite. Out of scope.
- README mentions `--tempo-min`, which Args no longer has (pre-existing doc drift, not touched).

## Verification log
- cargo test --workspace: all green (end_to_end 17 passed, incl. 9 new dry-run tests).
- cargo clippy --workspace --all-targets: no warnings. cargo build --release: ok. node --check on page script: ok.
- Re-verified after review fixes: tests/clippy/build/JS all green; real data unchanged counts.
- Real data -o analysis_fast.json: 201 / 2891 / 116 / 0 / 416, resumed. Default output: no-resume warning + hint (2891 analysed). Ledger size/mtime/sha256 unchanged.
