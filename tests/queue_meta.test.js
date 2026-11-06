// F16: BPM and key in the queue rows. queue_meta.js is a plain <script> file,
// loaded into a VM context with the helpers it calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function load() {
    const ctx = { Math, Date, JSON, console, document: { addEventListener() {} } };
    vm.createContext(ctx);
    for (const f of ['src/utils.js', 'src/actions.js', 'src/camelot.js', 'src/meta.js', 'src/queue_meta.js']) {
        vm.runInContext(read(f), ctx, { filename: f });
    }
    return ctx;
}

const Q = load();
const plain = v => JSON.parse(JSON.stringify(v));

test('BPM is rounded to a whole number; keys become Camelot codes', () => {
    assert.deepEqual(plain(Q.queueMetaParts({ bpm: 123.6, key: '8A' })), { bpm: 124, key: '8A' });
    assert.deepEqual(plain(Q.queueMetaParts({ bpm: 99.5 })), { bpm: 100, key: null });
    assert.deepEqual(plain(Q.queueMetaParts({ bpm: '128.2' })), { bpm: 128, key: null });
    assert.deepEqual(plain(Q.queueMetaParts({ key: ' 08a ' })), { bpm: null, key: '8A' });
    assert.deepEqual(plain(Q.queueMetaParts({ key: 'A minor' })), { bpm: null, key: '8A' });
    assert.deepEqual(plain(Q.queueMetaParts({ key_musical: 'C major' })), { bpm: null, key: '8B' });
});

test('nothing to show: no record, no values, or values that are not a tempo or a key', () => {
    assert.equal(Q.queueMetaParts(null), null);
    assert.equal(Q.queueMetaParts({ rating: 4 }), null);
    assert.equal(Q.queueMetaParts({ bpm: '', key: '' }), null);
    assert.equal(Q.queueMetaParts({ bpm: 0, key: 'H minor' }), null);
    assert.equal(Q.queueMetaParts({ bpm: 'fast', key: '13A' }), null);
    assert.equal(Q.queueMetaParts({ bpm: -5 }), null);
    assert.equal(Q.queueMetaHtml(null), '');
    assert.equal(Q.queueMetaHtml({ id: '1_x', rating: 5 }), '');
});

test('screen readers hear "124 BPM, key 8A"', () => {
    assert.equal(Q.queueMetaLabel({ bpm: 124, key: '8A' }), '124 BPM, key 8A');
    assert.equal(Q.queueMetaLabel({ bpm: 98, key: null }), '98 BPM');
    assert.equal(Q.queueMetaLabel({ bpm: null, key: '11B' }), 'key 11B');
    const html = Q.queueMetaHtml({ bpm: 123.6, key: '8A' });
    assert.match(html, /<span class="queue-meta-vis" aria-hidden="true">/);
    assert.match(html, /<span class="sr-only">124 BPM, key 8A<\/span>/);
    assert.match(html, />124<\/span>/);
    assert.match(html, /camelot-chip/);
    assert.doesNotMatch(html, /camelot-rel|camelot-musical|A minor<\/span>/, 'compact chip: no relative key or name');
});

test('only what there is gets drawn, and estimates are marked', () => {
    const bpmOnly = Q.queueMetaHtml({ bpm: 98.2 });
    assert.match(bpmOnly, /queue-bpm/);
    assert.doesNotMatch(bpmOnly, /camelot-chip/);
    const keyOnly = Q.queueMetaHtml({ key: '3A' });
    assert.match(keyOnly, /camelot-chip/);
    assert.doesNotMatch(keyOnly, /queue-bpm/);
    const est = Q.queueMetaHtml({ bpm: 120, key: '5A', bpm_source: 'analysis', key_source: 'analysis' });
    assert.match(est, /queue-bpm-estimated/);
    assert.match(est, /camelot-chip-estimated/);
    const confirmed = Q.queueMetaHtml({ bpm: 120, key: '5A', bpm_source: 'analysis', key_source: 'analysis', bpm_verified: true });
    assert.doesNotMatch(confirmed, /estimated/);
});

test('a queue item finds its record by metaId, then release + video, then video alone', () => {
    const idx = Q.queueMetaIndex([
        { id: '1_abc', bpm: 120 },
        { id: 'custom', bpm: 130 },
        { id: '9_dup', bpm: 90 },
        { id: '7_dup', bpm: 70 },
        { id: '5_under_score', key: '1A' },
        { id: '6_given', youtube_id: 'from-field', key: '2A' },
        { id: '3_empty', rating: 3 },
        { id: '4_empty', bpm: 140 },
    ]);
    const bpmOf = item => { const m = Q.queueItemMeta(item, idx); return m ? m.bpm || m.key : null; };
    assert.equal(bpmOf({ youtubeId: 'abc', releaseId: 1 }), 120);
    assert.equal(bpmOf({ youtubeId: 'abc', releaseId: '1' }), 120, 'a string release id still matches');
    assert.equal(bpmOf({ youtubeId: 'abc', releaseId: 1, metaId: 'custom' }), 130, 'metaId first');
    assert.equal(bpmOf({ youtubeId: 'abc', releaseId: 1, metaId: 'gone' }), 120, 'unknown metaId falls through');
    assert.equal(bpmOf({ youtubeId: 'abc', releaseId: null }), 120, 'no release: by video');
    assert.equal(bpmOf({ youtubeId: 'abc', releaseId: 2 }), 120, 'other release: by video');
    assert.equal(bpmOf({ youtubeId: 'dup', releaseId: 7 }), 70, 'exact release beats the video fallback');
    assert.equal(bpmOf({ youtubeId: 'dup' }), 90, 'several releases: the first record with data');
    assert.equal(bpmOf({ youtubeId: 'under_score' }), '1A', 'video ids may contain "_"');
    assert.equal(bpmOf({ youtubeId: 'from-field' }), '2A', 'youtube_id field preferred over the id');
    assert.equal(bpmOf({ youtubeId: 'empty', releaseId: 3 }), 140, 'a record with nothing to show is skipped');
    assert.equal(bpmOf({ youtubeId: 'nothing', releaseId: 1 }), null);
    assert.equal(Q.queueItemMeta(null, idx), null);
    assert.equal(Q.queueItemMeta({ youtubeId: 'abc' }, null), null);
});

test('the index ignores junk records and does not trip over inherited names', () => {
    const idx = Q.queueMetaIndex([null, {}, { id: null, bpm: 1 }, { id: 'x_constructor', bpm: 111 }]);
    assert.equal(Q.queueItemMeta({ youtubeId: 'toString' }, idx), null);
    assert.equal(Q.queueItemMeta({ youtubeId: 'constructor' }, idx).bpm, 111);
    assert.equal(Q.queueItemMeta({ youtubeId: 'x', metaId: '__proto__' }, idx), null);
    assert.deepEqual(plain(Q.queueMetaIndex(undefined)), { byId: {}, byVideo: {} });
});
