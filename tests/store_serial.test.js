// Store serial numbers (src/store_serial.js): country names to codes, the
// serial prefix for a release's country string, the next free number, the
// duplicate check and the bulk serialization. A priority test target in
// docs/PROJECT_PLAN.md §5a.
//
// store_serial.js is a plain <script>; it is loaded into a VM context with an
// in-memory stand-in for the two IndexedDB calls it makes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'store_serial.js'), 'utf8');

function load(storeItems = []) {
    const db = { store_items: new Map(storeItems.map(i => [i.id, structuredClone(i)])), puts: [] };
    const ctx = {
        Date, JSON, Math, Object, Promise, console,
        dbGetAll: async name => {
            assert.equal(name, 'store_items');
            return [...db.store_items.values()].map(r => structuredClone(r));
        },
        dbPut: async (name, item) => {
            assert.equal(name, 'store_items');
            db.puts.push(item.id);
            db.store_items.set(item.id, structuredClone(item));
        },
    };
    vm.createContext(ctx);
    vm.runInContext(SRC, ctx, { filename: 'src/store_serial.js' });
    return { S: ctx, db };
}

const { S } = load();

// ---- countryToCode ----

test('countryToCode maps Discogs country names to two-letter codes', () => {
    assert.equal(S.countryToCode('Germany'), 'DE');
    assert.equal(S.countryToCode('Netherlands'), 'NL');
    assert.equal(S.countryToCode('Japan'), 'JP');
    assert.equal(S.countryToCode('Europe'), 'EU');
    assert.equal(S.countryToCode('Worldwide'), 'WW');
});

test('countryToCode folds the aliases Discogs uses onto one code', () => {
    for (const n of ['US', 'USA', 'United States']) assert.equal(S.countryToCode(n), 'US', n);
    // The project uses UK, not the ISO GB.
    for (const n of ['UK', 'United Kingdom', 'Great Britain']) assert.equal(S.countryToCode(n), 'UK', n);
    assert.equal(S.countryToCode('West Germany'), 'DE');
    assert.equal(S.countryToCode('East Germany'), 'DD');
    assert.equal(S.countryToCode('USSR'), 'SU');
    assert.equal(S.countryToCode('Soviet Union'), 'SU');
    assert.equal(S.countryToCode('Bosnia'), S.countryToCode('Bosnia and Herzegovina'));
    assert.equal(S.countryToCode('Korea'), S.countryToCode('South Korea'));
});

test('countryToCode ignores case and surrounding spaces', () => {
    assert.equal(S.countryToCode('  germany '), 'DE');
    assert.equal(S.countryToCode('UNITED KINGDOM'), 'UK');
    assert.equal(S.countryToCode('new zealand'), 'NZ');
});

test('countryToCode takes an unknown two-letter code as it is, upper-cased', () => {
    assert.equal(S.countryToCode('fr'), 'FR');
    assert.equal(S.countryToCode('QZ'), 'QZ');
    assert.equal(S.countryToCode(' be '), 'BE');
});

test('countryToCode gives XX for anything else', () => {
    for (const n of [undefined, null, '', '   ', 'Unknown', 'Atlantis', 'U.S.', 'ABC', 'D', '12']) {
        assert.equal(S.countryToCode(n), 'XX', String(n));
    }
});

test('every name in COUNTRY_CODES maps to a two-letter upper-case code', () => {
    for (const [name, code] of Object.entries(S.COUNTRY_CODES)) {
        assert.match(code, /^[A-Z]{2}$/, name);
        assert.equal(S.countryToCode(name), code, name);
    }
});

// ---- getSerialPrefix ----

test('getSerialPrefix: one country gives its code', () => {
    assert.equal(S.getSerialPrefix('Germany'), 'DE');
    assert.equal(S.getSerialPrefix(' Japan '), 'JP');
});

