// P6: the shared loading / error wrapper the router runs every view through
// (src/view_state.js), and the database-open errors it explains (src/db.js).
//
// Both are plain <script>s; they are loaded into a VM context with hand-run
// timers and just enough of an element for #app and #view-status.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

function makeEl(html = '') {
    const attrs = {};
    const classes = new Set();
    const el = {
        innerHTML: html,
        textContent: '',
        setAttribute(n, v) { attrs[n] = String(v); },
        removeAttribute(n) { delete attrs[n]; },
        getAttribute(n) { return n in attrs ? attrs[n] : null; },
        classList: {
            add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
        },
        querySelector(sel) {
            if (sel !== '.view-loading' || !el.innerHTML.includes('view-loading')) return null;
            return { parentNode: { removeChild() { el.innerHTML = ''; } } };
        },
    };
    return el;
}

function load() {
    const timers = [];
    const errors = [];
    const ctx = {
        Promise, Error, JSON, String,
        console: { error: (...a) => errors.push(a), warn() {}, log() {} },
        setTimeout(fn, ms) { timers.push({ fn, ms, live: true }); return timers.length; },
        clearTimeout(id) { if (timers[id - 1]) timers[id - 1].live = false; },
        retried: 0,
    };
    vm.createContext(ctx);
    for (const f of ['src/utils.js', 'src/actions.js', 'src/view_state.js']) {
        // actions.js wires document listeners at load; give it a stub.
        ctx.document = { addEventListener() {} };
        vm.runInContext(read(f), ctx, { filename: f });
    }
    ctx.renderCurrentView = () => { ctx.retried++; };
    const root = makeEl('<p>old view</p>');
    const status = makeEl();
    // Fires every live timer due by now (all of them: the tests pick when).
    const runTimers = () => { for (const t of timers.splice(0)) if (t.live) t.fn(); };
    const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };
    return { ctx, root, status, timers, errors, runTimers, flush };
}

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

test('a fast render shows no loading state at all (no flash)', async () => {
    const { ctx, root, status, timers, runTimers, flush } = load();
    const ok = await ctx.runViewRender(() => { root.innerHTML = '<p>new</p>'; return Promise.resolve(); },
        { root, status, label: 'tracks', replace: true });
    assert.equal(ok, true);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, ctx.VIEW_LOADING_DELAY_MS);
    assert.ok(ctx.VIEW_LOADING_DELAY_MS >= 200 && ctx.VIEW_LOADING_DELAY_MS <= 300);
    runTimers();
    await flush();
    assert.equal(root.innerHTML, '<p>new</p>');
    assert.equal(root.getAttribute('aria-busy'), null);
    assert.equal(status.textContent, '');
});

