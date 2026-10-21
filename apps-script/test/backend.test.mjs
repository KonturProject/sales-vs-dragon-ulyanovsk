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
    assert.equal(status.totalThisWeek, 3, 'payments, not money: three rows of this week, one payment each');
    assert.deepEqual(Object.fromEntries(status.byRop.map(r => [r.ropName, r.amount])), { 'ВШ1': 2, 'ВШ2': 1 });
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
    assert.deepEqual(res.sales.map(s => [s.rop, s.count, s.row]), [['ВШ1', 1, 4], ['ВШ2', 1, 3]]);
    assert.match(res.sales[0].date, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.equal(res.settings.WeeklyPlan, 5000000);
    assert.equal(res.status.totalThisWeek, 3);
    assert.equal(b.post({ action: 'listSales', pin: 'no' }).error, 'invalid_pin');
});

test('dayCount / setDayCount: a group\'s payments on a day; that day\'s rows of the group become one row with the count', () => {
    const b = ulyanovskBackend();
    assert.equal(b.post({ action: 'dayCount', pin: PIN, rop: 'ВШ4', date: '2026-09-22' }).count, 1, 'an old row without a count is one payment');
    const res = b.post({ action: 'setDayCount', pin: PIN, rop: 'ВШ4', date: '2026-09-22', count: 3 });
    assert.equal(res.ok, true);
    assert.deepEqual(res.saved, { rop: 'ВШ4', date: '2026-09-22', count: 3, previous: 1 });
    assert.equal(res.status.totalThisWeek, 1 + 3 + 1);
    assert.equal(b.salesSheet().setValuesCalls, 1, 'one write for the whole table');

    const rows = b.salesRows();
    assert.deepEqual(rows[0], ['Date', 'Amount', 'ROP', 'Invoice', 'Count'], 'the first save adds the Invoice and Count columns');
    const group = rows.slice(1).filter(r => r[2] === 'ВШ4');
    assert.equal(group.length, 1);
    assert.deepEqual([group[0][1], group[0][3], group[0][4]], ['', '', 3]);
    assert.equal(b.post({ action: 'dayCount', pin: PIN, rop: 'ВШ4', date: '2026-09-22' }).count, 3);
    assert.deepEqual(Object.fromEntries(b.get().byRop.map(r => [r.ropName, r.amount])), { 'ВШ1': 1, 'ВШ4': 3, 'ВШ5': 1 }, 'the other groups and days are untouched');
    assert.equal(b.post({ action: 'listSales', pin: PIN }).sales.find(s => s.rop === 'ВШ4').count, 3);
});

test('setDayCount: 0 clears the day, a day without rows gets one, the other columns stay', () => {
    const b = loadBackend(); // the harness sheet: names in D, a drop-down list in F reaching further down
    assert.equal(b.post({ action: 'setDayCount', pin: PIN, rop: 'ВШ1', date: '2026-09-21', count: 0 }).saved.previous, 1);
    assert.equal(b.get().totalThisWeek, 2);
    assert.equal(b.post({ action: 'setDayCount', pin: PIN, rop: 'ВШ6', date: '2026-09-23', count: 2 }).status.totalThisWeek, 4);
    const rows = b.salesRows();
    assert.deepEqual([rows[0][6], rows[0][7]], ['Invoice', 'Count'], 'added after the last used column (F)');
    assert.deepEqual(rows.map(r => r[5]), ['', 'ВШ1', 'ВШ2', 'ВШ3', 'ВШ5', 'ВШ6', 'ВШ9'], 'column F untouched');
    assert.equal(b.post({ action: 'listSales', pin: PIN }).totalRows, 3);
});

