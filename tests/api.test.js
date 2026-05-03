const { test } = require('node:test');
const assert = require('node:assert/strict');

// Stub browser globals before requiring app.js
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
global.fetch = () => Promise.resolve({});
global.YT = {};

const { discogsGet, _testOverrides } = require('../app.js');

// Bypass real sleep in all tests — we test logic, not timing
_testOverrides.sleep = async () => {};

const CONFIG = { token: 'test-token', username: 'test-user' };

function makeResponse(status, body, headers = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
        headers: { get: (name) => headers[name] ?? null },
    };
}

test('discogsGet: resolves with parsed JSON on 200', async () => {
    global.fetch = async () => makeResponse(200, { items: [1, 2, 3] });
    const result = await discogsGet('/test', CONFIG);
    assert.deepEqual(result, { items: [1, 2, 3] });
});

test('discogsGet: throws on non-ok response (404)', async () => {
    global.fetch = async () => makeResponse(404, null);
    await assert.rejects(() => discogsGet('/test', CONFIG), /404/);
});

test('discogsGet: retries after network error then resolves', async () => {
    let calls = 0;
    global.fetch = async () => {
        calls++;
        if (calls === 1) throw new Error('network failure');
        return makeResponse(200, { ok: true });
    };
    const result = await discogsGet('/test', CONFIG, 1);
    assert.equal(result.ok, true);
    assert.equal(calls, 2);
});

test('discogsGet: throws after exhausting all retries', async () => {
    global.fetch = async () => { throw new Error('always fails'); };
    await assert.rejects(() => discogsGet('/test', CONFIG, 0), /always fails/);
});

test('discogsGet: handles 429 with Retry-After header and retries', async () => {
    let calls = 0;
    global.fetch = async () => {
        calls++;
        if (calls === 1) return makeResponse(429, null, { 'Retry-After': '0' });
        return makeResponse(200, { retried: true });
    };
    const result = await discogsGet('/test', CONFIG, 1);
    assert.equal(result.retried, true);
    assert.equal(calls, 2);
});

test('discogsGet: sleeps 10s when X-Discogs-Ratelimit-Remaining < 5', async () => {
    const sleepCalls = [];
    _testOverrides.sleep = async (ms) => { sleepCalls.push(ms); };
    global.fetch = async () => makeResponse(200, { data: 1 }, { 'X-Discogs-Ratelimit-Remaining': '3' });

    await discogsGet('/test', CONFIG);

    assert.ok(sleepCalls.includes(10000), 'expected sleep(10000) to be called');

    _testOverrides.sleep = async () => {}; // restore no-op
});
