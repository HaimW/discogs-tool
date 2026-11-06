// Harmonic suggestions (src/harmonic.js): Camelot neighbours, tempo distance,
// candidate scoring and the "Next up" ranking. A priority test target in
// docs/PROJECT_PLAN.md §5a.
//
// harmonic.js is a plain <script>; it is loaded into a VM context with the real
// helpers it calls (escHtml, act, the Camelot table, ratingStars), an in-memory
// stand-in for IndexedDB and a minimal document.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const FILES = ['src/utils.js', 'src/actions.js', 'src/camelot.js', 'src/meta.js', 'src/harmonic.js'];

// Arrays made inside the VM have another realm's prototype; copy them out
// before deep comparisons.
const arr = a => Array.from(a);

function makeDocument() {
    const byId = new Map();
    const el = tag => ({
        tagName: tag, id: '', className: '', innerHTML: '',
        _classes: new Set(),
        get classList() {
            const s = this._classes;
            return { add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c) };
        },
        remove() { if (byId.get(this.id) === this) byId.delete(this.id); },
    });
    return {
        byId,
        addEventListener() {},
        createElement: el,
        getElementById: id => byId.get(id) || null,
        body: { appendChild(node) { if (node.id) byId.set(node.id, node); } },
        _el: el,
    };
}

function load({ stores = {}, queue = [], index = -1 } = {}) {
    const document = makeDocument();
    const calls = { loaded: [], saved: 0, toasts: [], queueRefreshes: [] };
    const ctx = {
        Math, Date, JSON, console, Promise, document,
        dbGetAll: async name => (stores[name] || []).map(r => ({ ...r })),
        currentQueue: queue,
        currentIndex: index,
        loadFromQueue(i) { calls.loaded.push(i); },
        _savePlayerState() { calls.saved++; },
        refreshQueuePanel(opts) { calls.queueRefreshes.push(opts); },
        showToast(msg) { calls.toasts.push(msg); },
    };
    vm.createContext(ctx);
    for (const f of FILES) vm.runInContext(read(f), ctx, { filename: f });
    return { ctx, document, calls };
}

const H = load().ctx;

// Runs openSuggestions and resolves with what it handed to the panel.
async function suggest(opts) {
    const app = load(opts);
    let seen = null;
    const realRender = app.ctx.renderSuggestionsPanel;
    app.ctx.renderSuggestionsPanel = (c, cands) => { seen = { ctx: c, cands: arr(cands) }; realRender(c, cands); };
    app.ctx.openSuggestions();
    for (let i = 0; i < 20 && !seen; i++) await new Promise(r => setImmediate(r));
    assert.ok(seen, 'the panel was rendered');
    return { app, ...seen };
}

// ---- compatibleKeys ----

test('compatibleKeys: same key, one step either way on the wheel, then the relative key', () => {
    assert.deepEqual(arr(H.compatibleKeys('8A')), ['8A', '9A', '7A', '8B']);
    assert.deepEqual(arr(H.compatibleKeys('8B')), ['8B', '9B', '7B', '8A']);
    assert.deepEqual(arr(H.compatibleKeys('5A')), ['5A', '6A', '4A', '5B']);
});

test('compatibleKeys wraps round the wheel between 12 and 1', () => {
    assert.deepEqual(arr(H.compatibleKeys('12A')), ['12A', '1A', '11A', '12B']);
    assert.deepEqual(arr(H.compatibleKeys('12B')), ['12B', '1B', '11B', '12A']);
    assert.deepEqual(arr(H.compatibleKeys('1A')), ['1A', '2A', '12A', '1B']);
    assert.deepEqual(arr(H.compatibleKeys('1B')), ['1B', '2B', '12B', '1A']);
});

test('compatibleKeys gives four distinct real keys for every key on the wheel, symmetrically', () => {
    for (const e of H.CAMELOT_WHEEL) {
        const keys = arr(H.compatibleKeys(e.code));
        assert.equal(keys.length, 4, e.code);
        assert.equal(new Set(keys).size, 4, e.code + ' has duplicates: ' + keys);
        for (const k of keys) {
            assert.ok(H.camelotEntry(k), e.code + ' -> ' + k + ' is not on the wheel');
            // Compatibility goes both ways: if B mixes out of A, A mixes out of B.
            assert.ok(arr(H.compatibleKeys(k)).includes(e.code), k + ' does not list ' + e.code);
        }
        assert.equal(keys[3], H.camelotRelative(e.code), 'fourth entry is the relative key');
    }
});

