// The Analyzer tab against a fake desktop analyzer: a real HTTP server on a
// local port that speaks the analyzer's upload-based API (see
// desktop-analyzer/crates/cli/src/ui/http.rs and state.rs) with the same
// origin check and CORS echo, so the browser's cross-origin rules apply for
// real. The app is served over http here, which is the only way the tab's
// controls can appear.
const http = require('node:http');
const { test, expect, seedApp, navTo } = require('./fixtures');

const RESTART = {
    needed: true, status: 'fresh', analyze: 60, analysed_in_backup: 60, discarded_completed: 0,
    message: 'No resume file.',
};
const PLAN = {
    analyze: 60, will_run: 60, done: 0, exhausted: 0, skip: 0, review: 2, analysed_in_backup: 60,
    resume: { status: 'fresh', path: '/data/analysis.ledger.json', completed: 0, warning: true,
        message: 'No resume file <b>here</b>: earlier progress is not known.' },
    restart: RESTART, text: '',
};
const RESULT = {
    _app: 'VinylCollectionPlayer', _version: 2, _generated_by: 'vinyl-analyzer test',
    track_meta: [
        { id: '1_yt000000001', release_id: 1, youtube_id: 'yt000000001', bpm: 99.5, bpm_source: 'analysis',
            key: '5A', key_source: 'analysis', energy: 6, energy_source: 'analysis' },
        { id: '2_yt000000002', release_id: 2, youtube_id: 'yt000000002', bpm: 101, bpm_source: 'analysis',
            key: '6A', key_source: 'analysis' },
    ],
};

// Starts the fake on a free port. `allowOrigin` is what --allow-origin names.
function startFakeAnalyzer(allowOrigin) {
    const calls = [];
    const st = { result: false, ledgerCompleted: 0 };
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const url = new URL(req.url, 'http://x');
            const body = Buffer.concat(chunks).toString('utf8');
            const origin = req.headers.origin;
            const send = (status, value, extra) => {
                const text = typeof value === 'string' ? value : JSON.stringify(value);
                res.writeHead(status, {
                    'content-type': 'application/json',
                    ...(origin === allowOrigin ? {
                        'access-control-allow-origin': origin,
                        'access-control-allow-headers': 'Content-Type',
                        'access-control-allow-methods': 'GET, POST, OPTIONS',
                        vary: 'Origin',
                    } : {}),
                    ...extra,
                });
                res.end(text);
            };
            if (origin && origin !== allowOrigin) return send(403, { error: 'this origin is not allowed' });
            if (req.method === 'OPTIONS') return send(204, '');
            calls.push({
                method: req.method, path: url.pathname, query: url.search,
                length: req.headers['content-length'], body,
            });
            const json = () => (body ? JSON.parse(body) : {});
            const route = req.method + ' ' + url.pathname;
            switch (route) {
            case 'GET /api/state':
                if (st.stateDelay) return setTimeout(() => send(200, { running: false, done: 0, total: 0, log: [] }), st.stateDelay);
                return send(200, { running: false, activity: '', done: 0, total: 0, analyzed: 0, failed: 0,
                    result: st.result ? 'Finished: 2 analysed.' : null, output: null, stopping: false, log: [] });
            case 'GET /api/files':
                return send(200, { data_dir: '/data', backup: null, result: st.result, ledger: null });
            case 'GET /api/audio':
                return send(200, { path: '/data/audio', files: st.audioFiles || 0, bytes: (st.audioFiles || 0) * 4 * 1024 * 1024 });
            case 'POST /api/audio/delete': {
                const n = st.audioFiles || 0;
                st.audioFiles = 0;
                return send(200, { ok: true, deleted_files: n, freed_bytes: n * 4 * 1024 * 1024 });
            }
            case 'POST /api/backup': {
                if (!req.headers['content-length']) return send(411, { error: 'length', code: 'length_required' });
                const b = JSON.parse(body);
                return send(200, { ok: true, videos: b.collection.videos.length });
            }
            case 'POST /api/plan':
                return send(200, PLAN);
            case 'POST /api/run':
                if (json().confirm_restart !== true) {
                    return send(409, { error: RESTART.message, code: 'restart_needs_confirmation', restart: RESTART });
                }
                st.result = true;
                return send(200, { ok: true });
            case 'POST /api/ledger':
                if (st.ledgerExists && !url.searchParams.has('replace')) {
                    return send(200, { error: 'exists', code: 'ledger_exists', existing_completed: 10, incoming_completed: 7,
                        settings_match: true, matching_setting: 'always' });
                }
                return send(200, { ok: true, completed: 7, settings_match: false, matching_setting: 'never' });
            case 'GET /api/result':
                if (!st.result) return send(404, { error: 'There is no result yet', code: 'no_result' });
                return send(200, RESULT, { 'content-disposition': 'attachment; filename="analysis.json"' });
            default:
                return send(404, { error: 'no such endpoint' });
            }
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({ url: 'http://127.0.0.1:' + server.address().port, calls, st, close: () => server.close() });
        });
    });
}

