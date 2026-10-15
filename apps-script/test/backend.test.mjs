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
    assert.deepEqual(first, { ok: true, roster: { slot_1: 'viking', slot_2: 'wizard', lead: 'businesswoman' }, leaders: null });
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

test('leaders: names for the nameplates are stored, merged and handed out; the roster is left alone', () => {
    const b = loadBackend();
    assert.equal(b.get().leaders, null, 'nothing edited yet -> the displays use their built-in list');
    const first = b.post({ action: 'setRoster', pin: PIN, leaders: { slot_1: 'Измайлова И.', slot_6: '  Бордачева   В. ' } });
    assert.deepEqual(first, { ok: true, roster: null, leaders: { slot_1: 'Измайлова И.', slot_6: 'Бордачева В.' } });
    const second = b.post({ action: 'setRoster', pin: PIN, roster: { slot_2: 'ninja' }, leaders: { slot_1: '' } });
    assert.deepEqual(second.leaders, { slot_1: '', slot_6: 'Бордачева В.' }, 'an empty name clears the plate to the group code');
    assert.deepEqual(second.roster, { slot_2: 'ninja' });
    assert.deepEqual(b.get().leaders, second.leaders);
});

test('leaders: bad slots and names are refused without changing anything', () => {
    const b = loadBackend();
    for (const leaders of [null, [], 'Иванов', { lead: 'Иванов И.' }, { slot_7: 'Иванов И.' }, { slot_1: '=HYPERLINK("x")' }, { slot_1: 'И'.repeat(41) }, { slot_1: 'Иванов <b>' }]) {
        assert.equal(b.post({ action: 'setRoster', pin: PIN, leaders }).error, 'bad_request', JSON.stringify(leaders));
    }
    assert.equal(b.post({ action: 'setRoster', pin: 'bad', leaders: { slot_1: 'Иванов И.' } }).error, 'invalid_pin');
    assert.equal(b.get().leaders, null);
});

/* ------------------------------------------------------------- importSales */

/** A sheet like the real Ulyanovsk one: tidy Date | Amount | ROP, no Invoice column yet. */
function ulyanovskBackend() {
    const b = loadBackend();
    const rows = b.salesRows();
    rows.length = 0;
    rows.push(
        ['Date', 'Amount', 'ROP'],
        [b.day('2026-09-15'), 90000, 'ВШ1'], // last week: outside any period below
        [b.day('2026-09-21'), 400000, 'ВШ1'],
        [b.day('2026-09-22T11:30'), 250000, 'ВШ4'], // typed in by hand, with a time
        [b.day('2026-09-23'), 120000, 'ВШ5'],
    );
    return b;
}

const importRows = [
    { date: '2026-09-22', amount: 21990, rop: 'ВШ1', invoice: '568010911' },
    { date: '2026-09-22', amount: 30, rop: 'ВШ4', invoice: '568465060' },
    { date: '2026-09-23', amount: 112147.38, rop: 'ВШ10', invoice: '567674920' },
];

test('importSales dry run: what the sheet holds for the period now, nothing written', () => {
    const b = ulyanovskBackend();
    const before = JSON.stringify(b.salesRows());
    const res = b.post({ action: 'importSales', pin: PIN, from: '2026-09-22', to: '2026-09-23', rows: importRows, dryRun: true });
    assert.equal(res.ok, true);
    assert.equal(res.dryRun, true);
    assert.deepEqual(res.current, { rows: 2, amount: 370000, manualRows: 2, manualAmount: 370000, byRop: { 'ВШ4': 250000, 'ВШ5': 120000 } });
    assert.equal(JSON.stringify(b.salesRows()), before);
});