test('compatibleKeys tidies the input: case, spaces, a leading zero', () => {
    assert.deepEqual(arr(H.compatibleKeys('8a')), ['8A', '9A', '7A', '8B']);
    assert.deepEqual(arr(H.compatibleKeys(' 11b ')), ['11B', '12B', '10B', '11A']);
    assert.deepEqual(arr(H.compatibleKeys('08A')), ['8A', '9A', '7A', '8B']);
});

test('compatibleKeys returns nothing for anything that is not a Camelot code', () => {
    for (const k of [null, undefined, '', '   ', '0A', '13A', '8C', '8', 'A', '8AB', '100A', 'Am', 'C major']) {
        assert.deepEqual(arr(H.compatibleKeys(k)), [], String(k));
    }
    assert.equal(H.parseCamelot('13B'), null);
    assert.deepEqual({ ...H.parseCamelot('12b') }, { n: 12, letter: 'B' });
});

// ---- bpmDelta ----

test('bpmDelta is the percentage difference, measured against the slower tempo', () => {
    assert.equal(H.bpmDelta(120, 120), 0);
    assert.equal(H.bpmDelta(100, 110), 10);
    assert.equal(H.bpmDelta(110, 100), 10, 'symmetric');
    assert.ok(Math.abs(H.bpmDelta(124, 126) - 2 / 124 * 100) < 1e-9);
    assert.ok(Math.abs(H.bpmDelta(127.5, 128) - 0.5 / 127.5 * 100) < 1e-9, 'fractional BPM');
});

test('bpmDelta treats half and double time as a match', () => {
    assert.equal(H.bpmDelta(70, 140), 0);
    assert.equal(H.bpmDelta(140, 70), 0);
    assert.equal(H.bpmDelta(87, 174), 0, 'drum & bass over half-time');
    // Near double time: 70 doubled is 140, 5 BPM from 145.
    assert.ok(Math.abs(H.bpmDelta(70, 145) - 5 / 140 * 100) < 1e-9);
    assert.ok(Math.abs(H.bpmDelta(145, 70) - 5 / 140 * 100) < 1e-9);
});

test('bpmDelta keeps the smallest of the straight, half-time and double-time readings', () => {
    // 100 vs 150: straight 50 %, 200 vs 150 is 33.3 %, 100 vs 300 is 200 %.
    assert.ok(Math.abs(H.bpmDelta(100, 150) - 50 / 150 * 100) < 1e-9);
    assert.ok(Math.abs(H.bpmDelta(150, 100) - 50 / 150 * 100) < 1e-9);
    for (const [a, b] of [[90, 128], [128, 90], [60, 175], [174, 86], [120, 121]]) {
        const d = H.bpmDelta(a, b);
        assert.ok(d >= 0 && Number.isFinite(d), a + '/' + b);
        assert.equal(d, H.bpmDelta(b, a), 'symmetric for ' + a + '/' + b);
    }
});

test('bpmDelta: a missing tempo, including 0, is no match at all (L3: by design)', () => {
    // 0 BPM is not a real tempo, so it counts as missing (PROJECT_PLAN L3).
    for (const [a, b] of [[0, 120], [120, 0], [0, 0], [null, 120], [120, undefined], [NaN, 120]]) {
        assert.equal(H.bpmDelta(a, b), Infinity, a + '/' + b);
    }
});

// ---- scoreCandidate ----

test('scoreCandidate: same key 100, a neighbouring or relative key 70, any other key 0', () => {
    const cur = { key: '8A' };
    assert.equal(H.scoreCandidate(cur, { key: '8A' }), 100);
    for (const k of ['9A', '7A', '8B']) assert.equal(H.scoreCandidate(cur, { key: k }), 70, k);
    for (const k of ['10A', '9B', '2A', '3B']) assert.equal(H.scoreCandidate(cur, { key: k }), 0, k);
    assert.equal(H.scoreCandidate({ key: '12B' }, { key: '1B' }), 70, 'across the 12/1 wrap');
    assert.equal(H.scoreCandidate({ key: '8a' }, { key: '8A' }), 100, 'current key is normalised');
});