test('setDayCount refuses other groups, future or impossible days and bad numbers, and writes nothing', () => {
    const b = ulyanovskBackend(); // fake now: Wed 2026-09-23
    const before = JSON.stringify(b.salesRows());
    const ok = { rop: 'ВШ1', date: '2026-09-22', count: 2 };
    const cases = [
        [{ ...ok, rop: 'ВШ2' }, 'rop'], [{ ...ok, rop: '=1+1' }, 'rop'],
        [{ ...ok, date: '2026-09-24' }, 'date'], [{ ...ok, date: '22.09.2026' }, 'date'], [{ ...ok, date: '2026-02-30' }, 'date'],
        [{ ...ok, count: -1 }, 'count'], [{ ...ok, count: 1.5 }, 'count'], [{ ...ok, count: 1000 }, 'count'],
        [{ ...ok, count: 'abc' }, 'count'], [{ ...ok, count: '' }, 'count'],
    ];
    for (const [payload, field] of cases) assert.equal(b.post({ action: 'setDayCount', pin: PIN, ...payload }).field, field, JSON.stringify(payload));
    assert.equal(b.post({ action: 'setDayCount', pin: 'bad', ...ok }).error, 'invalid_pin');
    assert.equal(b.post({ action: 'dayCount', pin: PIN, rop: 'ВШ2', date: '2026-09-22' }).field, 'rop');
    assert.equal(JSON.stringify(b.salesRows()), before);
    assert.equal(b.post({ action: 'setDayCount', pin: PIN, ...ok, date: '2026-09-23' }).ok, true, 'today is fine');
});

test('a retried setDayCount (same requestId) writes once', () => {
    const b = ulyanovskBackend();
    const first = b.post({ action: 'setDayCount', pin: PIN, rop: 'ВШ9', date: '2026-09-23', count: 2, requestId: 'c-1' });
    const writes = b.salesSheet().setValuesCalls;
    assert.deepEqual(b.post({ action: 'setDayCount', pin: PIN, rop: 'ВШ9', date: '2026-09-23', count: 2, requestId: 'c-1' }), first);
    assert.equal(b.salesSheet().setValuesCalls, writes);
});

