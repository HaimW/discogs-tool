// Data-safety fixes M2–M5 and price snapshots (F10), from docs/PROJECT_PLAN.md.
//
// The app is plain <script> files sharing one global scope, so each test loads
// the real source files into a fresh VM context the same way, with an
// in-memory stand-in for IndexedDB (src/db.js) and the Discogs API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const FILES = ['src/utils.js', 'src/api.js', 'src/marketplace.js', 'src/backup.js',
    'src/player_state.js', 'src/views/wantlist_sync.js'];

// Indexes the code under test queries, per store.
const INDEXES = {
    notifications: ['release_id'],
    price_history: ['release_id'],
    videos: ['release_id'],
    tracklist: ['release_id'],
    track_meta: ['release_id'],
};

function makeApp({ confirmAnswer = true } = {}) {
    const stores = {};
    const store = name => (stores[name] = stores[name] || new Map());
    let nextId = 1;
    const calls = { confirm: [], banner: [], badge: 0 };

    const ctx = {
        console: { log() {}, warn() {}, error() {} },
        Date, JSON, Math, Object, Promise, setTimeout, clearTimeout,
        sessionStorage: { _v: {}, getItem(k) { return this._v[k] ?? null; }, setItem(k, v) { this._v[k] = String(v); } },
        confirm(msg) { calls.confirm.push(msg); return confirmAnswer; },
        alert() {},
        _currentView: 'collection',

        dbPut: async (s, item) => {
            const rec = structuredClone(item);
            if (rec.id === undefined) rec.id = nextId++;
            store(s).set(rec.id, rec);
        },
        dbGet: async (s, k) => structuredClone(store(s).get(k)),
        dbGetAll: async s => [...store(s).values()].map(r => structuredClone(r)),
        dbDelete: async (s, k) => { store(s).delete(k); },
        dbGetByIndex: async (s, idx, v) => [...store(s).values()].filter(r => r[idx] === v),
        dbDeleteByIndex: async (s, idx, v) => {
            assert.ok((INDEXES[s] || []).includes(idx), `no index ${s}.${idx}`);
            let n = 0;
            for (const [k, r] of store(s)) if (r[idx] === v) { store(s).delete(k); n++; }
            return n;
        },
        openDB: async () => ({}),
    };
    vm.createContext(ctx);
    for (const f of FILES) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
    // Stand-ins for the page, set after loading: some are defined by the
    // loaded files themselves and touch the DOM.
    ctx.showSyncBanner = msg => { calls.banner.push(msg); };
    ctx.hideSyncBanner = () => {};
    ctx.updateNotifBadge = () => { calls.badge++; return Promise.resolve(); };
    ctx.renderWantList = () => {};
    ctx.showToast = msg => { calls.banner.push(msg); };
    // backup.js writes through _bulkPut, which opens IndexedDB directly.
    ctx._bulkPut = async (s, records) => {
        for (const r of records || []) await ctx.dbPut(s, r);
        return (records || []).length;
    };
    return { ctx, stores, store, calls };
}

const CONFIG = { token: 't', username: 'me' };
const want = id => ({ id, artist: 'A' + id, title: 'T' + id });

// ---------- M3: a sync never prunes from a listing it cannot trust ----------

test('M3: prune guard refuses incomplete, empty and unconfirmed large cuts', () => {
    const { ctx, calls } = makeApp({ confirmAnswer: false });
    const ok = (f, rep, stored, gone) => ctx.syncPruneAllowed('releases', f, rep, stored, gone);

    assert.equal(ok(100, 100, 100, 0), true, 'nothing to remove');
    assert.equal(ok(98, 100, 102, 4), false, 'pages held fewer items than Discogs reported');
    assert.equal(ok(0, null, 50, 50), false, 'empty listing while records are stored');
    assert.equal(ok(97, 97, 100, 3), true, 'small removal goes ahead without asking');
    assert.equal(calls.confirm.length, 0);
    assert.equal(ok(60, 60, 100, 40), false, 'large cut, person said Cancel');
    assert.equal(calls.confirm.length, 1);
    assert.match(calls.confirm[0], /40 of your 100 releases/);
});