test('scoreCandidate: candidate keys are normalised too (decided 2026-11-06)', () => {
    const cur = { key: '8A' };
    // Before: only the exact string "8A" matched, so these scored 0.
    for (const k of ['8a', '08A', ' 8A ', 'Am', 'A minor']) assert.equal(H.scoreCandidate(cur, { key: k }), 100, k);
    assert.equal(H.scoreCandidate(cur, { key: 'C major' }), 70, 'C major is 8B, the relative of 8A');
    assert.equal(H.scoreCandidate({ key: 'Am' }, { key: '9a' }), 70, 'musical name on the current side');
});

test('scoreCandidate: a missing key on either side scores nothing for key', () => {
    assert.equal(H.scoreCandidate({ key: null }, { key: '8A' }), 0);
    assert.equal(H.scoreCandidate({ key: '8A' }, { key: null }), 0);
    assert.equal(H.scoreCandidate({ key: 'nonsense' }, { key: '8A' }), 0);
    assert.equal(H.scoreCandidate({}, {}), 0);
});

test('scoreCandidate: a shared genre is worth 40, but only when the key did not match', () => {
    assert.equal(H.scoreCandidate({ genres: 'Electronic, Jazz' }, { genres: 'Jazz' }), 40);
    assert.equal(H.scoreCandidate({ genres: 'Electronic' }, { genres: 'Rock, Pop' }), 0);
    // Key matched: no genre bonus on top.
    assert.equal(H.scoreCandidate({ key: '8A', genres: 'Jazz' }, { key: '8A', genres: 'Jazz' }), 100);
    assert.equal(H.scoreCandidate({ key: '8A', genres: 'Jazz' }, { key: '9A', genres: 'Jazz' }), 70);
    // Keys that do not mix fall back to genre.
    assert.equal(H.scoreCandidate({ key: '8A', genres: 'Jazz' }, { key: '2B', genres: 'Jazz' }), 40);
    // A missing genre list on either side is no bonus.
    assert.equal(H.scoreCandidate({ genres: '' }, { genres: 'Jazz' }), 0);
    assert.equal(H.scoreCandidate({ genres: 'Jazz' }, { genres: '' }), 0);
    assert.equal(H.scoreCandidate({ genres: null }, { genres: 'Jazz' }), 0);
});

test('scoreCandidate: tempo bonus is 100 for the same tempo, falling to nothing beyond 12 %', () => {
    const at = bpm => H.scoreCandidate({ bpm: 100 }, { bpm });
    assert.equal(at(100), 100);
    assert.equal(at(50), 100, 'half time');
    assert.equal(at(200), 100, 'double time');
    assert.equal(at(103), 70);
    assert.equal(at(106), 40);
    assert.equal(at(112), 32);
    assert.equal(at(113), 0);
    assert.equal(at(150), 0);
    assert.equal(H.scoreCandidate({ bpm: 0 }, { bpm: 100 }), 0, '0 BPM is missing (L3)');
    assert.equal(H.scoreCandidate({ bpm: 100 }, { bpm: null }), 0);
});

test('scoreCandidate: a closer tempo never scores lower than a further one (L8)', () => {
    // Before L8 the score jumped from 40 at 6 % up to ~50 just past it, so a
    // track 7 % off outranked one 5.5 % off.
    let prev = Infinity;
    for (let pct = 0; pct <= 14; pct += 0.25) {
        const s = H.scoreCandidate({ bpm: 100 }, { bpm: 100 + pct });
        assert.ok(s <= prev + 1e-9, `${pct}% scores ${s}, more than ${prev} for a closer tempo`);
        prev = s;
    }
    assert.ok(H.scoreCandidate({ bpm: 100 }, { bpm: 105.5 }) > H.scoreCandidate({ bpm: 100 }, { bpm: 107 }));
});

test('scoreCandidate: rating adds 2 per star; the parts add up', () => {
    assert.equal(H.scoreCandidate({}, { rating: 5 }), 10);
    assert.equal(H.scoreCandidate({}, { rating: null }), 0);
    assert.equal(H.scoreCandidate(
        { key: '8A', bpm: 124, genres: 'Electronic' },
        { key: '9A', bpm: 124, genres: 'Electronic', rating: 4 }), 70 + 100 + 8);
    assert.equal(H.scoreCandidate(
        { key: '8A', bpm: 124, genres: 'Electronic' },
        { key: '3B', bpm: 124, genres: 'Electronic', rating: 1 }), 40 + 100 + 2);
});

