// P4: delegated actions replace inline onclick/onchange/... handlers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

function appFiles() {
    const out = ['app.js'];
    (function walk(dir) {
        for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
            const p = dir + '/' + e.name;
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.js')) out.push(p);
        }
    })('src');
    return out;
}

test('no inline event handlers are left in the markup the app builds', () => {
    for (const f of [...appFiles(), 'index.html']) {
        const hits = read(f).split('\n')
            .map((line, i) => [i + 1, line])
            .filter(([, line]) => /\son(click|change|input|keydown|keyup|submit)\s*=/.test(line))
            .filter(([, line]) => !/^\s*\/\//.test(line));
        assert.deepEqual(hits, [], `${f} still has inline handlers`);
    }
});

test('every function an action names exists as a global function', () => {
    const declared = new Set();
    const named = [];
    for (const f of appFiles()) {
        const src = read(f);
        for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) declared.add(m[1]);
        for (const m of src.matchAll(/act\('(?:click|change|input|enter|escape)',\s*'([A-Za-z_$][\w$]*)'/g)) named.push([f, m[1]]);
    }
    // Names passed through as variables (pager and Camelot wheel callers).
    for (const m of read('src/views/collection.js').matchAll(/renderPagination\([^)]*'(\w+)'\)/g)) named.push(['collection', m[1]]);
    for (const f of ['src/views/tracks.js', 'src/views/wantlist.js'])
        for (const m of read(f).matchAll(/renderPagination\([^)]*'(\w+)'\)/g)) named.push([f, m[1]]);
    for (const m of read('src/meta_editor.js').matchAll(/camelotWheelSvg\([^,]+,\s*'(\w+)'/g)) named.push(['meta_editor', m[1]]);

    assert.ok(named.length > 100, `found ${named.length} actions`);
    const missing = named.filter(([, n]) => !declared.has(n));
    assert.deepEqual(missing, []);
});

// ---------- the dispatcher ----------

function makeDom() {
    // Just enough DOM for actions.js: elements with attributes, parents,
    // closest('[attr]'), and document-level listeners.
    class El {
        constructor(attrs = {}, parent = null) {
            this.attrs = attrs; this.parentElement = parent; this.value = attrs.value; this.checked = false;
        }
        getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
        closest(sel) {
            const name = sel.slice(1, -1);
            for (let el = this; el; el = el.parentElement) if (el.getAttribute(name) !== null) return el;
            return null;
        }
    }
    const listeners = {};
    const document = { addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); } };
    const fire = (type, target, extra = {}) => {
        const e = { type, target, cancelBubble: false, stopPropagation() { this.cancelBubble = true; }, ...extra };
        for (const fn of listeners[type] || []) fn(e);
        return e;
    };
    return { El, document, fire };
}

// Parses the attributes act() renders into an El attribute map.
function attrs(html) {
    const out = {};
    for (const m of html.matchAll(/\s([\w-]+)="([^"]*)"/g)) {
        out[m[1]] = m[2].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    }
    return out;
}

function load() {
    const { El, document, fire } = makeDom();
    const calls = [];
    const ctx = { document, console, JSON, calls };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(read('src/utils.js'), ctx);
    vm.runInContext(read('src/actions.js'), ctx);
    return { ctx, El, fire, calls };
}

test('act() renders data attributes, and values never become code', () => {
    const { ctx } = load();
    const html = ctx.act('click', 'wlRemove', [12, 'Blue Monday 12"', "peak' onmouseover='x"]);
    // Exactly two attributes come out: the hostile text stays inside the
    // escaped value instead of opening an attribute of its own.
    assert.deepEqual(Object.keys(attrs(html)), ['data-on-click', 'data-args-click']);
    assert.doesNotMatch(html.replace(/^ data-on-click="wlRemove" data-args-click="[^"]*"$/, ''), /./);
    assert.equal(JSON.stringify(JSON.parse(attrs(html)['data-args-click'])), JSON.stringify([12, 'Blue Monday 12"', "peak' onmouseover='x"]));
    assert.equal(ctx.act('click', 'closeQueue'), ' data-on-click="closeQueue"');
    assert.throws(() => ctx.act('click', 'alert(1)'), /not a function name/);
    assert.throws(() => ctx.act('hover', 'x'), /unknown event type/);
});

test('a click calls the named function with its arguments and the element', () => {
    const { ctx, El, fire, calls } = load();
    ctx.wlRemove = function (...args) { calls.push(['wlRemove', this, args]); };
    const btn = new El(attrs(ctx.act('click', 'wlRemove', [12, 'A "quoted" artist', ctx.ACT_THIS, ctx.ACT_PARENT])));
    const row = new El({});
    btn.parentElement = row;
    const icon = new El({}, btn); // click lands on a child of the button
    fire('click', icon);
    assert.equal(calls.length, 1);
    const [, self, args] = calls[0];
    assert.equal(self, btn);
    assert.equal(args[0], 12);
    assert.equal(args[1], 'A "quoted" artist');
    assert.equal(args[2], btn);
    assert.equal(args[3], row);
});

test('value, checked, enter and escape', () => {
    const { ctx, El, fire, calls } = load();
    ctx.setQ = (...a) => calls.push(['setQ', a]);
    ctx.save = (...a) => calls.push(['save', a]);
    ctx.cancel = (...a) => calls.push(['cancel', a]);
    const input = new El(attrs(
        ctx.act('input', 'setQ', ['q', ctx.ACT_VALUE]) + ctx.act('enter', 'save', [7]) + ctx.act('escape', 'cancel', [7])));
    input.value = 'house';
    fire('input', input);
    fire('keydown', input, { key: 'a' });
    fire('keydown', input, { key: 'Enter' });
    fire('keydown', input, { key: 'Escape' });
    assert.equal(JSON.stringify(calls), JSON.stringify([['setQ', ['q', 'house']], ['save', [7]], ['cancel', [7]]]));
});

test('actions bubble like inline handlers did, and stopPropagation stops them', () => {
    const { ctx, El, fire, calls } = load();
    ctx.outer = () => calls.push('outer');
    ctx.inner = () => calls.push('inner');
    ctx.stopper = (e) => { calls.push('stopper'); e.stopPropagation(); };
    const card = new El(attrs(ctx.act('click', 'outer')));
    const btn = new El(attrs(ctx.act('click', 'inner')), card);
    fire('click', btn);
    assert.deepEqual([...calls], ['inner', 'outer']);
    calls.length = 0;
    const stop = new El(attrs(ctx.act('click', 'stopper', [ctx.ACT_EVENT])), card);
    fire('click', stop);
    assert.deepEqual([...calls], ['stopper']);
});

test('an unknown function name is reported, not thrown', () => {
    const { ctx, El, fire } = load();
    const errors = [];
    ctx.console = { error: m => errors.push(m) };
    vm.runInContext('console = this.console', ctx);
    fire('click', new El(attrs(ctx.act('click', 'noSuchFn'))));
    assert.equal(errors.length, 1);
});