test('M3: collection sync keeps releases and track_meta when the listing is short', async () => {
    const { ctx, store } = makeApp();
    for (const id of [1, 2, 3]) await ctx.dbPut('releases', { id, title: 'r' + id });
    await ctx.dbPut('track_meta', { id: '3_yt', release_id: 3, bpm: 124 });

    ctx.discogsGet = async p => {
        if (p.endsWith('/collection/folders')) return { folders: [{ id: 0, name: 'All', count: 3 }] };
        // Folder 0 claims 3 items but its single page only holds 2.
        return {
            releases: [1, 2].map(id => ({ basic_information: { id, title: 'r' + id } })),
            pagination: { pages: 1, items: 3 },
        };
    };
    await ctx.syncCollection(CONFIG);

    assert.ok(store('releases').has(3), 'release 3 kept');
    assert.equal(store('track_meta').get('3_yt').bpm, 124, 'hand-typed BPM kept');
});

test('M3: collection sync still removes a release Discogs really dropped', async () => {
    const { ctx, store } = makeApp();
    for (const id of [1, 2, 3]) await ctx.dbPut('releases', { id, title: 'r' + id });
    await ctx.dbPut('track_meta', { id: '3_yt', release_id: 3, bpm: 124 });
    await ctx.dbPut('videos', { id: 9, release_id: 3 });

    ctx.discogsGet = async p => {
        if (p.endsWith('/collection/folders')) return { folders: [{ id: 0, name: 'All', count: 2 }] };
        return {
            releases: [1, 2].map(id => ({ basic_information: { id, title: 'r' + id } })),
            pagination: { pages: 1, items: 2 },
        };
    };
    await ctx.syncCollection(CONFIG);

    assert.ok(!store('releases').has(3));
    assert.ok(!store('track_meta').has('3_yt'));
    assert.ok(!store('videos').has(9));
});

// ---------- M2: a removed want takes its marketplace data with it ----------

test('M2: want sync removes stats, alerts and price history of dropped wants', async () => {
    const { ctx, store } = makeApp();
    for (const id of [1, 2]) await ctx.dbPut('wants', want(id));
    await ctx.dbPut('marketplace_stats', { id: 2, num_for_sale: 1 });
    await ctx.dbPut('notifications', { release_id: 2, seen: false });
    await ctx.dbPut('price_history', { id: '2_x', release_id: 2 });
    await ctx.dbPut('price_history', { id: '1_x', release_id: 1 });

    ctx.discogsGet = async () => ({
        wants: [{ basic_information: { id: 1, title: 'T1' } }],
        pagination: { pages: 1, items: 1 },
    });
    await ctx.syncWantList(CONFIG);

    assert.ok(!store('wants').has(2));
    assert.ok(!store('marketplace_stats').has(2));
    assert.equal([...store('notifications').values()].filter(n => n.release_id === 2).length, 0);
    assert.ok(!store('price_history').has('2_x'));
    assert.ok(store('price_history').has('1_x'), 'other wants untouched');
});

test('M2 + M3: want sync keeps everything when the listing is incomplete', async () => {
    const { ctx, store } = makeApp();
    for (const id of [1, 2]) await ctx.dbPut('wants', want(id));
    await ctx.dbPut('marketplace_stats', { id: 2, num_for_sale: 1 });

    ctx.discogsGet = async () => ({
        wants: [{ basic_information: { id: 1, title: 'T1' } }],
        pagination: { pages: 1, items: 2 },
    });
    await ctx.syncWantList(CONFIG);

    assert.ok(store('wants').has(2));
    assert.ok(store('marketplace_stats').has(2));
});

// ---------- F10: price snapshots ----------

test('F10: first reading, changes and a daily heartbeat are kept; repeats are not', async () => {
    const { ctx, store } = makeApp();
    await ctx.dbPut('wants', want(7));
    let reading = { num_for_sale: 2, lowest_price: { value: 30, currency: 'EUR' } };
    ctx.discogsGet = async () => reading;
    const history = () => [...store('price_history').values()].filter(r => r.release_id === 7);
    // Rows are keyed by their timestamp; real polls are minutes apart.
    const tick = () => new Promise(r => setTimeout(r, 3));

    await tick();
    await ctx.syncMarketplaceStats(false, CONFIG);
    assert.equal(history().length, 1, 'first reading kept');
    assert.deepEqual(
        (({ num_for_sale, lowest_price, currency }) => ({ num_for_sale, lowest_price, currency }))(history()[0]),
        { num_for_sale: 2, lowest_price: 30, currency: 'EUR' });

    await tick();
    await ctx.syncMarketplaceStats(false, CONFIG);
    assert.equal(history().length, 1, 'same reading again is not stored');

    reading = { num_for_sale: 3, lowest_price: { value: 25, currency: 'EUR' } };
    await tick();
    await ctx.syncMarketplaceStats(false, CONFIG);
    assert.equal(history().length, 2, 'a price change is stored');

    // A day later with no change: the heartbeat row.
    const s = store('marketplace_stats').get(7);
    s.snapshot_at = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    await tick();
    await ctx.syncMarketplaceStats(false, CONFIG);
    assert.equal(history().length, 3, 'daily heartbeat stored');
    assert.ok(history().every(r => r.id === `7_${r.checked_at}`), 'deterministic ids merge across backups');
});

