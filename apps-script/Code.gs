/**
 * Backend for the "Победи дракона" sales game (Ulyanovsk branch of sales-vs-dragon).
 * Standalone script (not container-bound) — opens the spreadsheet explicitly by
 * ID via getSpreadsheet_(), so it works from script.google.com directly without
 * going through Extensions > Apps Script inside the sheet itself.
 *
 * First start: run setupSpreadsheet() once from the editor — it creates the spreadsheet
 * «победи дракона» (tabs below, ROP drop-down) in the owner's Drive and remembers its id in
 * Script Properties (SPREADSHEET_ID), so no id sits in this file. Then set the ADMIN_PIN property
 * (Project Settings > Script properties) and deploy as a Web App (execute as me, anyone can access).
 *
 * The game counts PAYMENTS (pieces), not money: the weekly plan, the totals and the strikes are numbers of payments.
 *
 * Sheet schema (tab names are literal, columns are header-matched, order-independent):
 *   "Sales"    — Date | Amount | ROP | Invoice | Count
 *                one row per imported invoice (Invoice set, Count 1, Amount kept for reference only), or one row per
 *                group and day saved by a group leader / the admin (Count = that day's number of payments). A row
 *                without a Count (an old one) stands for one payment.
 *   "Settings" — Key | Value                   (rows: WeeklyPlan — in payments, TotalMeters)
 *
 * HTTP API (one Web App URL):
 *   GET            public, aggregates only: week status + recent admin "commands" + the stage setup for the displays.
 *   POST (JSON, sent as text/plain to avoid a CORS preflight) — every action needs the admin PIN:
 *     { action: 'login',       pin }                                  check the PIN
 *     { action: 'setPlan',     pin, plan }                            weekly plan (also the legacy { pin, plan } form)
 *     { action: 'listSales',   pin, limit? }                          latest rows of "Sales" + week status + settings
 *     { action: 'dayCount',    pin, rop, date }                       how many payments a group has on a day
 *     { action: 'setDayCount', pin, rop, date, count, requestId? }    set that number (the day's rows of the group are replaced)
 *     { action: 'importSales', pin, from, to, rows, dryRun?, requestId? }  replace the payments of a period (export file)
 *     { action: 'changePin',   pin, newPin }                          change the PIN (stored as a salted hash)
 *     { action: 'command',     pin, type, args?, requestId? }         show an animation on the displays
 *     { action: 'setRoster',   pin, roster?, leaders? }               which character stands in which slot (see ROSTER_SLOTS),
 *                                                                     the group leaders' names on the stage nameplates
 *     { action: 'setGroupPins', pin, pins }                          the group leaders' PINs { slot_1: '123456', … }
 *     { action: 'groupPinStatus', pin }                              which groups have a PIN
 *   The group leaders' page (rg.html) signs in with its group PIN instead — the group is known from the PIN:
 *     { action: 'groupLogin',    groupPin }                          which group, this week's payments per day
 *     { action: 'groupSetCount', groupPin, date, count, requestId? }  that group's payments on a day of this week (up to today)
 *   Commands are pure visual triggers: they live in Script Properties, never in the spreadsheet,
 *   and never touch "Sales"/"Settings".
 *
 * The PIN lives ONLY in PropertiesService, never in this source file and never
 * echoed back in any response — see setAdminPin_() below, run once manually.
 */

/** Fallback only; the real id is read from the SPREADSHEET_ID script property written by setupSpreadsheet(). */
var SPREADSHEET_ID = '';
var SPREADSHEET_ID_PROPERTY_KEY = 'SPREADSHEET_ID';
var SPREADSHEET_TITLE = 'победи дракона';
var SALES_SHEET_NAME = 'Sales';
var SETTINGS_SHEET_NAME = 'Settings';
/** The six groups of the branch (short codes, as they appear in the ROP drop-down of "Sales"). */
var DEPARTMENT_CODES = ['ВШ1', 'ВШ4', 'ВШ5', 'ВШ6', 'ВШ9', 'ВШ10'];

/** Legacy plain-text PIN. Still honoured until the PIN is changed (then deleted); kept so an older deployment can be rolled back to. */
var PIN_PROPERTY_KEY = 'ADMIN_PIN';
/** 'salt$sha256hex' of the PIN, written by storePin_(). Takes precedence over the legacy property. */
var PIN_HASH_PROPERTY_KEY = 'ADMIN_PIN_HASH';
var COMMANDS_PROPERTY_KEY = 'COMMANDS';
var COMMAND_SEQ_PROPERTY_KEY = 'COMMAND_SEQ';
/** JSON { slot: characterId } — who stands where on the displays, chosen in the admin page. */
var ROSTER_PROPERTY_KEY = 'ROSTER';
/** Places on the stage: six departments (left to right) and the branch lead. */
var ROSTER_SLOTS = ['slot_1', 'slot_2', 'slot_3', 'slot_4', 'slot_5', 'slot_6', 'lead'];
/** JSON { slot: 'Фамилия И.' } — the group leader shown on each department's nameplate, edited in the admin page. */
var LEADERS_PROPERTY_KEY = 'LEADERS';
var LEADER_SLOTS = ['slot_1', 'slot_2', 'slot_3', 'slot_4', 'slot_5', 'slot_6'];
/** JSON { slot: 'salt$sha256' } — the group leaders' PINs for rg.html (the group is known from the PIN). Same order as DEPARTMENT_CODES. */
var GROUP_PINS_PROPERTY_KEY = 'GROUP_PINS';

/** Header of the "Sales" column that holds the invoice number of an imported payment (added by the first import). */
var INVOICE_HEADER = 'Invoice';
/** One export file is a few hundred rows a month; this only stops an absurd request. */
var MAX_IMPORT_ROWS = 5000;
/** Header of the "Sales" column that says how many payments a row stands for (added on first use). */
var COUNT_HEADER = 'Count';
/** Payments of one group on one day — a sanity bound for the counter. */
var MAX_DAY_COUNT = 999;

