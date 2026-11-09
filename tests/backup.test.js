// Backup v3 (authored vs derived) and restore of every format: v1, v2, v3 and
// desktop-analyzer's analysis.json. Loads the real source files into a VM
// context with an in-memory stand-in for IndexedDB, as data_safety.test.js does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const FILES = ['src/utils.js', 'src/marketplace.js', 'src/backup.js'];

function makeApp() {
    const stores = {};
    const store = name => (stores[name] = stores[name] || new Map());
    const keyOf = (s, rec) => (s === 'config' ? rec.key : rec.id);
    let nextId = 1;
    const toasts = [];

    const ctx = {
        console: { log() {}, warn() {}, error() {} },
        Date, JSON, Math, Object, Promise, setTimeout, clearTimeout,
        dbPut: async (s, item) => {
            const rec = structuredClone(item);
            if (s !== 'config' && rec.id === undefined) rec.id = nextId++;
            store(s).set(keyOf(s, rec), rec);
        },
        dbGet: async (s, k) => structuredClone(store(s).get(k)),
        dbGetAll: async s => [...store(s).values()].map(r => structuredClone(r)),
        dbDelete: async (s, k) => { store(s).delete(k); },
        openDB: async () => ({}),
        _syncRunning: false, // api.js global
    };
    vm.createContext(ctx);
    for (const f of FILES) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
    ctx.showToast = (msg, type) => { toasts.push([msg, type]); };
    ctx.showSyncBanner = () => {};
    ctx.hideSyncBanner = () => {};
    ctx._bulkPut = async (s, records) => {
        for (const r of records || []) await ctx.dbPut(s, r);
        return (records || []).length;
    };
    return { ctx, store, toasts };
}

// Objects built inside the VM have its own prototypes: compare as plain JSON.
const plain = v => JSON.parse(JSON.stringify(v));

// ---------- export ----------

