// All Tracks key badge: must be the shared colour-coded Camelot chip, like the
// release page, queue, setlists and suggestions — not a plain accent badge.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function load() {
    const ctx = { Math, Date, JSON, console, document: { addEventListener() {} } };
    vm.createContext(ctx);
    for (const f of ['src/utils.js', 'src/actions.js', 'src/camelot.js', 'src/meta_editor.js', 'src/views/tracks.js']) {
        vm.runInContext(read(f), ctx, { filename: f });
    }
    return ctx;
}

const C = load();

test('a key is drawn in its Camelot colour with the relative key', () => {
    const html = C.trackKeyBadgeHtml('8A', {});
    assert.match(html, /camelot-chip/);
    assert.ok(html.includes('background:' + C.camelotColor('8A')), html);
    assert.match(html, /rel 8B/);
    assert.doesNotMatch(html, /camelot-chip-estimated/);
});

test('an analyzer key is marked as an estimate until verified', () => {
    assert.match(C.trackKeyBadgeHtml('5A', { key_source: 'analysis' }), /camelot-chip-estimated/);
    assert.doesNotMatch(
        C.trackKeyBadgeHtml('5A', { key_source: 'analysis', bpm_verified: true }),
        /camelot-chip-estimated/
    );
});

test('hand-typed keys are normalised before colouring', () => {
    for (const k of ['8a', '08A', 'Am', 'A minor']) {
        const html = C.trackKeyBadgeHtml(k, {});
        assert.ok(html.includes('background:' + C.camelotColor('8A')), k + ': ' + html);
    }
});

test('an analyzer BPM is marked as an estimate until verified', () => {
    const est = C.trackBpmBadgeHtml({ bpm: 189.78, bpm_source: 'analysis', bpm_confidence: 0.96 });
    assert.match(est, /badge-bpm/);
    assert.match(est, /badge-estimated/);
    assert.match(est, /189\.78/);
    assert.match(est, /confidence/);
    const ok = C.trackBpmBadgeHtml({ bpm: 120, bpm_source: 'analysis', bpm_verified: true });
    assert.doesNotMatch(ok, /badge-estimated/);
    assert.doesNotMatch(C.trackBpmBadgeHtml({ bpm: 120 }), /badge-estimated/);
    assert.equal(C.trackBpmBadgeHtml({}), '');
});

test('an unrecognised key falls back to a plain, escaped badge', () => {
    const html = C.trackKeyBadgeHtml('<b>weird</b>', {});
    assert.doesNotMatch(html, /camelot-chip/);
    assert.match(html, /&lt;b&gt;weird&lt;\/b&gt;/);
    assert.doesNotMatch(html, /<b>/);
});
