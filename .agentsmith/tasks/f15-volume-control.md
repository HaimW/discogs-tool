# F15 — Volume control (slider + mute, crossfade-aware, persisted)
Status: done      Path: standard (one feature in one area — now-playing bar + crossfade engine; no auth/PII/schema)
Iteration: 2 of 3

## Request
Volume slider + mute toggle in the now-playing bar, remembered between visits (IndexedDB config). Crossfade engine must
respect it: fades go 0 <-> master volume, resets restore master (0 when muted), slider/mute mid-fade rescales both players
at the current fade ratio. New players/videos start at master volume (apply in onReady too). Accessible. Persist + backup
allowlist. Unit tests (node:vm) + e2e with fake window.YT. Update PROJECT_PLAN F15 + README YouTube Playback/Crossfade
(fix stale "fade duration + 2" sentence). Hard rules: no commits/branches, keep existing uncommitted work, no new runtime deps.

## Acceptance criteria (orchestrator, from a well-specified request — PM skipped)
- AC1 One master volume (int 0–100) + muted flag; every player.setVolume / player2.setVolume call in src/ goes through one helper.
- AC2 Crossfade: player1 fades master->0, player2 0->master; changing volume or muting mid-fade rescales both at current ratio (no jump); _abortCrossfade and the 'switching' hand-over restore master (0 when muted); loadFromQueue uses master.
- AC3 Player creation (onReady for both players) and new videos apply master volume.
- AC4 UI: mute button (aria-pressed, aria-label switches Mute/Unmute) + native range input with label, keyboard-operable; narrow layout OK; #np-time intact.
- AC5 Persist config keys, restore on load; added to backup EXPORT_CONFIG_KEYS; restore validates values.
- AC6 Unit tests for volume maths; e2e spec with fake YT: slider -> player volume, mute, reload persistence, crossfade hand-over keeps volume.
- AC7 PROJECT_PLAN F15 dated status note; README sections updated + stale sentence fixed.
- AC8 `npm run check` and `npm run test:e2e` green; code-reviewer run on the diff.

## Decisions & constraints
- Default volume 100, unmuted (= today's behaviour). To confirm with the person.
- Config keys: `player_volume` (int 0–100), `player_muted` (bool).
- New file src/volume.js (script tag after player.js, before crossfade.js); helpers used by crossfade.js/player.js.
- No keyboard shortcuts added (none exist today; range input is keyboard-operable when focused). Offer as follow-up.
- Volume set via setVolume only (not YT mute()/unMute()), plus unMute() on ready to clear any stale YT mute state — engineer to confirm.
- File ownership: frontend-engineer owns src/, index.html, style.css, tests/; technical-writer owns README.md + docs/PROJECT_PLAN.md.

## Findings by role

## Open risks
- Player 1 shows YouTube's own controls (controls:1); a user changing volume inside the iframe bypasses the master volume until the next track/apply.

## Verification log
### technical-writer (done, written ahead of code — re-check vs final implementation)
- PROJECT_PLAN F15 -> [x] with "Done 2026-11-06" note (F9/F11 style). README: §5 controls + Volume list + YT-frame limitation; §6 fade wording fixed (time left == fade length, <= 1/3 track, <3 s no fade) + volume-aware fades; §13 backup config list; project structure adds volume.js.
### frontend-engineer (done)
- New src/volume.js (masterVolume/masterMuted/_cfFadeRatio, _setPlayerVolume sole setVolume caller, _applyVolumeNow, _initPlayerVolume unMute-on-ready). crossfade.js/player.js rewired. UI #np-mute + labelled #np-volume range; slider while muted unmutes; save on change/mute. backup allowlist + restore validation (_configToRestore, hasOwnProperty-safe). Narrow layout: fixed pre-existing overflow at <=768px; wraps at <=600px; slider hidden <=480px (mute stays); mobile queue/suggest panels use --player-height.
- YT finding: new player starts at YT-remembered volume/mute; setVolume doesn't unmute -> unMute() once on ready, apply on ready/new track/PLAYING.
- Notes: restored volume applies on next load (like crossfade); player-container is off-screen so YT-frame volume caveat is mostly moot.
### code-reviewer (advisory): approve with nits, no must-fix
- SF1 toggleMute before settings load sets _volumeTouched -> stored volume skipped and overwritten with default 100 on save. -> FIX (split flags).
- SF2 redundant onVolumeInput in change handler -> optional cleanup, accepted.
- SF3 add assertion in tests/player_progress.test.js that player1 volume == master after real hand-over -> FIX.
- Nits: header comment "unMute once on ready" loose -> fix wording; others accepted (Chromium-only PageDown step, PLAYING re-apply harmless, .sr-only location).
- Docs: YT-frame caveat wrong (player hidden off-screen, controls 0) -> remove/replace in README + PLAN; add slider hidden <=480px, slider unmutes, backup-restore applies on next load, invalid values skipped on restore.
## Verification log
- iter1: npm run check 108/108; npm run test:e2e 15/15 (orchestrator re-run)
- iter2 fixes: SF1 split flags (_volumeTouched/_mutedTouched) + save deferred while loading (_volumeLoading/_volumeSavePending, cleared on failure too) + unit test; SF2 change handler saves (fallback apply if value differs); SF3 real onPlayerStateChange hand-over test (60 / muted 0); header comment fixed. Docs: YT-frame caveat removed, iOS note, slider hidden <=480px, slider unmutes, restore applies next load, invalid values skipped, narrow-screen notes in PLAN.
- iter2: npm run check 110/110 lint clean; npm run test:e2e 15/15 (orchestrator re-run). Iter-2 delta read by orchestrator against the review findings (not re-sent to code-reviewer: small, targeted).
