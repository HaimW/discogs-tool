// Shared fixtures for the browser smoke tests.
//
// - Network: everything off the app's own origin is aborted (YouTube, fonts,
//   images, anything new). api.discogs.com is answered by a small fake.
// - Errors: every test fails if the page throws (pageerror) or logs a
//   console.error, other than the browser's own "failed to load" noise from
//   the requests we abort on purpose.
// - Dialogs: prompts get "Smoke set", confirms/alerts are accepted.
const base = require('@playwright/test');

const CORS = { 'access-control-allow-origin': '*' };
const JSON_CORS = { ...CORS, 'content-type': 'application/json' };
// The browser logs these for every aborted / non-2xx request; they are the
// expected cost of blocking the network, not app errors.
const NETWORK_NOISE = /Failed to load resource|net::ERR/;

// Fake Discogs. `mode` is the `discogs` test option:
//   'ok'   - identity accepts any token containing "good" (as RealUser),
//            rejects the rest with 401; user lookup returns an avatar.
//   'down' - identity is unreachable.
// Anything else the app asks Discogs for is aborted (no live calls).
function fakeDiscogs(mode, origin) {
    return async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        if (url.pathname === '/oauth/identity') {
            if (mode === 'down') return route.abort();
            const auth = req.headers()['authorization'] || '';
            if (!auth.includes('good')) return route.fulfill({ status: 401, headers: CORS, body: '{}' });
            return route.fulfill({ status: 200, headers: JSON_CORS, body: JSON.stringify({ username: 'RealUser' }) });
        }
        if (url.pathname === '/users/RealUser') {
            return route.fulfill({ status: 200, headers: JSON_CORS, body: JSON.stringify({ avatar_url: origin + '/e2e-avatar.png' }) });
        }
        return route.abort();
    };
}

const test = base.test.extend({
    discogs: ['ok', { option: true }],

    // Collected page errors; asserted empty after each test.
    pageErrors: async ({}, use) => { // eslint-disable-line no-empty-pattern
        await use([]);
    },

    context: async ({ context, baseURL, discogs }, use) => {
        const origin = new URL(baseURL).origin;
        // Registered first = lowest priority: Playwright tries routes newest-first.
        await context.route((u) => u.origin !== origin, (route) => route.abort());
        await context.route('https://api.discogs.com/**', fakeDiscogs(discogs, origin));
        await use(context);
    },

    page: async ({ page, pageErrors }, use) => {
        page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
        page.on('console', (m) => {
            if (m.type() === 'error' && !NETWORK_NOISE.test(m.text())) pageErrors.push('console.error: ' + m.text());
        });
        page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept('Smoke set') : d.accept()));
        await use(page);
        base.expect(pageErrors, 'page errors / console errors during the test').toEqual([]);
    },
});

// Loads the app, writes a realistic data set straight into IndexedDB through
// the app's own globals, and reloads so every view starts from stored data.
// Strings carry quotes and apostrophes on purpose (escaping regressions).
async function seedApp(page) {
    await page.goto('/');
    await page.waitForFunction(() => typeof dbPut === 'function' && typeof saveConfig === 'function');
    await page.evaluate(async () => {
        await saveConfig('tok', 'me');
        const genres = ['House', 'Techno', 'Disco'];
        for (let i = 1; i <= 60; i++) {
            const yt = 'yt' + String(i).padStart(9, '0');
            await dbPut('releases', {
                id: i, title: 'Record "' + i + '"', artist: "Artist O'Neil " + i, year: 1980 + (i % 40),
                genres: genres[i % 3], styles: 'Deep', format: 'Vinyl', quantity: 1, folder_ids: [], video_count: 1,
                date_added: '2026-01-0' + (1 + (i % 9)) + 'T00:00:00Z', country: i % 2 ? 'UK' : 'US',
            });
            await dbPut('videos', { release_id: i, youtube_id: yt, title: 'Track ' + i, duration: 300 });
            await dbPut('tracklist', { id: i + '_0', release_id: i, position: 'A1', title: 'Track ' + i, duration: '5:00' });
            await dbPut('track_meta', { id: i + '_' + yt, release_id: i, youtube_id: yt, bpm: 120 + (i % 10), key: '8A', rating: 3, tags: ['peak'] });
        }
        for (let i = 100; i < 160; i++) {
            await dbPut('wants', { id: i, title: 'Want ' + i, artist: 'W"ant', year: 1990, genres: 'House', formats: 'Vinyl', video_count: 0 });
        }
        await dbPut('setlists', {
            name: 'Friday', tracks: [{ youtubeId: 'yt000000001', title: 'Track 1', artist: 'A', releaseId: 1 }],
            created_at: '2026-01-01', updated_at: '2026-01-01',
        });
        await dbPut('store_items', { id: 1, serial: 'A-001', artist: 'Artist', title: 'Record', store_status: 'active', batch_id: null });
        await dbPut('store_batches', { name: "Fair 'May'", created_at: '2026-01-01' });
    });
    await page.reload();
    await base.expect(page.locator('.release-card').first()).toBeVisible();
}

// Clicks a top-nav link and waits until its view has replaced #app's content.
async function navTo(page, view) {
    await page.evaluate(() => {
        const s = document.createElement('i');
        s.id = 'e2e-stale';
        document.getElementById('app').appendChild(s);
    });
    await page.locator('.nav-link[data-nav="' + view + '"]').click();
    await base.expect(page.locator('#e2e-stale')).toHaveCount(0);
    await base.expect.poll(() => page.evaluate(() => _currentView)).toBe(view);
}

module.exports = { test, expect: base.expect, seedApp, navTo };