test('importSales replaces every payment of the period (typed in by hand too) and keeps the other days', () => {
    const b = ulyanovskBackend();
    const res = b.post({ action: 'importSales', pin: PIN, from: '2026-09-22', to: '2026-09-23', rows: importRows, requestId: 'imp-1' });
    assert.equal(res.ok, true);
    assert.deepEqual(res.removed, { rows: 2, amount: 370000 });
    assert.deepEqual(res.added, { rows: 3, amount: 21990 + 30 + 112147.38 });
    assert.equal(b.salesSheet().setValuesCalls, 1, 'one write for the whole table');

    const rows = b.salesRows();
    assert.deepEqual(rows[0], ['Date', 'Amount', 'ROP', 'Invoice'], 'the first import adds the Invoice column');
    const sales = rows.slice(1).filter(r => r[0] !== '');
    assert.deepEqual(sales.map(r => [r[1], r[2], r[3]]), [
        [90000, 'ВШ1', ''],
        [400000, 'ВШ1', ''],
        [21990, 'ВШ1', '568010911'],
        [30, 'ВШ4', '568465060'],
        [112147.38, 'ВШ10', '567674920'],
    ]);
    assert.ok(sales.every(r => typeof r[0].getTime === 'function'), 'dates are real dates');

    // Monday 2026-09-21 .. the week of the fake "now" (Wed 2026-09-23): the hand-typed 250 000 and 120 000 are gone.
    assert.equal(res.status.totalThisWeek, 400000 + 21990 + 30 + 112147.38);
    const byRop = Object.fromEntries(b.get().byRop.map(r => [r.ropName, r.amount]));
    assert.deepEqual(byRop, { 'ВШ1': 421990, 'ВШ4': 30, 'ВШ10': 112147.38 });

    const listed = b.post({ action: 'listSales', pin: PIN, limit: 1 }).sales[0];
    assert.equal(listed.invoice, '567674920');
});

test('importSales again with the same or a fresher overlapping file never counts a payment twice', () => {
    const b = ulyanovskBackend();
    b.post({ action: 'importSales', pin: PIN, from: '2026-09-22', to: '2026-09-23', rows: importRows });
    b.post({ action: 'importSales', pin: PIN, from: '2026-09-22', to: '2026-09-23', rows: importRows });
    assert.equal(b.get().totalThisWeek, 400000 + 21990 + 30 + 112147.38);

    // A later export covers 21..23 and lost one payment (cancelled in the CRM): the sheet follows it.
    const fresher = [{ date: '2026-09-21', amount: 5000, rop: 'ВШ6', invoice: '1' }, importRows[0]];
    const res = b.post({ action: 'importSales', pin: PIN, from: '2026-09-21', to: '2026-09-23', rows: fresher });
    assert.deepEqual(res.removed, { rows: 4, amount: 400000 + 21990 + 30 + 112147.38 });
    assert.equal(res.status.totalThisWeek, 5000 + 21990);
});

test('importSales with fewer rows than before blanks the leftover rows and leaves other columns alone', () => {
    const b = loadBackend(); // the harness sheet: names in D, the drop-down list in F reaching further down
    const res = b.post({ action: 'importSales', pin: PIN, from: '2026-09-21', to: '2026-09-23', rows: [importRows[0]] });
    assert.equal(res.ok, true);
    assert.deepEqual(res.removed.rows, 3);
    const rows = b.salesRows();
    assert.equal(rows[0][6], 'Invoice', 'added after the last used column (F), not over the names in D');
    assert.deepEqual([rows[1][1], rows[1][2], rows[1][6]], [21990, 'ВШ1', '568010911']);
    for (const r of rows.slice(2, 4)) assert.deepEqual([r[0], r[1], r[2], r[6]], ['', '', '', ''], 'old sale rows are blanked');
    assert.deepEqual(rows.map(r => r[5]), ['', 'ВШ1', 'ВШ2', 'ВШ3', 'ВШ5', 'ВШ6', 'ВШ9'], 'column F untouched');
    assert.equal(b.post({ action: 'listSales', pin: PIN }).totalRows, 1);
});

test('importSales with an empty period list just clears the period', () => {
    const b = ulyanovskBackend();
    const res = b.post({ action: 'importSales', pin: PIN, from: '2026-09-21', to: '2026-09-23', rows: [] });
    assert.deepEqual(res.removed, { rows: 3, amount: 770000 });
    assert.equal(res.status.totalThisWeek, 0);
    assert.equal(b.post({ action: 'listSales', pin: PIN }).totalRows, 1, 'last week is kept');
});