test('getSerialPrefix splits on "/" and ",", sorts the codes and joins two with "-"', () => {
    assert.equal(S.getSerialPrefix('UK/Europe'), 'EU-UK');
    assert.equal(S.getSerialPrefix('Europe / UK'), 'EU-UK', 'same prefix in either order');
    assert.equal(S.getSerialPrefix('USA, Canada'), 'CA-US');
    assert.equal(S.getSerialPrefix('Canada,USA'), 'CA-US');
    assert.equal(S.getSerialPrefix('Germany/Austria, Switzerland'), 'AT-CH', 'at most two, after sorting');
});

test('getSerialPrefix drops repeats and empty parts', () => {
    assert.equal(S.getSerialPrefix('USA/US'), 'US', 'two names for one country');
    assert.equal(S.getSerialPrefix('West Germany / Germany'), 'DE');
    assert.equal(S.getSerialPrefix('France,'), 'FR');
    assert.equal(S.getSerialPrefix('/Italy//'), 'IT');
});

test('getSerialPrefix gives XX with no country', () => {
    for (const c of [undefined, null, '', '   ', '/', ' , / ', 'Unknown']) {
        assert.equal(S.getSerialPrefix(c), 'XX', JSON.stringify(c));
    }
});

test('getSerialPrefix: "&" joins countries like "/" and ","', () => {
    // Decided 2026-11-06: Discogs writes joint releases as "UK & Europe".
    assert.equal(S.getSerialPrefix('UK & Europe'), 'EU-UK');
    assert.equal(S.getSerialPrefix('UK&Europe'), 'EU-UK');
    assert.equal(S.getSerialPrefix('&'), 'XX');
    // An unknown part still takes a slot in a joint prefix (unchanged).
    assert.equal(S.getSerialPrefix('Unknown / Germany'), 'DE-XX');
});

// ---- getNextSerial ----

test('getNextSerial starts at 001 and pads to three digits', () => {
    assert.equal(S.getNextSerial('DE', []), 'DE-001');
    assert.equal(S.getNextSerial('DE', [{ serial: 'DE-009' }]), 'DE-010');
    assert.equal(S.getNextSerial('EU-UK', [{ serial: 'EU-UK-041' }]), 'EU-UK-042');
});

test('getNextSerial follows the highest number and does not fill gaps', () => {
    const items = [{ serial: 'DE-001' }, { serial: 'DE-007' }, { serial: 'DE-003' }];
    assert.equal(S.getNextSerial('DE', items), 'DE-008');
});

test('getNextSerial counts only its own prefix', () => {
    const items = [
        { serial: 'US-050' },
        { serial: 'DE-NL-090' },   // a joint prefix starting with the same code
        { serial: 'DEX-070' },     // a longer prefix starting with the same letters
        { serial: 'DE-002' },
    ];
    assert.equal(S.getNextSerial('DE', items), 'DE-003');
    assert.equal(S.getNextSerial('DE-NL', items), 'DE-NL-091');
    assert.equal(S.getNextSerial('NL', items), 'NL-001');
});

test('getNextSerial matches serials in any case and keeps the prefix as given', () => {
    assert.equal(S.getNextSerial('DE', [{ serial: 'de-004' }]), 'DE-005');
    assert.equal(S.getNextSerial('de', [{ serial: 'DE-004' }]), 'de-005');
});

test('getNextSerial skips items with no serial or no number, and reads a manual suffix by its number', () => {
    const items = [{}, { serial: null }, { serial: '' }, { serial: 'DE-' }, { serial: 'DE-abc' }, { serial: 'DE-5b' }];
    assert.equal(S.getNextSerial('DE', items), 'DE-006');
});

test('getNextSerial goes past 999 without truncating', () => {
    assert.equal(S.getNextSerial('XX', [{ serial: 'XX-999' }]), 'XX-1000');
    assert.equal(S.getNextSerial('XX', [{ serial: 'XX-1000' }]), 'XX-1001');
});