/** After this many wrong PINs within PIN_FAILURE_WINDOW_SEC the admin API refuses everything for PIN_LOCK_SEC. */
var MAX_PIN_FAILURES = 5;
var PIN_FAILURE_WINDOW_SEC = 600;
var PIN_LOCK_SEC = 600;

var COMMAND_KEEP = 10;
var COMMAND_MAX_AGE_MS = 10 * 60 * 1000;
var REQUEST_CACHE_SEC = 600;
var MAX_AMOUNT = 100000000;

var COMMAND_HEROES = ['random', 'slot_1', 'slot_2', 'slot_3', 'slot_4', 'slot_5', 'slot_6'];

/** Opening the spreadsheet is the slow part of a request (~0.5 s); do it once per execution, not once per helper. */
var spreadsheet_ = null;
function getSpreadsheet_() {
  if (!spreadsheet_) {
    var id = PropertiesService.getScriptProperties().getProperty(SPREADSHEET_ID_PROPERTY_KEY) || SPREADSHEET_ID;
    if (!id) throw new Error('No spreadsheet yet: run setupSpreadsheet() once from the editor');
    spreadsheet_ = SpreadsheetApp.openById(id);
  }
  return spreadsheet_;
}

/**
 * Run ONCE from the Apps Script editor (function dropdown > setupSpreadsheet > Run; Google asks for access the
 * first time). Creates the spreadsheet «победи дракона» in the owner's Drive with the two tabs this backend needs:
 *   Sales    Date | Amount | ROP | Invoice | Count   (ROP has a drop-down of the six groups)
 *   Settings Key | Value           (WeeklyPlan, TotalMeters)
 * and stores its id in Script Properties. Safe to run again: it does nothing if a spreadsheet is already set up.
 */
function setupSpreadsheet() {
  var props = PropertiesService.getScriptProperties();
  var existing = props.getProperty(SPREADSHEET_ID_PROPERTY_KEY);
  if (existing) {
    Logger.log('Already set up: ' + SpreadsheetApp.openById(existing).getUrl());
    return;
  }
  var ss = SpreadsheetApp.create(SPREADSHEET_TITLE);

  var sales = ss.getActiveSheet();
  sales.setName(SALES_SHEET_NAME);
  sales.getRange(1, 1, 1, 5).setValues([['Date', 'Amount', 'ROP', INVOICE_HEADER, COUNT_HEADER]]).setFontWeight('bold');
  sales.setFrozenRows(1);
  sales.getRange('A2:A').setNumberFormat('yyyy-mm-dd');
  sales.getRange('B2:B').setNumberFormat('#,##0');
  var rule = SpreadsheetApp.newDataValidation().requireValueInList(DEPARTMENT_CODES, true).setAllowInvalid(false).build();
  sales.getRange('C2:C2000').setDataValidation(rule);
  sales.setColumnWidth(1, 120);
  sales.setColumnWidth(2, 120);
  sales.setColumnWidth(3, 90);

  var settings = ss.insertSheet(SETTINGS_SHEET_NAME);
  settings.getRange(1, 1, 3, 2).setValues([['Key', 'Value'], ['WeeklyPlan', 0], ['TotalMeters', 300]]);
  settings.getRange(1, 1, 1, 2).setFontWeight('bold');

  props.setProperty(SPREADSHEET_ID_PROPERTY_KEY, ss.getId());
  Logger.log('Created: ' + ss.getUrl());
}

/**
 * Run this from the Apps Script editor (select it in the function dropdown, click Run)
 * to set the admin PIN without the web page — e.g. if it was forgotten. Put the new PIN in
 * the literal, run once, then put the placeholder back so it doesn't sit in source control.
 * (The admin page itself can also change the PIN: "PIN-код" tab.)
 */
function setAdminPin_() {
  var pin = '0000'; // CHANGE THIS, run once, then remove the literal.
  storePin_(pin);
}

function doGet(e) {
  try {
    var status = computeWeeklyStatus_();
    status.commands = readRecentCommands_();
    status.roster = readRoster_();
    status.leaders = readLeaders_();
    status.serverNow = Date.now();
    return jsonResponse_(status);
  } catch (err) {
    return jsonResponse_({ ok: false, error: 'server_error', detail: String(err) });
  }
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse_({ ok: false, error: 'bad_request', detail: 'body is not JSON' });
  }
  if (!body || typeof body !== 'object') return jsonResponse_({ ok: false, error: 'bad_request', detail: 'body is not an object' });

  try {
    // The first version of the admin page sent { pin, plan } with no action.
    var action = body.action || (body.plan !== undefined ? 'setPlan' : '');
    var groupHandler = GROUP_ACTIONS_.hasOwnProperty(action) ? GROUP_ACTIONS_[action] : null;
    var handler = ACTIONS_.hasOwnProperty(action) ? ACTIONS_[action] : null;
    if (!handler && !groupHandler) return jsonResponse_({ ok: false, error: 'bad_request', detail: 'unknown action' });

    // The group leaders' page signs in with a group PIN (`groupPin`) and can only do its own few things;
    // everything else needs the admin PIN (`pin`).
    var groupSlot = '';
    if (groupHandler) {
      var auth = authorizeGroup_(body.groupPin);
      if (auth.denied) return jsonResponse_(auth.denied);
      groupSlot = auth.slot;
    } else {
      var denied = authorize_(body.pin);
      if (denied) return jsonResponse_(denied);
    }

    // A retried request (double click, flaky connection) must not run twice.
    var requestId = body.requestId ? String(body.requestId).slice(0, 64) : '';
    var cacheKey = requestId ? 'req_' + action + '_' + groupSlot + '_' + requestId : '';
    if (cacheKey) {
      var earlier = CacheService.getScriptCache().get(cacheKey);
      if (earlier) return jsonResponse_(JSON.parse(earlier));
    }

    var result = groupHandler ? groupHandler(body, groupSlot) : handler(body);
    if (cacheKey && result.ok) CacheService.getScriptCache().put(cacheKey, JSON.stringify(result), REQUEST_CACHE_SEC);
    return jsonResponse_(result);
  } catch (err) {
    // Not the caller's fault (a missing sheet, a lock that could not be taken, ...): say so, instead of blaming the request.
    return jsonResponse_({ ok: false, error: 'server_error', detail: String(err) });
  }
}

