// M1 from docs/PROJECT_PLAN.md: a track shorter than the chosen fade still
// crossfades, with the fade shortened to fit, instead of being skipped.
//
// src/crossfade.js is a plain <script>; it is loaded into a VM context with
// stand-in players.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
// crossfade.js sets volumes through src/volume.js (F15), loaded first as in index.html.
const FILES = ['volume.js', 'crossfade.js'];

function load({ duration, currentTime, cfSeconds }) {
    const intervals = [];
    const ctx = {
        Math, console,
        cfEnabled: true, cfSeconds, _cfState: 'preloaded', _cfFadeInterval: null,
        playerReady: true, player2Ready: true,
        player: { getDuration: () => duration, getCurrentTime: () => currentTime, getVolume: () => 100, setVolume() {} },
        player2: { setVolume() {}, playVideo() {} },
        setInterval(fn, ms) { intervals.push({ fn, ms }); return intervals.length; },
        clearInterval() {},
    };
    vm.createContext(ctx);
    for (const f of FILES) vm.runInContext(read(f), ctx, { filename: 'src/' + f });
    return { ctx, intervals };
}

test('fade length: the chosen one, capped at a third of the track', () => {
    const { ctx } = load({ duration: 0, currentTime: 0, cfSeconds: 5 });
    assert.equal(ctx._effectiveFadeSeconds(240, 5), 5, 'normal track keeps the chosen fade');
    assert.ok(Math.abs(ctx._effectiveFadeSeconds(10, 9) - 10 / 3) < 1e-9, 'the plan\'s example: 9 s fade on a 10 s track');
    assert.equal(ctx._effectiveFadeSeconds(6, 5), 2);
    assert.equal(ctx._effectiveFadeSeconds(2, 5), 0, 'under 3 s: no fade');
    assert.equal(ctx._effectiveFadeSeconds(0, 5), 0, 'no duration yet');
    assert.equal(ctx._effectiveFadeSeconds(NaN, 5), 0);
});

test('a 10 s track with a 9 s fade crossfades over 3.3 s instead of being skipped', () => {
    // 3 s left: inside the shortened 3.33 s window.
    const { ctx, intervals } = load({ duration: 10, currentTime: 7, cfSeconds: 9 });
    ctx._checkCrossfade();
    assert.equal(ctx._cfState, 'fading');
    assert.equal(intervals.length, 1);
    // 50 ms ticks: ceil(3333 / 50) = 67 steps, not the 180 a 9 s fade takes.
    let ticks = 0;
    ctx._completeCrossfade = () => { ctx._cfState = 'done'; };
    while (ctx._cfState === 'fading' && ticks < 500) { intervals[0].fn(); ticks++; }
    assert.equal(ticks, 67);
});

test('the fade does not start before the shortened window', () => {
    const { ctx } = load({ duration: 10, currentTime: 5, cfSeconds: 9 });
    ctx._checkCrossfade();
    assert.equal(ctx._cfState, 'preloaded', '5 s left is outside a 3.33 s fade');
});

test('a normal track is unchanged', () => {
    const early = load({ duration: 240, currentTime: 230, cfSeconds: 5 });
    early.ctx._checkCrossfade();
    assert.equal(early.ctx._cfState, 'preloaded');
    const late = load({ duration: 240, currentTime: 236, cfSeconds: 5 });
    late.ctx._checkCrossfade();
    assert.equal(late.ctx._cfState, 'fading');
});