test('a slow move to another view: busy, loading block, announced; cleared when drawn', async () => {
    const { ctx, root, status, runTimers } = load();
    const d = deferred();
    const done = ctx.runViewRender(() => d.promise, { root, status, label: 'tracks', replace: true });
    runTimers();
    assert.equal(root.getAttribute('aria-busy'), 'true');
    assert.match(root.innerHTML, /class="view-loading"/);
    assert.match(root.innerHTML, /view-loading-spinner" aria-hidden="true"/);
    assert.equal(status.textContent, 'Loading tracks…');

    root.innerHTML = '<p>tracks</p>';   // what the view does when its data arrives
    d.resolve();
    assert.equal(await done, true);
    assert.equal(root.getAttribute('aria-busy'), null);
    assert.equal(status.textContent, '');
    assert.equal(root.innerHTML, '<p>tracks</p>');
});

test('a slow refresh of the same view keeps its content, only dimmed', async () => {
    const { ctx, root, status, runTimers } = load();
    const d = deferred();
    const done = ctx.runViewRender(() => d.promise, { root, status, label: 'tracks', replace: false });
    runTimers();
    assert.equal(root.innerHTML, '<p>old view</p>');
    assert.ok(root.classList.contains('view-refreshing'));
    assert.equal(root.getAttribute('aria-busy'), 'true');
    d.resolve();
    await done;
    assert.ok(!root.classList.contains('view-refreshing'));
    assert.equal(root.getAttribute('aria-busy'), null);
});

test('a render that throws synchronously shows the error with Try again, and logs it', async () => {
    const { ctx, root, status, errors } = load();
    const boom = new Error('kaput <b>');
    const ok = await ctx.runViewRender(() => { throw boom; }, { root, status, label: 'stats' });
    assert.equal(ok, false);
    assert.equal(errors.length, 1);
    assert.equal(errors[0][1], boom, 'the error itself is logged, not just a message');
    assert.match(root.innerHTML, /role="alert"/);
    assert.match(root.innerHTML, /This page could not be shown/);
    assert.match(root.innerHTML, /kaput &lt;b&gt;/, 'error text is escaped');
    assert.match(root.innerHTML, /data-on-click="retryCurrentView"/);
    ctx.retryCurrentView();
    assert.equal(ctx.retried, 1, 'Try again re-runs the router');
});

test('a rejected render shows the error and clears the loading state', async () => {
    const { ctx, root, status, errors, runTimers } = load();
    const d = deferred();
    const done = ctx.runViewRender(() => d.promise, { root, status, label: 'stats', replace: true });
    runTimers();
    d.reject(new TypeError('x is undefined'));
    assert.equal(await done, false);
    assert.equal(errors.length, 1);
    assert.equal(root.getAttribute('aria-busy'), null);
    assert.equal(status.textContent, '');
    assert.match(root.innerHTML, /view-error/);
    assert.doesNotMatch(root.innerHTML, /view-loading/);
});

test('a database that would not open gets its own title and plain message', () => {
    const { ctx } = load();
    const err = new Error('The browser is not letting this site store data.');
    err.name = 'DbOpenError';
    const html = ctx.viewErrorHtml(err);
    assert.match(html, /Your saved data could not be opened/);
    assert.match(html, /not letting this site store data/);
    assert.doesNotMatch(html, /details in the browser console/);
});

test('race: a slow older run neither shows loading nor overwrites a newer one', async () => {
    const { ctx, root, status, errors, timers } = load();
    const older = deferred();
    let olderCurrent;
    const a = ctx.runViewRender((isCurrent) => { olderCurrent = isCurrent; return older.promise; },
        { root, status, label: 'stats', replace: true });
    const newer = deferred();
    const b = ctx.runViewRender(() => newer.promise, { root, status, label: 'tracks', replace: true });
    assert.equal(olderCurrent(), false, 'the older run knows it is superseded');

    timers[0].fn();     // the older run's delay passes first
    assert.equal(root.getAttribute('aria-busy'), null, 'no loading state for a superseded run');
    timers[1].fn();
    assert.equal(status.textContent, 'Loading tracks…');

    root.innerHTML = '<p>tracks</p>';
    newer.resolve();
    await b;
    older.reject(new Error('late failure'));
    assert.equal(await a, false);
    assert.equal(errors.length, 1, 'still logged');
    assert.equal(root.innerHTML, '<p>tracks</p>', 'but the newer view stays');
});

test('view tokens: a newer render, or a router run, makes an older one stale', () => {
    const { ctx } = load();
    const t1 = ctx.startViewRender();
    assert.equal(ctx.viewRenderIsCurrent(t1), true);
    const t2 = ctx.startViewRender();
    assert.equal(ctx.viewRenderIsCurrent(t1), false);
    assert.equal(ctx.viewRenderIsCurrent(t2), true);
    ctx.runViewRender(() => {}, { root: makeEl(), status: makeEl() });
    assert.equal(ctx.viewRenderIsCurrent(t2), false, 'a navigation drops a pending direct re-render');
});

// ---------- src/db.js: opening the database ----------

function loadDb(indexedDB) {
    const toasts = [];
    const ctx = {
        Promise, Error, console: { warn() {}, error() {} },
        showToast: (msg, kind) => { const t = { msg, kind, parentNode: {} }; toasts.push(t); return t; },
        _dismissToast: (t) => { t.parentNode = null; },
        alert() {}, window: { location: { reload() {} } },
    };
    if (indexedDB !== undefined) ctx.indexedDB = indexedDB;
    vm.createContext(ctx);
    vm.runInContext(read('src/db.js'), ctx, { filename: 'src/db.js' });
    return { ctx, toasts };
}

// An indexedDB whose open() requests the test settles by hand.
function fakeIDB() {
    const requests = [];
    return {
        requests,
        open() { const req = {}; requests.push(req); return req; },
    };
}

test('openDB: no IndexedDB at all rejects with a plain DbOpenError', async () => {
    const { ctx } = loadDb(undefined);
    await assert.rejects(ctx.openDB(), (err) => {
        assert.equal(err.name, 'DbOpenError');
        assert.equal(err.dbErrorName, 'MissingIndexedDB');
        assert.match(err.message, /IndexedDB/);
        return true;
    });
});

test('openDB: open() throwing (e.g. SecurityError) is explained, not thrown raw', async () => {
    const { ctx } = loadDb({ open() { const e = new Error('denied'); e.name = 'SecurityError'; throw e; } });
    await assert.rejects(ctx.openDB(), (err) => {
        assert.equal(err.name, 'DbOpenError');
        assert.equal(err.dbErrorName, 'SecurityError');
        assert.match(err.message, /private browsing/);
        assert.equal(err.cause.message, 'denied');
        return true;
    });
});

test('openDB: VersionError and private-mode errors map to their advice', () => {
    const { ctx } = loadDb(undefined);
    const named = (name) => Object.assign(new Error(name), { name });
    assert.match(ctx.dbOpenError(named('VersionError')).message, /newer version/);
    assert.match(ctx.dbOpenError(named('InvalidStateError')).message, /private browsing/);
    assert.match(ctx.dbOpenError(named('QuotaExceededError')).message, /storage space/);
    assert.match(ctx.dbOpenError(named('UnknownError')).message, /UnknownError/);
});

test('openDB: callers share one open request; a failure is not cached', async () => {
    const idb = fakeIDB();
    const { ctx } = loadDb(idb);
    const p1 = ctx.openDB();
    const p2 = ctx.openDB();
    assert.equal(idb.requests.length, 1, 'one request for concurrent callers');
    const req = idb.requests[0];
    req.error = Object.assign(new Error('v'), { name: 'VersionError' });
    req.onerror();
    await assert.rejects(p1, { name: 'DbOpenError' });
    await assert.rejects(p2, { name: 'DbOpenError' });

    const p3 = ctx.openDB();
    assert.equal(idb.requests.length, 2, 'Try again opens afresh');
    const db = {};
    idb.requests[1].onsuccess({ target: { result: db } });
    assert.equal(await p3, db);
    assert.equal(await ctx.openDB(), db, 'then the open connection is reused');
    assert.equal(idb.requests.length, 2);
});

test('openDB: a blocked upgrade says so once, waits, and goes on when unblocked', async () => {
    const idb = fakeIDB();
    const { ctx, toasts } = loadDb(idb);
    const p = ctx.openDB();
    const req = idb.requests[0];
    req.onblocked();
    req.onblocked();
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].kind, 'error');
    assert.match(toasts[0].msg, /Another tab/);
    const db = {};
    req.onsuccess({ target: { result: db } });
    assert.equal(await p, db);
    assert.equal(toasts[0].parentNode, null, 'the notice goes once the database opens');
    db.onclose();
    ctx.openDB();
    assert.equal(idb.requests.length, 2, 'a connection the browser closed is reopened');
});