test('importSales grows the sheet when the rows do not fit', () => {
    const b = ulyanovskBackend();
    b.salesSheet().maxRows = 5;
    const many = Array.from({ length: 20 }, (_, i) => ({ date: '2026-09-22', amount: 1000 + i, rop: 'ВШ9', invoice: String(i) }));
    assert.equal(b.post({ action: 'importSales', pin: PIN, from: '2026-09-22', to: '2026-09-22', rows: many }).added.rows, 20);
    assert.equal(b.post({ action: 'listSales', pin: PIN }).totalRows, 3 + 20);
});

test('importSales refuses bad periods and rows (formulas too) and writes nothing', () => {
    const b = ulyanovskBackend();
    const before = JSON.stringify(b.salesRows());
    const ok = { date: '2026-09-22', amount: 100, rop: 'ВШ1', invoice: '1' };
    const cases = [
        [{ from: '2026-09-23', to: '2026-09-22', rows: [] }, 'period'],
        [{ from: '22.09.2026', to: '2026-09-23', rows: [] }, 'period'],
        [{ from: '2026-02-30', to: '2026-09-23', rows: [] }, 'period'],
        [{ from: '2026-09-21', to: '2030-01-01', rows: [] }, 'period'],
        [{ from: '2026-09-21', to: '2026-09-23', rows: 'x' }, 'rows'],
        [{ from: '2026-09-21', to: '2026-09-23', rows: Array(5001).fill(ok) }, 'rows'],
        [{ from: '2026-09-21', to: '2026-09-23', rows: [ok, { ...ok, date: '2026-09-20' }] }, 'rows'],
        [{ from: '2026-09-21', to: '2026-09-23', rows: [{ ...ok, rop: 'ВШ2' }] }, 'rows'],
        [{ from: '2026-09-21', to: '2026-09-23', rows: [{ ...ok, rop: '=1+1' }] }, 'rows'],
        [{ from: '2026-09-21', to: '2026-09-23', rows: [{ ...ok, amount: 0 }] }, 'rows'],
        [{ from: '2026-09-21', to: '2026-09-23', rows: [{ ...ok, invoice: '=IMPORTXML("http://x")' }] }, 'rows'],
        [{ from: '2026-09-21', to: '2026-09-23', rows: [null] }, 'rows'],
    ];
    for (const [payload, field] of cases) {
        const res = b.post({ action: 'importSales', pin: PIN, ...payload });
        assert.equal(res.error, 'bad_request', JSON.stringify(payload).slice(0, 120));
        assert.equal(res.field, field);
    }
    assert.equal(b.post({ action: 'importSales', pin: PIN, from: '2026-09-21', to: '2026-09-23', rows: [ok, { ...ok, rop: 'ВШ3' }] }).row, 1, 'the bad entry is named');
    assert.equal(b.post({ action: 'importSales', pin: 'bad', from: '2026-09-21', to: '2026-09-23', rows: [ok] }).error, 'invalid_pin');
    assert.equal(JSON.stringify(b.salesRows()), before);
});

test('a retried importSales (same requestId) runs once', () => {
    const b = ulyanovskBackend();
    const first = b.post({ action: 'importSales', pin: PIN, from: '2026-09-22', to: '2026-09-23', rows: importRows, requestId: 'r-imp' });
    const writes = b.salesSheet().setValuesCalls;
    assert.deepEqual(b.post({ action: 'importSales', pin: PIN, from: '2026-09-22', to: '2026-09-23', rows: importRows, requestId: 'r-imp' }), first);
    assert.equal(b.salesSheet().setValuesCalls, writes);
});

/* ------------------------------------------------- group leaders' PINs (rg.html) */

const GROUP_PINS = { slot_1: '111111', slot_2: '222222', slot_3: '333333', slot_4: '444444', slot_5: '555555', slot_6: '101010' };

function withGroupPins() {
    const b = loadBackend();
    assert.equal(b.post({ action: 'setGroupPins', pin: PIN, pins: GROUP_PINS }).ok, true);
    return b;
}

