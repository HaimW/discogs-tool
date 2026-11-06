// F15 volume control: one master volume (0-100) + mute, applied to both
// YouTube players through src/volume.js, and respected by the crossfade.
// src/player.js, src/volume.js and src/crossfade.js are loaded into a VM
// context (as in index.html) with stand-in players that record setVolume().
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function fakePlayer(name) {
    const p = {
        name, volume: 100, muted: false, calls: [],
        setVolume(v) { p.volume = v; p.calls.push(v); },
        getVolume: () => p.volume,
        mute() { p.muted = true; }, unMute() { p.muted = false; }, isMuted: () => p.muted,
        getDuration: () => 300, getCurrentTime: () => 290,
        loadVideoById() {}, cueVideoById() {}, playVideo() {}, pauseVideo() {}, stopVideo() {},
    };
    return p;
}

function load() {
    const elements = {};
    const el = id => (elements[id] = elements[id] || {
        id, style: {}, textContent: '', innerHTML: '', src: '', dataset: {}, value: '', title: '', attrs: {},
        setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; },
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener() {}, appendChild() {}, querySelectorAll() { return []; },
    });
    const intervals = new Map();
    let nextId = 1;
    const config = new Map();
    const ctx = {
        console, Math, JSON, Date, Promise, Number,
        document: {
            getElementById: el,
            createElement: () => el('created-' + nextId++),
            head: { appendChild() {} },
            documentElement: { style: { setProperty() {} } },
            querySelectorAll() { return []; },
        },
        sessionStorage: { setItem() {}, getItem() { return null; } },
        setInterval(fn, ms) { const id = nextId++; intervals.set(id, { fn, ms }); return id; },
        clearInterval(id) { intervals.delete(id); },
        setTimeout() { return 0; },
        YT: { PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } },
        dbGet: async (s, k) => config.get(k),
        dbPut: async (s, rec) => { config.set(rec.key, rec); },
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    for (const f of ['src/player.js', 'src/volume.js', 'src/crossfade.js']) vm.runInContext(read(f), ctx, { filename: f });
    Object.assign(ctx, {
        startViz() {}, stopViz() {}, highlightActiveTrack() {}, _savePlayerState() {},
        _renderQueuePanel() {}, _trackPlayerHeight() {},
    });
    ctx.player = fakePlayer('p1');
    ctx.player2 = fakePlayer('p2');
    ctx.playerReady = true;
    ctx.player2Ready = true;
    ctx.currentQueue = [
        { youtubeId: 'aaaaaaaaaaa', title: 'One', artist: 'A' },
        { youtubeId: 'bbbbbbbbbbb', title: 'Two', artist: 'B' },
    ];
    ctx.currentIndex = 0;
    ctx.cfEnabled = true;
    ctx.cfSeconds = 5;
    const fadeTimer = () => [...intervals.values()].find(t => t.ms === 50);
    return { ctx, el, config, fadeTimer, p1: ctx.player, p2: ctx.player2 };
}

// Starts a fade of `seconds` (20 ticks per second) from the preloaded state.
function startFade(app, seconds) {
    app.ctx._cfState = 'preloaded';
    app.ctx._cfPreloadedIndex = 1;
    app.ctx._startCrossfade(seconds);
    assert.equal(app.ctx._cfState, 'fading');
    return app.fadeTimer();
}

test('clamping: ints 0-100; NaN and non-numbers fall back', () => {
    const { ctx } = load();
    assert.equal(ctx._clampVolume(60, 1), 60);
    assert.equal(ctx._clampVolume('42', 1), 42);
    assert.equal(ctx._clampVolume(42.6, 1), 43);
    assert.equal(ctx._clampVolume(-5, 1), 0);
    assert.equal(ctx._clampVolume(250, 1), 100);
    for (const bad of [NaN, Infinity, undefined, null, '', 'abc', {}, true]) {
        assert.equal(ctx._clampVolume(bad, 7), 7, String(bad));
    }
    ctx.setMasterVolume(60);
    ctx.setMasterVolume(NaN);
    ctx.setMasterVolume('loud');
    assert.equal(ctx.masterVolume, 60, 'invalid input ignored');
    ctx.onVolumeInput('');
    assert.equal(ctx.masterVolume, 60);
});

