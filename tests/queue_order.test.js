// F17: reordering the queue. queue_order.js is a plain <script> file, loaded
// into a VM context like the app loads it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = { Number };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src/queue_order.js'), 'utf8'), ctx, { filename: 'src/queue_order.js' });
const Q = ctx;
const plain = v => JSON.parse(JSON.stringify(v));

test('a move puts the entry at `to` and keeps the others in order', () => {
    const q = ['a', 'b', 'c', 'd', 'e'];
    assert.deepEqual(plain(Q.queueMoved(q, 1, 3)), ['a', 'c', 'd', 'b', 'e']);
    assert.deepEqual(plain(Q.queueMoved(q, 3, 1)), ['a', 'd', 'b', 'c', 'e']);
    assert.deepEqual(plain(Q.queueMoved(q, 0, 4)), ['b', 'c', 'd', 'e', 'a']);
    assert.deepEqual(plain(Q.queueMoved(q, 4, 0)), ['e', 'a', 'b', 'c', 'd']);
    assert.deepEqual(q, ['a', 'b', 'c', 'd', 'e'], 'the input is not changed');
});

test('only real moves inside the queue are valid', () => {
    assert.equal(Q.queueMoveIsValid(5, 1, 3), true);
    assert.equal(Q.queueMoveIsValid(5, 2, 2), false, 'no-op');
    assert.equal(Q.queueMoveIsValid(5, 0, -1), false, 'above the top');
    assert.equal(Q.queueMoveIsValid(5, 4, 5), false, 'below the bottom');
    assert.equal(Q.queueMoveIsValid(5, 5, 0), false);
    assert.equal(Q.queueMoveIsValid(5, 1.5, 0), false);
    assert.equal(Q.queueMoveIsValid(5, '1', 0), false);
    assert.equal(Q.queueMoveIsValid(0, 0, 0), false);
});

test('every index follows its entry, checked against the moved array', () => {
    const n = 6;
    const q = Array.from({ length: n }, (_, i) => i);
    for (let from = 0; from < n; from++) {
        for (let to = 0; to < n; to++) {
            const moved = Q.queueMoved(q, from, to);
            for (let i = 0; i < n; i++) {
                assert.equal(moved[Q.queueIndexAfterMove(i, from, to)], i, `entry ${i} after ${from}->${to}`);
            }
        }
    }
});

test('the playing track keeps playing: moving it, or moving others across it', () => {
    const idle = (cur, from, to) => plain(Q.queueMovePlayback({ cfState: 'idle', currentIndex: cur, preloadedIndex: -1 }, from, to));
    assert.equal(idle(2, 2, 0).currentIndex, 0, 'the current track moved up');
    assert.equal(idle(2, 2, 4).currentIndex, 4, 'the current track moved down');
    assert.equal(idle(2, 0, 3).currentIndex, 1, 'a track from above moved below it');
    assert.equal(idle(2, 4, 1).currentIndex, 3, 'a track from below moved above it');
    assert.equal(idle(2, 3, 4).currentIndex, 2, 'a move below it');
    assert.equal(idle(2, 0, 1).currentIndex, 2, 'a move above it');
    assert.equal(idle(2, 4, 2).currentIndex, 3, 'a track dropped onto its place pushes it down');
    assert.equal(idle(2, 0, 2).currentIndex, 1, 'a track from above dropped onto its place pushes it up');
    assert.deepEqual(idle(2, 0, 3), { ok: true, currentIndex: 1, preloadedIndex: -1, repreload: false });
});

test('a cued crossfade track is kept when it is still next, and re-cued when it is not', () => {
    const pre = (from, to) => plain(Q.queueMovePlayback({ cfState: 'preloaded', currentIndex: 2, preloadedIndex: 3 }, from, to));
    assert.deepEqual(pre(0, 4), { ok: true, currentIndex: 1, preloadedIndex: 2, repreload: false }, 'both shift together');
    assert.deepEqual(pre(4, 5), { ok: true, currentIndex: 2, preloadedIndex: 3, repreload: false }, 'move further down');
    assert.deepEqual(pre(5, 3), { ok: true, currentIndex: 2, preloadedIndex: 4, repreload: true }, 'a track dropped in between');
    assert.deepEqual(pre(3, 5), { ok: true, currentIndex: 2, preloadedIndex: 5, repreload: true }, 'the next track moved away');
    assert.deepEqual(pre(2, 0), { ok: true, currentIndex: 0, preloadedIndex: 3, repreload: true }, 'the current track moved away');
    assert.deepEqual(pre(2, 3), { ok: true, currentIndex: 3, preloadedIndex: 2, repreload: true }, 'current and next swapped');
});

test('a fade in progress is never broken', () => {
    const fading = (from, to) => plain(Q.queueMovePlayback({ cfState: 'fading', currentIndex: 2, preloadedIndex: 3 }, from, to));
    assert.deepEqual(fading(0, 5), { ok: true, currentIndex: 1, preloadedIndex: 2, repreload: false }, 'the pair stays together');
    assert.deepEqual(fading(5, 4), { ok: true, currentIndex: 2, preloadedIndex: 3, repreload: false });
    assert.equal(fading(5, 3).ok, false, 'nothing may come between the two fading tracks');
    assert.equal(fading(3, 5).ok, false, 'the track fading in stays next');
    assert.equal(fading(2, 0).ok, false, 'the track fading out stays before it');
    assert.deepEqual(fading(5, 3), { ok: false, currentIndex: 2, preloadedIndex: 3, repreload: false }, 'a refused move changes nothing');

    // Hand-over: the current track already is the one that faded in.
    const sw = plain(Q.queueMovePlayback({ cfState: 'switching', currentIndex: 3, preloadedIndex: 3 }, 3, 0));
    assert.deepEqual(sw, { ok: true, currentIndex: 0, preloadedIndex: 0, repreload: false });
});
