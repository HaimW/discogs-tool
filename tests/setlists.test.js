// F18: BPM, key, energy and rating in setlists. Tracks saved without a metaId
// still find their track_meta record (release + video, then video alone), in
// the setlist view and in the CSV export; the rows share fixed columns.
// The plain <script> files are loaded into a VM context, as elsewhere.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const FILES = ['src/utils.js', 'src/actions.js', 'src/camelot.js', 'src/meta.js', 'src/queue_meta.js',
    'src/setlists.js', 'src/marketplace.js', 'src/backup.js'];

function load() {
    const stores = { setlists: new Map() };
    const toasts = [];
    const ctx = {
        Math, Date, JSON, Object, Promise, console, structuredClone,
        document: { addEventListener() {} },
        dbGet: async (s, k) => structuredClone(stores[s].get(k)),
        dbPut: async (s, rec) => { stores[s].set(rec.id, structuredClone(rec)); },
    };
    vm.createContext(ctx);
    for (const f of FILES) vm.runInContext(read(f), ctx, { filename: f });
    ctx.showToast = (msg, type) => { toasts.push([msg, type]); };
    return { S: ctx, stores, toasts };
}

const { S, stores } = load();
const plain = v => JSON.parse(JSON.stringify(v));

const METAS = [
    { id: '1_vidA', bpm: 124, key: '8A', energy: 7, rating: 4 },
    { id: '2_vidB', bpm: 122.5, key: '9A' },
    { id: '3_vidC', bpm: 126.2, key: '10B', bpm_source: 'analysis', key_source: 'analysis' },
    { id: '6_vidF', energy: 3, rating: 2 },              // no tempo or key
    { id: '7_vidG', rating: 1 },                         // rating only, on one release ...
    { id: '8_vidG', bpm: 100, key: '1A' },               // ... tempo and key on another
    { id: '9_vidH' },                                    // nothing at all
];

test('a setlist track is matched by metaId, then release + video, then the video alone', () => {
    const idx = S.setlistMetaIndex(METAS);
    assert.equal(S.queueItemMeta({ metaId: '1_vidA', youtubeId: 'vidA' }, idx).id, '1_vidA');
    assert.equal(S.queueItemMeta({ metaId: null, releaseId: 2, youtubeId: 'vidB' }, idx).id, '2_vidB');
    assert.equal(S.queueItemMeta({ metaId: null, releaseId: null, youtubeId: 'vidC' }, idx).id, '3_vidC');
    assert.equal(S.queueItemMeta({ metaId: null, releaseId: 99, youtubeId: 'vidC' }, idx).id, '3_vidC', 'other pressing, same video');
    assert.equal(S.queueItemMeta({ metaId: '5_gone', releaseId: 5, youtubeId: 'vidZ' }, idx), null);
    assert.equal(S.queueItemMeta({ youtubeId: 'vidH' }, idx), null, 'an empty record is not a match');
});

test('setlists also find energy / rating-only records; the queue index is unchanged', () => {
    const sIdx = S.setlistMetaIndex(METAS);
    const qIdx = S.queueMetaIndex(METAS);
    assert.equal(S.queueItemMeta({ releaseId: 6, youtubeId: 'vidF' }, sIdx).id, '6_vidF');
    assert.equal(S.queueItemMeta({ releaseId: 6, youtubeId: 'vidF' }, qIdx), null, 'queue: BPM / key only');
    // By video alone, a record with tempo / key beats a rating-only one listed first.
    assert.equal(S.queueItemMeta({ youtubeId: 'vidG' }, sIdx).id, '8_vidG');
    assert.equal(S.queueItemMeta({ youtubeId: 'vidG' }, qIdx).id, '8_vidG');
    // ... but the exact release still wins.
    assert.equal(S.queueItemMeta({ releaseId: 7, youtubeId: 'vidG' }, sIdx).id, '7_vidG');
    assert.equal(S.setlistMetaHasData({ rating: 0, energy: '' }), false);
    assert.equal(S.setlistMetaHasData({ energy: '4' }), true);
});

test('itemMetaId: kept when there is one, built from release + video when not', () => {
    assert.equal(S.itemMetaId({ metaId: '1_x', releaseId: 2, youtubeId: 'y' }), '1_x');
    assert.equal(S.itemMetaId({ metaId: null, releaseId: 2, youtubeId: 'y_z' }), '2_y_z');
    assert.equal(S.itemMetaId({ releaseId: null, youtubeId: 'y' }), null);
    assert.equal(S.itemMetaId({ releaseId: 2 }), null);
    assert.equal(S.itemMetaId(null), null);
});