// ---- isSerialTaken ----

test('isSerialTaken ignores case and surrounding spaces on both sides', () => {
    const items = [{ id: 1, serial: 'DE-001' }, { id: 2, serial: ' eu-uk-002 ' }];
    assert.equal(S.isSerialTaken('DE-001', items), true);
    assert.equal(S.isSerialTaken('de-001', items), true);
    assert.equal(S.isSerialTaken('  De-001  ', items), true);
    assert.equal(S.isSerialTaken('EU-UK-002', items), true);
    assert.equal(S.isSerialTaken('DE-002', items), false);
    assert.equal(S.isSerialTaken('DE-01', items), false, 'no loose number matching');
});

test('isSerialTaken leaves out the item being edited', () => {
    const items = [{ id: 10, serial: 'DE-001' }, { id: 11, serial: 'DE-002' }];
    assert.equal(S.isSerialTaken('DE-001', items, 10), false, 'keeping its own serial');
    assert.equal(S.isSerialTaken('DE-002', items, 10), true, 'taking another item\'s');
    // Ids are compared strictly; the store view passes the numeric release id.
    assert.equal(S.isSerialTaken('DE-001', items, '10'), true);
});

test('isSerialTaken is false for an empty list and skips items without a serial', () => {
    assert.equal(S.isSerialTaken('DE-001', []), false);
    assert.equal(S.isSerialTaken('DE-001', [{ id: 1 }, { id: 2, serial: null }]), false);
});

// ---- runSerialization ----

test('runSerialization numbers new releases in the order given, per prefix', async () => {
    const { S: app, db } = load();
    await app.runSerialization([
        { id: 1, country: 'Germany' },
        { id: 2, country: 'UK/Europe' },
        { id: 3, country: 'Germany' },
        { id: 4, country: '' },
        { id: 5, country: 'Europe, UK' },
    ]);
    const serial = id => db.store_items.get(id).serial;
    assert.deepEqual([1, 2, 3, 4, 5].map(serial), ['DE-001', 'EU-UK-001', 'DE-002', 'XX-001', 'EU-UK-002']);
    assert.deepEqual(db.puts, [1, 2, 3, 4, 5]);
});

test('runSerialization writes a complete new store item', async () => {
    const { S: app, db } = load();
    const before = Date.now();
    await app.runSerialization([{ id: 7, country: 'Japan' }]);
    const item = db.store_items.get(7);
    const { added_at, ...rest } = item;
    assert.deepEqual(rest, {
        id: 7, serial: 'JP-001', manual_serial: false, store_status: 'active',
        sold_date: null, sold_price: null, batch_id: null,
        median_price: null, median_price_currency: null, median_price_updated_at: null,
    });
    assert.ok(Date.parse(added_at) >= before - 1000, 'added_at is an ISO timestamp');
});

test('runSerialization continues after existing serials and leaves serialized releases alone', async () => {
    const existing = [
        { id: 1, serial: 'DE-004', manual_serial: false },
        { id: 2, serial: 'DE-010', manual_serial: true },
    ];
    const { S: app, db } = load(existing);
    await app.runSerialization([
        { id: 1, country: 'Germany' },   // already has a serial
        { id: 3, country: 'Germany' },
        { id: 3, country: 'Germany' },   // listed twice: serialized once
    ]);
    assert.equal(db.store_items.get(1).serial, 'DE-004');
    assert.equal(db.store_items.get(2).serial, 'DE-010');
    assert.equal(db.store_items.get(3).serial, 'DE-011');
    assert.deepEqual(db.puts, [3]);
});

test('runSerialization with nothing to do writes nothing', async () => {
    const { S: app, db } = load([{ id: 1, serial: 'US-001' }]);
    await app.runSerialization([]);
    await app.runSerialization([{ id: 1, country: 'USA' }]);
    assert.deepEqual(db.puts, []);
});