test('a master volume change and mute apply to player 1 when not fading', () => {
    const { ctx, p1, p2 } = load();
    ctx.setMasterVolume(60);
    assert.equal(p1.volume, 60);
    assert.equal(p2.volume, 0, 'the idle preload player stays silent');
    ctx.setMasterMuted(true);
    assert.equal(p1.volume, 0);
    ctx.setMasterMuted(false);
    assert.equal(p1.volume, 60, 'unmute returns to the chosen volume');
});

test('fade with master 60: player 1 60 -> 0, player 2 0 -> 60', () => {
    const app = load();
    const { ctx, p1, p2 } = app;
    ctx.setMasterVolume(60);
    const timer = startFade(app, 1); // 20 ticks
    assert.equal(p1.volume, 60, 'fade starts at master');
    assert.equal(p2.volume, 0);
    for (let i = 0; i < 10; i++) timer.fn();
    assert.equal(p1.volume, 30, 'midpoint');
    assert.equal(p2.volume, 30, 'midpoint');
    for (let i = 0; i < 5; i++) timer.fn();
    assert.equal(p1.volume, 15);
    assert.equal(p2.volume, 45);
    for (let i = 0; i < 5; i++) timer.fn();
    // Last tick: the fade completes and player 1 switches to the next track.
    assert.equal(ctx._cfState, 'switching');
    assert.equal(p1.volume, 0, 'player 1 loads the next track silently');
    assert.equal(p2.volume, 60, 'player 2 carries the master volume until the hand-over');
    assert.ok(Math.max(...p2.calls) <= 60, 'player 2 never goes above the master volume');
    assert.equal(app.fadeTimer(), undefined, 'fade timer stopped');
});

test('changing the volume mid-fade rescales both players at the current ratio', () => {
    const app = load();
    const { ctx, p1, p2 } = app;
    ctx.setMasterVolume(60);
    const timer = startFade(app, 1);
    for (let i = 0; i < 5; i++) timer.fn(); // ratio 0.25
    assert.equal(p1.volume, 45);
    assert.equal(p2.volume, 15);
    ctx.onVolumeInput('80');
    assert.equal(p1.volume, 60, '80 * 0.75');
    assert.equal(p2.volume, 20, '80 * 0.25');
    timer.fn(); // ratio 0.3
    assert.equal(p1.volume, 56);
    assert.equal(p2.volume, 24);
});

test('muting mid-fade silences both; unmuting restores them at the ratio', () => {
    const app = load();
    const { ctx, p1, p2 } = app;
    ctx.setMasterVolume(60);
    const timer = startFade(app, 1);
    for (let i = 0; i < 10; i++) timer.fn(); // ratio 0.5
    ctx.toggleMute();
    assert.equal(ctx.masterMuted, true);
    assert.equal(p1.volume, 0);
    assert.equal(p2.volume, 0);
    timer.fn(); // the fade keeps going, silently
    assert.equal(p1.volume, 0);
    assert.equal(p2.volume, 0);
    ctx.toggleMute(); // ratio 0.55
    assert.equal(p1.volume, 27);
    assert.equal(p2.volume, 33);
});

test('aborting a fade restores the master volume on player 1 (0 when muted)', () => {
    const app = load();
    const { ctx, p1, p2 } = app;
    ctx.setMasterVolume(60);
    let timer = startFade(app, 1);
    for (let i = 0; i < 7; i++) timer.fn();
    ctx._abortCrossfade();
    assert.equal(ctx._cfState, 'idle');
    assert.equal(ctx._cfFadeRatio, null);
    assert.equal(p1.volume, 60);
    assert.equal(p2.volume, 0);

    ctx.setMasterMuted(true);
    timer = startFade(app, 1);
    for (let i = 0; i < 7; i++) timer.fn();
    ctx._abortCrossfade();
    assert.equal(p1.volume, 0, 'muted: stays silent');
    assert.equal(p2.volume, 0);
    assert.ok(Math.max(...p1.calls.slice(-8)) === 0, 'never audible while muted');
});

test('the switching hand-over restores the master volume on player 1', () => {
    const app = load();
    const { ctx, p1, p2 } = app;
    ctx.setMasterVolume(60);
    const timer = startFade(app, 1);
    for (let i = 0; i < 20; i++) timer.fn();
    assert.equal(ctx._cfState, 'switching');
    // Volume changed while player 1 is still loading: player 2 follows.
    ctx.onVolumeInput(40);
    assert.equal(p1.volume, 0);
    assert.equal(p2.volume, 40);
    ctx.onPlayerStateChange({ data: ctx.YT.PlayerState.PLAYING });
    assert.equal(ctx._cfState, 'idle');
    assert.equal(p1.volume, 40, 'player 1 takes over at the master volume, not 100');
    assert.equal(p2.volume, 0);
});