test('adding a track without a metaId stores the release + video id', async () => {
    stores.setlists.set(1, { id: 1, name: 'Set', tracks: [] });
    await S.addTrackToSetlist(1, { youtubeId: 'vidB', title: 'B', releaseId: 2, metaId: null });
    await S.addTrackToSetlist(1, { youtubeId: 'vidC', title: 'C', releaseId: null });
    const tracks = stores.setlists.get(1).tracks;
    assert.equal(tracks[0].metaId, '2_vidB');
    assert.equal(tracks[1].metaId, null, 'no release: left empty, the view matches by video');
});

test('playing a setlist carries metaId into the queue', () => {
    const items = S.setlistQueueItems({ tracks: [{ youtubeId: 'v', title: 'T', releaseId: 2, metaId: '2_v' }, { youtubeId: 'w', title: 'U' }] });
    assert.deepEqual(plain(items), [
        { youtubeId: 'v', releaseId: 2, metaId: '2_v', title: 'T', artist: '', cover: '' },
        { youtubeId: 'w', releaseId: null, metaId: null, title: 'U', artist: '', cover: '' },
    ]);
});

test('the table: a header row, then one row per track with the same ten cells', () => {
    const sl = {
        id: 4, name: 'Fri <b>', tracks: [
            { youtubeId: 'vidB', title: 'Can <You> "Feel"', artist: 'Mr. F', releaseId: 2, metaId: null },
            { youtubeId: 'vidZ', title: 'Nothing', artist: '', releaseId: 5, metaId: null },
        ],
    };
    const html = S.setlistTableHtml(sl, S.setlistMetaIndex(METAS));
    assert.match(html, /role="table" aria-label="Tracks in Fri &lt;b&gt;"/);
    assert.equal((html.match(/class="setlist-head" role="row"/g) || []).length, 1);
    assert.equal((html.match(/class="video-item setlist-row"/g) || []).length, 2);
    assert.equal((html.match(/role="columnheader"/g) || []).length, 10);
    assert.equal((html.match(/role="cell"/g) || []).length, 20, 'every row has every cell, filled or not');
    assert.doesNotMatch(html, /setlist-head[^>]*draggable/, 'the header is not draggable');
    assert.match(html, /Can &lt;You&gt; &quot;Feel&quot;/);
    assert.doesNotMatch(html, /<You>/);
    const rows = html.split('class="video-item setlist-row"').slice(1);
    assert.match(rows[0], /badge-bpm"[^>]*>122\.5</, 'no metaId: found by release + video');
    assert.match(rows[0], /camelot-chip[^>]*>9A/);
    assert.equal((rows[1].match(/class="sl-none"/g) || []).length, 4, 'no data: four empty cells');
});

test('the table: values from a tampered backup cannot break out of any attribute (C1)', () => {
    const evil = 'x" onmouseover="alert(1)" a="<img src=x onerror=alert(2)>';
    const sl = {
        id: 4, name: evil, tracks: [
            { youtubeId: evil, title: evil, artist: evil, cover: evil, releaseId: evil, metaId: evil },
            { youtubeId: 'vidB', title: 'B', releaseId: 0, metaId: null },
        ],
    };
    const html = S.setlistTableHtml(sl, S.setlistMetaIndex(METAS));
    assert.doesNotMatch(html, /onmouseover="/, 'no injected handler attribute');
    assert.doesNotMatch(html, /<img src=x/, 'no injected element');
    const esc = 'x&quot; onmouseover=&quot;alert(1)&quot; a=&quot;&lt;img src=x onerror=alert(2)&gt;';
    assert.ok(html.includes('data-release-id="' + esc + '"'), 'releaseId escaped');
    for (const attr of ['data-youtube-id', 'data-title', 'data-artist', 'data-cover', 'data-meta-id']) {
        assert.ok(html.includes(attr + '="' + esc + '"'), attr + ' escaped');
    }
    // Every quote in the markup belongs to an attribute this code wrote.
    for (const tag of html.match(/<[^>]+>/g)) {
        assert.match(tag, /^<\/?[a-z]+(\s+[a-z-]+(="[^"]*")?)*\s*\/?>$/, 'well-formed tag: ' + tag.slice(0, 80));
    }
});

test('metadata cells: estimates marked, energy and rating shown, rating spoken as "n of 5"', () => {
    const est = S.setlistMetaCellsHtml(METAS[2]);
    assert.match(est, /badge-bpm badge-estimated/);
    assert.match(est, /126\.2<span class="badge-est" aria-hidden="true">~<\/span>/);
    assert.match(est, /camelot-chip-estimated/);
    const full = S.setlistMetaCellsHtml(METAS[0]);
    assert.match(full, /124<span class="badge-est" aria-hidden="true"><\/span>/, 'empty ~ slot keeps figures aligned');
    assert.match(full, /badge-energy/);
    assert.match(full, /<span class="sr-only">4 of 5<\/span>/);
    assert.equal(S.setlistBpmText({ bpm: '128.04' }), '128');
    assert.equal(S.setlistBpmText({ bpm: 0 }), '');
});

test('CSV export finds BPM / key the same way as the view', () => {
    const sl = {
        tracks: [
            { youtubeId: 'vidA', title: 'A', artist: 'X, Y', releaseId: 1, metaId: '1_vidA' },
            { youtubeId: 'vidB', title: 'B "b"', artist: '', releaseId: 2, metaId: null },
            { youtubeId: 'vidC', title: 'C', artist: '', releaseId: null },
            { youtubeId: 'vidZ', title: 'Z', artist: '', releaseId: 5, metaId: null },
        ],
    };
    const lines = S.setlistCsv(sl, METAS).trim().split('\n');
    assert.equal(lines[0], 'order,artist,title,release_id,youtube_id,youtube_url,bpm,key,energy,rating');
    assert.equal(lines[1], '1,"X, Y",A,1,vidA,https://www.youtube.com/watch?v=vidA,124,8A,7,4');
    assert.equal(lines[2], '2,,"B ""b""",2,vidB,https://www.youtube.com/watch?v=vidB,122.5,9A,,');
    assert.equal(lines[3], '3,,C,,vidC,https://www.youtube.com/watch?v=vidC,126.2,10B,,');
    assert.equal(lines[4], '4,,Z,5,vidZ,https://www.youtube.com/watch?v=vidZ,,,,');
});

test('CSV export: a comma, quote or newline in release_id stays in its own cell', () => {
    const sl = {
        tracks: [
            { youtubeId: 'vidA', title: 'A', artist: '', releaseId: '1,"2"\n3', metaId: '1_vidA' },
        ],
    };
    const text = S.setlistCsv(sl, METAS);
    assert.equal(text, 'order,artist,title,release_id,youtube_id,youtube_url,bpm,key,energy,rating\n' +
        '1,,A,"1,""2""\n3",vidA,https://www.youtube.com/watch?v=vidA,124,8A,7,4\n');
    // Quoted fields parsed properly: ten columns, release_id intact.
    const cells = [];
    let cur = '', q = false;
    const row = text.split('\n').slice(1).join('\n').replace(/\n$/, '');
    for (let i = 0; i < row.length; i++) {
        const c = row[i];
        if (q) { if (c === '"' && row[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
        else if (c === '"') q = true; else if (c === ',') { cells.push(cur); cur = ''; } else cur += c;
    }
    cells.push(cur);
    assert.equal(cells.length, 10);
    assert.equal(cells[3], '1,"2"\n3');
    assert.equal(cells[4], 'vidA');
    assert.equal(cells[8], '7');
    assert.equal(cells[9], '4');
});

test('CSV export: energy column, and the key from a musical name when no code is stored (decided 2026-11-06)', () => {
    const metas = [
        { id: '1_vidM', key_musical: 'A minor', energy: 0, rating: 3 },   // name only; energy 0 is a value
        { id: '2_vidN', key: '8a', bpm: 120 },                            // code spelled loosely
        { id: '3_vidO', key: 'weird', energy: 5 },                        // unrecognised: kept as written
    ];
    const sl = { tracks: [
        { youtubeId: 'vidM', title: 'M', releaseId: 1 },
        { youtubeId: 'vidN', title: 'N', releaseId: 2 },
        { youtubeId: 'vidO', title: 'O', releaseId: 3 },
    ] };
    const lines = S.setlistCsv(sl, metas).trim().split('\n');
    assert.equal(lines[1], '1,,M,1,vidM,https://www.youtube.com/watch?v=vidM,,8A,0,3');
    assert.equal(lines[2], '2,,N,2,vidN,https://www.youtube.com/watch?v=vidN,120,8A,,');
    assert.equal(lines[3], '3,,O,3,vidO,https://www.youtube.com/watch?v=vidO,,weird,5,');
});