// ---------- M5: restored baselines never fire (or swallow) alerts ----------

test('M5: a restored count is not a baseline; a local reading is kept over the backup', async () => {
    const { ctx, store } = makeApp();
    await ctx.dbPut('wants', want(5));
    await ctx.dbPut('wants', want(6));
    // Local, live reading for 6: newer than anything in a backup.
    await ctx.dbPut('marketplace_stats', { id: 6, num_for_sale: 4, checked_at: new Date().toISOString() });

    await ctx._restoreMarketplaceStats([
        { id: 5, num_for_sale: 0, checked_at: '2026-01-01T00:00:00Z' },
        { id: 6, num_for_sale: 0, checked_at: '2026-01-01T00:00:00Z' },
    ]);
    assert.equal(store('marketplace_stats').get(6).num_for_sale, 4, 'local reading kept');
    const restored = store('marketplace_stats').get(5);
    assert.equal(restored.baseline_restored, true);
    assert.equal(restored.checked_at, null, 'due for a check');

    // Now 5 is for sale. With the old 0 as a baseline this would alert.
    ctx.discogsGet = async () => ({ num_for_sale: 1, lowest_price: { value: 10, currency: 'USD' } });
    await ctx.syncMarketplaceStats(true, CONFIG);
    assert.equal([...store('notifications').values()].length, 0, 'no alert from a restored baseline');
    assert.equal(store('marketplace_stats').get(5).baseline_restored, undefined, 'fresh baseline recorded');

    // From the fresh baseline, a real 0 -> 1 change alerts as before.
    ctx.discogsGet = async () => ({ num_for_sale: 0, lowest_price: null });
    await ctx.syncMarketplaceStats(false, CONFIG);
    ctx.discogsGet = async () => ({ num_for_sale: 2, lowest_price: { value: 9, currency: 'USD' } });
    await ctx.syncMarketplaceStats(false, CONFIG);
    assert.equal([...store('notifications').values()].filter(n => n.release_id === 5).length, 1);
});

test('backup export carries price history', async () => {
    const { ctx } = makeApp();
    await ctx.dbPut('price_history', { id: '1_x', release_id: 1 });
    let saved = null;
    ctx.getConfig = async () => CONFIG;
    ctx.downloadBlob = (_name, _type, text) => { saved = JSON.parse(text); };
    await ctx.exportFullBackup();
    await new Promise(r => setTimeout(r, 0));
    assert.equal(JSON.stringify(saved.wantlist.price_history), JSON.stringify([{ id: '1_x', release_id: 1 }]));
});

// ---------- M4: a restored tab comes back paused ----------

test('M4: player state restores paused even when it was playing', () => {
    const { ctx } = makeApp();
    const seen = [];
    ctx.player = {
        loadVideoById(o) { seen.push(['load', o]); },
        cueVideoById(o) { seen.push(['cue', o]); },
    };
    ctx.isPlaying = false;
    ctx.cfEnabled = false;
    ctx.showNowPlaying = () => {};
    ctx.updatePlayPauseBtn = () => {};
    ctx.sessionStorage.setItem('playerState', JSON.stringify({
        queue: [{ youtubeId: 'abc', title: 't', artist: 'a' }], currentIndex: 0, currentTime: 42, isPlaying: true,
    }));

    ctx._restorePlayerState();
    // Objects made inside the VM have its own prototypes: compare as JSON.
    assert.equal(JSON.stringify(seen), JSON.stringify([['cue', { videoId: 'abc', startSeconds: 42 }]]));
    assert.equal(ctx.isPlaying, false);
});
