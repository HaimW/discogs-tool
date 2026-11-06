// Relative key (M-2, task 3c). camelot.js is a plain <script> file, so it is
// loaded into a VM context alongside the helpers it calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function load() {
    const ctx = { Math, Date, JSON, console, document: { addEventListener() {} } };
    vm.createContext(ctx);
    for (const f of ['src/utils.js', 'src/actions.js', 'src/camelot.js']) {
        vm.runInContext(read(f), ctx, { filename: f });
    }
    return ctx;
}

const C = load();

test('relative key swaps A and B and keeps the number', () => {
    assert.equal(C.camelotRelative('8A'), '8B');
    assert.equal(C.camelotRelative('8B'), '8A');
    assert.equal(C.camelotRelative('1A'), '1B');
    assert.equal(C.camelotRelative('12B'), '12A');
});

test('every key on the wheel has a relative that maps back to it', () => {
    for (const e of C.CAMELOT_WHEEL) {
        const rel = C.camelotRelative(e.code);
        assert.ok(C.camelotEntry(rel), e.code + ' -> ' + rel);
        assert.notEqual(rel, e.code);
        assert.equal(C.camelotRelative(rel), e.code);
        assert.equal(rel.replace(/[AB]$/, ''), e.code.replace(/[AB]$/, ''));
    }
    assert.equal(C.camelotMusical(C.camelotRelative('8A')), 'C major');
    assert.equal(C.camelotMusical(C.camelotRelative('11B')), 'F# minor');
});

test('tolerates how codes get typed or stored', () => {
    assert.equal(C.camelotRelative(' 8a '), '8B');
    assert.equal(C.camelotRelative('08A'), '8B');
    assert.equal(C.camelotRelative('10b'), '10A');
});

test('accepts musical names, including short and flat spellings', () => {
    assert.equal(C.camelotCode('A minor'), '8A');
    assert.equal(C.camelotCode('Am'), '8A');
    assert.equal(C.camelotCode('Amin'), '8A');
    assert.equal(C.camelotCode('C'), '8B');
    assert.equal(C.camelotCode('C major'), '8B');
    assert.equal(C.camelotCode('Cmaj'), '8B');
    assert.equal(C.camelotCode('Bbm'), '3A');      // = A# minor
    assert.equal(C.camelotCode('Eb major'), '5B'); // = D# major
    assert.equal(C.camelotCode('F#m'), '11A');
    assert.equal(C.camelotRelative('A minor'), '8B');
    assert.equal(C.camelotRelative('Am'), '8B');
    assert.equal(C.camelotRelative('C'), '8A');
});

test('anything that is not a key gives null, not a guess', () => {
    for (const bad of [null, undefined, '', '   ', '0A', '13A', '8C', '8', 'AM', 'H minor',
        'Cb', 'E#m', 'A dorian', '8A8B', '<b>8A</b>', 42, {}]) {
        assert.equal(C.camelotRelative(bad), null, JSON.stringify(bad));
    }
    // 'A' alone is A major, not "A" the Camelot letter.
    assert.equal(C.camelotCode('A'), '11B');
});

test('relative marker HTML: short visible text, full accessible name', () => {
    const html = C.camelotRelativeHtml('8A');
    assert.match(html, /class="camelot-rel"/);
    assert.match(html, /title="Relative key 8B \(C major\)"/);
    assert.match(html, /<span aria-hidden="true">rel 8B<\/span>/);
    assert.match(html, /<span class="sr-only">, Relative key 8B \(C major\)<\/span>/);
    assert.equal(C.camelotRelativeHtml(''), '');
    assert.equal(C.camelotRelativeHtml('<script>'), '');
});

test('the key chip carries the relative key unless asked not to', () => {
    const chip = C.camelotChip('8A', { musical: true });
    assert.match(chip, /A minor/);
    assert.match(chip, /rel 8B/);
    assert.ok(chip.indexOf('rel 8B') > chip.indexOf('A minor'), 'relative comes after the name');
    assert.doesNotMatch(C.camelotChip('8A', { relative: false }), /camelot-rel/);
    assert.equal(C.camelotChip('nope'), '');
});

test('the wheel hub names the relative key of the selection', () => {
    const svg = C.camelotWheelSvg('5A', 'metaEditorPickKey', 'x');
    assert.match(svg, /class="camelot-hub-rel">rel 5B</);
    assert.doesNotMatch(C.camelotWheelSvg(null, 'metaEditorPickKey', 'x'), /camelot-hub-rel/);
});
