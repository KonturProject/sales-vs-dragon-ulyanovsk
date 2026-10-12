/**
 * Runs the real apps-script/Code.gs in Node against in-memory stand-ins for the Google services it
 * uses (SpreadsheetApp, PropertiesService, CacheService, LockService, Utilities, ContentService),
 * so the backend logic can be tested — and served locally (game/tools/mock-backend.mjs) — without
 * touching the live spreadsheet or deploying anything.
 *
 * Only what Code.gs needs is imitated. Time zone: the sheet is "Europe/Moscow" (UTC+3, no DST),
 * like the real one.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CODE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'Code.gs');
const MOSCOW_OFFSET_MS = 3 * 3600 * 1000;

function pad(n, width = 2) {
    return String(n).padStart(width, '0');
}

/** Google's Utilities.formatDate for the few patterns Code.gs uses; always Moscow time. */
function formatDate(date, _tz, pattern) {
    const d = new Date(date.getTime() + MOSCOW_OFFSET_MS);
    return pattern.replace(/'([^']*)'|yyyy|MM|dd|HH|mm|ss|u/g, (token, literal) => {
        if (literal !== undefined) return literal;
        switch (token) {
            case 'yyyy': return pad(d.getUTCFullYear(), 4);
            case 'MM': return pad(d.getUTCMonth() + 1);
            case 'dd': return pad(d.getUTCDate());
            case 'HH': return pad(d.getUTCHours());
            case 'mm': return pad(d.getUTCMinutes());
            case 'ss': return pad(d.getUTCSeconds());
            case 'u': return String(d.getUTCDay() === 0 ? 7 : d.getUTCDay());
            default: return token;
        }
    });
}

class FakeSheet {
    constructor(rows, { maxRows = 1000, maxColumns = 26 } = {}) {
        this.rows = rows;
        this.maxRows = maxRows;
        this.maxColumns = maxColumns;
        /** How many times a range was written with setValues (the import must do it in one go). */
        this.setValuesCalls = 0;
    }
    /** Like Sheets: the last row/column holding a non-empty value (an empty string is no value). */
    getLastRow() {
        for (let r = this.rows.length - 1; r >= 0; r--) if (this.rows[r].some(v => v !== '' && v !== undefined)) return r + 1;
        return 0;
    }
    getLastColumn() {
        let last = 0;
        for (const r of this.rows) r.forEach((v, c) => { if (v !== '' && v !== undefined) last = Math.max(last, c + 1); });
        return last;
    }
    getMaxRows() { return this.maxRows; }
    getMaxColumns() { return this.maxColumns; }
    insertRowsAfter(_after, count) { this.maxRows += count; }
    insertColumnsAfter(_after, count) { this.maxColumns += count; }
    getDataRange() {
        const width = this.getLastColumn();
        return { getValues: () => this.rows.slice(0, this.getLastRow()).map(r => Array.from({ length: width }, (_, c) => r[c] ?? '')) };
    }
    getRange(row, col, numRows = 1, numCols = 1) {
        const sheet = this;
        if (row + numRows - 1 > sheet.maxRows || col + numCols - 1 > sheet.maxColumns) {
            throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
        }
        const put = (r, c, value) => {
            while (sheet.rows.length < r) sheet.rows.push([]);
            sheet.rows[r - 1][c - 1] = value;
        };
        return {
            getValues: () => {
                const out = [];
                for (let r = 0; r < numRows; r++) {
                    const line = [];
                    for (let c = 0; c < numCols; c++) line.push((sheet.rows[row - 1 + r] || [])[col - 1 + c] ?? '');
                    out.push(line);
                }
                return out;
            },
            setValue: (value) => put(row, col, value),
            setValues: (values) => {
                if (values.length !== numRows || values.some(line => line.length !== numCols)) throw new Error('The number of rows or columns in the data does not match the range.');
                sheet.setValuesCalls++;
                values.forEach((line, r) => line.forEach((value, c) => put(row + r, col + c, value)));
            },
            setFontWeight() {},
            setNumberFormat() {},
        };
    }
    appendRow(values) {
        this.rows.push(values.slice());
    }
}

/**
 * @param {object} [options]
 * @param {number} [options.startAt]  fake "now" (ms); defaults to a Wednesday in a fixed week
 * @param {boolean} [options.realClock]  follow the real clock instead (for the local mock server)
 * @param {string} [options.legacyPin]  plain PIN as the live deployment stores it today
 */