test('an import replaces the counts saved for its period; a count saved later replaces that day\'s invoices', () => {
    const b = ulyanovskBackend();
    b.post({ action: 'setDayCount', pin: PIN, rop: 'ВШ1', date: '2026-09-22', count: 4 });
    b.post({ action: 'importSales', pin: PIN, from: '2026-09-22', to: '2026-09-23', rows: importRows });
    assert.equal(b.post({ action: 'dayCount', pin: PIN, rop: 'ВШ1', date: '2026-09-22' }).count, 1, 'the file says one invoice');
    b.post({ action: 'setDayCount', pin: PIN, rop: 'ВШ1', date: '2026-09-22', count: 2 });
    assert.equal(b.post({ action: 'dayCount', pin: PIN, rop: 'ВШ1', date: '2026-09-22' }).count, 2);
    const sales = b.post({ action: 'listSales', pin: PIN }).sales;
    assert.equal(sales.filter(s => s.invoice === '568010911').length, 0, 'the invoice row of that day made way for the count');
    assert.equal(sales.filter(s => s.invoice === '567674920').length, 1, 'other groups keep their invoices');
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
    assert.deepEqual(b.post({ action: 'command', pin: PIN, type: 'hit', args: { rop: 'ВШ5', count: 3 } }), { ok: true, id: 2 });
    assert.equal(b.post({ action: 'command', pin: PIN, type: 'fall', args: { hero: 'slot_5', mode: 'doze' } }).id, 3);
    b.post({ action: 'command', pin: PIN, type: 'fall' });
    b.post({ action: 'command', pin: PIN, type: 'wake' });
    b.post({ action: 'command', pin: PIN, type: 'confetti' });
    b.post({ action: 'command', pin: PIN, type: 'celebrate' });

    const commands = b.get().commands;
    assert.deepEqual(commands.map(c => c.type), ['growl', 'hit', 'fall', 'fall', 'wake', 'confetti', 'celebrate']);
    assert.deepEqual(commands.map(c => c.id), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(commands[1].args, { rop: 'ВШ5', count: 3 });
    assert.deepEqual(commands[3].args, { hero: 'random', mode: 'random' });

    assert.equal(JSON.stringify(b.salesRows()), salesBefore);
    assert.equal(JSON.stringify(b.settingsRows()), settingsBefore);
});

test('commands: a hit shows one payment by default; bad types/args and a wrong PIN are refused', () => {
    const b = loadBackend();
    b.post({ action: 'command', pin: PIN, type: 'hit', args: { rop: 'ВШ1' } });
    assert.equal(b.get().commands[0].args.count, 1);
    for (const [type, args] of [['explode', {}], ['hit', {}], ['hit', { rop: 'ВШ1', count: 0 }], ['hit', { rop: 'ВШ1', count: -1 }], ['hit', { rop: 'ВШ1', count: 1.5 }], ['hit', { rop: '=1+1' }], ['fall', { hero: 'hero_x' }], ['fall', { mode: 'die' }]]) {
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
    assert.deepEqual(res.current, { rows: 2, payments: 2, manualPayments: 2, byRop: { 'ВШ4': 1, 'ВШ5': 1 } });
    assert.equal(JSON.stringify(b.salesRows()), before);
});

test('importSales replaces every payment of the period (typed in by hand too) and keeps the other days', () => {
    const b = ulyanovskBackend();
    const res = b.post({ action: 'importSales', pin: PIN, from: '2026-09-22', to: '2026-09-23', rows: importRows, requestId: 'imp-1' });
    assert.equal(res.ok, true);
    assert.deepEqual(res.removed, { rows: 2, payments: 2 });
    assert.deepEqual(res.added, { payments: 3 });
    assert.equal(b.salesSheet().setValuesCalls, 1, 'one write for the whole table');

    const rows = b.salesRows();
    assert.deepEqual(rows[0], ['Date', 'Amount', 'ROP', 'Invoice', 'Count'], 'the first import adds the Invoice and Count columns');
    const sales = rows.slice(1).filter(r => r[0] !== '');
    assert.deepEqual(sales.map(r => [r[1], r[2], r[3], r[4]]), [
        [90000, 'ВШ1', '', ''],
        [400000, 'ВШ1', '', ''],
        [21990, 'ВШ1', '568010911', 1],
        [30, 'ВШ4', '568465060', 1],
        [112147.38, 'ВШ10', '567674920', 1],
    ], 'one invoice = one payment; the amount stays for reference');
    assert.ok(sales.every(r => typeof r[0].getTime === 'function'), 'dates are real dates');

    // Monday 2026-09-21 .. the week of the fake "now" (Wed 2026-09-23): the rows of the 22nd and 23rd are replaced.
    assert.equal(res.status.totalThisWeek, 1 + 3);
    const byRop = Object.fromEntries(b.get().byRop.map(r => [r.ropName, r.amount]));
    assert.deepEqual(byRop, { 'ВШ1': 2, 'ВШ4': 1, 'ВШ10': 1 });

    const listed = b.post({ action: 'listSales', pin: PIN, limit: 1 }).sales[0];
    assert.deepEqual([listed.invoice, listed.count], ['567674920', 1]);
});

test('importSales again with the same or a fresher overlapping file never counts a payment twice', () => {
    const b = ulyanovskBackend();
    b.post({ action: 'importSales', pin: PIN, from: '2026-09-22', to: '2026-09-23', rows: importRows });
    b.post({ action: 'importSales', pin: PIN, from: '2026-09-22', to: '2026-09-23', rows: importRows });
    assert.equal(b.get().totalThisWeek, 4);

    // A later export covers 21..23 and lost one payment (cancelled in the CRM): the sheet follows it.
    const fresher = [{ date: '2026-09-21', amount: 5000, rop: 'ВШ6', invoice: '1' }, importRows[0]];
    const res = b.post({ action: 'importSales', pin: PIN, from: '2026-09-21', to: '2026-09-23', rows: fresher });
    assert.deepEqual(res.removed, { rows: 4, payments: 4 });
    assert.equal(res.status.totalThisWeek, 2);
});

test('importSales with fewer rows than before blanks the leftover rows and leaves other columns alone', () => {
    const b = loadBackend(); // the harness sheet: names in D, the drop-down list in F reaching further down
    const res = b.post({ action: 'importSales', pin: PIN, from: '2026-09-21', to: '2026-09-23', rows: [importRows[0]] });
    assert.equal(res.ok, true);
    assert.deepEqual(res.removed.rows, 3);
    const rows = b.salesRows();
    assert.deepEqual([rows[0][6], rows[0][7]], ['Invoice', 'Count'], 'added after the last used column (F), not over the names in D');
    assert.deepEqual([rows[1][1], rows[1][2], rows[1][6], rows[1][7]], [21990, 'ВШ1', '568010911', 1]);
    for (const r of rows.slice(2, 4)) assert.deepEqual([r[0], r[1], r[2], r[6], r[7]], ['', '', '', '', ''], 'old sale rows are blanked');
    assert.deepEqual(rows.map(r => r[5]), ['', 'ВШ1', 'ВШ2', 'ВШ3', 'ВШ5', 'ВШ6', 'ВШ9'], 'column F untouched');
    assert.equal(b.post({ action: 'listSales', pin: PIN }).totalRows, 1);
});

test('importSales with an empty period list just clears the period', () => {
    const b = ulyanovskBackend();
    const res = b.post({ action: 'importSales', pin: PIN, from: '2026-09-21', to: '2026-09-23', rows: [] });
    assert.deepEqual(res.removed, { rows: 3, payments: 3 });
    assert.equal(res.status.totalThisWeek, 0);
    assert.equal(b.post({ action: 'listSales', pin: PIN }).totalRows, 1, 'last week is kept');
});

test('importSales grows the sheet when the rows do not fit', () => {
    const b = ulyanovskBackend();
    b.salesSheet().maxRows = 5;
    const many = Array.from({ length: 20 }, (_, i) => ({ date: '2026-09-22', amount: 1000 + i, rop: 'ВШ9', invoice: String(i) }));
    assert.equal(b.post({ action: 'importSales', pin: PIN, from: '2026-09-22', to: '2026-09-22', rows: many }).added.payments, 20);
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
    assert.deepEqual(res.week, { start: '2026-09-21', today: '2026-09-23', total: 2, days: { '2026-09-21': 1, '2026-09-23': 1 } });
    assert.deepEqual(b.post({ action: 'groupLogin', groupPin: '101010' }).group.code, 'ВШ10');
    b.post({ action: 'setRoster', pin: PIN, leaders: { slot_6: 'Бордачева В.' } });
    assert.equal(b.post({ action: 'groupLogin', groupPin: '101010' }).group.leader, 'Бордачева В.');
});

test('group PINs open only the group page, and the admin PIN does not open it', () => {
    const b = withGroupPins();
    assert.equal(b.post({ action: 'groupLogin', groupPin: PIN }).error, 'invalid_pin', 'the admin PIN is not a group PIN');
    assert.equal(b.post({ action: 'groupLogin', pin: '111111' }).error, 'invalid_pin', 'a group PIN must come as groupPin');
    const sheet = JSON.stringify(b.salesRows()) + JSON.stringify(b.settingsRows());
    for (const action of ['login', 'listSales', 'setPlan', 'importSales', 'setRoster', 'setGroupPins', 'setDayCount']) {
        // Wrong admin PINs: refused, and from the fifth one on the admin API is locked.
        assert.ok(['invalid_pin', 'locked'].includes(b.post({ action, pin: '111111', plan: 1, rop: 'ВШ1', amount: 1 }).error), action);
    }
    assert.equal(JSON.stringify(b.salesRows()) + JSON.stringify(b.settingsRows()), sheet);
});

test('groupSetCount sets the payments of the PIN\'s own group, whatever group the request names', () => {
    const b = withGroupPins();
    const res = b.post({ action: 'groupSetCount', groupPin: '444444', rop: 'ВШ1', date: '2026-09-23', count: 3, requestId: 'g1' });
    assert.equal(res.ok, true);
    assert.deepEqual(res.saved, { rop: 'ВШ6', date: '2026-09-23', count: 3, previous: 0 });
    assert.equal(res.group.code, 'ВШ6');
    assert.deepEqual(res.week.days, { '2026-09-23': 3 });
    assert.equal(res.week.total, 3);
    assert.equal(Object.fromEntries(b.get().byRop.map(r => [r.ropName, r.amount]))['ВШ6'], 3);
    const writes = b.salesSheet().setValuesCalls;
    assert.deepEqual(b.post({ action: 'groupSetCount', groupPin: '444444', date: '2026-09-23', count: 3, requestId: 'g1' }), res, 'a retry writes nothing');
    assert.equal(b.salesSheet().setValuesCalls, writes);
    assert.equal(b.post({ action: 'groupSetCount', groupPin: '444444', date: '2026-09-23', count: 1 }).week.total, 1, 'a mistake is fixed with a lower number');
});

test('groupSetCount: days of this week up to today only; bad numbers refused', () => {
    const b = withGroupPins(); // fake now: Wed 2026-09-23, week from Mon 2026-09-21
    const set = (extra) => b.post({ action: 'groupSetCount', groupPin: '222222', date: '2026-09-23', count: 1, ...extra });
    assert.equal(set({ date: '2026-09-21' }).ok, true, 'Monday of this week');
    assert.equal(set({}).ok, true, 'today');
    for (const date of ['2026-09-20', '2026-09-24', '2026-13-01', 'вчера', '', undefined]) assert.equal(set({ date }).field, 'date', String(date));
    for (const count of [-1, 1.5, 1000, 'abc', '', undefined]) assert.equal(set({ count }).field, 'count', String(count));
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
