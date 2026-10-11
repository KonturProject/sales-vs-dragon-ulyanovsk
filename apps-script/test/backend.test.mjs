/**
 * Tests of the real Code.gs against fake Google services (see gas-harness.mjs).
 * Run:  node --test apps-script/test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBackend } from './gas-harness.mjs';

const PIN = '1234';

/** Rows of "Sales" that actually hold a sale (Date/Amount/ROP in their default columns A-C), ignoring the other columns. */
const saleRows = (b) => b.salesRows().slice(1).filter(r => [r[0], r[1], r[2]].some(v => String(v).trim() !== ''));

test('public GET: unchanged week status plus an empty command list and the server clock', () => {
    const b = loadBackend();
    const status = b.get();
    assert.equal(status.ok, true);
    assert.equal(status.plan, 5000000);
    assert.equal(status.totalThisWeek, 400000 + 250000 + 120000);
    assert.deepEqual(status.byRop.map(r => r.ropName).sort(), ['ВШ1', 'ВШ2']);
    assert.deepEqual(status.commands, []);
    assert.equal(status.serverNow, b.now());
});

test('the public GET never contains raw rows, the PIN or its hash', () => {
    const b = loadBackend();
    b.post({ action: 'changePin', pin: PIN, newPin: '987654' });
    const text = JSON.stringify(b.get());
    assert.ok(!text.includes('987654') && !text.includes('ADMIN_PIN') && !text.includes('$'));
    assert.ok(!('sales' in JSON.parse(text)));
});

test('legacy request { pin, plan } still sets the plan (older admin page)', () => {
    const b = loadBackend();
    assert.deepEqual(b.post({ pin: PIN, plan: 7000000 }), { ok: true, plan: 7000000 });
    assert.equal(b.get().plan, 7000000);
    assert.equal(b.settingsRows()[1][1], 7000000);
});

test('wrong PIN is refused and changes nothing', () => {
    const b = loadBackend();
    assert.deepEqual(b.post({ pin: '0000', plan: 1 }), { ok: false, error: 'invalid_pin' });
    assert.equal(b.settingsRows()[1][1], 5000000);
});

test('login checks the PIN; missing or absurd PINs fail', () => {
    const b = loadBackend();
    assert.deepEqual(b.post({ action: 'login', pin: PIN }), { ok: true });
    assert.equal(b.post({ action: 'login' }).error, 'invalid_pin');
    assert.equal(b.post({ action: 'login', pin: 'x'.repeat(500) }).error, 'invalid_pin');
});

test('five wrong PINs lock the API; even the right PIN waits; it unlocks after the lock time', () => {
    const b = loadBackend();
    for (let i = 0; i < 4; i++) assert.equal(b.post({ action: 'login', pin: 'bad' + i }).error, 'invalid_pin');
    const fifth = b.post({ action: 'login', pin: 'bad5' });
    assert.equal(fifth.error, 'locked');
    assert.ok(fifth.retryAfterSec > 0 && fifth.retryAfterSec <= 600);

    const rightButLocked = b.post({ action: 'login', pin: PIN });
    assert.equal(rightButLocked.error, 'locked');

    b.advance(601 * 1000);
    assert.deepEqual(b.post({ action: 'login', pin: PIN }), { ok: true });
});

test('a right PIN clears the failure count', () => {
    const b = loadBackend();
    for (let i = 0; i < 4; i++) b.post({ action: 'login', pin: 'bad' });
    assert.equal(b.post({ action: 'login', pin: PIN }).ok, true);
    for (let i = 0; i < 4; i++) assert.equal(b.post({ action: 'login', pin: 'bad' }).error, 'invalid_pin');
});

test('unknown action and malformed body are bad requests', () => {
    const b = loadBackend();
    assert.equal(b.post({ action: 'dropTable', pin: PIN }).error, 'bad_request');
    assert.equal(b.post({ action: 'toString', pin: PIN }).error, 'bad_request', 'inherited object members are not actions');
    assert.equal(b.post({ action: 'constructor', pin: PIN }).error, 'bad_request');
    assert.equal(b.postRaw('not json').error, 'bad_request');
    assert.equal(b.postRaw('null').error, 'bad_request');
    assert.equal(b.postRaw('42').error, 'bad_request');
});

test('a fault on the server side is reported as server_error, not blamed on the request', () => {
    const b = loadBackend();
    b.renameSheet('Sales', 'Sales-broken');
    const res = b.post({ action: 'listSales', pin: PIN });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'server_error');
    assert.match(res.detail, /Sales/);
    assert.equal(b.post({ action: 'login', pin: PIN }).ok, true, 'and the PIN check itself still works');
});

