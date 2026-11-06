// F11 Stats: breakdowns, decades, collectability, the collection value record,
// and the have/want counts the sync records and keeps. The app is plain
// <script> files, loaded into a VM context with the stand-ins they need.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function load(files, extra = {}) {
    const ctx = { Math, Date, JSON, console, document: { addEventListener() {}, getElementById() { return null; } }, ...extra };
    vm.createContext(ctx);
    for (const f of files) vm.runInContext(read(f), ctx, { filename: f });
    return ctx;
}

const S = load(['src/utils.js', 'src/actions.js', 'src/views/stats.js']);
const plain = v => JSON.parse(JSON.stringify(v));

test('decade from year; 0, missing and junk are Unknown', () => {
    assert.equal(S.statsDecade(1977), '1970s');
    assert.equal(S.statsDecade(1980), '1980s');
    assert.equal(S.statsDecade(2009), '2000s');
    assert.equal(S.statsDecade('1994'), '1990s');
    for (const y of [0, null, undefined, '', 'n/a', NaN]) assert.equal(S.statsDecade(y), 'Unknown', String(y));
});

test('list fields split from strings or arrays, once each, keeping comma names whole', () => {
    assert.deepEqual(plain(S.statsSplitList('Electronic, Rock')), ['Electronic', 'Rock']);
    assert.deepEqual(plain(S.statsSplitList('Vinyl, Vinyl')), ['Vinyl']);
    assert.deepEqual(plain(S.statsSplitList(['Vinyl', 'CD', 'Vinyl'])), ['Vinyl', 'CD']);
    assert.deepEqual(plain(S.statsSplitList('Folk, World, & Country, Jazz')), ['Folk, World, & Country', 'Jazz']);
    assert.deepEqual(plain(S.statsSplitList(null)), []);
    assert.deepEqual(plain(S.statsSplitList('')), []);
});

const rel = (o) => ({ id: o.id || 1, artist: 'A', title: 'T', year: null, genres: null, styles: null, format: null, country: null, ...o });

test('breakdown counts releases, sorts by count, and folds the rest into Other', () => {
    const releases = [
        rel({ id: 1, country: 'UK' }), rel({ id: 2, country: 'UK' }), rel({ id: 3, country: 'UK' }),
        rel({ id: 4, country: 'US' }), rel({ id: 5, country: 'US' }),
        rel({ id: 6, country: 'Germany' }), rel({ id: 7, country: 'France' }), rel({ id: 8, country: 'Japan' }),
        rel({ id: 9, country: null }), rel({ id: 10 })
    ];
    const b = plain(S.statsBreakdown(releases, 'country', 2));
    assert.equal(b.total, 10);
    assert.equal(b.distinct, 5);
    assert.deepEqual(b.rows.map(r => [r.label, r.count, r.kind]), [
        ['UK', 3, 'value'], ['US', 2, 'value'], ['Other', 3, 'other'], ['Unknown', 2, 'unknown']
    ]);
    assert.equal(b.rows[2].labels, 3);
    assert.equal(b.rows[0].pct, 30);
    assert.equal(b.max, 3);
    // Single-valued: the rows add up to every release.
    assert.equal(b.rows.reduce((s, r) => s + r.count, 0), 10);
});

test('breakdown ties sort by label, and one leftover value shows by name rather than as Other', () => {
    const releases = [rel({ id: 1, country: 'B' }), rel({ id: 2, country: 'A' }), rel({ id: 3, country: 'C' })];
    const b = plain(S.statsBreakdown(releases, 'country', 2));
    assert.deepEqual(b.rows.map(r => r.label), ['A', 'B', 'C']);
    assert.equal(b.rows.some(r => r.kind === 'other'), false);
});

test('multi-valued breakdown: a release counts under each value, Other counts releases', () => {
    const releases = [
        rel({ id: 1, genres: 'Electronic, Rock' }),
        rel({ id: 2, genres: 'Electronic' }),
        rel({ id: 3, genres: 'Jazz, Funk / Soul, Folk, World, & Country' }),
        rel({ id: 4, genres: 'Electronic, Jazz, Hip Hop' })
    ];
    const b = plain(S.statsBreakdown(releases, 'genres', 2));
    assert.deepEqual(b.rows.map(r => [r.label, r.count]), [['Electronic', 3], ['Jazz', 2], ['Other', 3]]);
    assert.equal(b.rows[2].labels, 4); // Rock, Funk / Soul, Folk, World, & Country, Hip Hop
    assert.equal(b.rows[0].pct, 75);
});