test('group PINs: set by the admin, stored only as hashes, status shows which groups have one', () => {
    const b = loadBackend();
    assert.deepEqual(b.post({ action: 'groupPinStatus', pin: PIN }).set, { slot_1: false, slot_2: false, slot_3: false, slot_4: false, slot_5: false, slot_6: false });
    const res = b.post({ action: 'setGroupPins', pin: PIN, pins: { slot_1: '111111', slot_6: '101010' } });
    assert.deepEqual(res, { ok: true, set: { slot_1: true, slot_2: false, slot_3: false, slot_4: false, slot_5: false, slot_6: true } });
    const stored = b.props.get('GROUP_PINS');
    assert.ok(!stored.includes('111111') && !stored.includes('101010'), 'no PIN in clear text');
    assert.ok(!JSON.stringify(b.get()).includes('GROUP') && !JSON.stringify(b.get()).includes(stored.slice(0, 20)), 'nothing of it on the public GET');
    assert.equal(b.post({ action: 'setGroupPins', pin: 'bad', pins: { slot_2: '222222' } }).error, 'invalid_pin');
});

test('group PINs: bad slots and PINs, duplicates and the admin PIN are refused', () => {
    const b = withGroupPins();
    for (const pins of [null, [], {}, { lead: '999999' }, { slot_7: '999999' }, { slot_1: '12345' }, { slot_1: 'abcdef' }, { slot_1: '1234567890123' }]) {
        assert.equal(b.post({ action: 'setGroupPins', pin: PIN, pins }).error, 'bad_request', JSON.stringify(pins));
    }
    const dup = (pins) => b.post({ action: 'setGroupPins', pin: PIN, pins }).field;
    assert.equal(dup({ slot_1: '999999', slot_2: '999999' }), 'pins_duplicate', 'two groups, one PIN');
    assert.equal(dup({ slot_1: '222222' }), 'pins_duplicate', 'the PIN of a group that keeps it');
    assert.equal(b.post({ action: 'setGroupPins', pin: PIN, pins: { slot_1: '222222', slot_2: '777777' } }).ok, true, 'a swap is fine');
    b.post({ action: 'changePin', pin: PIN, newPin: '864200' });
    assert.equal(b.post({ action: 'setGroupPins', pin: '864200', pins: { slot_3: '864200' } }).field, 'pins_duplicate', 'the admin PIN');
    assert.equal(b.post({ action: 'changePin', pin: '864200', newPin: '777777' }).field, 'newPin_group', 'and the admin PIN cannot become a group PIN');
});

test('groupLogin: the PIN says which group; it carries this week and the leader once edited', () => {
    const b = withGroupPins();
    const res = b.post({ action: 'groupLogin', groupPin: '111111' });
    assert.equal(res.ok, true);
    assert.deepEqual(res.group, { slot: 'slot_1', code: 'ВШ1', leader: null });
    assert.deepEqual(res.week, { start: '2026-09-21', today: '2026-09-23', total: 400000 + 120000 });
    assert.deepEqual(b.post({ action: 'groupLogin', groupPin: '101010' }).group.code, 'ВШ10');
    b.post({ action: 'setRoster', pin: PIN, leaders: { slot_6: 'Бордачева В.' } });
    assert.equal(b.post({ action: 'groupLogin', groupPin: '101010' }).group.leader, 'Бордачева В.');
});

test('group PINs open only the group page, and the admin PIN does not open it', () => {
    const b = withGroupPins();
    assert.equal(b.post({ action: 'groupLogin', groupPin: PIN }).error, 'invalid_pin', 'the admin PIN is not a group PIN');
    assert.equal(b.post({ action: 'groupLogin', pin: '111111' }).error, 'invalid_pin', 'a group PIN must come as groupPin');
    const sheet = JSON.stringify(b.salesRows()) + JSON.stringify(b.settingsRows());
    for (const action of ['login', 'listSales', 'setPlan', 'importSales', 'setRoster', 'setGroupPins', 'addSale']) {
        // Wrong admin PINs: refused, and from the fifth one on the admin API is locked.
        assert.ok(['invalid_pin', 'locked'].includes(b.post({ action, pin: '111111', plan: 1, rop: 'ВШ1', amount: 1 }).error), action);
    }
    assert.equal(JSON.stringify(b.salesRows()) + JSON.stringify(b.settingsRows()), sheet);
});

