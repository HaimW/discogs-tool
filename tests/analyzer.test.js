// The Analyzer tab's pure helpers (src/views/analyzer.js): how it reads the
// desktop analyzer's replies. Wording mirrors the analyzer's own page
// (desktop-analyzer/crates/cli/src/ui/page.html).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function load() {
    const ctx = { console, JSON, Math, Object, Promise, setTimeout, clearTimeout };
    vm.createContext(ctx);
    for (const f of ['src/utils.js', 'src/views/analyzer.js']) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
    }
    return ctx;
}

const plain = v => JSON.parse(JSON.stringify(v));

const PLAN = { analyze: 12, will_run: 12, done: 3, exhausted: 0, skip: 4, review: 1 };

test('plan line: the analyzer page counts, in its order', () => {
    const a = load();
    assert.equal(a.analyzerPlanText(PLAN),
        '12 to analyse · 3 already analysed · 0 failed too often · 4 already yours · 1 held for review');
    const parts = plain(a.analyzerPlanParts(PLAN));
    assert.deepEqual(parts[0], { count: 12, text: ' to analyse · ' });
    assert.deepEqual(parts[parts.length - 1], { count: 1, text: ' held for review' });
});

test('plan line: a limit and exhausted tracks are explained', () => {
    const a = load();
    const text = a.analyzerPlanText({ ...PLAN, will_run: 5, exhausted: 2 });
    assert.match(text, /^12 to analyse · \(this run stops after 5\) · 3 already analysed · /);
    assert.match(text, /2 failed too often \(raise Retries per track on the analyzer’s own page to retry\) · /);
});

test('resume line: resumed is a hint, a first run a note, anything else a warning with import offered', () => {
    const a = load();
    const resumed = plain(a.analyzerResumeView({ resume: { status: 'resumed', message: 'Resuming 40.' }, analysed_in_backup: 40 }));
    assert.deepEqual(resumed, { text: 'Resuming 40.', kind: 'hint', offerImport: false });

    const first = plain(a.analyzerResumeView({ resume: { status: 'fresh', message: 'First run.' }, analysed_in_backup: 0 }));
    assert.deepEqual(first, { text: 'First run.', kind: 'ok', offerImport: false });

    const lost = plain(a.analyzerResumeView({ resume: { status: 'fresh', message: 'No resume file.' }, analysed_in_backup: 7 }));
    assert.deepEqual(lost, { text: 'No resume file.', kind: 'warn', offerImport: true });

    const discarded = plain(a.analyzerResumeView({ resume: { status: 'discarded_settings', message: 'Different setting.' }, analysed_in_backup: 0 }));
    assert.equal(discarded.kind, 'warn');
    assert.equal(discarded.offerImport, true);

    assert.deepEqual(plain(a.analyzerResumeView({})), { text: '', kind: 'hint', offerImport: false });
});

test('run reply: 409 restart_needs_confirmation asks; other refusals are errors; ok starts', () => {
    const a = load();
    const restart = { status: 'fresh', analyze: 9, analysed_in_backup: 4 };
    assert.deepEqual(plain(a.analyzerRunOutcome(409, { error: 'x', code: 'restart_needs_confirmation', restart })),
        { action: 'confirm', restart });
    // The code decides, not the status alone: a 409 without it is an error.
    assert.deepEqual(plain(a.analyzerRunOutcome(409, { error: 'odd' })), { action: 'error', message: 'odd' });
    assert.deepEqual(plain(a.analyzerRunOutcome(200, { error: 'a run is already going', code: 'running' })),
        { action: 'error', message: 'a run is already going' });
    assert.equal(a.analyzerRunOutcome(200, { error: 'Choose a backup file first.', code: 'no_backup' }).message,
        'Send your collection to the analyzer first.');
    assert.deepEqual(plain(a.analyzerRunOutcome(200, { ok: true })), { action: 'started' });
    assert.equal(a.analyzerRunOutcome(500, null).action, 'error');
});