// ---- openSuggestions: the ranking ----

function library() {
    const releases = [
        { id: 1, artist: 'Cur', title: 'Current LP', genres: 'Electronic', thumb_url: 'c.jpg' },
        { id: 2, artist: 'A', title: 'Two', genres: 'Electronic' },
        { id: 3, artist: 'B', title: 'Three', genres: 'Jazz' },
    ];
    const videos = [
        { release_id: 1, youtube_id: 'cur', title: 'Now playing' },
        { release_id: 2, youtube_id: 'same', title: 'Same key, same tempo' },
        { release_id: 2, youtube_id: 'nbr', title: 'Neighbour key' },
        { release_id: 2, youtube_id: 'genre', title: 'Genre only' },
        { release_id: 3, youtube_id: 'none', title: 'Nothing in common' },
        { release_id: 3, youtube_id: 'queued', title: 'Already queued' },
        { release_id: 3, youtube_id: '', title: 'No video id' },
    ];
    const track_meta = [
        { id: '1_cur', bpm: 124, key: '8A' },
        { id: '2_same', bpm: 124, key: '8A' },
        { id: '2_nbr', bpm: 124, key: '9A', rating: 5 },
        { id: '3_none', bpm: 90, key: '2B' },
        { id: '3_queued', bpm: 124, key: '8A' },
    ];
    return { releases, videos, track_meta };
}

test('suggestions rank by score, best first, and leave out zero scores, the queue and blank videos', async () => {
    const { ctx: c, cands } = await suggest({
        stores: library(),
        queue: [{ youtubeId: 'cur', releaseId: 1 }, { youtubeId: 'queued', releaseId: 3 }],
        index: 0,
    });
    assert.deepEqual({ ...c }, { bpm: 124, key: '8A', genres: 'Electronic' });
    assert.deepEqual(cands.map(x => x.youtubeId), ['same', 'nbr', 'genre']);
    assert.deepEqual(cands.map(x => x.score), [200, 180, 40]);
    const top = cands[0];
    assert.equal(top.artist, 'A');
    assert.equal(top.releaseId, 2);
    assert.equal(top.releaseTitle, 'Two');
});

test('suggestions match the current track by release as well as video', async () => {
    const stores = library();
    // The same video on two releases with different keys.
    stores.videos.push({ release_id: 3, youtube_id: 'cur', title: 'Now playing (reissue)' });
    stores.track_meta.push({ id: '3_cur', bpm: 90, key: '2B' });
    const { ctx: c } = await suggest({ stores, queue: [{ youtubeId: 'cur', releaseId: 3 }], index: 0 });
    assert.deepEqual({ ...c }, { bpm: 90, key: '2B', genres: 'Jazz' });
    // A string id (older queue entries) still finds it.
    const { ctx: c2 } = await suggest({ stores, queue: [{ youtubeId: 'cur', releaseId: '3' }], index: 0 });
    assert.equal(c2.key, '2B');
});

test('suggestions with no BPM or key for the current track fall back to genre', async () => {
    const stores = library();
    stores.track_meta = stores.track_meta.filter(m => m.id !== '1_cur');
    const { ctx: c, cands, app } = await suggest({ stores, queue: [{ youtubeId: 'cur', releaseId: 1 }], index: 0 });
    assert.deepEqual({ ...c }, { bpm: null, key: null, genres: 'Electronic' });
    assert.deepEqual(cands.map(x => x.youtubeId).sort(), ['genre', 'nbr', 'same']);
    // rating breaks the tie
    assert.equal(cands[0].youtubeId, 'nbr');
    const panel = app.document.getElementById('suggestions-panel');
    assert.match(panel.innerHTML, /matching by genre/);
});

test('suggestions are capped at 20', async () => {
    const stores = { releases: [{ id: 1, genres: 'House' }], videos: [], track_meta: [] };
    for (let i = 0; i < 30; i++) stores.videos.push({ release_id: 1, youtube_id: 'v' + i, title: 'T' + i });
    const { cands } = await suggest({ stores, queue: [{ youtubeId: 'v0', releaseId: 1 }], index: 0 });
    assert.equal(cands.length, 20);
});