test('export: v3 shape, authored/derived split, analyzer paths kept, token left out', async () => {
    const { ctx } = makeApp();
    await ctx.dbPut('config', { key: 'discogs_token', value: 'SECRET' });
    await ctx.dbPut('config', { key: 'discogs_username', value: 'me' });
    await ctx.dbPut('config', { key: 'collection_value', value: { median: '$1' } });
    await ctx.dbPut('config', { key: 'crossfade_enabled', value: true });
    await ctx.dbPut('config', { key: 'crossfade_seconds', value: 6 });
    await ctx.dbPut('config', { key: 'player_volume', value: 60 });
    await ctx.dbPut('config', { key: 'player_muted', value: true });
    await ctx.dbPut('releases', { id: 1, title: 'R' });
    await ctx.dbPut('videos', { id: '1_yt', release_id: 1 });
    await ctx.dbPut('tracklist', { id: '1_A1', release_id: 1 });
    await ctx.dbPut('folders', { id: 0, name: 'All' });
    await ctx.dbPut('track_meta', { id: '1_yt', release_id: 1, bpm: 124 });
    await ctx.dbPut('setlists', { id: 3, name: 'Set' });
    await ctx.dbPut('store_items', { id: 'i1' });
    await ctx.dbPut('store_batches', { id: 4 });
    await ctx.dbPut('price_history', { id: '9_x', release_id: 9 });
    await ctx.dbPut('notifications', { id: 5, release_id: 9 });
    await ctx.dbPut('want_alerts', { id: 9, max_price: 20, currency: 'EUR' });
    await ctx.dbPut('wants', { id: 9, artist: 'A' });
    await ctx.dbPut('marketplace_stats', { id: 9, num_for_sale: 0 });

    let saved = null;
    let name = null;
    ctx.downloadBlob = (n, _type, text) => { name = n; saved = JSON.parse(text); };
    await ctx.exportFullBackup();

    assert.match(name, /^vinyl-backup-\d{4}-\d{2}-\d{2}\.json$/);
    assert.equal(saved._version, 3);
    assert.equal(saved._app, 'VinylCollectionPlayer');
    assert.ok(saved._contents && saved._contents.note && saved._contents.sections);
    assert.deepEqual(saved._contents.pinned_v2_paths, ['track_meta', 'collection']);
    // Every section in the file is labelled.
    for (const key of ['track_meta', 'collection']) assert.ok(saved._contents.sections[key], key);
    for (const key of Object.keys(saved.authored)) assert.ok(saved._contents.sections['authored.' + key], key);
    for (const key of Object.keys(saved.derived)) assert.ok(saved._contents.sections['derived.' + key], key);

    // desktop-analyzer reads these two paths (crates/core/src/backup.rs).
    assert.equal(saved.track_meta[0].bpm, 124);
    assert.deepEqual(Object.keys(saved.collection).sort(), ['folders', 'releases', 'tracklist', 'videos']);
    assert.equal(saved.collection.releases[0].id, 1);

    assert.deepEqual(Object.keys(saved.authored).sort(),
        ['config', 'notifications', 'price_history', 'setlists', 'store', 'want_alerts']);
    assert.deepEqual(saved.authored.store, { items: [{ id: 'i1' }], batches: [{ id: 4 }] });
    assert.deepEqual(saved.authored.want_alerts, [{ id: 9, max_price: 20, currency: 'EUR' }]);
    assert.deepEqual(saved.derived, {
        wants: [{ id: 9, artist: 'A' }],
        marketplace_stats: [{ id: 9, num_for_sale: 0 }],
    });

    // Only allowlisted config travels: no token, no cached collection value.
    assert.deepEqual(saved.authored.config, [
        { key: 'discogs_username', value: 'me' },
        { key: 'crossfade_enabled', value: true },
        { key: 'crossfade_seconds', value: 6 },
        { key: 'player_volume', value: 60 },
        { key: 'player_muted', value: true },
    ]);
    assert.ok(!JSON.stringify(saved).includes('median'), 'collection value not exported');
    assert.ok(!JSON.stringify(saved).includes('SECRET'), 'token appears nowhere in the file');
    // No v2-only top-level sections duplicated alongside.
    for (const k of ['config', 'setlists', 'store', 'notifications', 'wantlist']) assert.ok(!(k in saved), k);
});

test('buildBackupPayload is pure and tolerates missing stores', () => {
    const { ctx } = makeApp();
    const p = plain(ctx.buildBackupPayload({}, '2026-11-06T00:00:00.000Z'));
    assert.equal(p.exported_at, '2026-11-06T00:00:00.000Z');
    assert.deepEqual(p.track_meta, []);
    assert.deepEqual(p.authored.config, []);
    assert.deepEqual(p.derived.wants, []);
});

// ---------- normalize: every format to flat lists ----------

const V1 = {
    _app: 'VinylCollectionPlayer',
    config: [{ key: 'discogs_token', value: 'OLD' }, { key: 'discogs_username', value: 'me' }],
    collection: { releases: [{ id: 1 }], videos: [{ id: 'v' }], folders: [], tracklist: [] },
    wantlist: { wants: [{ id: 9 }], marketplace_stats: [{ id: 9, num_for_sale: 1 }] },
    track_meta: [{ id: '1_v', bpm: 120 }],
    setlists: [{ id: 2 }],
    store: { items: [{ id: 'i' }], batches: [] },
    notifications: [{ id: 3 }],
};
const V2 = Object.assign({}, V1, {
    _version: 2,
    wantlist: Object.assign({}, V1.wantlist, { price_history: [{ id: '9_t', release_id: 9 }] }),
});

