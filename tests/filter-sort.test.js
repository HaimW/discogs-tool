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
global.showSyncBanner = () => {};
global.hideSyncBanner = () => {};
global.sleep = () => Promise.resolve();
global.fetch = () => Promise.resolve({});
global.YT = {};

const { filterSortPaginate } = require('../app.js');

function makeRelease(overrides) {
    return Object.assign(
        { id: 1, artist: 'Artist', title: 'Title', genres: 'Rock', folder_ids: [1], country: 'US', year: 2000, date_added: '2020-01-01' },
        overrides
    );
}

// ── Filtering ─────────────────────────────────────────────────────────────────

test('filterSortPaginate: returns all when no filters', () => {
    const releases = [makeRelease({ id: 1 }), makeRelease({ id: 2 }), makeRelease({ id: 3 })];
    const { filtered } = filterSortPaginate(releases, {});
    assert.equal(filtered.length, 3);
});

test('filterSortPaginate: text search matches artist (case-insensitive)', () => {
    const releases = [makeRelease({ artist: 'The Beatles' }), makeRelease({ artist: 'Rolling Stones' })];
    const { filtered } = filterSortPaginate(releases, { q: 'beatl' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].artist, 'The Beatles');
});

test('filterSortPaginate: text search matches title (case-insensitive)', () => {
    const releases = [makeRelease({ title: 'Abbey Road' }), makeRelease({ title: 'Exile on Main St.' })];
    const { filtered } = filterSortPaginate(releases, { q: 'ABBEY' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].title, 'Abbey Road');
});

test('filterSortPaginate: empty query returns all releases', () => {
    const releases = [makeRelease({ id: 1 }), makeRelease({ id: 2 })];
    const { filtered } = filterSortPaginate(releases, { q: '' });
    assert.equal(filtered.length, 2);
});

test('filterSortPaginate: genre filter returns only matching releases', () => {
    const releases = [makeRelease({ genres: 'Rock, Pop' }), makeRelease({ genres: 'Jazz' })];
    const { filtered } = filterSortPaginate(releases, { genre: 'Jazz' });
    assert.equal(filtered.length, 1);
    assert.ok(filtered[0].genres.includes('Jazz'));
});

test('filterSortPaginate: folder filter returns only releases with matching folder_id', () => {
    const releases = [makeRelease({ folder_ids: [1, 2] }), makeRelease({ folder_ids: [3] })];
    const { filtered } = filterSortPaginate(releases, { folder: '2' });
    assert.equal(filtered.length, 1);
    assert.ok(filtered[0].folder_ids.includes(2));
});

test('filterSortPaginate: country filter returns only matching releases', () => {
    const releases = [makeRelease({ country: 'UK' }), makeRelease({ country: 'US' }), makeRelease({ country: 'UK' })];
    const { filtered } = filterSortPaginate(releases, { country: 'UK' });
    assert.equal(filtered.length, 2);
    assert.ok(filtered.every(r => r.country === 'UK'));
});

// ── Sorting ───────────────────────────────────────────────────────────────────

test('filterSortPaginate: sorts by artist ascending by default', () => {
    const releases = [makeRelease({ artist: 'Z Band' }), makeRelease({ artist: 'A Band' })];
    const { filtered } = filterSortPaginate(releases, {});
    assert.equal(filtered[0].artist, 'A Band');
    assert.equal(filtered[1].artist, 'Z Band');
});

test('filterSortPaginate: sorts by title', () => {
    const releases = [makeRelease({ title: 'Zephyr' }), makeRelease({ title: 'Abbey Road' })];
    const { filtered } = filterSortPaginate(releases, { sort: 'title' });
    assert.equal(filtered[0].title, 'Abbey Road');
});

test('filterSortPaginate: sorts by year descending', () => {
    const releases = [makeRelease({ year: 1970 }), makeRelease({ year: 1990 }), makeRelease({ year: 1980 })];
    const { filtered } = filterSortPaginate(releases, { sort: 'year' });
    assert.equal(filtered[0].year, 1990);
    assert.equal(filtered[2].year, 1970);
});

test('filterSortPaginate: sorts by date_added descending', () => {
    const releases = [makeRelease({ date_added: '2020-01-01' }), makeRelease({ date_added: '2023-06-01' })];
    const { filtered } = filterSortPaginate(releases, { sort: 'date_added' });
    assert.equal(filtered[0].date_added, '2023-06-01');
});

// ── Pagination ────────────────────────────────────────────────────────────────

test('filterSortPaginate: page 1 of 2 returns 48 items', () => {
    const releases = Array.from({ length: 53 }, (_, i) => makeRelease({ id: i, artist: String(i).padStart(3, '0') }));
    const { pageReleases, totalPages } = filterSortPaginate(releases, { page: 1 });
    assert.equal(pageReleases.length, 48);
    assert.equal(totalPages, 2);
});

test('filterSortPaginate: page 2 of 2 returns remaining items', () => {
    const releases = Array.from({ length: 53 }, (_, i) => makeRelease({ id: i, artist: String(i).padStart(3, '0') }));
    const { pageReleases } = filterSortPaginate(releases, { page: 2 });
    assert.equal(pageReleases.length, 5);
});

test('filterSortPaginate: out-of-range page clamped to last page', () => {
    const releases = Array.from({ length: 10 }, (_, i) => makeRelease({ id: i }));
    const { page, pageReleases } = filterSortPaginate(releases, { page: 99 });
    assert.equal(page, 1);
    assert.equal(pageReleases.length, 10);
});

test('filterSortPaginate: combined filter + sort + paginate', () => {
    const releases = [
        ...Array.from({ length: 30 }, (_, i) => makeRelease({ id: i, genres: 'Rock', year: 2000 - i, artist: String(i).padStart(3, '0') })),
        ...Array.from({ length: 20 }, (_, i) => makeRelease({ id: 100 + i, genres: 'Jazz' })),
    ];
    const { filtered, pageReleases, totalPages } = filterSortPaginate(releases, { genre: 'Rock', sort: 'year', page: 1 });
    assert.equal(filtered.length, 30);
    assert.equal(filtered[0].year, 2000);
    assert.equal(totalPages, 1);
    assert.equal(pageReleases.length, 30);
});