test('format breakdown reads strings and arrays; decade breakdown sorts oldest first', () => {
    const releases = [
        rel({ id: 1, format: 'Vinyl, Vinyl', year: 1999 }),
        rel({ id: 2, format: 'CD', year: 1972 }),
        rel({ id: 3, format: undefined, formats: ['Vinyl', 'Cassette'], year: 0 }),
        rel({ id: 4, format: 'Vinyl', year: 1975 })
    ];
    const f = plain(S.statsBreakdown(releases, 'format', 10));
    assert.deepEqual(f.rows.map(r => [r.label, r.count]), [['Vinyl', 3], ['CD', 1], ['Cassette', 1]]);
    const d = plain(S.statsBreakdown(releases, 'decade', 0, 'label'));
    assert.deepEqual(d.rows.map(r => [r.label, r.count]), [['1970s', 2], ['1990s', 1], ['Unknown', 1]]);
});

test('breakdown of nothing is empty', () => {
    const b = plain(S.statsBreakdown([], 'genres', 5));
    assert.deepEqual(b, { total: 0, distinct: 0, max: 0, rows: [] });
});

test('collectability: totals, most wanted, and want/have ratio with a minimum of wants', () => {
    const at = '2026-11-01T00:00:00Z';
    const releases = [
        rel({ id: 1, artist: 'X', title: 'Common', community_have: 5000, community_want: 900, community_fetched_at: at }),
        rel({ id: 2, artist: 'Y', title: 'Rare', community_have: 20, community_want: 400, community_fetched_at: at }),
        rel({ id: 3, artist: 'Z', title: 'Nobody has it', community_have: 0, community_want: 30, community_fetched_at: at }),
        rel({ id: 4, artist: 'W', title: 'Few wants', community_have: 0, community_want: 3, community_fetched_at: at }),
        rel({ id: 5, artist: 'V', title: 'No counts sent', community_have: null, community_want: null, community_fetched_at: at }),
        rel({ id: 6, artist: 'U', title: 'Not fetched' })
    ];
    const c = plain(S.statsCollectability(releases, 3, 5));
    assert.equal(c.total, 6);
    assert.equal(c.fetched, 5);
    assert.equal(c.missing, 1);
    assert.equal(c.have, 5020);
    assert.equal(c.want, 1333);
    assert.deepEqual(c.mostWanted.map(i => i.id), [1, 2, 3]);
    // have 0 counts as 1; release 4 has too few wants to rank.
    assert.deepEqual(c.byRatio.map(i => [i.id, i.ratio]), [[3, 30], [2, 20], [1, 0.18]]);
});

test('collectability of releases never fetched', () => {
    const c = plain(S.statsCollectability([rel({ id: 1 }), rel({ id: 2 })]));
    assert.equal(c.fetched, 0);
    assert.equal(c.missing, 2);
    assert.deepEqual(c.mostWanted, []);
    assert.deepEqual(c.byRatio, []);
});

test('ETA in minutes for the backfill', () => {
    assert.equal(S.statsEtaMinutes(0), 0);
    assert.equal(S.statsEtaMinutes(1), 1);
    assert.equal(S.statsEtaMinutes(50), 1);
    assert.equal(S.statsEtaMinutes(500), 10);
});

test('collection value is kept as Discogs formatted it', () => {
    const now = '2026-11-06T12:00:00.000Z';
    const rec = plain(S.statsValueRecord({ minimum: '€1,234.50', median: '€2,000.00', maximum: '€3,100.75' }, now));
    assert.deepEqual(rec, { key: 'collection_value', minimum: '€1,234.50', median: '€2,000.00', maximum: '€3,100.75', fetched_at: now });
    // Not strings are dropped, not converted; nothing usable is null.
    assert.equal(plain(S.statsValueRecord({ minimum: 12, median: '$5.00' }, now)).minimum, '');
    assert.equal(S.statsValueRecord({}, now), null);
    assert.equal(S.statsValueRecord(null, now), null);
});