test('_normalizeBackup reads a v1 file', () => {
    const { ctx } = makeApp();
    const b = plain(ctx._normalizeBackup(V1));
    assert.equal(b.version, 1);
    assert.equal(b.config.length, 2);
    assert.deepEqual(b.releases, [{ id: 1 }]);
    assert.deepEqual(b.videos, [{ id: 'v' }]);
    assert.deepEqual(b.wants, [{ id: 9 }]);
    assert.deepEqual(b.marketplace_stats, [{ id: 9, num_for_sale: 1 }]);
    assert.deepEqual(b.track_meta, [{ id: '1_v', bpm: 120 }]);
    assert.deepEqual(b.setlists, [{ id: 2 }]);
    assert.deepEqual(b.store_items, [{ id: 'i' }]);
    assert.deepEqual(b.notifications, [{ id: 3 }]);
    assert.deepEqual(b.price_history, []);
    assert.deepEqual(b.want_alerts, []);
});

test('_normalizeBackup reads a v2 file (price history under wantlist)', () => {
    const { ctx } = makeApp();
    const b = plain(ctx._normalizeBackup(V2));
    assert.equal(b.version, 2);
    assert.deepEqual(b.price_history, [{ id: '9_t', release_id: 9 }]);
    assert.deepEqual(b.wants, [{ id: 9 }]);
});

test('_normalizeBackup reads its own v3 export back', () => {
    const { ctx } = makeApp();
    const v3 = plain(ctx.buildBackupPayload({
        config: [{ key: 'discogs_username', value: 'me' }],
        releases: [{ id: 1 }], videos: [{ id: 'v' }], folders: [{ id: 0 }], tracklist: [{ id: 't' }],
        wants: [{ id: 9 }], marketplace_stats: [{ id: 9 }], track_meta: [{ id: 'm' }],
        setlists: [{ id: 2 }], store_items: [{ id: 'i' }], store_batches: [{ id: 4 }],
        notifications: [{ id: 3 }], price_history: [{ id: 'p' }], want_alerts: [{ id: 9, max_price: 5, currency: 'USD' }],
    }, '2026-11-06T00:00:00Z'));
    const b = plain(ctx._normalizeBackup(v3));
    assert.equal(b.version, 3);
    assert.deepEqual(b.config, [{ key: 'discogs_username', value: 'me' }]);
    assert.deepEqual(b.releases, [{ id: 1 }]);
    assert.deepEqual(b.folders, [{ id: 0 }]);
    assert.deepEqual(b.tracklist, [{ id: 't' }]);
    assert.deepEqual(b.wants, [{ id: 9 }]);
    assert.deepEqual(b.marketplace_stats, [{ id: 9 }]);
    assert.deepEqual(b.track_meta, [{ id: 'm' }]);
    assert.deepEqual(b.setlists, [{ id: 2 }]);
    assert.deepEqual(b.store_items, [{ id: 'i' }]);
    assert.deepEqual(b.store_batches, [{ id: 4 }]);
    assert.deepEqual(b.notifications, [{ id: 3 }]);
    assert.deepEqual(b.price_history, [{ id: 'p' }]);
    assert.deepEqual(b.want_alerts, [{ id: 9, max_price: 5, currency: 'USD' }]);
});

test('_normalizeBackup reads desktop-analyzer analysis.json (track_meta only)', () => {
    const { ctx } = makeApp();
    // Shape of MetaExport in desktop-analyzer/crates/core/src/backup.rs.
    const analysis = {
        _app: 'VinylCollectionPlayer', _version: 2, _generated_by: 'vinyl-analyzer 0.1',
        track_meta: [{ id: '1_yt', release_id: 1, bpm: 128, bpm_source: 'analysis' }],
    };
    const b = plain(ctx._normalizeBackup(analysis));
    assert.equal(b.track_meta.length, 1);
    for (const k of Object.keys(b)) if (k !== 'track_meta' && k !== 'version') assert.deepEqual(b[k], [], k);
});

test('_normalizeBackup rejects foreign files and junk sections', () => {
    const { ctx } = makeApp();
    assert.equal(ctx._normalizeBackup(null), null);
    assert.equal(ctx._normalizeBackup([]), null);
    assert.equal(ctx._normalizeBackup({ _app: 'Other', track_meta: [] }), null);
    const b = plain(ctx._normalizeBackup({ _app: 'VinylCollectionPlayer', track_meta: 'x', collection: { releases: [null, 1, { id: 1 }] } }));
    assert.deepEqual(b.track_meta, []);
    assert.deepEqual(b.releases, [{ id: 1 }]);
});