let fake;
test.beforeEach(async ({ page, context, baseURL }) => {
    fake = await startFakeAnalyzer(new URL(baseURL).origin);
    // The shared fixture aborts every request off the app's origin; let the
    // fake analyzer's through to the network.
    await context.route((u) => u.origin === fake.url, (route) => route.continue());
    await seedApp(page);
    await page.evaluate((url) => { window.ANALYZER_URL = url; }, fake.url);
});
test.afterEach(() => fake.close());

const posts = (p) => fake.calls.filter((c) => c.method === 'POST' && c.path === p);

test('analyzer: sends the app export, dry run renders, 409 asks, Cancel sends nothing, confirm resends', async ({ page }) => {
    await navTo(page, 'analyzer');
    await expect(page.locator('.analyzer-card > h2')).toContainText('Connected');

    await page.locator('#an-send').click();
    await expect(page.locator('#an-backup-status')).toHaveText('Sent: 60 videos');
    const upload = posts('/api/backup')[0];
    const sent = JSON.parse(upload.body);
    expect(sent._app).toBe('VinylCollectionPlayer');
    expect(sent._version).toBe(3);
    expect(sent.collection.videos).toHaveLength(60);
    expect(sent.track_meta).toHaveLength(60);
    expect(Number(upload.length)).toBe(Buffer.byteLength(upload.body));

    // Sending runs the dry run, as on the analyzer's own page.
    await expect(page.locator('#an-planline')).toHaveText(
        '60 to analyse · 0 already analysed · 0 failed too often · 0 already yours · 2 held for review');
    const resume = page.locator('#an-resumeline');
    // Server text is shown as text, never parsed as markup.
    await expect(resume).toHaveText(PLAN.resume.message);
    await expect(resume).toHaveClass(/analyzer-warn/);
    await expect(page.locator('#an-resume-import')).toBeVisible();

    await page.locator('#an-run').click();
    const dialog = page.locator('#an-restart-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.locator('#an-restart-text')).toHaveText(
        'This will analyse all 60 tracks from scratch, including 60 that are already analysed.');
    await expect(page.locator('#an-restart-cancel')).toBeFocused();
    expect(posts('/api/run')).toHaveLength(1);
    await page.locator('#an-restart-cancel').click();
    await expect(dialog).toBeHidden();
    await page.waitForTimeout(300);
    expect(posts('/api/run'), 'Cancel sends nothing').toHaveLength(1);

    await page.locator('#an-run').click();
    await expect(dialog).toBeVisible();
    await page.locator('#an-restart-fresh').click();
    await expect.poll(() => posts('/api/run').length).toBe(3);
    const runs = posts('/api/run').map((c) => JSON.parse(c.body));
    expect(runs[0].confirm_restart).toBeUndefined();
    expect(runs[2].confirm_restart).toBe(true);
    expect(runs[2].keep_audio).toBe(false);
});

test('analyzer: Load results imports the result into IndexedDB as estimates', async ({ page }) => {
    fake.st.result = true;
    await navTo(page, 'analyzer');
    await expect(page.locator('#an-download')).toHaveAttribute('href', fake.url + '/api/result');
    await page.locator('#an-load').click();   // the fixture accepts the confirm
    await expect(page.locator('.toast-success')).toContainText('2 track metadata records');
    const metas = await page.evaluate(async () => [await dbGet('track_meta', '1_yt000000001'), await dbGet('track_meta', '2_yt000000002')]);
    expect(metas[0].bpm).toBe(99.5);
    expect(metas[0].bpm_source).toBe('analysis');
    expect(metas[1].key_source).toBe('analysis');
    // Still on the analyzer, connected.
    await expect(page.locator('#an-load')).toBeVisible();
});