test('percent labels', () => {
    assert.equal(S.statsPctLabel(0), '0%');
    assert.equal(S.statsPctLabel(0.4), '<1%');
    assert.equal(S.statsPctLabel(33.3), '33%');
    assert.equal(S.statsPctLabel(100), '100%');
});

// ---------- api.js: recording and keeping the counts ----------

function loadApi(db) {
    const el = { style: {}, textContent: '', disabled: false };
    const ctx = load(['src/api.js'], { document: { getElementById: () => el }, setTimeout: (fn) => { fn(); } });
    ctx.dbGet = async (store, id) => db[store] && db[store][id] ? JSON.parse(JSON.stringify(db[store][id])) : undefined;
    ctx.dbPut = async (store, item) => { (db[store] = db[store] || {})[item.id] = JSON.parse(JSON.stringify(item)); };
    ctx.dbGetAll = async (store) => Object.values(db[store] || {});
    ctx.dbDelete = async (store, id) => { delete db[store][id]; };
    ctx.dbDeleteByIndex = async () => {};
    ctx.sleep = async () => {};
    return ctx;
}

test('the per-release fetch records have/want, and marks releases with no counts as fetched', () => {
    const api = loadApi({});
    const r = plain(api.applyReleaseCommunity({ id: 1 }, { community: { have: 12, want: 34, rating: {} } }));
    assert.equal(r.community_have, 12);
    assert.equal(r.community_want, 34);
    assert.ok(Number.isFinite(Date.parse(r.community_fetched_at)));
    const none = plain(api.applyReleaseCommunity({ id: 2 }, {}));
    assert.equal(none.community_have, null);
    assert.equal(none.community_want, null);
    assert.ok(none.community_fetched_at);
});

test('a collection sync keeps the counts already recorded', async () => {
    const db = {
        releases: {
            7: { id: 7, title: 'Old', synced_at: 'x', country: 'UK', community_have: 10, community_want: 20, community_fetched_at: '2026-10-01T00:00:00Z' },
            8: { id: 8, title: 'Old 2', synced_at: 'x', country: 'US' }
        }
    };
    const api = loadApi(db);
    api.discogsGet = async (p) => {
        if (p.endsWith('/collection/folders')) return { folders: [{ id: 0, name: 'All', count: 2 }] };
        return {
            pagination: { pages: 1, items: 2 },
            releases: [7, 8].map(id => ({ basic_information: { id, title: 'New ' + id, artists: [{ name: 'A' }], formats: [{ name: 'Vinyl' }] } }))
        };
    };
    await api.syncCollection({ username: 'me', token: 't' });
    assert.equal(db.releases[7].title, 'New 7');
    assert.equal(db.releases[7].community_have, 10);
    assert.equal(db.releases[7].community_want, 20);
    assert.equal(db.releases[7].community_fetched_at, '2026-10-01T00:00:00Z');
    assert.equal('community_fetched_at' in db.releases[8], false);
});

test('the collectability backfill also records the country from the same fetch', async () => {
    const db = {
        releases: {
            7: { id: 7, artist: 'A', title: 'T', country: null },
            8: { id: 8, artist: 'B', title: 'U', country: 'UK' }
        }
    };
    const api = loadApi(db);
    vm.runInContext(read('src/utils.js'), api, { filename: 'src/utils.js' });
    vm.runInContext(read('src/views/stats.js'), api, { filename: 'src/views/stats.js' });
    api.getConfig = async () => ({ token: 't', username: 'me' });
    api.showSyncBanner = () => {};
    api.hideSyncBanner = () => {};
    api.showToast = () => {};
    api._currentView = 'collection';
    api.discogsGet = async (p) => p === '/releases/7'
        ? { country: 'Germany', community: { have: 1, want: 2 } }
        : { community: { have: 3, want: 4 } };
    await api.statsStartBackfill();
    assert.equal(db.releases[7].country, 'Germany');
    assert.equal(db.releases[7].community_have, 1);
    assert.equal(db.releases[8].country, 'UK', 'no country in the response keeps the stored one');
    assert.equal(db.releases[8].community_want, 4);
    assert.equal(api._syncRunning, false, 'lock released');
});