// ---------- restore ----------

test('token rule: a file token is used only when this browser has none', async () => {
    {
        const { ctx, store } = makeApp();
        const res = await ctx.restoreBackup(ctx._normalizeBackup(V2));
        assert.equal(res.tokenOutcome, 'restored');
        assert.equal(store('config').get('discogs_token').value, 'OLD');
        assert.match(ctx._restoreMessage(2, res.counts, res.tokenOutcome), /token restored/);
    }
    {
        const { ctx, store } = makeApp();
        await ctx.dbPut('config', { key: 'discogs_token', value: 'MINE' });
        const res = await ctx.restoreBackup(ctx._normalizeBackup(V2));
        assert.equal(res.tokenOutcome, 'kept');
        assert.equal(store('config').get('discogs_token').value, 'MINE');
        assert.equal(store('config').has('discogs_username'), false, 'file username does not join a local token');
        assert.match(ctx._restoreMessage(2, res.counts, res.tokenOutcome), /Kept your current Discogs token/);
    }
    {
        const { ctx } = makeApp();
        const v3 = plain(ctx.buildBackupPayload({ config: [{ key: 'discogs_username', value: 'me' }] }, 'now'));
        const res = await ctx.restoreBackup(ctx._normalizeBackup(v3));
        assert.equal(res.tokenOutcome, null);
        assert.doesNotMatch(ctx._restoreMessage(3, res.counts, res.tokenOutcome), /token/i);
    }
});

test('want alerts restore after wants; orphans are dropped', async () => {
    const { ctx, store } = makeApp();
    await ctx.dbPut('wants', { id: 7 }); // already here, not in the file
    const v3 = plain(ctx.buildBackupPayload({
        wants: [{ id: 9 }],
        want_alerts: [
            { id: 9, max_price: 20, currency: 'EUR' },   // want in the file
            { id: 7, max_price: 5, currency: 'USD' },    // want already local
            { id: 8, max_price: 1, currency: 'USD' },    // want nowhere: orphan
        ],
    }, 'now'));
    const res = await ctx.restoreBackup(ctx._normalizeBackup(v3));
    assert.equal(res.counts.want_alerts, 2);
    assert.deepEqual([...store('want_alerts').keys()].sort(), [7, 9]);
    assert.match(ctx._restoreMessage(3, res.counts, null), /2 max-price alerts/);
});

test('M5 preserved: restored stats keep local readings and are flagged as no baseline', async () => {
    const { ctx, store } = makeApp();
    await ctx.dbPut('marketplace_stats', { id: 6, num_for_sale: 4, checked_at: '2026-11-01T00:00:00Z' });
    const v3 = plain(ctx.buildBackupPayload({
        wants: [{ id: 5 }, { id: 6 }],
        marketplace_stats: [{ id: 5, num_for_sale: 0, checked_at: '2026-01-01T00:00:00Z' },
            { id: 6, num_for_sale: 0, checked_at: '2026-01-01T00:00:00Z' }],
    }, 'now'));
    const res = await ctx.restoreBackup(ctx._normalizeBackup(v3));
    assert.equal(res.counts.marketplace_stats, 1);
    assert.equal(store('marketplace_stats').get(6).num_for_sale, 4, 'local reading kept');
    assert.equal(store('marketplace_stats').get(5).baseline_restored, true);
    assert.equal(store('marketplace_stats').get(5).checked_at, null);
});