test('analyzer: Import earlier progress switches Cross-check to the setting that resumes it', async ({ page }) => {
    await navTo(page, 'analyzer');
    await expect(page.locator('.analyzer-card > h2')).toContainText('Connected');
    await page.locator('#an-ledger-file').setInputFiles({
        name: 'analysis.ledger.json', mimeType: 'application/json', buffer: Buffer.from('{"version":3}'),
    });
    await expect(page.locator('#an-import-status')).toContainText('Imported resume file: 7 finished tracks.');
    await expect(page.locator('#an-second')).toHaveValue('never');
    const call = posts('/api/ledger')[0];
    expect(call.query).toBe('?second_opinion=always');
    expect(call.body).toBe('{"version":3}');
});

test('analyzer: a page the analyzer was not told to trust shows how to start it', async ({ page, context, pageErrors }) => {
    fake.close();
    fake = await startFakeAnalyzer('http://elsewhere.example');
    await context.route((u) => u.origin === fake.url, (route) => route.continue());
    await page.evaluate((url) => { window.ANALYZER_URL = url; }, fake.url);
    await navTo(page, 'analyzer');
    await expect(page.locator('.analyzer-card > h2')).toHaveText('Not connected');
    await expect(page.locator('.analyzer-cmd')).toContainText('--allow-origin');
    // The browser reports the refused cross-origin read itself; that is the
    // point of this test, not an app error.
    for (let i = pageErrors.length - 1; i >= 0; i--) {
        if (/blocked by CORS policy/.test(pageErrors[i])) pageErrors.splice(i, 1);
    }
});

test('analyzer: a reply that lands after leaving the tab draws nothing', async ({ page }) => {
    fake.st.stateDelay = 600;
    await page.locator('.nav-link[data-nav="analyzer"]').click();
    await expect(page.locator('#analyzer-body')).toBeVisible();
    await navTo(page, 'collection');
    await page.waitForTimeout(1000);
    await expect(page.locator('#analyzer-body')).toHaveCount(0);
    await expect(page.locator('#an-run')).toHaveCount(0);
    await expect(page.locator('.release-card').first()).toBeVisible();
});

test('analyzer: Esc cancels the restart dialog; keep audio is sent when ticked', async ({ page }) => {
    await navTo(page, 'analyzer');
    await expect(page.locator('.analyzer-card > h2')).toContainText('Connected');
    await page.locator('#an-keep-audio').check();
    await page.locator('#an-run').click();
    await expect(page.locator('#an-restart-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#an-restart-dialog')).toBeHidden();
    await page.waitForTimeout(300);
    expect(posts('/api/run'), 'Esc sends nothing').toHaveLength(1);
    expect(JSON.parse(posts('/api/run')[0].body).keep_audio).toBe(true);
});

test('analyzer: replacing a resume file with finished work asks first, then sends replace=1', async ({ page }) => {
    fake.st.ledgerExists = true;
    await navTo(page, 'analyzer');
    await expect(page.locator('.analyzer-card > h2')).toContainText('Connected');
    const asked = [];
    page.removeAllListeners('dialog');
    page.on('dialog', (d) => { asked.push(d.message()); d.accept(); });
    await page.locator('#an-ledger-file').setInputFiles({
        name: 'analysis.ledger.json', mimeType: 'application/json', buffer: Buffer.from('{"version":3}'),
    });
    await expect(page.locator('#an-import-status')).toContainText('Imported resume file: 7 finished tracks.');
    expect(asked).toEqual(['The analyzer already has a resume file with 10 finished tracks. Replace it with this one (7 finished)?']);
    expect(posts('/api/ledger').map((c) => c.query)).toEqual(['?second_opinion=always', '?second_opinion=always&replace=1']);
});

test('analyzer: saved audio size and Delete saved audio (after confirming)', async ({ page }) => {
    fake.st.audioFiles = 3;
    await navTo(page, 'analyzer');
    await expect(page.locator('#an-audio-stats')).toHaveText('Saved audio: 3 files, 12.0 MB');
    await page.locator('#an-audio-delete').click();   // the fixture accepts the confirm
    await expect(page.locator('#an-audio-status')).toHaveText('Deleted 3 files, freed 12.0 MB.');
    await expect(page.locator('#an-audio-stats')).toHaveText('No saved audio.');
    await expect(page.locator('#an-audio-delete')).toBeDisabled();
});
