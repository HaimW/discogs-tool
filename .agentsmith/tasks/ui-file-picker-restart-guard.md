# Analyzer UI: pick files (data folder) + warn before a full restart
Status: done      Path: complex
Iteration: 2 of 3

## Request
Two usability changes to `discogs-analyzer --ui` (Rust workspace `desktop-analyzer/`), building on the
uncommitted ledger-aware dry run. (1) Upload backup / import ledger via file pickers; analyzer keeps
backup, ledger and result in its own data folder; "Download result". (2) Refuse a run that would redo
work unless confirmed (UI dialog + server-enforced `confirm_restart`; CLI `--fresh`).
No commit/push. Do not touch `src/`, `.claude/`, `docs/PROJECT_PLAN.md`.

HARD SAFETY: a real run is live on port 8733 writing /mnt/c/Users/yafim/Downloads/analysis_fast*.json.
Never signal that process, never touch port 8733, never write/move/lock anything in
/mnt/c/Users/yafim/Downloads. Real-data checks use COPIES in
/tmp/claude-1000/-home-yafim-projects-discogs-tool/1c9a793d-06bd-4578-a8ab-98f5877d0530/scratchpad/
with DISCOGS_ANALYZER_DATA + `--ui-port 0 --no-open`.

## Acceptance criteria
(see the request in the caller's brief; summarised)
- Data dir: $DISCOGS_ANALYZER_DATA, else Linux $XDG_DATA_HOME/discogs-analyzer | ~/.local/share/discogs-analyzer,
  macOS ~/Library/Application Support/discogs-analyzer, Windows %APPDATA%\discogs-analyzer. Fixed names
  backup.json, analysis.json, analysis.ledger.json. No new crate deps. Created only when writing.
- Upload backup: <=64 MB, larger rejected with a clear error without unbounded buffering; validated with
  Backup::parse before storing; reply gives video count.
- Plan/run/oracle use data-dir backup + paths. Ledger-aware dry run output unchanged on top.
- GET result download with Content-Disposition attachment; 404 when none.
- Import ledger: Ledger::parse validation; report done count + settings match; atomic install; refuse
  replacing a ledger with completed entries unless confirmed (both counts); refuse during a run.
- Restart guard: condition = not Resumed AND (analysed_in_backup > 0 OR discarded ledger had completed > 0).
  /api/run refuses with code restart_needs_confirmation unless confirm_restart:true. CLI refuses unless --fresh,
  writes nothing. Same load_ledger/hash path, no duplicated logic.
- Origin check on every new endpoint. TDD. Existing tests stay green. clippy clean. README updated.

## Decisions & constraints  (contract — do not re-litigate)
D1. New module `crates/cli/src/datadir.rs`: pure `resolve(env: &dyn Fn(&str)->Option<OsString>) -> Option<PathBuf>`
    (cfg!-based OS branches; tests inject env) + `pub fn data_dir() -> Result<PathBuf,String>` using std::env::var_os.
    Constants BACKUP_FILE="backup.json", RESULT_FILE="analysis.json", LEDGER_FILE="analysis.ledger.json"
    (= default_ledger_for(analysis.json)).
D2. `UiState` carries `data_dir: PathBuf` (constructor `UiState::new(data_dir)`); `serve()` resolves it once at
    startup and prints it. Tests inject a temp dir — no process-global env mutation in tests (parallel tests).
D3. Uploading a backup PERSISTS it to <data>/backup.json (atomic write, creates folder). That is the only write
    outside a run/import. Dry run otherwise stays read-only (never creates ledger/result/work dir).
    Upload and import are refused while a run is going (checked under the same lock start_run claims with).
D4. HTTP: per-path body limit. JSON endpoints keep 64 KB. Upload endpoints (`POST /api/backup`,
    `POST /api/ledger`) allow 64 MiB. Content-Length above the limit -> 413 + JSON error, body not read.
    Missing Content-Length on an upload -> 411. Never `min()`-truncate silently. Page also pre-checks file.size.
D5. Endpoints (all through the existing origin+host check):
    - `GET /api/files` -> {data_dir, backup: null|{videos, bytes}, result: bool, ledger: null|{completed}}
      (backup video count cached in UiState after upload; computed lazily once otherwise).
    - `POST /api/backup` raw body = backup file bytes -> {ok:true, videos} | {error, code:"invalid_backup"|"running"|"too_large"}
    - `POST /api/ledger?second_opinion=always|unsure|never[&replace=1]` raw body = ledger bytes ->
      {ok:true, completed, settings_match:bool, matching_setting:"always"|"unsure"|"never"|null}
      | {error, code:"invalid_ledger"} | {error, code:"running"}
      | {error, code:"ledger_exists", existing_completed, incoming_completed, settings_match, matching_setting}.
      Installs even on hash mismatch (reports it; matching_setting tells the page which Cross-check value resumes it).
      Install = runtime::write_file_atomically to <data>/analysis.ledger.json.
    - `GET /api/result` -> 200, Content-Type application/json, `Content-Disposition: attachment; filename="analysis.json"`;
      404 {error, code:"no_result"} when absent.
    - `POST /api/plan` / `POST /api/run`: body no longer carries backup/output/ledger; server uses data dir.
      No backup uploaded -> {error, code:"no_backup"}. Plan JSON gains `restart: {needed, status, analyze,
      analysed_in_backup, discarded_completed, message}`.
    - `/api/run` refusal: HTTP 409 {error, code:"restart_needs_confirmation", restart:{...same...}} unless
      body.confirm_restart === true. Check happens AFTER claiming `running` (so an import cannot slip in between),
      released on refusal.
    - `POST /api/oracle/run`: ignores body.backup, uses <data>/backup.json; "choose a backup file first" if absent.
D6. Restart condition lives in lib.rs: `load_ledger` also yields the discarded ledger's completed count
    (Ledger::parse of the raw file when outcome is Discarded*, 0 if unparseable); DryRun gains
    `discarded_completed` and `pub fn restart_redoes_work(&self) -> bool` + `restart_message()`. CLI and UI both call
    `dry_run` then this — no second implementation.
D7. CLI: `--fresh` flag. Real run (not --plan) evaluates the guard BEFORE yt-dlp resolution and before execute;
    refusal = error exit, nothing written. Integration test via `env!("CARGO_BIN_EXE_discogs-analyzer")`.
D8. Work dir stays configurable in Advanced (temp default); yt-dlp/cookies/timeout unchanged.
D9. Page (frontend-engineer, page.html only): file input for backup, "Loaded <name>: N videos"; Advanced shows data
    folder via textContent + "Import earlier progress" picker; no-resume warning also offers Import; Download result
    button enabled from /api/files.result or after a finished run; Start posts /api/run, on code
    restart_needs_confirmation opens a native <dialog> (showModal, labelled, initial focus on Cancel, Esc = cancel)
    with [Import earlier progress] [Start from scratch] [Cancel]; text via textContent, reason distinguishes
    fresh ("no resume file") vs discarded_settings ("resume file would be discarded because the cross-check
    setting changed") vs other discarded. Ledger replace confirmation shows both counts.
D11. (Scope addition from user) Keep-audio in UI: default OFF (page checkbox unchecked, server body default false).
    When keep_audio is on, the UI run's work_dir = <data>/audio (Advanced scratch-space override applies only when
    keep_audio is off). CLI --keep-audio/--work-dir unchanged. Endpoints: `GET /api/audio` -> {path, files, bytes}
    (0/0 when absent; read-only, never creates it); `POST /api/audio/delete` -> {ok, deleted_files, freed_bytes} |
    {error, code:"running"}. Delete walks <data>/audio with symlink_metadata, never follows symlinks (removes the link
    itself), refuses if <data>/audio is itself a symlink, keeps the audio/ dir, done under the inner lock vs running.
    Page: plain-language hint next to the checkbox, "Saved audio: N files, X MB" (textContent), "Delete saved audio"
    with confirm dialog; refresh after runs/deletes.
D10. No separate security-architect pass: loopback server, existing origin model unchanged; upload-size/DoS and
    path concerns are folded into the code-reviewer brief.

## Findings by role
- frontend-engineer (done): page.html only. backupFile upload (Blob body, 64 MiB pre-check), runPlan(), resume-warning
  Import button, Advanced dataDir + importBtn/ledgerFile, downloadBtn <a download> aria-disabled, restartDialog +
  replaceDialog (showModal, Cancel focus, Esc, focus return; confirm() fallback). Depends on /api/files{data_dir,
  backup{videos},result}, /api/ledger replies per D5, 409 restart{status,analyze,analysed_in_backup,discarded_completed}.
  node --check OK. Note: with a limit set, "all N tracks" can overstate (uses analyze). Server must send a 413 body
  (not drop) for the specific message.
- backend-engineer-web (done): datadir.rs; LoadedLedger{discarded_completed}; DryRun.restart_redoes_work/restart_message;
  --fresh guard before yt-dlp; UiState::new(data_dir) + with_launcher seam, run_with stubs; http per-path limits
  (413 before read, 411, 400), incremental body read, 30 s read timeout, Expect: 100-continue, Response w/ headers;
  serve_on test seam; ui/tests.rs (real HTTP) + test_support.rs. Deviations: non-409/404/413/411/400 errors stay HTTP
  200 {error,code}; extra codes length_required/bad_request/write_failed; import rejects non-current ledger version;
  files().ledger.readable. Tests: cli 58 lib + 3 bin + 24 e2e, core 99, all green; clippy 0; release OK.
  Risks: browser may see reset on oversized (page pre-check is the guard); lock held during 64 MiB fsync.

- frontend-engineer keep-audio (done): #keepAudioHint, #audioStats, #audioDelete, #audioStatus, #audioDialog
  (openDialog helper, confirm fallback). Uses GET /api/audio {path,files,bytes}, POST /api/audio/delete. node --check OK.

- code-reviewer (iteration 1): approve with fixes, no blocker. Should-fix: (1) web app Analyzer tab
  (src/views/analyzer.js) posts typed paths -> now gets no_backup and cannot send confirm_restart; (2) unbounded
  request-line/header reads in http.rs; (3) start_run leaks running=true on panic (needs RAII claim). Nits: drain body
  after early 403/411/413; lock held during fsync (accepted); chunked POST treated as empty body; guard fires when
  outstanding==0; page warning vs server guard mismatch for discarded empty ledger (harmless); test gaps.
  Decisions: (1) src/ is out of scope -> document in README + escalate in report, no legacy path mode (would reopen
  typed paths the request removed). Fix 2, 3, chunked, drain, outstanding==0, plus stale UI resume hint. Accept lock
  during fsync and the page warning nit.

- backend-engineer-web (iteration 2, done): 16 KiB line / 64 header caps -> 431; Transfer-Encoding -> 411; bounded
  drain (128 KiB / 1 s) after early replies; RunClaim RAII; restart guard requires outstanding>0; Frontend::{Cli,Ui}
  resume_message_for (UI points at Import earlier progress); README note on web app tab. cli lib 79, e2e 26.

## Open risks
- Web app Analyzer tab (src/views/analyzer.js) broken against this server (no_backup; cannot confirm restart).
  Out of scope; README note added; needs a src/ follow-up (upload + result download + confirm_restart).
- Lock held during 64 MiB upload fsync (polls stall briefly) - accepted.
- Page shows red warning + Import for a discarded ledger with 0 finished and no analysed backup tracks, where the
  server does not demand confirmation - harmless, accepted.
- No browser-level test of dialogs/focus/Blob upload (page verified by node --check + server-level curl only).

## Verification log
- Orchestrator: cargo test --workspace all ok (cli lib 72, bin 3, e2e 24, core 99, others); clippy 0 warnings;
  release build ok; node --check page script OK.
- Real-data (copies, DISCOGS_ANALYZER_DATA=scratch/real/data, port 0): files empty -> result 404 -> plan no_backup ->
  invalid upload rejected -> backup upload {ok, videos:3624} -> foreign Origin 403 -> plan 3208/0/0/0/416 fresh,
  analysed_in_backup 2891, restart.needed -> run 409 restart_needs_confirmation -> import ledger (posted never)
  ok completed 3077 settings_match false matching_setting always -> reimport ledger_exists 3077/3077 -> invalid ledger
  rejected -> plan(always) resumed 3 to analyse / 3077 done / 128 exhausted / 416 review, restart.needed false ->
  plan(never) discarded_settings, discarded_completed 3077 -> 65 MiB upload 413 too_large -> audio 0/0, delete ok 0.
  Installed ledger sha256 == copy. CLI on copy without --fresh: exit 1, refusal message, cli/ dir empty.
- Observation: fresh resume_message still advises "use the same output name (or resume file)" — stale for the UI
  (should point to Import earlier progress). Queued for the fix round.
- Iteration 2 re-verify: tests all ok (cli lib 79, bin 3, e2e 26, core 99), clippy 0, release ok, node --check OK.
  Real data (copies, data2): upload 3624 videos; plan 3208 fresh restart.needed, UI message points to Import;
  run 409; import 3077 settings_match; plan 3 / 3077 resumed, restart.needed false. Scratch servers stopped (own PIDs).