test('restart dialog text: counts and the reason for each status', () => {
    const a = load();
    const fresh = plain(a.analyzerRestartText({ status: 'fresh', analyze: 9, analysed_in_backup: 4 }));
    assert.equal(fresh.text, 'This will analyse all 9 tracks from scratch, including 4 that are already analysed.');
    assert.match(fresh.reason, /^No resume file was found/);
    const settings = plain(a.analyzerRestartText({ status: 'discarded_settings', analyze: 9, discarded_completed: 6 }));
    assert.equal(settings.text, 'This will analyse all 9 tracks from scratch.');
    assert.match(settings.reason, /\(6 finished tracks\) would be discarded because it was written with a different Cross-check/);
    const old = plain(a.analyzerRestartText({ status: 'discarded_unreadable', analyze: 1 }));
    assert.match(old.reason, /unreadable or from an older version/);
    assert.equal(plain(a.analyzerRestartText(null)).text, 'This will analyse all 0 tracks from scratch.');
});

test('ledger reply: replace needs confirming; a settings mismatch names the setting to switch to', () => {
    const a = load();
    const labels = { always: 'Always (recommended)', unsure: 'Only when unsure', never: 'Never' };
    const exists = plain(a.analyzerLedgerOutcome({ code: 'ledger_exists', existing_completed: 10, incoming_completed: 3 }, labels));
    assert.equal(exists.action, 'confirm_replace');
    assert.equal(exists.text, 'The analyzer already has a resume file with 10 finished tracks. Replace it with this one (3 finished)?');

    assert.deepEqual(plain(a.analyzerLedgerOutcome({ ok: true, completed: 5, settings_match: true }, labels)),
        { action: 'done', message: 'Imported resume file: 5 finished tracks.', switchTo: null });

    const switched = plain(a.analyzerLedgerOutcome({ ok: true, completed: 5, settings_match: false, matching_setting: 'never' }, labels));
    assert.equal(switched.switchTo, 'never');
    assert.equal(switched.message, 'Imported resume file: 5 finished tracks. It was written with a different ' +
        'Cross-check setting, so I switched "Cross-check tempo" to "Never" so the run resumes from it.');

    const unknown = plain(a.analyzerLedgerOutcome({ ok: true, completed: 5, settings_match: false, matching_setting: null }, labels));
    assert.equal(unknown.switchTo, null);
    assert.match(unknown.message, /with the current settings a run would not resume from it\.$/);

    assert.deepEqual(plain(a.analyzerLedgerOutcome({ error: 'not a resume file', code: 'invalid_ledger' }, labels)),
        { action: 'error', message: 'not a resume file' });
});

test('upload reply: JSON when sent, a readable error otherwise', () => {
    const a = load();
    assert.deepEqual(plain(a.analyzerReadReply(200, '{"ok":true,"videos":3}')), { ok: true, videos: 3 });
    assert.equal(a.analyzerReadReply(413, '').error, 'That file is too large (the limit is 64 MB).');
    assert.equal(a.analyzerReadReply(403, 'nope').error, 'The analyzer refused the file (HTTP 403).');
    assert.equal(a.analyzerReadReply(200, '{}').error, 'Unexpected reply from the analyzer.');
    // The server's own message wins over the generic one.
    assert.equal(a.analyzerReadReply(413, '{"error":"too big","code":"too_large"}').error, 'too big');
});

test('saved audio text and sizes', () => {
    const a = load();
    assert.equal(a.analyzerSizeText(0), '0.0 MB');
    assert.equal(a.analyzerSizeText(5 * 1024 * 1024), '5.0 MB');
    assert.equal(a.analyzerSizeText(3 * 1024 * 1024 * 1024), '3.0 GB');
    assert.equal(a.analyzerAudioText({ files: 0, bytes: 0 }), 'No saved audio.');
    assert.equal(a.analyzerAudioText({ files: 1, bytes: 1024 * 1024 }), 'Saved audio: 1 file, 1.0 MB');
    assert.equal(a.analyzerAudioText({ files: 2, bytes: 2 * 1024 * 1024 }), 'Saved audio: 2 files, 2.0 MB');
});

test('a run result is flagged as bad by the same words as the analyzer page', () => {
    const a = load();
    assert.equal(a.analyzerResultIsBad('Run failed: yt-dlp not found'), true);
    assert.equal(a.analyzerResultIsBad('yt-dlp could not run'), true);
    assert.equal(a.analyzerResultIsBad('Done: 12 analysed.'), false);
});
