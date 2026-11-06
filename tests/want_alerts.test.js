// F9: per-want max-price alerts. The decision is a pure function in
// src/marketplace.js; the sync and removal paths are exercised against an
// in-memory stand-in for IndexedDB, as in data_safety.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const FILES = ['src/utils.js', 'src/api.js', 'src/marketplace.js', 'src/views/wantlist.js', 'src/views/wantlist_sync.js'];
const INDEXES = { notifications: ['release_id'], price_history: ['release_id'] };

function makeApp() {
    const stores = {};
    const store = name => (stores[name] = stores[name] || new Map());
    let nextId = 1;
    const ctx = {
        console: { log() {}, warn() {}, error() {} },
        Date, JSON, Math, Object, Promise, setTimeout, clearTimeout,
        confirm: () => true,
        _currentView: 'collection',
        dbPut: async (s, item) => {
            const rec = structuredClone(item);
            if (rec.id === undefined) rec.id = nextId++;
            store(s).set(rec.id, rec);
        },
        dbGet: async (s, k) => structuredClone(store(s).get(k)),
        dbGetAll: async s => [...store(s).values()].map(r => structuredClone(r)),
        dbDelete: async (s, k) => { store(s).delete(k); },
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
    ctx.showSyncBanner = () => {};
    ctx.hideSyncBanner = () => {};
    ctx.updateNotifBadge = () => Promise.resolve();
    ctx.renderWantList = () => {};
    ctx.showToast = () => {};
    return { ctx, store };
}

const plain = v => JSON.parse(JSON.stringify(v));
const reading = (num, price, currency = 'EUR') => ({ num_for_sale: num, lowest_price: price, currency });
const MAX = { id: 1, max_price: 20, currency: 'EUR' };

// ---------- the decision ----------

test('no max set: the plain 0 -> 1+ alert fires as before', () => {
    const { ctx } = makeApp();
    const d = plain(ctx._wantAlertDecision({ num_for_sale: 0 }, reading(2, 50), undefined));
    assert.deepEqual(d.notify, ['for_sale']);
    assert.equal(d.under_max, false);
    assert.deepEqual(plain(ctx._wantAlertDecision({ num_for_sale: 1 }, reading(2, 50), undefined)).notify, [],
        'already for sale: no repeat');
    assert.deepEqual(plain(ctx._wantAlertDecision({ num_for_sale: 3 }, reading(0, null), undefined)).notify, []);
});

test('max set, same currency: 0 -> 1+ above max is suppressed', () => {
    const { ctx } = makeApp();
    const d = plain(ctx._wantAlertDecision({ num_for_sale: 0 }, reading(1, 25), MAX));
    assert.deepEqual(d.notify, []);
    assert.equal(d.under_max, false);
    assert.equal(d.max_applies, true);
});

test('max set, same currency: 0 -> 1+ at or under max raises one price alert', () => {
    const { ctx } = makeApp();
    const d = plain(ctx._wantAlertDecision({ num_for_sale: 0 }, reading(1, 20), MAX));
    assert.deepEqual(d.notify, ['under_max'], 'the price alert supersedes the plain one');
    assert.equal(d.under_max, true);
});

test('price drop into the max while for sale alerts once, then not again', () => {
    const { ctx } = makeApp();
    let prev = { num_for_sale: 3, lowest_price: 30, currency: 'EUR', under_max: false };
    let d = plain(ctx._wantAlertDecision(prev, reading(3, 18), MAX));
    assert.deepEqual(d.notify, ['under_max']);
    assert.equal(d.under_max, true);

    prev = { num_for_sale: 3, lowest_price: 18, currency: 'EUR', under_max: true };
    d = plain(ctx._wantAlertDecision(prev, reading(4, 15), MAX));
    assert.deepEqual(d.notify, [], 'still under max: no repeat even as the price falls further');
    assert.equal(d.under_max, true);
});

test('leaving the under-max state re-arms the alert', () => {
    const { ctx } = makeApp();
    // Price rises above max.
    let d = plain(ctx._wantAlertDecision({ num_for_sale: 2, under_max: true }, reading(2, 25), MAX));
    assert.deepEqual(d.notify, []);
    assert.equal(d.under_max, false);
    d = plain(ctx._wantAlertDecision({ num_for_sale: 2, under_max: false }, reading(2, 19), MAX));
    assert.deepEqual(d.notify, ['under_max']);

    // Nothing for sale, then back under max.
    d = plain(ctx._wantAlertDecision({ num_for_sale: 2, under_max: true }, reading(0, null), MAX));
    assert.deepEqual(d.notify, []);
    assert.equal(d.under_max, false);
    d = plain(ctx._wantAlertDecision({ num_for_sale: 0, under_max: false }, reading(1, 10), MAX));
    assert.deepEqual(d.notify, ['under_max']);
});

test('no row or a restored baseline: the guard is set silently (M5)', () => {
    const { ctx } = makeApp();
    let d = plain(ctx._wantAlertDecision(undefined, reading(1, 10), MAX));
    assert.deepEqual(d.notify, []);
    assert.equal(d.under_max, true);

    d = plain(ctx._wantAlertDecision({ num_for_sale: 0, baseline_restored: true, under_max: false }, reading(1, 10), MAX));
    assert.deepEqual(d.notify, []);
    assert.equal(d.under_max, true);

    d = plain(ctx._wantAlertDecision({ num_for_sale: 0, baseline_restored: true }, reading(1, 10), undefined));
    assert.deepEqual(d.notify, [], 'no plain alert from a restored baseline either');
});

test('currency mismatch: no price alert, falls back to the plain 0 -> 1+ alert', () => {
    const { ctx } = makeApp();
    const usdMax = { id: 1, max_price: 20, currency: 'USD' };
    let d = plain(ctx._wantAlertDecision({ num_for_sale: 0 }, reading(1, 50, 'EUR'), usdMax));
    assert.deepEqual(d.notify, ['for_sale'], 'above the number but not comparable: plain alert still fires');
    assert.equal(d.max_applies, false);
    assert.equal(d.under_max, false);

    d = plain(ctx._wantAlertDecision({ num_for_sale: 2, under_max: false }, reading(2, 5, 'EUR'), usdMax));
    assert.deepEqual(d.notify, [], 'a price below the number in another currency is no alert');
});

test('max price at exactly the lowest price counts as under', () => {
    const { ctx } = makeApp();
    assert.equal(plain(ctx._wantAlertDecision(undefined, reading(1, 20), MAX)).under_max, true);
    assert.equal(plain(ctx._wantAlertDecision(undefined, reading(1, 20.01), MAX)).under_max, false);
});

// ---------- through the sync ----------

const CONFIG = { token: 't', username: 'me' };

test('sync: a price alert carries price, currency and the max, and does not repeat', async () => {
    const { ctx, store } = makeApp();
    await ctx.dbPut('wants', { id: 1, artist: 'A', title: 'T' });
    await ctx.dbPut('want_alerts', MAX);
    let data = { num_for_sale: 2, lowest_price: { value: 30, currency: 'EUR' } };
    ctx.discogsGet = async () => data;
    const tick = () => new Promise(r => setTimeout(r, 3));
    const notes = () => [...store('notifications').values()];

    await ctx.syncMarketplaceStats(false, CONFIG);     // baseline
    assert.equal(notes().length, 0);
    assert.equal(store('marketplace_stats').get(1).under_max, false);

    data = { num_for_sale: 2, lowest_price: { value: 18, currency: 'EUR' } };
    await tick();
    await ctx.syncMarketplaceStats(false, CONFIG);
    assert.equal(notes().length, 1);
    const n = notes()[0];
    assert.equal(n.type, 'under_max');
    assert.equal(n.lowest_price, 18);
    assert.equal(n.currency, 'EUR');
    assert.equal(n.max_price, 20);
    assert.equal(n.max_currency, 'EUR');
    assert.equal(store('marketplace_stats').get(1).under_max, true);

    data = { num_for_sale: 3, lowest_price: { value: 17, currency: 'EUR' } };
    await tick();
    await ctx.syncMarketplaceStats(false, CONFIG);
    assert.equal(notes().length, 1, 'no repeat while it stays under max');
});

test('sync: the plain for-sale alert is typed for_sale', async () => {
    const { ctx, store } = makeApp();
    await ctx.dbPut('wants', { id: 2, artist: 'A', title: 'T' });
    await ctx.dbPut('marketplace_stats', { id: 2, num_for_sale: 0 });
    ctx.discogsGet = async () => ({ num_for_sale: 1, lowest_price: { value: 9, currency: 'USD' } });
    await ctx.syncMarketplaceStats(false, CONFIG);
    const all = [...store('notifications').values()];
    assert.equal(all.length, 1);
    assert.equal(all[0].type, 'for_sale');
});

// ---------- the want's alert goes with the want, and survives want sync ----------

test('removeWantData deletes the want alert; want sync keeps alerts of listed wants', async () => {
    const { ctx, store } = makeApp();
    for (const id of [1, 2]) {
        await ctx.dbPut('wants', { id, artist: 'A', title: 'T' });
        await ctx.dbPut('want_alerts', { id, max_price: 10, currency: 'USD' });
    }
    ctx.discogsGet = async () => ({
        wants: [{ basic_information: { id: 1, title: 'T' } }],
        pagination: { pages: 1, items: 1 },
    });
    await ctx.syncWantList(CONFIG);
    assert.ok(store('want_alerts').has(1), 'listed want keeps its alert');
    assert.ok(!store('want_alerts').has(2), 'dropped want loses its alert');
});

// ---------- input validation ----------

test('_parseMaxPrice accepts positive amounts only', () => {
    const { ctx } = makeApp();
    assert.equal(ctx._parseMaxPrice('25'), 25);
    assert.equal(ctx._parseMaxPrice(' 25.5 '), 25.5);
    assert.equal(ctx._parseMaxPrice('12,50'), 12.5);
    assert.equal(ctx._parseMaxPrice('.99'), 0.99);
    assert.equal(ctx._parseMaxPrice('19.999'), 20);
    for (const bad of ['', '0', '0.00', '0.001', '-5', 'abc', '1e3', '12.5.1', 'Infinity', null, undefined]) {
        assert.equal(ctx._parseMaxPrice(bad), null, String(bad));
    }
});

test('_wantAlertCurrencyMismatch marks a max the listing cannot be compared with', () => {
    const { ctx } = makeApp();
    assert.equal(ctx._wantAlertCurrencyMismatch(MAX, { currency: 'USD' }), true);
    assert.equal(ctx._wantAlertCurrencyMismatch(MAX, { currency: 'EUR' }), false);
    assert.equal(ctx._wantAlertCurrencyMismatch(MAX, { currency: null }), false, 'unknown yet: no marker');
    assert.equal(ctx._wantAlertCurrencyMismatch(MAX, undefined), false);
    assert.equal(ctx._wantAlertCurrencyMismatch(undefined, { currency: 'USD' }), false);
});

// ---------- review round 1 ----------

test('m6 the marketplace poll skips a tick while a collection sync or stats backfill runs', async () => {
    const { ctx } = makeApp();
    let tick = null;
    ctx.setInterval = fn => { tick = fn; return 1; };
    ctx.getConfig = async () => ({ token: 't', username: 'u' });
    let polls = 0;
    ctx.syncMarketplaceStats = () => { polls++; };
    ctx.startMarketplacePoll();
    assert.equal(typeof tick, 'function');

    ctx._syncRunning = true;
    tick();
    await new Promise(r => setTimeout(r, 0));
    assert.equal(polls, 0, 'skipped while _syncRunning');

    ctx._syncRunning = false;
    tick();
    await new Promise(r => setTimeout(r, 0));
    assert.equal(polls, 1);
});

test('M2 the for-sale badge escapes a restored currency', async () => {
    const { ctx } = makeApp();
    const app = {
        innerHTML: '', removeAttribute() {}, classList: { remove() {} }, querySelector: () => null,
    };
    ctx.document = { getElementById: id => (id === 'app' ? app : null), addEventListener() {} };
    // The real view, not the stub, with just enough of the page around it.
    const FILES_UI = ['src/actions.js', 'src/meta.js', 'src/view_state.js', 'src/router.js', 'src/views/wantlist.js'];
    for (const f of FILES_UI) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
    ctx.playerReady = false;
    ctx._currentView = 'wantlist';   // views draw only while on their own route
    await ctx.dbPut('wants', { id: 9, artist: 'A', title: 'T' });
    await ctx.dbPut('marketplace_stats', {
        id: 9, num_for_sale: 2, lowest_price: 5,
        currency: '"><img src=x onerror=alert(2)>',
    });
    ctx.renderWantList();
    for (let i = 0; i < 5 && !app.innerHTML; i++) await new Promise(r => setTimeout(r, 0));
    assert.match(app.innerHTML, /badge-for-sale[^>]*>2 for sale</, 'badge rendered with the count');
    assert.ok(!/<img src=x/.test(app.innerHTML), 'no injected markup');
});