test('releases merge: local-only fields survive a backup record without them', async () => {
    const { ctx, store } = makeApp();
    await ctx.dbPut('releases', {
        id: 1, title: 'Old', video_overrides: { A1: 'yt' }, country: 'UK',
        community_have: 10, community_want: 20, community_fetched_at: '2026-10-01T00:00:00Z', local_note: 'x',
    });
    const res = await ctx.restoreBackup(ctx._normalizeBackup({
        _app: 'VinylCollectionPlayer', _version: 2,
        collection: { releases: [{ id: 1, title: 'New', country: null }, { id: 2, title: 'Two' }] },
    }));
    assert.equal(res.counts.releases, 2);
    const r1 = store('releases').get(1);
    assert.equal(r1.title, 'New', 'backup data upserted on top');
    assert.deepEqual(plain(r1.video_overrides), { A1: 'yt' });
    assert.equal(r1.country, 'UK', 'a null in the backup does not erase a local value');
    assert.equal(r1.community_have, 10);
    assert.equal(r1.community_want, 20);
    assert.equal(r1.community_fetched_at, '2026-10-01T00:00:00Z');
    assert.equal(store('releases').get(2).title, 'Two');
});

test('restore of an analyzer file only touches track_meta', async () => {
    const { ctx, store } = makeApp();
    await ctx.dbPut('releases', { id: 1 });
    await ctx.dbPut('config', { key: 'discogs_token', value: 'MINE' });
    const res = await ctx.restoreBackup(ctx._normalizeBackup({
        _app: 'VinylCollectionPlayer', _version: 2, track_meta: [{ id: '1_yt', bpm: 128 }],
    }));
    assert.equal(res.counts.track_meta, 1);
    assert.equal(res.tokenOutcome, null);
    assert.equal(store('track_meta').get('1_yt').bpm, 128);
    assert.equal(store('releases').size, 1);
    assert.equal(store('config').get('discogs_token').value, 'MINE');
    assert.equal(ctx._restoreMessage(2, res.counts, null), 'Restored (v2): 1 track metadata record');
});

test('round trip: export then restore into an empty browser', async () => {
    const a = makeApp();
    await a.ctx.dbPut('config', { key: 'discogs_token', value: 'SECRET' });
    await a.ctx.dbPut('config', { key: 'discogs_username', value: 'me' });
    await a.ctx.dbPut('wants', { id: 9 });
    await a.ctx.dbPut('want_alerts', { id: 9, max_price: 20, currency: 'EUR' });
    await a.ctx.dbPut('setlists', { id: 2, name: 'S' });
    let text = null;
    a.ctx.downloadBlob = (_n, _t, t) => { text = t; };
    await a.ctx.exportFullBackup();

    const b = makeApp();
    const res = await b.ctx.restoreBackup(b.ctx._normalizeBackup(JSON.parse(text)));
    assert.equal(res.tokenOutcome, null, 'no token in a v3 file');
    assert.equal(b.store('config').has('discogs_token'), false);
    assert.equal(b.store('config').get('discogs_username').value, 'me');
    assert.equal(b.store('want_alerts').get(9).max_price, 20);
    assert.equal(b.store('setlists').get(2).name, 'S');
});

// ---------- review round 1 ----------