test('openDB: a blocked upgrade that then fails also takes its notice away', async () => {
    const idb = fakeIDB();
    const { ctx, toasts } = loadDb(idb);
    const p = ctx.openDB();
    const req = idb.requests[0];
    req.onblocked();
    req.error = Object.assign(new Error('v'), { name: 'VersionError' });
    req.onerror();
    await assert.rejects(p, { name: 'DbOpenError' });
    assert.equal(toasts[0].parentNode, null, 'the error screen says it now; the waiting notice goes');
});

test('openDB: an old connection closing does not drop the newer one', async () => {
    const idb = fakeIDB();
    const { ctx } = loadDb(idb);
    const p1 = ctx.openDB();
    const old = {};
    idb.requests[0].onsuccess({ target: { result: old } });
    await p1;
    old.onclose();
    const p2 = ctx.openDB();
    const fresh = {};
    idb.requests[1].onsuccess({ target: { result: fresh } });
    assert.equal(await p2, fresh);
    old.onclose();                          // a late second close event of the old one
    ctx.openDB();
    assert.equal(idb.requests.length, 2, 'the newer connection is still used, not reopened');
});

// ---------- src/router.js on top of it ----------

function loadRouter() {
    const env = load();
    const { ctx, root, status } = env;
    ctx.document = { getElementById: id => (id === 'app' ? root : id === 'view-status' ? status : null), addEventListener() {} };
    ctx.history = { pushState() {} };
    ctx.window = { scrollTo() {} };
    // Replaces load()'s renderCurrentView stub with the real router.
    vm.runInContext(read('src/router.js'), ctx, { filename: 'src/router.js' });
    return env;
}