test('groupAddSale writes a payment of the PIN\'s own group, whatever group the request names', () => {
    const b = withGroupPins();
    const res = b.post({ action: 'groupAddSale', groupPin: '444444', amount: 75000, rop: 'ВШ1', requestId: 'g1' });
    assert.equal(res.ok, true);
    assert.equal(res.added.rop, 'ВШ6');
    assert.equal(res.added.amount, 75000);
    assert.equal(res.week.total, 75000);
    assert.equal(res.group.code, 'ВШ6');
    const byRop = Object.fromEntries(b.get().byRop.map(r => [r.ropName, r.amount]));
    assert.equal(byRop['ВШ6'], 75000);
    assert.deepEqual(b.post({ action: 'groupAddSale', groupPin: '444444', amount: 75000, requestId: 'g1' }), res, 'a retry adds nothing');
    assert.equal(b.post({ action: 'listSales', pin: PIN }).sales.filter(s => s.rop === 'ВШ6').length, 1);
});

test('groupAddSale: this week up to now only; bad amounts refused', () => {
    const b = withGroupPins(); // fake now: Wed 2026-09-23 10:00, week from Mon 2026-09-21
    const add = (extra) => b.post({ action: 'groupAddSale', groupPin: '222222', amount: 1000, ...extra });
    assert.equal(add({ date: '2026-09-21' }).added.date, '2026-09-21', 'Monday of this week');
    assert.equal(add({ date: '2026-09-23T09:30' }).added.date, '2026-09-23 09:30', 'earlier today');
    assert.equal(add({}).ok, true, 'now');
    for (const date of ['2026-09-20', '2026-09-23T11:00', '2026-09-24', '2026-13-01', 'вчера']) {
        assert.equal(add({ date }).field, 'date', date);
    }
    for (const amount of [0, -5, 'abc', '', 1e12]) assert.equal(add({ amount }).field, 'amount', String(amount));
});

test('group PIN guessing locks only the group page, a new PIN replaces the old one', () => {
    const b = withGroupPins();
    for (let i = 0; i < 4; i++) assert.equal(b.post({ action: 'groupLogin', groupPin: '00000' + i }).error, 'invalid_pin');
    assert.equal(b.post({ action: 'groupLogin', groupPin: '000009' }).error, 'locked');
    assert.equal(b.post({ action: 'groupLogin', groupPin: '111111' }).error, 'locked', 'even a right group PIN waits');
    assert.equal(b.post({ action: 'login', pin: PIN }).ok, true, 'the admin page is not locked');
    // New PINs from the admin page lift the lock (like a changed admin PIN does), and the old PIN stops working.
    b.post({ action: 'setGroupPins', pin: PIN, pins: { slot_1: '121212' } });
    assert.equal(b.post({ action: 'groupLogin', groupPin: '121212' }).group.code, 'ВШ1');
    assert.equal(b.post({ action: 'groupLogin', groupPin: '111111' }).error, 'invalid_pin');
    b.advance(601 * 1000);
    assert.equal(b.post({ action: 'groupLogin', groupPin: '222222' }).ok, true, 'the other groups keep theirs');
});

test('the group lock wears off after the lock time', () => {
    const b = withGroupPins();
    for (let i = 0; i < 5; i++) b.post({ action: 'groupLogin', groupPin: 'x' + i });
    assert.equal(b.post({ action: 'groupLogin', groupPin: '333333' }).error, 'locked');
    b.advance(601 * 1000);
    assert.equal(b.post({ action: 'groupLogin', groupPin: '333333' }).ok, true);
});

test('a fall command can name any of the six department slots', () => {
    const b = loadBackend();
    for (const hero of ['slot_1', 'slot_6', 'random']) assert.equal(b.post({ action: 'command', pin: PIN, type: 'fall', args: { hero } }).ok, true, hero);
    assert.equal(b.post({ action: 'command', pin: PIN, type: 'fall', args: { hero: 'lead' } }).error, 'bad_request');
});