test('M1 username: never repoints an existing login', async () => {
    const withUser = (cfg) => ({ _app: 'VinylCollectionPlayer', _version: 3, authored: { config: cfg } });
    {   // local token + local username, file username differs: local kept
        const { ctx, store } = makeApp();
        await ctx.dbPut('config', { key: 'discogs_token', value: 'MINE' });
        await ctx.dbPut('config', { key: 'discogs_username', value: 'alice' });
        await ctx.restoreBackup(ctx._normalizeBackup(withUser([{ key: 'discogs_username', value: 'bob' }])));
        assert.equal(store('config').get('discogs_username').value, 'alice');
        assert.equal(store('config').get('discogs_token').value, 'MINE');
    }
    {   // local token + local username, old file with token + other username: both local kept
        const { ctx, store } = makeApp();
        await ctx.dbPut('config', { key: 'discogs_token', value: 'MINE' });
        await ctx.dbPut('config', { key: 'discogs_username', value: 'alice' });
        const res = await ctx.restoreBackup(ctx._normalizeBackup(V2));
        assert.equal(res.tokenOutcome, 'kept');
        assert.equal(store('config').get('discogs_username').value, 'alice');
    }
    {   // local username only (no token), v3 file: local username kept
        const { ctx, store } = makeApp();
        await ctx.dbPut('config', { key: 'discogs_username', value: 'alice' });
        await ctx.restoreBackup(ctx._normalizeBackup(withUser([{ key: 'discogs_username', value: 'bob' }])));
        assert.equal(store('config').get('discogs_username').value, 'alice');
    }
    {   // no local token, file token restored: the file's username comes with it
        const { ctx, store } = makeApp();
        await ctx.dbPut('config', { key: 'discogs_username', value: 'alice' });
        const res = await ctx.restoreBackup(ctx._normalizeBackup(V2));
        assert.equal(res.tokenOutcome, 'restored');
        assert.equal(store('config').get('discogs_token').value, 'OLD');
        assert.equal(store('config').get('discogs_username').value, 'me');
    }
    {   // fresh browser + v3 file (no token in file): username restored
        const { ctx, store } = makeApp();
        const res = await ctx.restoreBackup(ctx._normalizeBackup(withUser([{ key: 'discogs_username', value: 'bob' }])));
        assert.equal(res.tokenOutcome, null);
        assert.equal(store('config').get('discogs_username').value, 'bob');
    }
});

test('m3 crossfade settings restore alongside other config', async () => {
    const { ctx, store } = makeApp();
    await ctx.restoreBackup(ctx._normalizeBackup({
        _app: 'VinylCollectionPlayer', _version: 3,
        authored: { config: [{ key: 'crossfade_enabled', value: true }, { key: 'crossfade_seconds', value: 8 }] },
    }));
    assert.equal(store('config').get('crossfade_enabled').value, true);
    assert.equal(store('config').get('crossfade_seconds').value, 8);
});

test('F15 volume settings restore when valid; invalid values are dropped, keeping the local ones', async () => {
    {
        const { ctx, store } = makeApp();
        await ctx.restoreBackup(ctx._normalizeBackup({
            _app: 'VinylCollectionPlayer', _version: 3,
            authored: { config: [{ key: 'player_volume', value: 35 }, { key: 'player_muted', value: true }] },
        }));
        assert.equal(store('config').get('player_volume').value, 35);
        assert.equal(store('config').get('player_muted').value, true);
    }
    for (const bad of [
        [{ key: 'player_volume', value: 150 }, { key: 'player_muted', value: 'yes' }],
        [{ key: 'player_volume', value: -1 }, { key: 'player_muted', value: 1 }],
        [{ key: 'player_volume', value: 12.5 }, { key: 'player_muted', value: null }],
        [{ key: 'player_volume', value: '50' }, { key: 'player_muted', value: {} }],
    ]) {
        const { ctx, store } = makeApp();
        await ctx.dbPut('config', { key: 'player_volume', value: 70 });
        await ctx.dbPut('config', { key: 'player_muted', value: false });
        await ctx.restoreBackup(ctx._normalizeBackup({
            _app: 'VinylCollectionPlayer', _version: 3,
            authored: { config: bad.concat([{ key: 'crossfade_seconds', value: 8 }]) },
        }));
        assert.equal(store('config').get('player_volume').value, 70, JSON.stringify(bad));
        assert.equal(store('config').get('player_muted').value, false, JSON.stringify(bad));
        assert.equal(store('config').get('crossfade_seconds').value, 8, 'the rest of the config still restores');
    }
    {   // a key named like an Object.prototype member is not mistaken for a check
        const { ctx, store } = makeApp();
        await ctx.restoreBackup(ctx._normalizeBackup({
            _app: 'VinylCollectionPlayer', _version: 3,
            authored: { config: [{ key: 'hasOwnProperty', value: 1 }] },
        }));
        assert.equal(store('config').get('hasOwnProperty').value, 1);
    }
});