export function loadBackend({ startAt = Date.parse('2026-09-23T10:00:00+03:00'), realClock = false, legacyPin = '1234' } = {}) {
    const clock = { offset: 0, fixed: startAt };
    const now = () => (realClock ? Date.now() + clock.offset : clock.fixed + clock.offset);

    // Date that follows the fake clock and reads zone-less ISO strings as Moscow time (as Apps Script does).
    const RealDate = Date;
    class FakeDate extends RealDate {
        constructor(...args) {
            if (args.length === 0) super(now());
            else if (typeof args[0] === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(args[0])) super(RealDate.parse(args[0] + '+03:00'));
            else super(...args);
        }
        static now() { return now(); }
    }

    const nowDate = (offsetMs) => new FakeDate(now() + offsetMs);
    const day = 86400000;
    const state = {
        // Laid out like the real sheet: Date | Amount | ROP, then names in D and — reaching further down than the
        // sales — the list of departments that feeds the ROP drop-down in column F.
        sales: new FakeSheet([
            ['Date', 'Amount', 'ROP', '', '', ''],
            [nowDate(-2 * day), 400000, 'ВШ1', 'Андреева Татьяна', '', 'ВШ1'],
            [nowDate(-1 * day), 250000, 'ВШ2', 'Татиевская Нина', '', 'ВШ2'],
            [nowDate(-3600000), 120000, 'ВШ1', '', '', 'ВШ3'],
            ['', '', '', '', '', 'ВШ5'],
            ['', '', '', '', '', 'ВШ6'],
            ['', '', '', '', '', 'ВШ9'],
        ]),
        settings: new FakeSheet([['Key', 'Value'], ['WeeklyPlan', 5000000], ['TotalMeters', 300]]),
    };

    const sheetNames = { Sales: state.sales, Settings: state.settings };
    const props = new Map();
    if (legacyPin !== null) props.set('ADMIN_PIN', legacyPin);
    props.set('SPREADSHEET_ID', 'fake-spreadsheet-id'); // what setupSpreadsheet_() stores on the real deployment
    const cacheStore = new Map();

    const sandbox = {
        console,
        Date: FakeDate,
        JSON, Math, Number, String, Array, Object, isFinite, isNaN, parseInt, parseFloat, RegExp, Error,
        Logger: { log() {} },
        SpreadsheetApp: {
            openById: () => ({
                getSheetByName: (name) => sheetNames[name] ?? null,
                getSpreadsheetTimeZone: () => 'Europe/Moscow',
            }),
        },
        PropertiesService: {
            getScriptProperties: () => ({
                getProperty: (k) => (props.has(k) ? props.get(k) : null),
                setProperty: (k, v) => { props.set(k, String(v)); },
                deleteProperty: (k) => { props.delete(k); },
            }),
        },
        CacheService: {
            getScriptCache: () => ({
                get: (k) => {
                    const hit = cacheStore.get(k);
                    if (!hit || hit.expires <= now()) { cacheStore.delete(k); return null; }
                    return hit.value;
                },
                put: (k, v, ttlSec = 600) => { cacheStore.set(k, { value: String(v), expires: now() + ttlSec * 1000 }); },
                remove: (k) => { cacheStore.delete(k); },
            }),
        },
        LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
        ContentService: {
            MimeType: { JSON: 'application/json' },
            createTextOutput: (text) => ({ setMimeType() { return this; }, getContent: () => text }),
        },
        Utilities: {
            DigestAlgorithm: { SHA_256: 'SHA_256' },
            Charset: { UTF_8: 'UTF_8' },
            computeDigest: (_alg, input) => Array.from(crypto.createHash('sha256').update(String(input), 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
            getUuid: () => crypto.randomUUID(),
            formatDate,
            parseDate: (text, _tz, pattern) => {
                if (pattern !== "yyyy-MM-dd'T'HH:mm") throw new Error('parseDate: unsupported pattern ' + pattern);
                const ms = RealDate.parse(text + ':00+03:00');
                if (Number.isNaN(ms)) throw new Error('Unparseable date: ' + text);
                return new FakeDate(ms);
            },
        },
    };

    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(CODE_PATH, 'utf8'), sandbox, { filename: 'Code.gs' });

    return {
        /** Public GET. */
        get: () => JSON.parse(sandbox.doGet({ parameter: {} }).getContent()),
        /** Admin/legacy POST with a JSON body (like the admin page sends it as text/plain). */
        post: (body) => JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(body) } }).getContent()),
        /** Raw POST body, for malformed-request tests. */
        postRaw: (contents) => JSON.parse(sandbox.doPost({ postData: { contents } }).getContent()),
        /** Call a top-level function of Code.gs (e.g. setAdminPin_). */
        run: (name) => sandbox[name](),
        /** Move the fake clock forward. */
        advance: (ms) => { clock.offset += ms; },
        now,
        props,
        /** Make a sheet "disappear" (to test failures on the server side). */
        renameSheet: (from, to) => { sheetNames[to] = sheetNames[from]; delete sheetNames[from]; },
        salesRows: () => state.sales.rows,
        salesSheet: () => state.sales,
        settingsRows: () => state.settings.rows,
        /** A Date the sheet would hold for a day in Moscow time ('2026-09-21' -> its midnight; with 'T10:00' a time). */
        day: (text) => new FakeDate(RealDate.parse((text.length === 10 ? text + 'T00:00' : text) + ':00+03:00')),
    };
}
