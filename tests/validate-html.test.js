const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('index.html: has DOCTYPE declaration', () => {
    assert.ok(html.toLowerCase().includes('<!doctype html>'), 'Missing <!DOCTYPE html>');
});

test('index.html: has UTF-8 charset meta tag', () => {
    assert.ok(/charset=["']?utf-8/i.test(html), 'Missing charset=UTF-8 meta tag');
});

test('index.html: has viewport meta tag', () => {
    assert.ok(/name=["']viewport["']/i.test(html), 'Missing viewport meta tag');
});

test('index.html: loads app.js via <script src>', () => {
    assert.ok(/src=["']app\.js["']/i.test(html), 'Missing <script src="app.js">');
});

test('index.html: loads style.css via <link rel="stylesheet">', () => {
    assert.ok(/rel=["']stylesheet["']/i.test(html), 'Missing rel="stylesheet"');
    assert.ok(/href=["']style\.css["']/i.test(html), 'Missing href="style.css"');
});

test('index.html: required DOM IDs are present', () => {
    const requiredIds = [
        'app',
        'now-playing',
        'np-play-pause',
        'np-next',
        'np-prev',
        'np-queue',
        'viz-canvas',
        'notif-panel',
        'sync-banner',
    ];
    for (const id of requiredIds) {
        assert.ok(html.includes(`id="${id}"`), `Missing required DOM element id="${id}"`);
    }
});

test('index.html: no hardcoded localhost or 127.0.0.1 URLs', () => {
    assert.ok(!html.includes('localhost'), 'Found hardcoded "localhost" in index.html');
    assert.ok(!html.includes('127.0.0.1'), 'Found hardcoded "127.0.0.1" in index.html');
});