test('the hand-over while muted keeps both silent', () => {
    const app = load();
    const { ctx, p1, p2 } = app;
    ctx.setMasterVolume(60);
    ctx.setMasterMuted(true);
    const from1 = p1.calls.length;
    const from2 = p2.calls.length;
    const timer = startFade(app, 1);
    for (let i = 0; i < 20; i++) timer.fn();
    ctx.onPlayerStateChange({ data: ctx.YT.PlayerState.PLAYING });
    assert.equal(p1.volume, 0);
    assert.equal(p2.volume, 0);
    assert.ok(Math.max(...p1.calls.slice(from1), ...p2.calls.slice(from2)) === 0, 'nothing audible at any point');
});

test('a new track and PLAYING apply the master volume; player ready clears a stale YT mute', () => {
    const { ctx, p1 } = load();
    ctx.setMasterVolume(35);
    p1.volume = 100; // as if YouTube reset it on the new video
    ctx.loadFromQueue(1);
    assert.equal(p1.volume, 35, 'loadFromQueue');
    p1.volume = 100;
    ctx.onPlayerStateChange({ data: ctx.YT.PlayerState.PLAYING });
    assert.equal(p1.volume, 35, 'PLAYING re-applies');
    p1.muted = true;
    p1.volume = 100;
    ctx._initPlayerVolume(p1);
    assert.equal(p1.muted, false, 'unMute()d');
    assert.equal(p1.volume, 35);
});

test('settings: loaded from config (validated), saved on demand, UI reflects state', async () => {
    const app = load();
    const { ctx, el, config, p1 } = app;
    config.set('player_volume', { key: 'player_volume', value: 45 });
    config.set('player_muted', { key: 'player_muted', value: true });
    await ctx._loadVolumeSettings();
    assert.equal(ctx.masterVolume, 45);
    assert.equal(ctx.masterMuted, true);
    assert.equal(p1.volume, 0, 'applied to an already-ready player');
    assert.equal(el('np-volume').value, '45', 'muted leaves the slider value');
    assert.equal(el('np-volume').attrs['aria-valuetext'], 'Muted (45%)');
    assert.equal(el('np-mute').attrs['aria-pressed'], 'true');
    assert.equal(el('np-mute').attrs['aria-label'], 'Unmute');

    ctx.onVolumeInput('70'); // moving the slider unmutes
    assert.equal(ctx.masterMuted, false);
    assert.equal(p1.volume, 70);
    assert.equal(el('np-mute').attrs['aria-pressed'], 'false');
    assert.equal(el('np-mute').attrs['aria-label'], 'Mute');
    assert.equal(el('np-volume').attrs['aria-valuetext'], '70%');
    ctx._saveVolumeSettings();
    await Promise.resolve();
    assert.equal(config.get('player_volume').value, 70);
    assert.equal(config.get('player_muted').value, false);

    // Garbage in the store falls back to the defaults.
    const other = load();
    other.config.set('player_volume', { key: 'player_volume', value: 'x' });
    other.config.set('player_muted', { key: 'player_muted', value: 'yes' });
    await other.ctx._loadVolumeSettings();
    assert.equal(other.ctx.masterVolume, 100);
    assert.equal(other.ctx.masterMuted, false);
});

test('a change made before the saved settings load is not overwritten by them', async () => {
    const { ctx, config } = load();
    config.set('player_volume', { key: 'player_volume', value: 45 });
    const loading = ctx._loadVolumeSettings();
    ctx.onVolumeInput(20);
    await loading;
    assert.equal(ctx.masterVolume, 20);
});

test('toggling mute before the saved settings load keeps the stored volume', async () => {
    const { ctx, config } = load();
    config.set('player_volume', { key: 'player_volume', value: 40 });
    const loading = ctx._loadVolumeSettings();
    ctx.toggleMute(); // saves, before the load has resolved
    assert.equal(config.has('player_muted'), false, 'no save while the stored values are still loading');
    await loading;
    await Promise.resolve();
    assert.equal(ctx.masterVolume, 40, 'the stored volume still applies');
    assert.equal(ctx.masterMuted, true, 'the mute toggle wins over the stored (unset) mute');
    assert.equal(config.get('player_volume').value, 40, 'the default 100 is not written over it');
    assert.equal(config.get('player_muted').value, true);
});
