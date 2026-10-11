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
 * Sheet schema (tab names are literal, columns are header-matched, order-independent):
 *   "Sales"    — Date | Amount | ROP           (one row per incoming payment)
 *   "Settings" — Key | Value                   (rows: WeeklyPlan, TotalMeters)
 *
 * HTTP API (one Web App URL):
 *   GET            public, aggregates only: week status + recent admin "commands" for the displays.
 *   POST (JSON, sent as text/plain to avoid a CORS preflight) — every action needs the admin PIN:
 *     { action: 'login',     pin }                                  check the PIN
 *     { action: 'setPlan',   pin, plan }                            weekly plan (also the legacy { pin, plan } form)
 *     { action: 'listSales', pin, limit? }                          latest rows of "Sales" + week status + settings
 *     { action: 'addSale',   pin, rop, amount, date?, requestId? }  append a payment row to "Sales"
 *     { action: 'changePin', pin, newPin }                          change the PIN (stored as a salted hash)
 *     { action: 'command',   pin, type, args?, requestId? }         show an animation on the displays
 *     { action: 'setRoster', pin, roster }                          which character stands in which slot (see ROSTER_SLOTS)
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
 *   Sales    Date | Amount | ROP   (ROP has a drop-down of the six groups)
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
  sales.getRange(1, 1, 1, 3).setValues([['Date', 'Amount', 'ROP']]).setFontWeight('bold');
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
    var handler = ACTIONS_.hasOwnProperty(action) ? ACTIONS_[action] : null;
    if (!handler) return jsonResponse_({ ok: false, error: 'bad_request', detail: 'unknown action' });

    var denied = authorize_(body.pin);
    if (denied) return jsonResponse_(denied);

    // A retried request (double click, flaky connection) must not run twice.
    var requestId = body.requestId ? String(body.requestId).slice(0, 64) : '';
    var cacheKey = requestId ? 'req_' + action + '_' + requestId : '';
    if (cacheKey) {
      var earlier = CacheService.getScriptCache().get(cacheKey);
      if (earlier) return jsonResponse_(JSON.parse(earlier));
    }

    var result = handler(body);
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
  addSale: actionAddSale_,
  changePin: actionChangePin_,
  command: actionCommand_,
  setRoster: actionSetRoster_
};

/** Manual test helper — run from the editor, inspect via View > Logs. */
function testDoGet() {
  var result = doGet({ parameter: {} });
  Logger.log(result.getContent());
}

/* ------------------------------------------------------------------ actions */

function actionSetPlan_(body) {
  var plan = Number(body.plan);
  if (!isFinite(plan) || plan < 0) return badRequest_('plan');
  setSetting_('WeeklyPlan', plan);
  return { ok: true, plan: plan };
}