test('listSales: newest first, limited, with week status and the plan', () => {
    const b = loadBackend();
    const res = b.post({ action: 'listSales', pin: PIN, limit: 2 });
    assert.equal(res.ok, true);
    assert.equal(res.totalRows, 3, 'the three empty rows that only hold the drop-down list in column F are not sales');
    assert.equal(res.shown, 2);
    assert.deepEqual(res.sales.map(s => [s.rop, s.amount, s.row]), [['ВШ1', 120000, 4], ['ВШ2', 250000, 3]]);
    assert.match(res.sales[0].date, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.equal(res.settings.WeeklyPlan, 5000000);
    assert.equal(res.status.totalThisWeek, 770000);
    assert.equal(b.post({ action: 'listSales', pin: 'no' }).error, 'invalid_pin');
});

test('addSale fills the first free sales row and leaves the other columns alone (no gap, no appended row)', () => {
    const b = loadBackend();
    const rowsBefore = b.salesRows().length;
    const res = b.post({ action: 'addSale', pin: PIN, rop: 'ВШ5', amount: 150000 });
    assert.equal(res.ok, true);
    assert.equal(res.added.rop, 'ВШ5');
    assert.equal(res.added.row, 5, 'right after the last real sale, not below the drop-down list in column F');
    assert.equal(res.status.totalThisWeek, 770000 + 150000);

    const rows = b.salesRows();
    assert.equal(rows.length, rowsBefore, 'no row was appended at the bottom');
    const added = rows[4]; // sheet row 5
    assert.equal(added[1], 150000);
    assert.equal(added[2], 'ВШ5');
    assert.equal(typeof added[0].getTime, 'function');
    assert.equal(added[3], '', 'names column untouched');
    assert.equal(added[5], 'ВШ5', 'the drop-down list value in column F is still there');
    assert.deepEqual(rows[5].slice(3), ['', '', 'ВШ6'], 'the next row is untouched');
});

test('two additions in a row go into consecutive rows', () => {
    const b = loadBackend();
    assert.equal(b.post({ action: 'addSale', pin: PIN, rop: 'ВШ1', amount: 1000 }).added.row, 5);
    assert.equal(b.post({ action: 'addSale', pin: PIN, rop: 'ВШ2', amount: 2000 }).added.row, 6);
    assert.equal(b.post({ action: 'listSales', pin: PIN }).sales.map(s => s.row).join(), '6,5,4,3,2');
});

test('addSale follows the header order, not fixed positions', () => {
    const b = loadBackend();
    // swap the Date and ROP columns everywhere: header becomes ROP | Amount | Date
    b.salesRows().forEach(r => { [r[0], r[2]] = [r[2], r[0]]; });
    assert.equal(b.post({ action: 'addSale', pin: PIN, rop: 'ВШ9', amount: 5000 }).ok, true);
    const added = b.salesRows()[4];
    assert.equal(added[0], 'ВШ9');
    assert.equal(added[1], 5000);
    assert.equal(typeof added[2].getTime, 'function');
    assert.equal(added[5], 'ВШ5', 'column F untouched');
});

test('addSale accepts a past date (date only, or with time) and rejects impossible ones', () => {
    const b = loadBackend();
    assert.equal(b.post({ action: 'addSale', pin: PIN, rop: 'ВШ2', amount: 1000, date: '2026-09-21' }).added.date, '2026-09-21', 'a date without a time is stored as midnight and shown without one');
    assert.equal(b.post({ action: 'addSale', pin: PIN, rop: 'ВШ2', amount: 1000, date: '2026-09-22T09:30' }).added.date, '2026-09-22 09:30');
    const listed = b.post({ action: 'listSales', pin: PIN, limit: 2 }).sales.map(s => s.date);
    assert.deepEqual(listed, ['2026-09-22 09:30', '2026-09-21']);
    for (const date of ['22.09.2026', '2026-13-40', '2019-01-01', '2030-01-01', 'yesterday']) {
        assert.equal(b.post({ action: 'addSale', pin: PIN, rop: 'ВШ2', amount: 1000, date }).error, 'bad_request', date);
    }
});

test('addSale rejects bad departments and amounts, including spreadsheet-formula injection', () => {
    const b = loadBackend();
    const rows = JSON.stringify(b.salesRows());
    const bad = [
        { rop: '=IMPORTXML("http://x")', amount: 1 },
        { rop: '+cmd', amount: 1 },
        { rop: '@SUM(A1)', amount: 1 },
        { rop: '', amount: 1 },
        { rop: 'x'.repeat(40), amount: 1 },
        { rop: 'ВШ1', amount: -5 },
        { rop: 'ВШ1', amount: 0 },
        { rop: 'ВШ1', amount: 'abc' },
        { rop: 'ВШ1', amount: '' },
        { rop: 'ВШ1', amount: 1e12 },
    ];
    for (const payload of bad) assert.equal(b.post({ action: 'addSale', pin: PIN, ...payload }).error, 'bad_request', JSON.stringify(payload));
    assert.equal(JSON.stringify(b.salesRows()), rows, 'the sheet is unchanged');
});

test('a retried addSale (same requestId) adds one row only', () => {
    const b = loadBackend();
    const rows = saleRows(b).length;
    const first = b.post({ action: 'addSale', pin: PIN, rop: 'ВШ3', amount: 70000, requestId: 'abc-1' });
    const again = b.post({ action: 'addSale', pin: PIN, rop: 'ВШ3', amount: 70000, requestId: 'abc-1' });
    assert.deepEqual(again, first);
    assert.equal(saleRows(b).length, rows + 1);
    b.post({ action: 'addSale', pin: PIN, rop: 'ВШ3', amount: 70000, requestId: 'abc-2' });
    assert.equal(saleRows(b).length, rows + 2);
});

test('changePin: needs the old PIN, a 4-12 digit new one; then only the new one works and the old plain PIN is gone', () => {
    const b = loadBackend();
    assert.equal(b.post({ action: 'changePin', pin: 'nope', newPin: '5555' }).error, 'invalid_pin');
    for (const newPin of ['12', '1234567890123', 'abcd', '12 34', '', undefined]) {
        assert.equal(b.post({ action: 'changePin', pin: PIN, newPin }).error, 'bad_request', String(newPin));
    }
    assert.equal(b.post({ action: 'changePin', pin: PIN, newPin: PIN }).error, 'bad_request');
    assert.equal(b.props.get('ADMIN_PIN'), PIN, 'nothing changed by the rejected attempts');

    assert.deepEqual(b.post({ action: 'changePin', pin: PIN, newPin: '482913' }), { ok: true });
    assert.equal(b.post({ action: 'login', pin: PIN }).error, 'invalid_pin');
    assert.equal(b.post({ action: 'login', pin: '482913' }).ok, true);
    assert.equal(b.props.has('ADMIN_PIN'), false, 'legacy plain PIN removed');
    const stored = b.props.get('ADMIN_PIN_HASH');
    assert.match(stored, /^[0-9a-f-]{36}\$[0-9a-f]{64}$/);
    assert.ok(![...b.props.values()].some(v => v.includes('482913')), 'the new PIN is not stored in clear text');
});

test('setAdminPin_ (editor recovery path) stores a hash too', () => {
    const b = loadBackend({ legacyPin: null });
    assert.equal(b.post({ action: 'login', pin: '0000' }).error, 'invalid_pin', 'no PIN set yet');
    b.run('setAdminPin_');
    assert.equal(b.post({ action: 'login', pin: '0000' }).ok, true);
});

test('commands: validated, queued with rising ids, visible on the public GET, never touch the sheets', () => {
    const b = loadBackend();
    const salesBefore = JSON.stringify(b.salesRows());
    const settingsBefore = JSON.stringify(b.settingsRows());

    assert.deepEqual(b.post({ action: 'command', pin: PIN, type: 'growl' }), { ok: true, id: 1 });
    assert.deepEqual(b.post({ action: 'command', pin: PIN, type: 'hit', args: { rop: 'ВШ5', amount: 90000 } }), { ok: true, id: 2 });
    assert.equal(b.post({ action: 'command', pin: PIN, type: 'fall', args: { hero: 'slot_5', mode: 'doze' } }).id, 3);
    b.post({ action: 'command', pin: PIN, type: 'fall' });
    b.post({ action: 'command', pin: PIN, type: 'wake' });
    b.post({ action: 'command', pin: PIN, type: 'confetti' });
    b.post({ action: 'command', pin: PIN, type: 'celebrate' });

    const commands = b.get().commands;
    assert.deepEqual(commands.map(c => c.type), ['growl', 'hit', 'fall', 'fall', 'wake', 'confetti', 'celebrate']);
    assert.deepEqual(commands.map(c => c.id), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(commands[1].args, { rop: 'ВШ5', amount: 90000 });
    assert.deepEqual(commands[3].args, { hero: 'random', mode: 'random' });

    assert.equal(JSON.stringify(b.salesRows()), salesBefore);
    assert.equal(JSON.stringify(b.settingsRows()), settingsBefore);
});

test('commands: a hit gets a default amount; bad types/args and a wrong PIN are refused', () => {
    const b = loadBackend();
    b.post({ action: 'command', pin: PIN, type: 'hit', args: { rop: 'ВШ1' } });
    assert.equal(b.get().commands[0].args.amount, 50000);
    for (const [type, args] of [['explode', {}], ['hit', {}], ['hit', { rop: 'ВШ1', amount: -1 }], ['hit', { rop: '=1+1' }], ['fall', { hero: 'hero_x' }], ['fall', { mode: 'die' }]]) {
        assert.equal(b.post({ action: 'command', pin: PIN, type, args }).error, 'bad_request', type + JSON.stringify(args));
    }
    assert.equal(b.post({ action: 'command', pin: 'bad', type: 'growl' }).error, 'invalid_pin');
    assert.equal(b.get().commands.length, 1);
});

test('commands: only the last 10 are kept, and old ones drop off the public list', () => {
    const b = loadBackend();
    for (let i = 0; i < 13; i++) b.post({ action: 'command', pin: PIN, type: 'growl' });
    let ids = b.get().commands.map(c => c.id);
    assert.deepEqual(ids, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);

    b.advance(11 * 60 * 1000);
    assert.deepEqual(b.get().commands, []);
    assert.equal(b.post({ action: 'command', pin: PIN, type: 'wake' }).id, 14, 'ids keep rising');
    ids = b.get().commands.map(c => c.id);
    assert.deepEqual(ids, [14]);
});

test('a retried command (same requestId) is queued once', () => {
    const b = loadBackend();
    b.post({ action: 'command', pin: PIN, type: 'growl', requestId: 'r1' });
    b.post({ action: 'command', pin: PIN, type: 'growl', requestId: 'r1' });
    assert.equal(b.get().commands.length, 1);
});

test('roster: nothing chosen yet -> the public status carries null', () => {
    assert.equal(loadBackend().get().roster, null);
});

test('roster: setRoster stores the choice, merges later changes, and the public GET hands it out', () => {
    const b = loadBackend();
    const first = b.post({ action: 'setRoster', pin: PIN, roster: { slot_1: 'viking', slot_2: 'wizard', lead: 'businesswoman' } });
    assert.deepEqual(first, { ok: true, roster: { slot_1: 'viking', slot_2: 'wizard', lead: 'businesswoman' } });
    const second = b.post({ action: 'setRoster', pin: PIN, roster: { slot_2: 'ninja' } });
    assert.deepEqual(second.roster, { slot_1: 'viking', slot_2: 'ninja', lead: 'businesswoman' });
    assert.deepEqual(b.get().roster, second.roster);
});

test('roster: it needs the PIN and rejects malformed choices without changing anything', () => {
    const b = loadBackend();
    assert.equal(b.post({ action: 'setRoster', pin: 'bad', roster: { slot_1: 'viking' } }).error, 'invalid_pin');
    for (const roster of [undefined, null, [], 'viking', {}, { slot_9: 'viking' }, { slot_1: 'Viking!' }, { slot_1: '' }, { slot_1: 'x' }, { slot_1: 'a'.repeat(40) }, { slot_1: '=1+1' }]) {
        assert.equal(b.post({ action: 'setRoster', pin: PIN, roster }).error, 'bad_request', JSON.stringify(roster));
    }
    assert.equal(b.get().roster, null);
});

test('roster: it never touches the spreadsheet', () => {
    const b = loadBackend();
    const before = JSON.stringify(b.salesRows()) + JSON.stringify(b.settingsRows());
    b.post({ action: 'setRoster', pin: PIN, roster: { slot_3: 'pirate' } });
    assert.equal(JSON.stringify(b.salesRows()) + JSON.stringify(b.settingsRows()), before);
});

test('a fall command can name any of the six department slots', () => {
    const b = loadBackend();
    for (const hero of ['slot_1', 'slot_6', 'random']) assert.equal(b.post({ action: 'command', pin: PIN, type: 'fall', args: { hero } }).ok, true, hero);
    assert.equal(b.post({ action: 'command', pin: PIN, type: 'fall', args: { hero: 'lead' } }).error, 'bad_request');
});
