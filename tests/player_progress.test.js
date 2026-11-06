// M6 from docs/PROJECT_PLAN.md: after a crossfade hands over to the next
// track, the time bar must keep moving. src/player.js and src/crossfade.js
// are loaded into a VM context with a stand-in YouTube player and DOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function load() {
    const elements = {};
    const el = id => (elements[id] = elements[id] || {
        id, style: {}, textContent: '', innerHTML: '', src: '', dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener() {}, appendChild() {}, querySelectorAll() { return []; },
        setAttribute() {},
        getBoundingClientRect() { return { height: 80 }; },
    });
    const timers = new Map();
    let nextTimer = 1;
    const ctx = {
        console, Math, JSON, Date,
        document: {
            getElementById: el,
            createElement: () => el('created-' + nextTimer++),
            head: { appendChild() {} },
            documentElement: { style: { setProperty() {} } },
            querySelectorAll() { return []; },
        },
        sessionStorage: { setItem() {}, getItem() { return null; } },
        setInterval(fn, ms) { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
        clearInterval(id) { timers.delete(id); },
        setTimeout() { return 0; },
        ResizeObserver: class { observe() {} disconnect() {} },
        YT: { PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } },
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    for (const f of ['src/player.js', 'src/volume.js', 'src/crossfade.js']) vm.runInContext(read(f), ctx, { filename: f });
    // Everything the hand-over touches that is not under test.
    Object.assign(ctx, {
        startViz() { ctx.vizStarted = (ctx.vizStarted || 0) + 1; }, stopViz() {},
        highlightActiveTrack() {}, _savePlayerState() {}, _renderQueuePanel() {},
        _trackPlayerHeight() {},
    });
    let time = 0;
    ctx.player = {
        volume: 100,
        getDuration: () => 300, getCurrentTime: () => time, setVolume(v) { ctx.player.volume = v; }, getVolume: () => 100,
        loadVideoById() {}, cueVideoById() {}, playVideo() {}, pauseVideo() {},
    };
    ctx.player2 = {
        volume: 100,
        getCurrentTime: () => 6, setVolume(v) { ctx.player2.volume = v; }, pauseVideo() {}, playVideo() {}, cueVideoById() {},
    };
    ctx.playerReady = true;
    ctx.player2Ready = true;
    return { ctx, el, timers, setTime: t => { time = t; } };
}

const progressTimers = ({ timers }) => [...timers.values()].filter(t => t.ms === 500);

test('M6: the time bar keeps moving after a crossfade hand-over', () => {
    const app = load();
    const { ctx, el } = app;
    ctx.currentQueue = [
        { youtubeId: 'aaaaaaaaaaa', title: 'One', artist: 'A' },
        { youtubeId: 'bbbbbbbbbbb', title: 'Two', artist: 'B' },
    ];
    ctx.currentIndex = 0;
    ctx.isPlaying = true;
    ctx.cfEnabled = true;

    // Track one is playing: the progress timer runs.
    ctx.onPlayerStateChange({ data: ctx.YT.PlayerState.PLAYING });
    assert.equal(progressTimers(app).length, 1);

    // The fade completes: player 1 is switched to track two...
    ctx._cfState = 'fading';
    ctx._cfPreloadedIndex = 1;
    ctx._completeCrossfade();
    assert.equal(ctx._cfState, 'switching');
    assert.equal(el('np-time').textContent, '0:00 / 0:00', 'reset for the new track');

    // ...and reports PLAYING: the hand-over branch.
    ctx.onPlayerStateChange({ data: ctx.YT.PlayerState.PLAYING });
    assert.equal(ctx._cfState, 'idle');
    const running = progressTimers(app);
    assert.equal(running.length, 1, 'progress timer running again after the hand-over');

    app.setTime(42);
    running[0].fn();
    assert.equal(el('np-time').textContent, '0:42 / 5:00', 'time bar follows the new track');
    assert.equal(el('np-progress-fill').style.width, (42 / 300 * 100) + '%');
});

test('M6: the visualizer is (re)started on the hand-over too', () => {
    const app = load();
    const { ctx } = app;
    ctx.currentQueue = [{ youtubeId: 'aaaaaaaaaaa', title: 'One' }, { youtubeId: 'bbbbbbbbbbb', title: 'Two' }];
    ctx.currentIndex = 0;
    ctx._cfState = 'fading';
    ctx._cfPreloadedIndex = 1;
    ctx._completeCrossfade();
    ctx.onPlayerStateChange({ data: ctx.YT.PlayerState.PLAYING });
    assert.ok(ctx.vizStarted >= 1);
});

test('F15: the hand-over leaves player 1 at the master volume and player 2 silent', () => {
    for (const muted of [false, true]) {
        const app = load();
        const { ctx } = app;
        ctx.currentQueue = [{ youtubeId: 'aaaaaaaaaaa', title: 'One' }, { youtubeId: 'bbbbbbbbbbb', title: 'Two' }];
        ctx.currentIndex = 0;
        ctx.setMasterVolume(60);
        ctx.setMasterMuted(muted);
        ctx._cfState = 'fading';
        ctx._cfPreloadedIndex = 1;
        ctx._completeCrossfade();
        assert.equal(ctx._cfState, 'switching');
        ctx.player.volume = 100; // as if YouTube reset it on the new video
        ctx.onPlayerStateChange({ data: ctx.YT.PlayerState.PLAYING });
        assert.equal(ctx._cfState, 'idle');
        assert.equal(ctx.player.volume, muted ? 0 : 60, 'player 1 at the master volume' + (muted ? ' (muted)' : ''));
        assert.equal(ctx.player2.volume, 0, 'player 2 silent');
    }
});