/** Latest rows of "Sales" (newest first) plus the same aggregates the game shows. */
function actionListSales_(body) {
  var limit = Math.floor(Number(body.limit));
  if (!isFinite(limit) || limit < 1) limit = 50;
  limit = Math.min(limit, 200);

  var tz = getSpreadsheet_().getSpreadsheetTimeZone();
  var sheet = getSalesSheet_();
  var cols = salesColumns_(sheet);
  var status = computeWeeklyStatus_();

  // Read the whole sheet: getLastRow() also counts rows that only hold other data (the ROP drop-down's
  // list of departments lives in column F of the real sheet, names in column D), so rows are judged by
  // the three columns that matter.
  var values = sheet.getRange(1, 1, Math.max(1, sheet.getLastRow()), sheet.getLastColumn()).getValues();
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
      rop: String(values[i][cols.rop] || '')
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

/** Appends one payment row. Real data: it moves the week's totals and makes the heroes strike on every display. */
function actionAddSale_(body) {
  var rop = validateRop_(body.rop);
  var amount = validateAmount_(body.amount);
  var date = parseSaleDate_(body.date);
  if (!rop || amount === null || !date) return badRequest_(!rop ? 'rop' : amount === null ? 'amount' : 'date');

  return withLock_(function () {
    var sheet = getSalesSheet_();
    var cols = salesColumns_(sheet);

    // Not appendRow(): that goes below the last row holding *anything*, and in the real sheet other columns
    // (the drop-down list in F, names in D) reach further down than the sales do — which would leave a gap.
    // Take the first row after the last one with a Date/Amount/ROP, and write only those three cells so the
    // neighbouring columns are left alone.
    var values = sheet.getRange(1, 1, Math.max(1, sheet.getLastRow()), sheet.getLastColumn()).getValues();
    var last = 1;
    for (var i = 1; i < values.length; i++) {
      if (!isBlankSale_(values[i], cols)) last = i + 1;
    }
    var target = last + 1;
    sheet.getRange(target, cols.date + 1).setValue(date);
    sheet.getRange(target, cols.amount + 1).setValue(amount);
    sheet.getRange(target, cols.rop + 1).setValue(rop);

    return {
      ok: true,
      added: { row: target, date: formatSaleDate_(date, getSpreadsheet_().getSpreadsheetTimeZone()), amount: amount, rop: rop },
      status: computeWeeklyStatus_()
    };
  });
}

function actionChangePin_(body) {
  var newPin = String(body.newPin === undefined ? '' : body.newPin);
  if (!/^[0-9]{4,12}$/.test(newPin)) return badRequest_('newPin');
  if (newPin === String(body.pin)) return badRequest_('newPin_same');
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
  var input = body.roster;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return badRequest_('roster');
  var changes = {};
  for (var key in input) {
    if (!input.hasOwnProperty(key)) continue;
    if (ROSTER_SLOTS.indexOf(key) < 0) return badRequest_('roster');
    var id = String(input[key]);
    if (!/^[a-z0-9_]{2,32}$/.test(id)) return badRequest_('roster');
    changes[key] = id;
  }
  if (Object.keys(changes).length === 0) return badRequest_('roster');

  return withLock_(function () {
    var roster = readRoster_() || {};
    for (var slot in changes) roster[slot] = changes[slot];
    PropertiesService.getScriptProperties().setProperty(ROSTER_PROPERTY_KEY, JSON.stringify(roster));
    return { ok: true, roster: roster };
  });
}

/** The saved choice, or null while nothing has been chosen (the displays then use their built-in defaults). */
function readRoster_() {
  var raw = PropertiesService.getScriptProperties().getProperty(ROSTER_PROPERTY_KEY);
  if (!raw) return null;
  try {
    var roster = JSON.parse(raw);
    return roster && typeof roster === 'object' && !Array.isArray(roster) ? roster : null;
  } catch (err) {
    return null;
  }
}

/** type -> args validator (returns the cleaned args, or null when they are unacceptable). */
var COMMAND_ARGS_ = {
  hit: function (a) {
    var rop = validateRop_(a.rop);
    var amount = a.amount === undefined ? 50000 : validateAmount_(a.amount);
    return rop && amount !== null ? { rop: rop, amount: amount } : null;
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

/** A "Sales" row with nothing in Date, Amount and ROP (other columns are ignored). */
function isBlankSale_(row, cols) {
  return String(row[cols.date]).trim() === '' && String(row[cols.amount]).trim() === '' && String(row[cols.rop]).trim() === '';
}

/** 'yyyy-MM-dd', plus ' HH:mm' unless it is exactly midnight (the sheet's own rows carry a date only). */
function formatSaleDate_(date, tz) {
  var time = Utilities.formatDate(date, tz, 'HH:mm');
  return Utilities.formatDate(date, tz, 'yyyy-MM-dd') + (time === '00:00' ? '' : ' ' + time);
}

function badRequest_(field) {
  return { ok: false, error: 'bad_request', field: field };
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

    var amount = Number(row[amountCol]) || 0;
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

function lockRemainingSec_() {
  var until = Number(CacheService.getScriptCache().get('pin_lock_until')) || 0;
  return until > Date.now() ? Math.ceil((until - Date.now()) / 1000) : 0;
}

function recordPinFailure_() {
  var cache = CacheService.getScriptCache();
  var fails = (Number(cache.get('pin_fails')) || 0) + 1;
  if (fails >= MAX_PIN_FAILURES) {
    cache.put('pin_lock_until', String(Date.now() + PIN_LOCK_SEC * 1000), PIN_LOCK_SEC + 60);
    cache.remove('pin_fails');
  } else {
    cache.put('pin_fails', String(fails), PIN_FAILURE_WINDOW_SEC);
  }
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