var ACTIONS_ = {
  login: function (body) { return { ok: true }; },
  setPlan: actionSetPlan_,
  listSales: actionListSales_,
  dayCount: actionDayCount_,
  setDayCount: actionSetDayCount_,
  importSales: actionImportSales_,
  changePin: actionChangePin_,
  command: actionCommand_,
  setRoster: actionSetRoster_,
  setGroupPins: actionSetGroupPins_,
  groupPinStatus: actionGroupPinStatus_
};

/** The group leaders' page (rg.html): `groupPin` instead of `pin`; the handler also gets the leader's slot. */
var GROUP_ACTIONS_ = {
  groupLogin: actionGroupLogin_,
  groupSetCount: actionGroupSetCount_
};

/** Manual test helper — run from the editor, inspect via View > Logs. */
function testDoGet() {
  var result = doGet({ parameter: {} });
  Logger.log(result.getContent());
}

/* ------------------------------------------------------------------ actions */

/** The weekly plan, in payments (a whole number). */
function actionSetPlan_(body) {
  var plan = Number(body.plan);
  if (!isFinite(plan) || plan < 0 || Math.floor(plan) !== plan) return badRequest_('plan');
  setSetting_('WeeklyPlan', plan);
  return { ok: true, plan: plan };
}

/** Latest rows of "Sales" (newest first) plus the same aggregates the game shows. */
function actionListSales_(body) {
  var limit = Math.floor(Number(body.limit));
  if (!isFinite(limit) || limit < 1) limit = 50;
  limit = Math.min(limit, 200);

  var tz = getSpreadsheet_().getSpreadsheetTimeZone();
  var table = readSales_(false);
  var cols = table.cols;
  var values = table.values;
  var status = computeWeeklyStatus_();

  // Rows are judged by Date / Amount / ROP: getLastRow() also counts rows that only hold other data.
  var sales = [];
  var totalRows = 0;
  for (var i = values.length - 1; i >= 1; i--) {
    if (isBlankSale_(values[i], cols)) continue;
    totalRows++;
    if (sales.length >= limit) continue;
    var raw = values[i][cols.date];
    sales.push({
      row: i + 1,
      date: raw instanceof Date ? formatSaleDate_(raw, tz) : String(raw),
      amount: Number(values[i][cols.amount]) || 0,
      rop: String(values[i][cols.rop] || ''),
      invoice: cols.invoice >= 0 ? String(values[i][cols.invoice] || '') : '',
      count: rowPayments_(values[i], cols)
    });
  }

  return {
    ok: true,
    totalRows: totalRows,
    shown: sales.length,
    sales: sales,
    status: status,
    settings: { WeeklyPlan: status.plan }
  };
}

/** How many payments a group has on a day (the admin page's counter starts from it). */
function actionDayCount_(body) {
  var rop = validateRop_(body.rop);
  if (DEPARTMENT_CODES.indexOf(rop) < 0) return badRequest_('rop');
  var day = validDay_(body.date);
  if (!day) return badRequest_('date');
  return { ok: true, rop: rop, date: day, count: dayPayments_(readSales_(false), rop)[day] || 0 };
}

/** Sets a group's payments on a day (admin page, «Внести оплату»): any day up to today. */
function actionSetDayCount_(body) {
  var rop = validateRop_(body.rop);
  if (DEPARTMENT_CODES.indexOf(rop) < 0) return badRequest_('rop');
  var day = validDay_(body.date);
  if (!day || day > today_()) return badRequest_('date');
  var count = validCount_(body.count);
  if (count === null) return badRequest_('count');
  var saved = setDayCount_(rop, day, count);
  return { ok: true, saved: saved, status: computeWeeklyStatus_() };
}

/**
 * A group's payments on a day become `count`: that day's rows of the group (imported invoices or an earlier count)
 * are replaced by one row carrying the number — none for 0. Whoever saves last wins: a later import of that day
 * replaces it again. Returns { rop, date, count, previous }.
 */
function setDayCount_(code, day, count) {
  return withLock_(function () {
    var table = readSales_(true);
    var removed = rewriteSales_(table, function (row, rowDay) {
      return rowDay === day && String(row[table.cols.rop]).trim() === code;
    }, count > 0 ? [{ day: day, amount: '', rop: code, invoice: '', count: count }] : []);
    return { rop: code, date: day, count: count, previous: removed.payments };
  });
}

/** { 'yyyy-MM-dd': payments } of one group, over the whole sheet. */
function dayPayments_(table, code) {
  var tz = getSpreadsheet_().getSpreadsheetTimeZone();
  var days = {};
  for (var i = 1; i < table.values.length; i++) {
    var row = table.values[i];
    if (isBlankSale_(row, table.cols) || String(row[table.cols.rop]).trim() !== code) continue;
    var day = saleDay_(row[table.cols.date], tz);
    if (day) days[day] = (days[day] || 0) + rowPayments_(row, table.cols);
  }
  return days;
}

/* ------------------------------------------------------ group leaders' page */

/** What the page shows after sign-in: which group, the leader's name if edited in the admin page, this week so far. */
function actionGroupLogin_(body, slot) {
  return groupView_(slot, { ok: true });
}

/**
 * The leader's own group's payments on a day — the group comes from the PIN, never from the request. Any day of the
 * current week up to today: a forgotten day can be filled in, past weeks and the future cannot be touched.
 */
function actionGroupSetCount_(body, slot) {
  var day = validDay_(body.date);
  var week = currentWeek_();
  if (!day || day < week.start || day > week.today) return badRequest_('date');
  var count = validCount_(body.count);
  if (count === null) return badRequest_('count');
  var saved = setDayCount_(groupCodeForSlot_(slot), day, count);
  return groupView_(slot, { ok: true, saved: saved });
}

function groupCodeForSlot_(slot) {
  return DEPARTMENT_CODES[LEADER_SLOTS.indexOf(slot)];
}