test('router: the database failing inside isConfigured shows the database message', async () => {
    const { ctx, root, errors } = loadRouter();
    ctx.isConfigured = () => {
        const e = new Error('The browser is not letting this site store data.');
        e.name = 'DbOpenError';
        return Promise.reject(e);
    };
    ctx._currentView = 'collection';
    assert.equal(await ctx.renderCurrentView(), false);
    assert.match(root.innerHTML, /Your saved data could not be opened/);
    assert.equal(errors.length, 1);
});

test('router: a view that rejects shows the error; Try again draws it', async () => {
    const { ctx, root } = loadRouter();
    ctx.isConfigured = () => Promise.resolve(true);
    let fail = true;
    ctx.renderStats = () => {
        if (fail) { fail = false; return Promise.reject(new Error('once')); }
        root.innerHTML = '<p>stats</p>';
        return Promise.resolve();
    };
    ctx._currentView = 'stats';
    assert.equal(await ctx.renderCurrentView(), false);
    assert.match(root.innerHTML, /view-error/);
    assert.equal(await ctx.renderCurrentView(), true);
    assert.equal(root.innerHTML, '<p>stats</p>');
});

test('router: a navigation made while isConfigured is pending wins; the older view is not drawn', async () => {
    const { ctx } = loadRouter();
    const gate = deferred();
    ctx.isConfigured = () => gate.promise;
    const drawn = [];
    ctx.renderStats = () => { drawn.push('stats'); };
    ctx.renderTracks = () => { drawn.push('tracks'); };
    ctx._currentView = 'stats';
    const a = ctx.renderCurrentView();
    ctx._currentView = 'tracks';
    const b = ctx.renderCurrentView();
    gate.resolve(true);
    await Promise.all([a, b]);
    assert.deepEqual(drawn, ['tracks']);
});

// ---------- direct re-renders (filter clicks, sync refreshes) ----------
//
// The real setlists view (src/setlists.js) on top of the router, with its
// database reads settled by hand.
function loadWithSetlists() {
    const env = loadRouter();
    const { ctx } = env;
    vm.runInContext(read('src/setlists.js'), ctx, { filename: 'src/setlists.js' });
    const reads = [];
    ctx.dbGetAll = () => { const d = deferred(); reads.push(d); return d.promise; };
    ctx.isConfigured = () => Promise.resolve(true);
    ctx._currentView = 'setlists';
    return Object.assign(env, { reads });
}