test('suggestions do nothing without a current track, and a second press closes the panel', async () => {
    const idle = load({ stores: library(), queue: [], index: -1 });
    let rendered = false;
    idle.ctx.renderSuggestionsPanel = () => { rendered = true; };
    idle.ctx.openSuggestions();
    await new Promise(r => setImmediate(r));
    assert.equal(rendered, false);

    const { app } = await suggest({ stores: library(), queue: [{ youtubeId: 'cur', releaseId: 1 }], index: 0 });
    assert.ok(app.document.getElementById('suggestions-panel'));
    app.ctx.openSuggestions();
    assert.equal(app.document.getElementById('suggestions-panel'), null);
});

test('the panel escapes titles and says so when nothing matches', async () => {
    const stores = library();
    stores.videos[1].title = '<img src=x onerror=alert(1)>';
    const { app } = await suggest({ stores, queue: [{ youtubeId: 'cur', releaseId: 1 }], index: 0 });
    const html = app.document.getElementById('suggestions-panel').innerHTML;
    assert.ok(!html.includes('<img src=x'), 'title is escaped');
    assert.ok(html.includes('&lt;img src=x'));
    assert.match(html, /Key 8A \(relative 8B\)/);

    const lonely = { releases: [{ id: 1 }], videos: [{ release_id: 1, youtube_id: 'cur' }], track_meta: [] };
    const empty = await suggest({ stores: lonely, queue: [{ youtubeId: 'cur', releaseId: 1 }], index: 0 });
    assert.deepEqual(empty.cands, []);
    assert.match(empty.app.document.getElementById('suggestions-panel').innerHTML, /No matches/);
});

// ---- Acting on a suggestion ----

test('"Queue" appends the suggestion with its release and saves the queue', async () => {
    const queue = [{ youtubeId: 'cur', releaseId: 1 }];
    const { app } = await suggest({ stores: library(), queue, index: 0 });
    app.ctx.addSuggestionToQueue(0);
    assert.equal(queue.length, 2);
    assert.equal(queue[1].youtubeId, 'same');
    assert.equal(queue[1].releaseId, 2);
    assert.equal(app.calls.saved, 1);
    assert.deepEqual(app.calls.toasts, ['Queued: Same key, same tempo']);
    assert.deepEqual(JSON.parse(JSON.stringify(app.calls.queueRefreshes)), [{ reveal: false }], 'an open queue panel redraws, the list stays put (L10)');
    app.ctx.addSuggestionToQueue(99);
    assert.equal(queue.length, 2, 'an unknown index is ignored');
});

test('"Play next" keeps the release, and the track it plays is not suggested again (L7)', async () => {
    const queue = [{ youtubeId: 'cur', releaseId: 1 }];
    const first = await suggest({ stores: library(), queue, index: 0 });
    first.app.ctx.playNextSuggestion(0);
    assert.equal(queue.length, 2);
    assert.equal(queue[1].youtubeId, 'same');
    assert.equal(queue[1].releaseId, 2, 'release id kept, as "Queue" does');
    assert.equal(first.app.ctx.currentIndex, 1);
    assert.deepEqual(first.app.calls.loaded, [1]);
    assert.equal(first.app.document.getElementById('suggestions-panel'), null, 'panel closed');

    // Ask again while that track plays: it must not suggest itself.
    const again = await suggest({ stores: library(), queue, index: 1 });
    assert.ok(!again.cands.some(x => x.youtubeId === 'same'), 'the playing track was suggested as its own next match');
    assert.ok(!again.cands.some(x => x.youtubeId === 'cur'), 'an earlier queue entry was suggested');
});

test('a queue entry without a release still keeps its video out of the suggestions (L7)', async () => {
    // Queue entries can lack a release id (a row whose release id did not parse,
    // or a queue saved before "Play next" kept it).
    const queue = [{ youtubeId: 'cur', releaseId: 1 }, { youtubeId: 'same', releaseId: null }];
    const { cands } = await suggest({ stores: library(), queue, index: 0 });
    assert.ok(!cands.some(x => x.youtubeId === 'same'));
});