/**
 * Adds { group: {slot, code, leader}, week: {start, today, total, days: {'yyyy-MM-dd': payments}} } to a group-page
 * answer — `days` covers this week up to today, so the page shows each day's number without asking again.
 */
function groupView_(slot, res) {
  var code = groupCodeForSlot_(slot);
  var leaders = readLeaders_() || {};
  var week = currentWeek_();
  var all = dayPayments_(readSales_(false), code);
  var days = {};
  var total = 0;
  for (var day in all) {
    if (day < week.start || day > week.today) continue;
    days[day] = all[day];
    total += all[day];
  }
  res.group = { slot: slot, code: code, leader: leaders.hasOwnProperty(slot) ? leaders[slot] : null };
  res.week = { start: week.start, today: week.today, total: total, days: days };
  return res;
}

/** This week in the sheet's time zone: Monday and today, as 'yyyy-MM-dd'. */
function currentWeek_() {
  var tz = getSpreadsheet_().getSpreadsheetTimeZone();
  return { start: Utilities.formatDate(getWeekBounds_(new Date(), tz).start, tz, 'yyyy-MM-dd'), today: today_() };
}

function today_() {
  return Utilities.formatDate(new Date(), getSpreadsheet_().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
}

/* --------------------------------------------- group PINs (admin page side) */

/**
 * Sets the group leaders' PINs: { pins: { slot_1: '123456', … } } — only the slots sent change; a new PIN replaces the
 * old one at once. The admin page makes them up at random and shows them to the admin once; here only a salted hash
 * is kept. A PIN must be 6–12 digits and differ from the other groups' PINs and from the admin PIN.
 */
function actionSetGroupPins_(body) {
  var input = body.pins;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return badRequest_('pins');
  var changes = {};
  var seen = {};
  for (var slot in input) {
    if (!input.hasOwnProperty(slot)) continue;
    var pin = String(input[slot] === undefined || input[slot] === null ? '' : input[slot]);
    if (LEADER_SLOTS.indexOf(slot) < 0 || !/^[0-9]{6,12}$/.test(pin)) return badRequest_('pins');
    if (seen[pin] || verifyPin_(pin)) return badRequest_('pins_duplicate');
    seen[pin] = true;
    changes[slot] = pin;
  }
  if (Object.keys(changes).length === 0) return badRequest_('pins');

  return withLock_(function () {
    var pins = readGroupPins_();
    // A new PIN must not open another group that keeps its current PIN.
    for (var s in changes) {
      var owner = groupSlotForPin_(changes[s]);
      if (owner && !changes.hasOwnProperty(owner)) return badRequest_('pins_duplicate');
    }
    for (var slotKey in changes) {
      var salt = Utilities.getUuid();
      pins[slotKey] = salt + '$' + hashPin_(salt, changes[slotKey]);
    }
    PropertiesService.getScriptProperties().setProperty(GROUP_PINS_PROPERTY_KEY, JSON.stringify(pins));
    // Like a changed admin PIN: new PINs (e.g. after someone tried to guess) lift the group page's lock.
    CacheService.getScriptCache().remove('group_pin_fails');
    CacheService.getScriptCache().remove('group_pin_lock_until');
    return { ok: true, set: groupPinsSet_(pins) };
  });
}

/** Which groups have a PIN (true/false per slot) — never the PINs or their hashes. */
function actionGroupPinStatus_(body) {
  return { ok: true, set: groupPinsSet_(readGroupPins_()) };
}

function groupPinsSet_(pins) {
  var set = {};
  for (var i = 0; i < LEADER_SLOTS.length; i++) set[LEADER_SLOTS[i]] = !!pins[LEADER_SLOTS[i]];
  return set;
}

/**
 * Replaces the payments of a period with those of an export file (admin page, tab «Импорт»: the file is read in the
 * browser, only date / amount / group / invoice number get here; one row = one invoice = one payment, invoices under
 * 100 ₽ are left out by the page). Every sale dated from..to (inclusive, in the sheet's time zone) goes — imported
 * earlier, or a day's count saved by a group leader — and the file's rows take its place; the rest of the sheet is
 * kept. The file is the truth for its period: re-importing an overlapping export never counts a payment twice, and a
 * payment cancelled in the CRM disappears with the next import.
 *
 * { dryRun: true } changes nothing and only reports what the sheet holds for the period now (the admin page shows
 * "now → after" per group before the real run). The write itself is rewriteSales_ (one setValues, no row deletion).
 */
function actionImportSales_(body) {
  var from = validDay_(body.from);
  var to = validDay_(body.to);
  if (!from || !to || from > to) return badRequest_('period');

  var input = body.rows;
  if (!Array.isArray(input) || input.length > MAX_IMPORT_ROWS) return badRequest_('rows');
  var rows = [];
  for (var i = 0; i < input.length; i++) {
    var r = input[i] && typeof input[i] === 'object' ? input[i] : {};
    var day = validDay_(r.date);
    var amount = validateAmount_(r.amount);
    var rop = validateRop_(r.rop);
    var invoice = String(r.invoice === undefined || r.invoice === null ? '' : r.invoice).trim();
    if (!day || day < from || day > to || amount === null || DEPARTMENT_CODES.indexOf(rop) < 0 || !/^[0-9A-Za-zА-Яа-яЁё\/_-]{0,30}$/.test(invoice)) {
      return badRequest_('rows', i);
    }
    rows.push({ day: day, amount: amount, rop: rop, invoice: invoice });
  }

  if (body.dryRun) {
    var tz = getSpreadsheet_().getSpreadsheetTimeZone();
    var table = readSales_(false);
    var current = { rows: 0, payments: 0, manualPayments: 0, byRop: {} };
    for (var j = 1; j < table.values.length; j++) {
      var row = table.values[j];
      if (isBlankSale_(row, table.cols)) continue;
      var d = saleDay_(row[table.cols.date], tz);
      if (!d || d < from || d > to) continue;
      var n = rowPayments_(row, table.cols);
      var code = String(row[table.cols.rop] || '').trim();
      current.rows++;
      current.payments += n;
      current.byRop[code] = (current.byRop[code] || 0) + n;
      if (table.cols.invoice < 0 || String(row[table.cols.invoice]).trim() === '') current.manualPayments += n;
    }
    return { ok: true, dryRun: true, from: from, to: to, current: current };
  }

  return withLock_(function () {
    var table = readSales_(true);
    var removed = rewriteSales_(table, function (row, day) { return !!day && day >= from && day <= to; },
      rows.map(function (r) { return { day: r.day, amount: r.amount, rop: r.rop, invoice: r.invoice, count: 1 }; }));
    return { ok: true, from: from, to: to, removed: removed, added: { payments: rows.length }, status: computeWeeklyStatus_() };
  });
}

/* ------------------------------------------------------------- sales table */

/**
 * The "Sales" sheet read in one go: { sheet, cols: {date, amount, rop, invoice, count}, values }. Invoice and Count
 * are -1 while the sheet has no such column — unless `create`, which adds them (an import or a saved count does).
 */
function readSales_(create) {
  var sheet = getSalesSheet_();
  var cols = salesColumns_(sheet);
  cols.invoice = headerColumn_(sheet, INVOICE_HEADER, create);
  cols.count = headerColumn_(sheet, COUNT_HEADER, create);
  var values = sheet.getRange(1, 1, Math.max(1, sheet.getLastRow()), Math.max(1, sheet.getLastColumn())).getValues();
  return { sheet: sheet, cols: cols, values: values };
}

/** How many payments a "Sales" row stands for: its Count, or 1 when it has none (an imported invoice, an old row). */
function rowPayments_(row, cols) {
  if (cols.count >= 0) {
    var cell = row[cols.count];
    if (cell !== '' && cell !== null && cell !== undefined) {
      var n = Math.floor(Number(cell));
      return isFinite(n) && n > 0 ? n : 0;
    }
  }
  return 1;
}

/** A day's number of payments: a whole number 0..MAX_DAY_COUNT, else null. */
function validCount_(value) {
  if (value === '' || value === null || value === undefined) return null;
  var n = Number(value);
  return isFinite(n) && Math.floor(n) === n && n >= 0 && n <= MAX_DAY_COUNT ? n : null;
}

/**
 * Rewrites the sales rows of a table from readSales_(true) (call under withLock_): every row `replaced(row, day)` says
 * yes to goes, the `incoming` rows ({ day, amount, rop, invoice, count }) come in, all sorted by day — a stable sort,
 * so one day keeps its order, the kept rows first. ONE setValues over the sales block, the rows no longer needed
 * blanked in the same write: never a row deletion, and no moment where the old rows are gone but the new ones are
 * not written yet. Only the Date / Amount / ROP / Invoice / Count cells change; other columns keep their values.
 * Returns { rows, payments } of what went.
 */
function rewriteSales_(table, replaced, incoming) {
  var sheet = table.sheet;
  var cols = table.cols;
  var values = table.values;
  var tz = getSpreadsheet_().getSpreadsheetTimeZone();

  var kept = [];
  var removed = { rows: 0, payments: 0 };
  var lastSale = 0; // index (in values) of the last row holding a sale
  for (var j = 1; j < values.length; j++) {
    if (isBlankSale_(values[j], cols)) continue;
    lastSale = j;
    var day = saleDay_(values[j][cols.date], tz);
    if (replaced(values[j], day)) {
      removed.rows++;
      removed.payments += rowPayments_(values[j], cols);
      continue;
    }
    kept.push({ day: day, date: values[j][cols.date], amount: values[j][cols.amount], rop: values[j][cols.rop], invoice: values[j][cols.invoice], count: values[j][cols.count] });
  }

  var midnight = {}; // day -> Date, parsed once per day rather than once per row
  var fresh = incoming.map(function (r) {
    if (!midnight[r.day]) midnight[r.day] = Utilities.parseDate(r.day + 'T00:00', tz, "yyyy-MM-dd'T'HH:mm");
    return { day: r.day, date: midnight[r.day], amount: r.amount, rop: r.rop, invoice: r.invoice, count: r.count };
  });
  var all = kept.concat(fresh).sort(function (a, b) { return a.day < b.day ? -1 : a.day > b.day ? 1 : 0; });

  // Cover every row that held a sale before, so the ones no longer needed are blanked in the same write.
  var span = Math.max(all.length, lastSale);
  if (span > 0) {
    if (sheet.getMaxRows() < span + 1) sheet.insertRowsAfter(sheet.getMaxRows(), span + 1 - sheet.getMaxRows());
    var fields = ['date', 'amount', 'rop', 'invoice', 'count'];
    var touched = fields.map(function (f) { return cols[f]; });
    var first = Math.min.apply(null, touched);
    var width = Math.max.apply(null, touched) - first + 1;
    var block = [];
    for (var k = 0; k < span; k++) {
      var source = values[k + 1] || [];
      var line = [];
      for (var c = 0; c < width; c++) line.push(source[first + c] === undefined ? '' : source[first + c]);
      var sale = all[k];
      for (var f = 0; f < fields.length; f++) {
        var v = sale ? sale[fields[f]] : '';
        line[cols[fields[f]] - first] = v === undefined || v === null ? '' : v;
      }
      block.push(line);
    }
    sheet.getRange(2, first + 1, span, width).setValues(block);
  }
  return removed;
}

function actionChangePin_(body) {
  var newPin = String(body.newPin === undefined ? '' : body.newPin);
  if (!/^[0-9]{4,12}$/.test(newPin)) return badRequest_('newPin');
  if (newPin === String(body.pin)) return badRequest_('newPin_same');
  if (groupSlotForPin_(newPin)) return badRequest_('newPin_group');
  return withLock_(function () {
    storePin_(newPin);
    return { ok: true };
  });
}

/**
 * Asks every display to play an animation. Purely visual: the game does not change any
 * numbers because of it, and nothing is written to the spreadsheet — the queue lives in
 * Script Properties. Each display runs every command once, in id order (see readRecentCommands_).
 */
function actionCommand_(body) {
  var type = String(body.type || '');
  var validate = COMMAND_ARGS_[type];
  if (!validate) return badRequest_('type');
  var args = validate(body.args || {});
  if (args === null) return badRequest_('args');

  return withLock_(function () {
    var props = PropertiesService.getScriptProperties();
    var seq = (Number(props.getProperty(COMMAND_SEQ_PROPERTY_KEY)) || 0) + 1;
    var now = Date.now();
    var queue = readCommandQueue_().filter(function (c) { return now - c.issuedAt <= COMMAND_MAX_AGE_MS; });
    queue.push({ id: seq, type: type, args: args, issuedAt: now });
    queue = queue.slice(-COMMAND_KEEP);
    props.setProperty(COMMANDS_PROPERTY_KEY, JSON.stringify(queue));
    props.setProperty(COMMAND_SEQ_PROPERTY_KEY, String(seq));
    return { ok: true, id: seq };
  });
}

/**
 * Which character stands in which slot (admin page, "Герои" tab). Stored as JSON in Script Properties — it is
 * display configuration, not data, so the spreadsheet is never touched. Only the slots that are sent change;
 * the displays pick the new choice up with their next poll and swap the heroes on stage.
 */
function actionSetRoster_(body) {
  var changes = {};
  if (body.roster !== undefined) {
    var input = body.roster;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return badRequest_('roster');
    for (var key in input) {
      if (!input.hasOwnProperty(key)) continue;
      if (ROSTER_SLOTS.indexOf(key) < 0) return badRequest_('roster');
      var id = String(input[key]);
      if (!/^[a-z0-9_]{2,32}$/.test(id)) return badRequest_('roster');
      changes[key] = id;
    }
  }

  // The group leaders' names on the nameplates («Фамилия И.»); an empty name leaves just the group code.
  var nameChanges = {};
  if (body.leaders !== undefined) {
    var names = body.leaders;
    if (!names || typeof names !== 'object' || Array.isArray(names)) return badRequest_('leaders');
    for (var slotKey in names) {
      if (!names.hasOwnProperty(slotKey)) continue;
      if (LEADER_SLOTS.indexOf(slotKey) < 0) return badRequest_('leaders');
      var name = String(names[slotKey] === null || names[slotKey] === undefined ? '' : names[slotKey]).replace(/\s+/g, ' ').trim();
      if (!/^[A-Za-zА-Яа-яЁё .'-]{0,40}$/.test(name)) return badRequest_('leaders');
      nameChanges[slotKey] = name;
    }
  }
  if (Object.keys(changes).length === 0 && Object.keys(nameChanges).length === 0) return badRequest_('roster');

  return withLock_(function () {
    var props = PropertiesService.getScriptProperties();
    if (Object.keys(changes).length > 0) {
      var roster = readRoster_() || {};
      for (var slot in changes) roster[slot] = changes[slot];
      props.setProperty(ROSTER_PROPERTY_KEY, JSON.stringify(roster));
    }
    if (Object.keys(nameChanges).length > 0) {
      var leaders = readLeaders_() || {};
      for (var s in nameChanges) leaders[s] = nameChanges[s];
      props.setProperty(LEADERS_PROPERTY_KEY, JSON.stringify(leaders));
    }
    return { ok: true, roster: readRoster_(), leaders: readLeaders_() };
  });
}

/** The saved choice, or null while nothing has been chosen (the displays then use their built-in defaults). */
function readRoster_() {
  return readJsonProperty_(ROSTER_PROPERTY_KEY);
}

/** The saved group leaders' names, or null while none were edited (the displays then use their built-in list). */
function readLeaders_() {
  return readJsonProperty_(LEADERS_PROPERTY_KEY);
}

function readJsonProperty_(key) {
  var raw = PropertiesService.getScriptProperties().getProperty(key);
  if (!raw) return null;
  try {
    var value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (err) {
    return null;
  }
}

/** type -> args validator (returns the cleaned args, or null when they are unacceptable). */
var COMMAND_ARGS_ = {
  hit: function (a) {
    var rop = validateRop_(a.rop);
    var count = a.count === undefined ? 1 : validCount_(a.count);
    return rop && count !== null && count >= 1 ? { rop: rop, count: count } : null;
  },
  fall: function (a) {
    var hero = a.hero === undefined ? 'random' : String(a.hero);
    var mode = a.mode === undefined ? 'random' : String(a.mode);
    if (COMMAND_HEROES.indexOf(hero) < 0 || ['random', 'fall', 'doze'].indexOf(mode) < 0) return null;
    return { hero: hero, mode: mode };
  },
  wake: function (a) { return {}; },
  growl: function (a) { return {}; },
  confetti: function (a) { return {}; },
  celebrate: function (a) { return {}; }
};

function readCommandQueue_() {
  var raw = PropertiesService.getScriptProperties().getProperty(COMMANDS_PROPERTY_KEY);
  if (!raw) return [];
  try {
    var list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (err) {
    return [];
  }
}

/** What the displays see on their normal poll: only commands still fresh enough to be worth playing. */
function readRecentCommands_() {
  var now = Date.now();
  return readCommandQueue_().filter(function (c) { return now - c.issuedAt <= COMMAND_MAX_AGE_MS; });
}

/* --------------------------------------------------------------- validation */

/** A department code such as "ВШ1": letters, digits and spaces only — never something a sheet would read as a formula. */
function validateRop_(value) {
  var rop = String(value === undefined || value === null ? '' : value).trim();
  return /^[A-Za-zА-Яа-яЁё0-9 ]{1,20}$/.test(rop) ? rop : '';
}

function validateAmount_(value) {
  var amount = Number(value);
  if (value === '' || value === null || !isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) return null;
  return Math.round(amount * 100) / 100;
}

/** Empty -> now; otherwise 'yyyy-MM-dd' (stored as midnight, like the sheet's own rows) or 'yyyy-MM-ddTHH:mm' in the sheet's time zone, within the last ~400 days and not later than tomorrow. */
function parseSaleDate_(value) {
  if (value === undefined || value === null || String(value).trim() === '') return new Date();
  var text = String(value).trim();
  var tz = getSpreadsheet_().getSpreadsheetTimeZone();
  var date = null;
  try {
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) date = Utilities.parseDate(text + 'T00:00', tz, "yyyy-MM-dd'T'HH:mm");
    else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) date = Utilities.parseDate(text, tz, "yyyy-MM-dd'T'HH:mm");
  } catch (err) {
    return null;
  }
  if (!date || isNaN(date.getTime())) return null;
  var now = Date.now();
  if (date.getTime() > now + 86400000 || date.getTime() < now - 400 * 86400000) return null;
  return date;
}

/** 'yyyy-MM-dd' -> the same text if it is a real day that a sale may carry (see parseSaleDate_), otherwise ''. */
function validDay_(value) {
  var text = String(value === undefined || value === null ? '' : value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
  var date = parseSaleDate_(text);
  // The round trip rejects days a lenient parser would roll over (2026-02-30 -> 2026-03-02).
  return date && Utilities.formatDate(date, getSpreadsheet_().getSpreadsheetTimeZone(), 'yyyy-MM-dd') === text ? text : '';
}

/** The day ('yyyy-MM-dd', sheet time zone) a "Sales" Date cell belongs to; '' if it holds no readable date. */
function saleDay_(value, tz) {
  if (value instanceof Date) return isNaN(value.getTime()) ? '' : Utilities.formatDate(value, tz, 'yyyy-MM-dd');
  var m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value).trim());
  return m ? m[1] : '';
}

/** A "Sales" row with nothing in Date, Amount and ROP (other columns are ignored). */
function isBlankSale_(row, cols) {
  return String(row[cols.date]).trim() === '' && String(row[cols.amount]).trim() === '' && String(row[cols.rop]).trim() === '';
}

/** 'yyyy-MM-dd', plus ' HH:mm' unless it is exactly midnight (the sheet's own rows carry a date only). */
function formatSaleDate_(date, tz) {
  var time = Utilities.formatDate(date, tz, 'HH:mm');
  return Utilities.formatDate(date, tz, 'yyyy-MM-dd') + (time === '00:00' ? '' : ' ' + time);
}

/** `row` — the index of the offending entry when a list was sent (importSales). */
function badRequest_(field, row) {
  var res = { ok: false, error: 'bad_request', field: field };
  if (row !== undefined) res.row = row;
  return res;
}

/* ------------------------------------------------------------------- status */

function computeWeeklyStatus_() {
  var ss = getSpreadsheet_();
  var tz = ss.getSpreadsheetTimeZone();
  var bounds = getWeekBounds_(new Date(), tz);

  var salesSheet = ss.getSheetByName(SALES_SHEET_NAME);
  if (!salesSheet) throw new Error('Missing "' + SALES_SHEET_NAME + '" sheet');

  var values = salesSheet.getDataRange().getValues();
  var header = values[0];
  var dateCol = header.indexOf('Date');
  var amountCol = header.indexOf('Amount');
  var ropCol = header.indexOf('ROP');
  var countCols = { count: header.indexOf(COUNT_HEADER) };
  if (dateCol < 0 || amountCol < 0 || ropCol < 0) {
    throw new Error('Sales sheet must have Date, Amount, ROP columns');
  }

  var totalsByRop = {};
  var totalThisWeek = 0;

  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var rawDate = row[dateCol];
    if (!rawDate) continue;
    var date = rawDate instanceof Date ? rawDate : new Date(rawDate);
    if (date < bounds.start || date >= bounds.end) continue;

    var amount = rowPayments_(row, countCols); // payments, not money
    var rop = String(row[ropCol] || '').trim();
    if (!rop) continue;

    totalsByRop[rop] = (totalsByRop[rop] || 0) + amount;
    totalThisWeek += amount;
  }

  var settings = readSettings_();
  var plan = Number(settings.WeeklyPlan) || 0;
  var totalMeters = Number(settings.TotalMeters) || 300;
  var ratio = plan > 0 ? Math.min(1, Math.max(0, totalThisWeek / plan)) : 0;
  var metersRemaining = Math.round(totalMeters * (1 - ratio));

  var byRop = [];
  for (var ropName in totalsByRop) {
    byRop.push({ ropName: ropName, amount: totalsByRop[ropName] });
  }

  return {
    ok: true,
    weekStart: Utilities.formatDate(bounds.start, tz, 'yyyy-MM-dd'),
    weekEnd: Utilities.formatDate(bounds.end, tz, 'yyyy-MM-dd'),
    plan: plan,
    totalThisWeek: totalThisWeek,
    totalMeters: totalMeters,
    metersRemaining: metersRemaining,
    byRop: byRop,
    lastUpdated: new Date().toISOString()
  };
}

/** Monday 00:00 (inclusive) to next Monday 00:00 (exclusive), in the sheet's own timezone. */
function getWeekBounds_(now, tz) {
  var dayOfWeek = Number(Utilities.formatDate(now, tz, 'u')); // 1=Mon..7=Sun
  var startOfToday = new Date(Utilities.formatDate(now, tz, "yyyy-MM-dd'T'00:00:00"));
  var start = new Date(startOfToday.getTime() - (dayOfWeek - 1) * 86400000);
  var end = new Date(start.getTime() + 7 * 86400000);
  return { start: start, end: end };
}

/* ---------------------------------------------------------------------- PIN */

/** Returns null when the PIN is right, otherwise the error response to send. Counts failures and locks out guessing. */
function authorize_(pin) {
  var lockedFor = lockRemainingSec_();
  if (lockedFor > 0) return { ok: false, error: 'locked', retryAfterSec: lockedFor };

  if (!verifyPin_(pin)) {
    recordPinFailure_();
    lockedFor = lockRemainingSec_();
    return lockedFor > 0 ? { ok: false, error: 'locked', retryAfterSec: lockedFor } : { ok: false, error: 'invalid_pin' };
  }
  CacheService.getScriptCache().remove('pin_fails');
  return null;
}

function verifyPin_(pin) {
  if (pin === undefined || pin === null) return false;
  var text = String(pin);
  if (text.length === 0 || text.length > 32) return false;

  var props = PropertiesService.getScriptProperties();
  var stored = props.getProperty(PIN_HASH_PROPERTY_KEY);
  if (stored) {
    var parts = stored.split('$');
    return parts.length === 2 && hashPin_(parts[0], text) === parts[1];
  }
  var legacy = props.getProperty(PIN_PROPERTY_KEY);
  return legacy !== null && text === legacy;
}

function hashPin_(salt, pin) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pin, Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

function storePin_(pin) {
  var props = PropertiesService.getScriptProperties();
  var salt = Utilities.getUuid();
  props.setProperty(PIN_HASH_PROPERTY_KEY, salt + '$' + hashPin_(salt, String(pin)));
  props.deleteProperty(PIN_PROPERTY_KEY);
  CacheService.getScriptCache().remove('pin_fails');
  CacheService.getScriptCache().remove('pin_lock_until');
}

/** `prefix` — 'pin' (the admin page) or 'group_pin' (the group leaders' page): each has its own failure count and lock. */
function lockRemainingSec_(prefix) {
  var until = Number(CacheService.getScriptCache().get((prefix || 'pin') + '_lock_until')) || 0;
  return until > Date.now() ? Math.ceil((until - Date.now()) / 1000) : 0;
}

function recordPinFailure_(prefix) {
  prefix = prefix || 'pin';
  var cache = CacheService.getScriptCache();
  var fails = (Number(cache.get(prefix + '_fails')) || 0) + 1;
  if (fails >= MAX_PIN_FAILURES) {
    cache.put(prefix + '_lock_until', String(Date.now() + PIN_LOCK_SEC * 1000), PIN_LOCK_SEC + 60);
    cache.remove(prefix + '_fails');
  } else {
    cache.put(prefix + '_fails', String(fails), PIN_FAILURE_WINDOW_SEC);
  }
}

/* ------------------------------------------------------------- group PINs */

/** { slot: 'salt$sha256' } — one PIN per group leader, made in the admin page; the PIN itself is never stored. */
function readGroupPins_() {
  return readJsonProperty_(GROUP_PINS_PROPERTY_KEY) || {};
}

/** The slot whose leader's PIN this is, or '' (the admin PIN is never a group PIN). */
function groupSlotForPin_(pin) {
  if (pin === undefined || pin === null) return '';
  var text = String(pin);
  if (text.length === 0 || text.length > 32) return '';
  var pins = readGroupPins_();
  for (var i = 0; i < LEADER_SLOTS.length; i++) {
    var stored = pins[LEADER_SLOTS[i]];
    if (!stored) continue;
    var parts = String(stored).split('$');
    if (parts.length === 2 && hashPin_(parts[0], text) === parts[1]) return LEADER_SLOTS[i];
  }
  return '';
}

/** { slot } when the group PIN is right, otherwise { denied: <error response> }. Its own lock: leaders mistyping never lock the admin out. */
function authorizeGroup_(pin) {
  var lockedFor = lockRemainingSec_('group_pin');
  if (lockedFor > 0) return { denied: { ok: false, error: 'locked', retryAfterSec: lockedFor } };
  var slot = groupSlotForPin_(pin);
  if (!slot) {
    recordPinFailure_('group_pin');
    lockedFor = lockRemainingSec_('group_pin');
    return { denied: lockedFor > 0 ? { ok: false, error: 'locked', retryAfterSec: lockedFor } : { ok: false, error: 'invalid_pin' } };
  }
  CacheService.getScriptCache().remove('group_pin_fails');
  return { slot: slot };
}

/* ------------------------------------------------------------------- sheets */

function getSalesSheet_() {
  var sheet = getSpreadsheet_().getSheetByName(SALES_SHEET_NAME);
  if (!sheet) throw new Error('Missing "' + SALES_SHEET_NAME + '" sheet');
  return sheet;
}

/** 0-based column indexes of Date / Amount / ROP, matched by the header row. */
function salesColumns_(sheet) {
  var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var cols = { date: header.indexOf('Date'), amount: header.indexOf('Amount'), rop: header.indexOf('ROP') };
  if (cols.date < 0 || cols.amount < 0 || cols.rop < 0) throw new Error('Sales sheet must have Date, Amount, ROP columns');
  return cols;
}

/**
 * 0-based index of the column headed `header` (Invoice, Count); -1 if there is none yet — unless `create`, which then
 * adds it right after the last used column (so a sheet made before that column existed keeps working).
 */
function headerColumn_(sheet, header, create) {
  var width = Math.max(1, sheet.getLastColumn());
  var index = sheet.getRange(1, 1, 1, width).getValues()[0].indexOf(header);
  if (index >= 0 || !create) return index;
  var column = sheet.getLastColumn() + 1;
  if (sheet.getMaxColumns() < column) sheet.insertColumnsAfter(sheet.getMaxColumns(), column - sheet.getMaxColumns());
  var cell = sheet.getRange(1, column);
  cell.setValue(header);
  cell.setFontWeight('bold');
  // Invoice numbers as plain text: otherwise Sheets turns «568010911» into a number (and drops leading zeros).
  if (header === INVOICE_HEADER) sheet.getRange(2, column, sheet.getMaxRows() - 1, 1).setNumberFormat('@');
  return column - 1;
}

function getSettingsSheet_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(SETTINGS_SHEET_NAME);
  if (!sheet) throw new Error('Missing "' + SETTINGS_SHEET_NAME + '" sheet');
  return sheet;
}

/** All "Settings" rows as { Key: Value } — one read of the sheet for however many settings are needed. */
function readSettings_() {
  var values = getSettingsSheet_().getDataRange().getValues();
  var settings = {};
  for (var i = 0; i < values.length; i++) {
    if (values[i][0] !== '') settings[String(values[i][0])] = values[i][1];
  }
  return settings;
}

function setSetting_(key, value) {
  var sheet = getSettingsSheet_();
  var values = sheet.getDataRange().getValues();
  for (var i = 0; i < values.length; i++) {
    if (values[i][0] === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value]);
}

/** Serialises writers (two admins clicking at once must not both read the same command counter / interleave rows). */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