test('m4 normalize drops records lacking their store key; autoIncrement stores keep id-less records', () => {
    const { ctx } = makeApp();
    const b = plain(ctx._normalizeBackup({
        _app: 'VinylCollectionPlayer', _version: 3,
        track_meta: [{ id: '1_a' }, { bpm: 120 }, { id: null }, { id: { x: 1 } }],
        collection: {
            releases: [{ id: 1 }, { title: 'no id' }, { id: Infinity }],
            videos: [{ release_id: 1 }, { id: 'v' }, { id: null }],
            folders: [{ name: 'no id' }], tracklist: [{ id: '1_A1' }, {}],
        },
        authored: {
            config: [{ key: 'discogs_username', value: 'me' }, { id: 'x', value: 1 }],
            setlists: [{ name: 'new' }, { id: 2 }, { id: [] }],
            store: { items: [{ sku: 'x' }, { id: 'i' }], batches: [{ name: 'b' }] },
            notifications: [{ release_id: 9 }],
            price_history: [{ release_id: 9 }],
            want_alerts: [{ max_price: 1 }, { id: 9, max_price: 2 }],
        },
        derived: { wants: [{ artist: 'A' }, { id: 9 }], marketplace_stats: [{ num_for_sale: 1 }] },
    }));
    assert.deepEqual(b.track_meta, [{ id: '1_a' }]);
    assert.deepEqual(b.releases, [{ id: 1 }]);
    assert.deepEqual(b.videos, [{ release_id: 1 }, { id: 'v' }]);
    assert.deepEqual(b.folders, []);
    assert.deepEqual(b.tracklist, [{ id: '1_A1' }]);
    assert.deepEqual(b.config, [{ key: 'discogs_username', value: 'me' }]);
    assert.deepEqual(b.setlists, [{ name: 'new' }, { id: 2 }]);
    assert.deepEqual(b.store_items, [{ id: 'i' }]);
    assert.deepEqual(b.store_batches, [{ name: 'b' }]);
    assert.deepEqual(b.notifications, [{ release_id: 9 }]);
    assert.deepEqual(b.price_history, []);
    assert.deepEqual(b.want_alerts, [{ id: 9, max_price: 2 }]);
    assert.deepEqual(b.wants, [{ id: 9 }]);
    assert.deepEqual(b.marketplace_stats, []);
});

test('m4 _bulkPut rejects when the transaction aborts', async () => {
    const vmCtx = { console, Promise, Error };
    vm.createContext(vmCtx);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/backup.js'), 'utf8'), vmCtx, { filename: 'src/backup.js' });
    let tx;
    vmCtx.openDB = async () => ({
        transaction() {
            tx = { error: null, abort() {}, objectStore: () => ({ put() {} }) };
            return tx;
        },
    });
    const p = vmCtx._bulkPut('releases', [{ id: 1 }]);
    await new Promise(r => setTimeout(r, 0));
    tx.error = new Error('QuotaExceededError');
    tx.onabort();
    await assert.rejects(p, /QuotaExceededError/);

    // A put that throws synchronously aborts the whole transaction.
    let aborted = false;
    vmCtx.openDB = async () => ({
        transaction() {
            return { abort() { aborted = true; }, objectStore: () => ({ put() { throw new Error('DataError'); } }) };
        },
    });
    await assert.rejects(vmCtx._bulkPut('releases', [{ id: 1 }]), /DataError/);
    assert.equal(aborted, true);
});