test('direct re-render superseding a slow navigation keeps the loading block until it draws', async () => {
    const { ctx, root, status, reads, runTimers, flush } = loadWithSetlists();
    const nav = ctx.renderCurrentView();
    await flush();
    assert.equal(reads.length, 1, 'the router\'s view is reading');
    runTimers();
    assert.match(root.innerHTML, /view-loading/);

    const direct = ctx.renderSetlists();     // e.g. a filter click meanwhile
    reads[0].resolve([]);                    // the router's view: superseded, draws nothing
    assert.equal(await nav, true);
    assert.match(root.innerHTML, /view-loading/, 'not left blank while the newer render reads');
    assert.equal(root.getAttribute('aria-busy'), 'true');

    reads[1].resolve([]);
    await direct;
    assert.match(root.innerHTML, /No setlists yet/);
    assert.equal(root.getAttribute('aria-busy'), null);
    assert.equal(status.textContent, '');
});

test('a direct re-render that rejects ends on the error screen with Try again, logged, not unhandled', async () => {
    const { ctx, root, status, errors, reads, runTimers, flush } = loadWithSetlists();
    const nav = ctx.renderCurrentView();
    await flush();
    runTimers();
    const direct = ctx.renderSetlists();
    reads[0].resolve([]);
    await nav;
    const boom = new Error('read failed');
    reads[1].reject(boom);
    await direct;                            // resolves: a caller that does not catch is fine
    assert.match(root.innerHTML, /view-error/);
    assert.match(root.innerHTML, /data-on-click="retryCurrentView"/);
    assert.equal(root.getAttribute('aria-busy'), null);
    assert.equal(status.textContent, '');
    assert.equal(errors.length, 1);
    assert.equal(errors[0][1], boom);
});

test('a direct re-render that rejects with nothing loading still shows the error', async () => {
    const { ctx, root, errors, reads } = loadWithSetlists();
    root.innerHTML = '<p>setlists</p>';
    const direct = ctx.renderSetlists();
    reads[0].reject(new Error('gone'));
    await direct;
    assert.match(root.innerHTML, /view-error/);
    assert.equal(errors.length, 1);
});

test('a superseded direct re-render that rejects is logged but leaves the newer view', async () => {
    const { ctx, root, errors, reads } = loadWithSetlists();
    const older = ctx.renderSetlists();
    const newer = ctx.renderSetlists();
    reads[1].resolve([]);
    await newer;
    reads[0].reject(new Error('late'));
    await older;
    assert.match(root.innerHTML, /No setlists yet/);
    assert.equal(errors.length, 1);
});

test('a view render started for one view does not draw once the user is on another', async () => {
    const { ctx, root, reads } = loadWithSetlists();
    root.innerHTML = '<p>stats page</p>';
    const poll = ctx.renderSetlists();       // a background refresh for the setlists view
    ctx._currentView = 'stats';              // the user has moved on
    reads[0].resolve([]);
    await poll;
    assert.equal(root.innerHTML, '<p>stats page</p>');
});

test('a navigation whose view fails after a direct re-render drew leaves that render on screen', async () => {
    const { ctx, root, errors, reads, timers, flush } = loadWithSetlists();
    const nav = ctx.renderCurrentView();
    await flush();
    const direct = ctx.renderSetlists();
    reads[1].resolve([]);
    await direct;
    timers.splice(0).forEach((t) => t.live && t.fn());   // the navigation's delay passes
    assert.doesNotMatch(root.innerHTML, /view-loading/, 'no loading block over a drawn view');
    reads[0].reject(new Error('late'));
    assert.equal(await nav, false);
    assert.equal(errors.length, 1, 'logged');
    assert.match(root.innerHTML, /No setlists yet/, 'but not drawn over the newer render');
    assert.equal(root.getAttribute('aria-busy'), null);
});

