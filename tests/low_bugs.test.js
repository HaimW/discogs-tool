// L2, L5 and L6 from docs/PROJECT_PLAN.md. The app is plain <script> files;
// each is loaded into a VM context with the stand-ins it needs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function load(files, extra = {}) {
    const ctx = { Math, Date, JSON, console, ...extra };
    vm.createContext(ctx);
    for (const f of files) vm.runInContext(read(f), ctx, { filename: f });
    return ctx;
}

// ---------- L6: one "…" per gap ----------

test('L6: pages shown, with one gap marker per gap', () => {
    const { paginationPages } = load(['src/utils.js']);
    const pages = (p, n) => JSON.stringify(paginationPages(p, n));
    // The old code printed "1 2 3 … … 10 11 12" here.
    assert.equal(pages(1, 12), JSON.stringify([1, 2, 3, null, 10, 11, 12]));
    assert.equal(pages(8, 16), JSON.stringify([1, 2, 3, null, 6, 7, 8, 9, 10, null, 14, 15, 16]));
    assert.equal(pages(12, 12), JSON.stringify([1, 2, 3, null, 10, 11, 12]));
    // A one-page gap shows the page: 4 sits between 3 and 5.
    assert.equal(pages(7, 12), JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
    assert.equal(pages(1, 7), JSON.stringify([1, 2, 3, 4, 5, 6, 7]));
    assert.equal(pages(1, 1), JSON.stringify([1]));
});

test('L6: no two gap markers in a row, for any page of any size', () => {
    const { paginationPages } = load(['src/utils.js']);
    for (let n = 1; n <= 40; n++) {
        for (let p = 1; p <= n; p++) {
            const out = paginationPages(p, n);
            assert.ok(out.includes(p), `current page ${p}/${n} shown`);
            for (let i = 1; i < out.length; i++) {
                assert.ok(!(out[i] === null && out[i - 1] === null), `${p}/${n}: doubled gap`);
                if (out[i] !== null && out[i - 1] !== null) assert.equal(out[i], out[i - 1] + 1, `${p}/${n}: hidden page without a marker`);
            }
            const gaps = out.filter(x => x === null).length;
            assert.ok(gaps <= 2, `${p}/${n}: at most two gaps`);
        }
    }
});

test('L6: the pager HTML links pages through the named function', () => {
    const { renderPagination } = load(['src/utils.js', 'src/actions.js'], { document: { addEventListener() {} } });
    assert.equal(renderPagination(1, 1, 'goPage'), '');
    const html = renderPagination(1, 12, 'tGoPage');
    assert.equal((html.match(/page-dots/g) || []).length, 1);
    assert.match(html, /data-on-click="tGoPage" data-args-click="\[2\]">Next &raquo;/);
    assert.match(html, /<span class="page-link active">1<\/span>/);
    assert.doesNotMatch(html, /Prev/);
});

// ---------- L5: dates ----------

test('L5: malformed or missing dates never render as NaN', () => {
    const ctx = load(['src/utils.js', 'src/marketplace.js']);
    assert.equal(ctx.dateMs('not a date'), null);
    assert.equal(ctx.dateMs(undefined), null);
    assert.equal(ctx.dateMs(''), null);
    assert.equal(ctx.dateMs('2026-11-06T10:00:00Z'), Date.parse('2026-11-06T10:00:00Z'));

    assert.equal(ctx.formatTimeAgo('garbage'), '');
    assert.equal(ctx.formatTimeAgo(null), '');
    assert.equal(ctx.formatTimeAgo(new Date(Date.now() - 5 * 60000).toISOString()), '5m ago');
    assert.equal(ctx.formatTimeAgo(new Date(Date.now() - 3 * 86400000).toISOString()), '3d ago');
    assert.equal(ctx.formatTimeAgo(new Date(Date.now() + 30000).toISOString()), 'just now');
});

test('L5: a reading with a malformed date is due for a check and a snapshot', () => {
    const ctx = load(['src/utils.js', 'src/marketplace.js']);
    const reading = { num_for_sale: 1, lowest_price: 5, currency: 'EUR', snapshot_at: 'garbage' };
    assert.equal(ctx._shouldSnapshot(reading, 1, 5, 'EUR', Date.now()), true);
});

// ---------- L2: the queue panel's document listeners ----------

test('L2: re-rendering the queue panel removes the old panel\'s document listeners', () => {
    const listeners = new Map();
    // Only the drag listeners: actions.js adds its own app-wide ones.
    const count = () => ['mousemove', 'mouseup'].reduce((n, t) => n + (listeners.get(t)?.size || 0), 0);
    let panelEl = null;

    function element(id) {
        return {
            id, style: {}, className: '', children: [], dataset: {},
            set innerHTML(_) {}, get innerHTML() { return ''; },
            addEventListener() {}, appendChild() {}, setAttribute() {},
            classList: { add() {}, remove() {}, toggle() {} },
            querySelector(sel) { return sel === '.queue-header' ? element() : null; },
            querySelectorAll() { return []; },
            getBoundingClientRect() { return { left: 0, top: 0 }; },
            remove() { if (panelEl === this) panelEl = null; },
            closest() { return null; },
        };
    }
    const document = {
        addEventListener(type, fn) { (listeners.get(type) || listeners.set(type, new Set()).get(type)).add(fn); },
        removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
        getElementById(id) { return id === 'queue-panel' ? panelEl : element(id); },
        createElement() { return element(); },
        body: { appendChild(el) { panelEl = el; } },
    };
    const ctx = load(['src/utils.js', 'src/actions.js', 'src/queue.js'], {
        document, window: { innerWidth: 1000, innerHeight: 800 }, setTimeout: () => 0,
        // The rows' BPM / key (F16) are read after drawing; none here.
        Promise, dbGetAll: () => Promise.resolve([]),
        currentQueue: [{ title: 't', artist: 'a', youtubeId: 'x' }], currentIndex: 0,
    });
    ctx._renderQueuePanel();
    const afterOne = count();
    assert.ok(afterOne > 0, 'the panel listens on document while open');
    for (let i = 0; i < 5; i++) ctx._renderQueuePanel();
    assert.equal(count(), afterOne, 'no extra listeners after five re-renders');
    ctx.closeQueue();
    assert.equal(count(), 0, 'closing removes them all');
});