test('m5 releases merge: newer local community counts kept; video picks merged, local winning', async () => {
    const { ctx, store } = makeApp();
    await ctx.dbPut('releases', {
        id: 1, community_have: 50, community_want: 60, community_fetched_at: '2026-11-01T00:00:00Z',
        video_overrides: { A1: 'local', B1: 'localB' },
    });
    await ctx.dbPut('releases', {
        id: 2, community_have: 1, community_want: 2, community_fetched_at: '2026-01-01T00:00:00Z',
    });
    await ctx.restoreBackup(ctx._normalizeBackup({
        _app: 'VinylCollectionPlayer', _version: 3,
        collection: { releases: [
            { id: 1, community_have: 5, community_want: 6, community_fetched_at: '2026-06-01T00:00:00Z',
                video_overrides: { A1: 'file', A2: 'fileA2' } },
            { id: 2, community_have: 10, community_want: 20, community_fetched_at: '2026-06-01T00:00:00Z' },
        ] },
    }));
    const r1 = store('releases').get(1);
    assert.equal(r1.community_have, 50, 'local reading is newer');
    assert.equal(r1.community_want, 60);
    assert.equal(r1.community_fetched_at, '2026-11-01T00:00:00Z');
    assert.deepEqual(plain(r1.video_overrides), { A1: 'local', A2: 'fileA2', B1: 'localB' });
    const r2 = store('releases').get(2);
    assert.equal(r2.community_have, 10, 'backup reading is newer');
    assert.equal(r2.community_want, 20);
    assert.equal(r2.community_fetched_at, '2026-06-01T00:00:00Z');
});

test('m5 restore is refused while a sync is running', async () => {
    const { ctx, store, toasts } = makeApp();
    ctx._syncRunning = true;
    await assert.rejects(ctx.restoreBackup(ctx._normalizeBackup(V2)), /sync is running/);
    assert.equal(store('releases').size, 0, 'nothing written');

    let read = false;
    ctx.FileReader = function () { this.readAsText = () => { read = true; }; };
    const input = { files: [{ name: 'b.json' }], value: 'b.json' };
    ctx.importBackupFile(input);
    assert.equal(read, false, 'file not even read');
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0][1], 'error');
    assert.match(toasts[0][0], /sync is running/i);
});

// ---------- shared with the Analyzer tab ----------

test('buildFullBackup resolves to the same payload exportFullBackup downloads', async () => {
    const { ctx } = makeApp();
    await ctx.dbPut('config', { key: 'discogs_token', value: 'SECRET' });
    await ctx.dbPut('videos', { release_id: 1, youtube_id: 'yt1' });
    const payload = plain(await ctx.buildFullBackup());
    assert.equal(payload._version, 3);
    assert.equal(payload.collection.videos.length, 1);
    assert.ok(!JSON.stringify(payload).includes('SECRET'), 'token never exported');

    let text = null;
    ctx.downloadBlob = (_n, _t, t) => { text = t; };
    await ctx.exportFullBackup();
    const downloaded = JSON.parse(text);
    delete downloaded.exported_at;
    delete payload.exported_at;
    assert.deepEqual(downloaded, payload);
});

test('restoreParsedBackup: same rules and toast as Restore from backup; null when refused', async () => {
    const { ctx, store, toasts } = makeApp();
    const res = await ctx.restoreParsedBackup({
        _app: 'VinylCollectionPlayer', _version: 2,
        track_meta: [{ id: '1_yt', bpm: 128, bpm_source: 'analysis' }, { id: '2_yt', bpm: 90, bpm_source: 'analysis' }],
    });
    assert.equal(res.counts.track_meta, 2);
    assert.equal(store('track_meta').get('1_yt').bpm_source, 'analysis');
    assert.deepEqual(toasts.pop(), ['Restored (v2): 2 track metadata records', 'success']);

    assert.equal(await ctx.restoreParsedBackup({ hello: 1 }), null);
    assert.match(toasts.pop()[0], /does not look like a Vinyl Collection Player backup/);

    ctx._syncRunning = true;
    assert.equal(await ctx.restoreParsedBackup({ _app: 'VinylCollectionPlayer', track_meta: [{ id: 'x' }] }), null);
    assert.match(toasts.pop()[0], /sync is running/i);
    assert.equal(store('track_meta').has('x'), false);
});