test('views check their own route: viewRenderIsCurrent is false once _currentView moves', () => {
    const { ctx } = loadRouter();
    ctx._currentView = 'wantlist';
    const tok = ctx.startViewRender('wantlist');
    assert.equal(ctx.viewRenderIsCurrent(tok), true);
    ctx._currentView = 'stats';
    assert.equal(ctx.viewRenderIsCurrent(tok), false);
    ctx._currentView = '';
    assert.equal(ctx.viewRenderIsCurrent(ctx.startViewRender('collection')), true, "'' routes to the collection");
});

// ---------- round 3: loading left up, direct renders for a left view ----------

test('a fast run after a slow one that showed loading clears it (aria-busy, status, block)', async () => {
    const { ctx, root, status, timers, flush } = load();
    const slow = deferred();
    const r1 = ctx.runViewRender(() => slow.promise, { root, status, label: 'stats', replace: true });
    timers[0].fn();                          // R1's delay passes: loading is up
    assert.equal(root.getAttribute('aria-busy'), 'true');
    const r2 = ctx.runViewRender(() => { root.innerHTML = '<p>tracks</p>'; },
        { root, status, label: 'tracks', replace: true });
    assert.equal(await r2, true);            // R2 is fast: its own timer never fires
    assert.equal(root.getAttribute('aria-busy'), null);
    assert.equal(status.textContent, '');
    slow.resolve();
    await r1;
    await flush();
    assert.equal(root.innerHTML, '<p>tracks</p>');
    assert.equal(root.getAttribute('aria-busy'), null);
});

test('a fast refresh after a slow one that dimmed the view clears view-refreshing', async () => {
    const { ctx, root, status, timers } = load();
    const slow = deferred();
    ctx.runViewRender(() => slow.promise, { root, status, label: 'tracks', replace: false });
    timers[0].fn();
    assert.ok(root.classList.contains('view-refreshing'));
    assert.equal(await ctx.runViewRender(() => {}, { root, status, label: 'tracks', replace: false }), true);
    assert.ok(!root.classList.contains('view-refreshing'));
    assert.equal(root.getAttribute('aria-busy'), null);
    assert.equal(status.textContent, '');
});

test('a direct re-render for a view the user has left does not supersede the router run', async () => {
    const { ctx, root, status, reads, runTimers, flush } = loadWithSetlists();
    const metaReads = [];
    ctx.dbGet = () => { const d = deferred(); metaReads.push(d); return d.promise; };
    const nav = ctx.renderCurrentView();     // the user went to the setlists list
    await flush();
    assert.equal(reads.length, 1);
    runTimers();
    assert.match(root.innerHTML, /view-loading/);

    // A setlist detail's dbPut lands after the user left it: renderSetlist(id).
    const late = ctx.renderSetlist(7);
    reads[0].resolve([]);                    // the router's setlists view gets its data
    assert.equal(await nav, true);
    assert.match(root.innerHTML, /No setlists yet/, 'the routed view is drawn');
    assert.equal(root.getAttribute('aria-busy'), null);
    assert.equal(status.textContent, '');

    metaReads[0].resolve({ id: 7, name: 'old', tracks: [] });
    reads[1].resolve([]);
    assert.equal(await late, false);
    assert.match(root.innerHTML, /No setlists yet/, 'the left view does not draw or clear');
});

