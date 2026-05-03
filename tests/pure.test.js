const { test } = require('node:test');
const assert = require('node:assert/strict');

// Stub browser globals consumed at app.js load time
const _elem = { style: {}, textContent: '', disabled: false };
global.document = {
    createElement: () => ({ src: '' }),
    head: { appendChild: () => {} },
    addEventListener: () => {},
    getElementById: () => _elem,
};
global.window = { addEventListener: () => {} };
global.indexedDB = {};
global.navigator = {};
global.sessionStorage = { getItem: () => null, setItem: () => {} };
global.showSyncBanner = () => {};
global.hideSyncBanner = () => {};
global.sleep = () => Promise.resolve();
global.fetch = () => Promise.resolve({});
global.YT = {};

const { extractYoutubeId, escHtml, escJs } = require('../app.js');

// ── extractYoutubeId ──────────────────────────────────────────────────────────

test('extractYoutubeId: standard ?v= query param', () => {
    assert.equal(extractYoutubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

test('extractYoutubeId: youtu.be short URL', () => {
    assert.equal(extractYoutubeId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

test('extractYoutubeId: /shorts/ path', () => {
    assert.equal(extractYoutubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

test('extractYoutubeId: /embed/ path', () => {
    assert.equal(extractYoutubeId('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

test('extractYoutubeId: /live/ path', () => {
    assert.equal(extractYoutubeId('https://www.youtube.com/live/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

test('extractYoutubeId: /v/ path', () => {
    assert.equal(extractYoutubeId('https://www.youtube.com/v/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

test('extractYoutubeId: URL with extra params after video ID', () => {
    assert.equal(extractYoutubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s'), 'dQw4w9WgXcQ');
});

test('extractYoutubeId: youtu.be with query string', () => {
    assert.equal(extractYoutubeId('https://youtu.be/dQw4w9WgXcQ?t=42'), 'dQw4w9WgXcQ');
});

test('extractYoutubeId: non-YouTube URL returns null', () => {
    assert.equal(extractYoutubeId('https://example.com/watch?v=dQw4w9WgXcQ'), null);
});

test('extractYoutubeId: malformed URL returns null', () => {
    assert.equal(extractYoutubeId('not-a-url'), null);
});

test('extractYoutubeId: empty string returns null', () => {
    assert.equal(extractYoutubeId(''), null);
});

// ── escHtml ───────────────────────────────────────────────────────────────────

test('escHtml: escapes ampersand', () => {
    assert.equal(escHtml('a&b'), 'a&amp;b');
});

test('escHtml: escapes less-than', () => {
    assert.equal(escHtml('<script>'), '&lt;script&gt;');
});

test('escHtml: escapes double quote', () => {
    assert.equal(escHtml('"hello"'), '&quot;hello&quot;');
});

test('escHtml: plain text passes through unchanged', () => {
    assert.equal(escHtml('hello world'), 'hello world');
});

test('escHtml: falsy input returns empty string', () => {
    assert.equal(escHtml(''), '');
    assert.equal(escHtml(null), '');
    assert.equal(escHtml(undefined), '');
});

test('escHtml: combined XSS payload fully escaped', () => {
    assert.equal(
        escHtml('<script>alert("x&y")</script>'),
        '&lt;script&gt;alert(&quot;x&amp;y&quot;)&lt;/script&gt;'
    );
});

// ── escJs ─────────────────────────────────────────────────────────────────────

test('escJs: escapes single quote', () => {
    assert.equal(escJs("it's"), "it\\'s");
});

test('escJs: escapes backslash', () => {
    assert.equal(escJs('a\\b'), 'a\\\\b');
});

test('escJs: plain text passes through unchanged', () => {
    assert.equal(escJs('hello'), 'hello');
});

test('escJs: falsy input returns empty string', () => {
    assert.equal(escJs(''), '');
    assert.equal(escJs(null), '');
    assert.equal(escJs(undefined), '');
});

test('escJs: backslash before quote escaped in correct order', () => {
    assert.equal(escJs("a\\'b"), "a\\\\\\'b");
});