test('a direct render for a left view gets a dead token, and its failure never rejects', async () => {
    const { ctx, root, status, errors } = loadRouter();
    ctx._currentView = 'stats';
    const live = ctx.startViewRender('stats');
    const tok = ctx.startViewRender('release');   // the user is on stats
    assert.equal(ctx.viewRenderIsCurrent(tok), false);
    assert.equal(ctx.viewRenderIsCurrent(live), true, 'the live render is not superseded');
    root.setAttribute('aria-busy', 'true');
    status.textContent = 'Loading stats…';
    const out = ctx.endViewRender(tok, Promise.reject(new Error('late write failed')));
    assert.equal(await out, false, 'resolves false, does not reject');
    assert.equal(errors.length, 1, 'still logged');
    assert.equal(root.getAttribute('aria-busy'), 'true', 'loading state left to its owner');
    assert.equal(status.textContent, 'Loading stats…');
    assert.equal(await ctx.endViewRender(ctx.startViewRender('release'), Promise.resolve()), false);
});

test('openDB: a connection closed right after it opened is not handed out', async () => {
    const idb = fakeIDB();
    const { ctx } = loadDb(idb);
    const p1 = ctx.openDB();
    const db = {};
    idb.requests[0].onsuccess({ target: { result: db } });
    db.onclose();                            // before the opening promise's callbacks ran
    ctx.openDB();
    assert.equal(idb.requests.length, 2, 'a fresh open, not the closed connection');
    assert.equal(await p1, db);
});

// ---------- round 4: a direct re-render for another release / setlist ----------

test('a direct render for another release or setlist than the routed one gets a dead token', () => {
    const { ctx } = loadRouter();
    ctx._currentView = 'release';
    ctx._filters.releaseId = 2;              // the user is on release 2
    const live = ctx.startViewRender('release', 2);
    assert.equal(ctx.viewRenderIsCurrent(live), true);
    const late = ctx.startViewRender('release', 1);   // release 1's late dbPut
    assert.equal(ctx.viewRenderIsCurrent(late), false, 'release 1 may not draw over release 2');
    assert.equal(ctx.viewRenderIsCurrent(live), true, "release 2's render is not superseded");
    // Ids are compared as strings: an old string id is the same release.
    ctx._filters.releaseId = '2';
    assert.equal(ctx.viewRenderIsCurrent(ctx.startViewRender('release', 2)), true, "'2' is release 2");
    // Callers that pass no key are checked by view name only, as before.
    assert.equal(ctx.viewRenderIsCurrent(ctx.startViewRender('release')), true);

    ctx._currentView = 'setlist';
    ctx._filters.setlistId = 8;
    const sl = ctx.startViewRender('setlist', 8);
    assert.equal(ctx.viewRenderIsCurrent(ctx.startViewRender('setlist', 7)), false);
    assert.equal(ctx.viewRenderIsCurrent(sl), true);
    // A render of setlist 8 is stale once the route moves to setlist 9.
    ctx._filters.setlistId = 9;
    assert.equal(ctx.viewRenderIsCurrent(sl), false);
});

test('a late renderSetlist for the setlist the user left does not draw over the one now routed', async () => {
    const { ctx, root, reads, flush } = loadWithSetlists();
    const slReads = [];
    ctx.dbGet = (_store, id) => { const d = deferred(); slReads.push({ id, d }); return d.promise; };
    ctx._currentView = 'setlist';
    ctx._filters.setlistId = 8;              // the user moved from setlist 7 to 8
    const nav = ctx.renderCurrentView();
    await flush();
    assert.deepEqual(slReads.map(r => r.id), [8]);

    const late = ctx.renderSetlist(7);       // setlist 7's removeTrack dbPut lands
    slReads[0].d.resolve({ id: 8, name: 'routed eight', tracks: [] });
    reads[0].resolve([]);                    // track_meta for setlist 8
    assert.equal(await nav, true);
    assert.match(root.innerHTML, /routed eight/, 'setlist 8 is drawn');

    if (slReads[1]) slReads[1].d.resolve({ id: 7, name: 'left seven', tracks: [] });
    if (reads[1]) reads[1].resolve([]);
    assert.equal(await late, false);
    await flush();
    assert.doesNotMatch(root.innerHTML, /left seven/, 'setlist 7 does not draw over it');
    assert.match(root.innerHTML, /routed eight/);
});
