import ropMapping from '../src/game/config/ropMapping.json';
import characterList from '../src/game/config/characters.json';
import defaultRoster from '../src/game/config/heroRoster.json';
import { GROUP_SLOTS, plateText, sanitiseLeaders, shortPersonName } from '../src/game/systems/Groups';
import { BackendError, callBackend, fetchPublicStatus, newRequestId } from './api';
import { ParsedPayments, PaymentsFileError, parsePaymentsFile } from './paymentsFile';

interface Character { id: string; name: string }
const CHARACTERS = characterList.characters as Character[];
const characterName = (id: string) => CHARACTERS.find(c => c.id === id)?.name ?? id;
const portrait = (id: string) => `assets/sprites/chars/${id}.png`;

/** Which character stands in which slot right now (as the displays show it); refreshed whenever a status is read. */
let roster: Record<string, string> = { ...(defaultRoster.selection as Record<string, string>) };
/** The group leaders on the nameplates (slot -> «Фамилия И.»), as the displays show them. */
let leaders: Record<string, string> = sanitiseLeaders(null);

/** The six departments (short sheet codes, in stage order) and the lead's slot. */
const LABELS = ropMapping.labels as Record<string, string>;
const DEPARTMENTS = Object.entries(LABELS).map(([slug, rop]) => ({
    rop,
    slug,
    /** «ВШ1 • Измайлова И.» — like the nameplate on the stage. */
    get plate() { return plateText(slug, leaders); },
    get label() { return `${plateText(slug, leaders)} · ${characterName(roster[slug])}`; },
}));
const LEAD = 'lead';

/** What the backend accepts as a leader's name (apps-script/Code.gs, setRoster). */
const LEADER_NAME = /^[A-Za-zА-Яа-яЁё .'-]{0,40}$/;

interface Sale { row: number; date: string; amount: number; rop: string; invoice?: string }
interface Status { plan: number; totalThisWeek: number; weekStart: string; weekEnd: string; byRop: { ropName: string; amount: number }[] }
interface ListSalesResponse { totalRows: number; shown: number; sales: Sale[]; status: Status }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const pinForm = $<HTMLFormElement>('pin-form');
const pinInput = $<HTMLInputElement>('pin');
const panel = $<HTMLDivElement>('panel');
const statusEl = $<HTMLParagraphElement>('status');

/** Kept in memory only for this page's lifetime — never stored, never in a URL. */
let pin = '';
let tableStale = true;

const money = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;

function setStatus(text: string, kind: 'ok' | 'error' | '' = '') {
    statusEl.textContent = text;
    statusEl.className = kind;
}

function showLogin(message = '') {
    pin = '';
    pinInput.value = '';
    panel.hidden = true;
    pinForm.hidden = false;
    setStatus(message, message ? 'error' : '');
}

const FIELD_NAMES: Record<string, string> = {
    plan: 'план', rop: 'отдел', amount: 'сумма', date: 'дата', newPin: 'новый PIN', newPin_same: 'новый PIN совпадает со старым',
    roster: 'список героев', leaders: 'имена РГ',
    period: 'даты оплат в файле (не старше ~года и не в будущем)', rows: 'строки файла',
    type: 'тип команды', args: 'параметры команды',
};

/** One place that turns a failed backend call into a message (and sends the user back to the PIN form when the PIN is the problem). */
function reportError(err: unknown) {
    if (!(err instanceof BackendError)) {
        console.error(err);
        setStatus('Что-то пошло не так. Подробности в консоли браузера.', 'error');
        return;
    }
    switch (err.code) {
        case 'invalid_pin':
            showLogin('Неверный PIN. Введите его снова.');
            break;
        case 'locked': {
            const minutes = Math.max(1, Math.ceil((err.detail?.retryAfterSec ?? 600) / 60));
            showLogin(`Слишком много неверных попыток. Подождите примерно ${minutes} мин.`);
            break;
        }
        case 'network':
            setStatus('Не удалось связаться с сервером. Проверьте соединение.', 'error');
            break;
        case 'demo':
            setStatus('Демо-режим (config.json.useMock=true): бэкенд отключён.', 'error');
            break;
        case 'bad_request': {
            const where = err.detail?.row !== undefined ? ` (запись №${err.detail.row + 1})` : '';
            setStatus(`Проверьте поле: ${FIELD_NAMES[err.detail?.field ?? ''] ?? err.detail?.field ?? 'данные'}${where}.`, 'error');
            break;
        }
        default:
            setStatus(`Ошибка: ${err.code}`, 'error');
    }
}

/* ----------------------------------------------------------------- login */

pinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setStatus('Проверяю…');
    const typed = pinInput.value;
    try {
        await callBackend('login', typed);
    } catch (err) {
        reportError(err);
        return;
    }
    pin = typed;
    pinInput.value = '';
    pinForm.hidden = true;
    panel.hidden = false;
    setStatus('');
    tableStale = true;
    loadPlanTab();
});

$('logout').addEventListener('click', () => showLogin());

/* ------------------------------------------------------------------ tabs */

const tabButtons = [...document.querySelectorAll<HTMLButtonElement>('.tab-btn')];
const tabPanels = [...document.querySelectorAll<HTMLElement>('[data-tab-panel]')];

function openTab(name: string) {
    tabButtons.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    tabPanels.forEach(p => { p.hidden = p.dataset.tabPanel !== name; });
    setStatus('');
    if (name === 'plan') loadPlanTab();
    if (name === 'table' && tableStale) loadTable();
    if (name === 'heroes') loadHeroesTab();
}

tabButtons.forEach(b => b.addEventListener('click', () => openTab(b.dataset.tab!)));

/* ------------------------------------------------------------------ plan */

const planForm = $<HTMLFormElement>('plan-form');
const planInput = $<HTMLInputElement>('plan');
const currentStatusEl = $<HTMLParagraphElement>('current-status');

// Public read (no PIN): shows the real numbers so the plan is not edited blind.
async function loadPlanTab() {
    const status = await fetchPublicStatus();
    if (!status) return;
    planInput.value = String(status.plan);
    currentStatusEl.textContent = `Сейчас: ${money(status.totalThisWeek)} / ${money(status.plan)}`;
    currentStatusEl.hidden = false;
}

planForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setStatus('Сохраняю…');
    try {
        const res = await callBackend<{ plan: number }>('setPlan', pin, { plan: Number(planInput.value) });
        setStatus(`План обновлён: ${money(res.plan)}`, 'ok');
        tableStale = true;
        loadPlanTab();
    } catch (err) {
        reportError(err);
    }
});

/* ----------------------------------------------------------------- table */

const tableBody = document.querySelector<HTMLTableSectionElement>('#sales-table tbody')!;
const tableSummary = $<HTMLDivElement>('table-summary');
const tableMeta = $<HTMLSpanElement>('table-meta');

function chip(label: string, value: string) {
    const el = document.createElement('div');
    el.className = 'chip';
    const l = document.createElement('span');
    l.textContent = label;
    const v = document.createElement('strong');
    v.textContent = value;
    el.append(l, v);
    return el;
}

async function loadTable() {
    setStatus('Читаю таблицу…');
    try {
        const res = await callBackend<ListSalesResponse>('listSales', pin, { limit: 50 });
        const s = res.status;
        const percent = s.plan > 0 ? Math.round((s.totalThisWeek / s.plan) * 100) : 0;

        tableSummary.replaceChildren(
            chip('Неделя', `${s.weekStart} — ${s.weekEnd}`),
            chip('План', money(s.plan)),
            chip('Набрано', `${money(s.totalThisWeek)} (${percent}%)`),
            ...s.byRop.map(r => chip(r.ropName, money(r.amount))),
        );

        tableBody.replaceChildren(...res.sales.map(sale => {
            const tr = document.createElement('tr');
            const cells = [String(sale.row), sale.date, sale.rop, Math.round(sale.amount).toLocaleString('ru-RU'), sale.invoice ?? ''];
            cells.forEach((text, i) => {
                const td = document.createElement('td');
                td.textContent = text; // textContent, never innerHTML: these are sheet cells
                if (i === 3) td.className = 'num';
                tr.append(td);
            });
            return tr;
        }));

        tableMeta.textContent = `Показано ${res.shown} из ${res.totalRows} строк (новые сверху)`;
        tableStale = false;
        setStatus('');
    } catch (err) {
        reportError(err);
    }
}

$('table-refresh').addEventListener('click', loadTable);

/* ------------------------------------------------------------- add sale */

const addForm = $<HTMLFormElement>('add-form');
const addRop = $<HTMLSelectElement>('add-rop');
const addAmount = $<HTMLInputElement>('add-amount');
const addDate = $<HTMLInputElement>('add-date');


addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const amount = Number(addAmount.value);
    if (!(amount > 0)) {
        setStatus('Введите сумму больше нуля.', 'error');
        return;
    }
    const when = addDate.value ? addDate.value.replace('T', ' ') : 'сейчас';
    const group = DEPARTMENTS.find(d => d.rop === addRop.value)?.plate ?? addRop.value;
    if (!confirm(`Внести в таблицу оплату ${money(amount)} для ${group} (${when})?\n\nЭто настоящая запись: итоги недели изменятся.`)) return;

    setStatus('Записываю…');
    const submit = addForm.querySelector('button')!;
    submit.disabled = true;
    try {
        const res = await callBackend<{ added: { date: string; amount: number; rop: string } }>('addSale', pin, {
            rop: addRop.value,
            amount,
            date: addDate.value || undefined,
            requestId: newRequestId(),
        });
        setStatus(`Записано: ${res.added.rop} — ${money(res.added.amount)} (${res.added.date})`, 'ok');
        addAmount.value = '';
        addDate.value = '';
        tableStale = true;
    } catch (err) {
        reportError(err);
    } finally {
        submit.disabled = false;
    }
});

/* ------------------------------------------------------------ animations */

const animAmount = $<HTMLInputElement>('anim-amount');
const animHero = $<HTMLSelectElement>('anim-hero');
const animHits = $<HTMLDivElement>('anim-hits');

/** The hit buttons, the "who falls" list and the payment form name the heroes currently on stage, so they are rebuilt when the roster is known/changes. */
function buildAnimationControls() {
    animHero.replaceChildren(new Option('Случайный', 'random'));
    for (const dep of DEPARTMENTS) animHero.add(new Option(dep.label, dep.slug));
    animHits.replaceChildren(...DEPARTMENTS.map(dep => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'anim-btn';
        button.textContent = dep.label;
        button.dataset.cmd = 'hit';
        button.dataset.rop = dep.rop;
        return button;
    }));
    const chosen = addRop.value;
    addRop.replaceChildren(...DEPARTMENTS.map(dep => new Option(dep.plate, dep.rop)));
    if (chosen) addRop.value = chosen;
}

function commandArgs(button: HTMLButtonElement): Record<string, unknown> {
    switch (button.dataset.cmd) {
        case 'hit': return { rop: button.dataset.rop, amount: Number(animAmount.value) || 50000 };
        case 'fall': return { hero: animHero.value, mode: button.dataset.mode };
        default: return {};
    }
}

async function sendCommand(button: HTMLButtonElement) {
    button.disabled = true;
    setStatus('Отправляю…');
    try {
        await callBackend('command', pin, {
            type: button.dataset.cmd,
            args: commandArgs(button),
            requestId: newRequestId(),
        });
        setStatus(`Отправлено: «${button.textContent}». Экраны покажут в течение ~15 секунд.`, 'ok');
    } catch (err) {
        reportError(err);
    } finally {
        // A short pause stops an accidental double click from queueing the animation twice.
        setTimeout(() => { button.disabled = false; }, 1200);
    }
}

document.querySelector('[data-tab-panel="anim"]')!.addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-cmd]');
    if (button) sendCommand(button);
});

/* ----------------------------------------------------------- change PIN */

const pinChangeForm = $<HTMLFormElement>('pin-change-form');
const pinOld = $<HTMLInputElement>('pin-old');
const pinNew = $<HTMLInputElement>('pin-new');
const pinNew2 = $<HTMLInputElement>('pin-new2');

pinChangeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!/^[0-9]{4,12}$/.test(pinNew.value)) {
        setStatus('Новый PIN — от 4 до 12 цифр.', 'error');
        return;
    }
    if (pinNew.value !== pinNew2.value) {
        setStatus('Новый PIN и повтор не совпадают.', 'error');
        return;
    }
    setStatus('Меняю PIN…');
    try {
        await callBackend('changePin', pinOld.value, { newPin: pinNew.value });
        pin = pinNew.value;
        [pinOld, pinNew, pinNew2].forEach(input => { input.value = ''; });
        setStatus('PIN изменён. Прежний больше не действует.', 'ok');
    } catch (err) {
        // A mistyped *current* PIN here is a typo in this form, not a reason to throw the user back to the login screen.
        if (err instanceof BackendError && err.code === 'invalid_pin') setStatus('Текущий PIN указан неверно.', 'error');
        else reportError(err);
    }
});

/* ---------------------------------------------------------------- heroes */

const rosterRows = $<HTMLDivElement>('roster-rows');
const rosterGallery = $<HTMLDivElement>('roster-gallery');
const rosterSave = $<HTMLButtonElement>('roster-save');
const SLOTS = [...DEPARTMENTS.map(d => ({ slug: d.slug, name: d.rop })), { slug: LEAD, name: 'Лидер филиала' }];

let activeSlot = SLOTS[0].slug;
/** What the form currently shows (may differ from `roster` / `leaders` until saved). */
let draft: Record<string, string> = { ...roster };
let draftLeaders: Record<string, string> = { ...leaders };

function renderHeroes() {
    rosterRows.replaceChildren(...SLOTS.map(slot => {
        const row = document.createElement('div');
        row.className = 'roster-row' + (slot.slug === activeSlot ? ' active' : '');
        const name = document.createElement('span');
        name.className = 'slot-name';
        name.textContent = slot.name;
        const select = document.createElement('select');
        select.setAttribute('aria-label', `Герой: ${slot.name}`);
        for (const c of CHARACTERS) select.add(new Option(c.name, c.id));
        select.value = draft[slot.slug];
        select.addEventListener('change', () => { draft[slot.slug] = select.value; activeSlot = slot.slug; renderHeroes(); });

        // The group leader on the nameplate (the branch lead has no plate).
        let leader: HTMLElement = document.createElement('span');
        if (GROUP_SLOTS.includes(slot.slug)) {
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'leader-input';
            input.placeholder = 'РГ: Фамилия И.';
            input.maxLength = 60;
            input.setAttribute('aria-label', `РГ группы ${slot.name}`);
            input.value = draftLeaders[slot.slug] ?? '';
            // A pasted full name («Измайлова Ильвира Дамировна») becomes «Измайлова И.» as soon as the field is left.
            input.addEventListener('change', () => {
                input.value = shortPersonName(input.value);
                draftLeaders[slot.slug] = input.value;
            });
            input.addEventListener('focus', () => { activeSlot = slot.slug; rosterRows.querySelectorAll('.roster-row').forEach(r => r.classList.toggle('active', r === row)); });
            leader = input;
        }

        const img = document.createElement('img');
        img.src = portrait(draft[slot.slug]);
        img.alt = characterName(draft[slot.slug]);
        row.append(name, select, leader, img);
        row.addEventListener('click', (e) => {
            const tag = (e.target as HTMLElement).tagName;
            if (tag === 'SELECT' || tag === 'INPUT') return;
            if (activeSlot !== slot.slug) { activeSlot = slot.slug; renderHeroes(); }
        });
        return row;
    }));

    const inUse = new Set(Object.values(draft));
    rosterGallery.replaceChildren(...CHARACTERS.map(c => {
        const card = document.createElement('button');
        card.type = 'button';
        if (inUse.has(c.id)) card.className = 'chosen';
        const img = document.createElement('img');
        img.src = portrait(c.id);
        img.alt = c.name;
        img.loading = 'lazy';
        const label = document.createElement('span');
        label.textContent = c.name;
        card.append(img, label);
        card.addEventListener('click', () => { draft[activeSlot] = c.id; renderHeroes(); });
        return card;
    }));
}

/** Takes the stage setup from a status / save answer (null parts = the built-in defaults are in force). */
function adoptStageSetup(next: { roster?: Record<string, string> | null; leaders?: Record<string, string> | null }) {
    if (next.roster) roster = { ...roster, ...next.roster };
    if (next.leaders) leaders = sanitiseLeaders(next.leaders);
    draft = { ...roster };
    draftLeaders = { ...leaders };
    buildAnimationControls();
    renderHeroes();
}

/** Reads what the displays show now (public status), so the form starts from the truth. */
async function loadHeroesTab() {
    const status = await fetchPublicStatus();
    if (status) adoptStageSetup(status);
    else renderHeroes();
}

rosterSave.addEventListener('click', async () => {
    const names: Record<string, string> = {};
    for (const slot of GROUP_SLOTS) names[slot] = shortPersonName(draftLeaders[slot] ?? '');
    const bad = GROUP_SLOTS.find(slot => !LEADER_NAME.test(names[slot]));
    if (bad) {
        setStatus(`РГ группы ${LABELS[bad]}: только буквы, пробел, точка, дефис — до 40 знаков.`, 'error');
        return;
    }
    setStatus('Сохраняю героев и РГ…');
    rosterSave.disabled = true;
    try {
        const res = await callBackend<{ roster: Record<string, string> | null; leaders: Record<string, string> | null }>('setRoster', pin, { roster: draft, leaders: names });
        adoptStageSetup(res);
        setStatus('Сохранено. Экраны заменят героев и таблички в течение ~15 секунд.', 'ok');
    } catch (err) {
        reportError(err);
    } finally {
        rosterSave.disabled = false;
    }
});

/* ---------------------------------------------------------------- import */

const importFile = $<HTMLInputElement>('import-file');
const importFileName = $<HTMLSpanElement>('import-file-name');
const importPreview = $<HTMLDivElement>('import-preview');
const importSummary = $<HTMLDivElement>('import-summary');
const importBody = document.querySelector<HTMLTableSectionElement>('#import-table tbody')!;
const importFoot = document.querySelector<HTMLTableSectionElement>('#import-table tfoot')!;
const importNotes = $<HTMLUListElement>('import-notes');
const importRun = $<HTMLButtonElement>('import-run');

interface PeriodNow { rows: number; amount: number; manualRows: number; manualAmount: number; byRop: Record<string, number> }

/** The file read and checked against the sheet, waiting for «Загрузить». */
let pendingImport: { file: ParsedPayments; now: PeriodNow } | null = null;

const ruDate = (day: string) => day.split('-').reverse().join('.');
/** «1 строка», «3 строки», «5 строк». */
function plural(n: number, one: string, few: string, many: string) {
    const word = n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many;
    return `${n} ${word}`;
}
const lines = (n: number) => plural(n, 'строка', 'строки', 'строк');
const records = (n: number) => plural(n, 'запись', 'записи', 'записей');
const invoices = (n: number) => plural(n, 'счёт', 'счёта', 'счетов');

function resetImport() {
    pendingImport = null;
    importPreview.hidden = true;
    importFile.value = '';
    importFileName.textContent = 'файл не выбран';
}

function cell(text: string, className = '') {
    const td = document.createElement('td');
    td.textContent = text;
    if (className) td.className = className;
    return td;
}

function renderImportPreview(file: ParsedPayments, now: PeriodNow) {
    const period = file.from === file.to ? ruDate(file.from) : `${ruDate(file.from)} — ${ruDate(file.to)}`;
    const after = file.rows.reduce((sum, r) => sum + r.amount, 0);
    importSummary.replaceChildren(
        chip('Период файла', period),
        chip('Счетов наших групп', String(file.rows.length)),
        chip('Станет за период', money(after)),
    );

    importBody.replaceChildren(...DEPARTMENTS.map(dep => {
        const mine = file.rows.filter(r => r.rop === dep.rop);
        const sum = mine.reduce((s, r) => s + r.amount, 0);
        const before = now.byRop[dep.rop] ?? 0;
        const tr = document.createElement('tr');
        // Less than the sheet holds now: payments would disappear (cancelled — or the export missed this group).
        if (sum < before - 0.5) tr.className = 'drop';
        tr.append(cell(dep.plate), cell(String(mine.length), 'num'), cell(money(before), 'num'), cell(money(sum), 'num'));
        return tr;
    }));
    const total = document.createElement('tr');
    total.append(cell('Итого'), cell(String(file.rows.length), 'num'), cell(money(now.amount), 'num'), cell(money(after), 'num'));
    importFoot.replaceChildren(total);

    const notes: { text: string; warn?: boolean }[] = [];
    notes.push({ text: `Все записи таблицы за ${period} (${records(now.rows)} на ${money(now.amount)}) заменятся счетами из файла.` });
    if (now.manualRows > 0) {
        notes.push({ text: `Из них внесены вручную: ${records(now.manualRows)} на ${money(now.manualAmount)} — они тоже заменятся. Если эти оплаты есть в выгрузке, двойного учёта не будет.` });
    }
    if (file.fileTotal !== null) {
        if (Math.abs(file.fileTotal - file.linesTotal) < 0.5) notes.push({ text: `Сумма строк файла совпадает с его итогом «Сумма заказа»: ${money(file.fileTotal)}.` });
        else notes.push({ text: `Сумма строк файла (${money(file.linesTotal)}) не совпадает с его итогом «Сумма заказа» (${money(file.fileTotal)}) — проверьте файл.`, warn: true });
    }
    for (const dep of DEPARTMENTS) {
        const before = now.byRop[dep.rop] ?? 0;
        if (before > 0 && !file.rows.some(r => r.rop === dep.rop)) {
            notes.push({ text: `В файле нет оплат группы ${dep.plate}: её ${money(before)} за период пропадут. Если выгрузка не по всем группам, не загружайте её.`, warn: true });
        }
    }
    if (file.foreign.length > 0) {
        const list = file.foreign.slice(0, 4).map(f => `«${f.group}» — ${lines(f.lines)} на ${money(f.amount)}`).join('; ');
        const more = file.foreign.length > 4 ? ` и ещё ${file.foreign.length - 4}` : '';
        notes.push({ text: `Не наши группы — не загружаются: ${list}${more}.`, warn: file.rows.length === 0 });
    }
    if (file.unreadable > 0) notes.push({ text: `Пропущено ${lines(file.unreadable)} без даты оплаты, группы или суммы.`, warn: true });
    if (file.rows.length === 0) notes.push({ text: 'В файле нет оплат групп ВШ — загружать нечего. Та ли это выгрузка?', warn: true });

    importNotes.replaceChildren(...notes.map(n => {
        const li = document.createElement('li');
        li.textContent = n.text;
        if (n.warn) li.className = 'warn';
        return li;
    }));
    importRun.disabled = file.rows.length === 0;
    importPreview.hidden = false;
}

importFile.addEventListener('change', async () => {
    const chosen = importFile.files?.[0];
    pendingImport = null;
    importPreview.hidden = true;
    if (!chosen) return;
    importFileName.textContent = chosen.name;

    setStatus('Читаю файл…');
    let file: ParsedPayments;
    try {
        file = await parsePaymentsFile(chosen);
    } catch (err) {
        if (!(err instanceof PaymentsFileError)) console.error(err);
        setStatus(err instanceof PaymentsFileError ? err.message : 'Не получилось прочитать файл. Подробности в консоли браузера.', 'error');
        return;
    }

    // A dry run: the backend checks every row and says what the sheet holds for the period now.
    setStatus('Сверяю с таблицей…');
    try {
        const res = await callBackend<{ current: PeriodNow }>('importSales', pin, { from: file.from, to: file.to, rows: file.rows, dryRun: true });
        pendingImport = { file, now: res.current };
        renderImportPreview(file, res.current);
        setStatus('');
    } catch (err) {
        reportError(err);
    }
});

importRun.addEventListener('click', async () => {
    if (!pendingImport) return;
    const { file, now } = pendingImport;
    const period = file.from === file.to ? ruDate(file.from) : `${ruDate(file.from)} — ${ruDate(file.to)}`;
    const after = file.rows.reduce((sum, r) => sum + r.amount, 0);
    if (!confirm(`Заменить оплаты за ${period}?\n\nСейчас в таблице: ${records(now.rows)} на ${money(now.amount)}.\nСтанет: ${invoices(file.rows.length)} на ${money(after)}.\n\nЭто настоящая запись: итоги недели изменятся, на экранах ударят герои.`)) return;

    setStatus('Загружаю в таблицу…');
    importRun.disabled = true;
    try {
        const res = await callBackend<{ removed: { rows: number }; added: { rows: number; amount: number } }>('importSales', pin, {
            from: file.from, to: file.to, rows: file.rows, requestId: newRequestId(),
        });
        resetImport();
        tableStale = true;
        setStatus(`Загружено: ${invoices(res.added.rows)} на ${money(res.added.amount)}, заменено: ${records(res.removed.rows)}. Если суммы этой недели выросли, герои ударят по очереди в течение ~15 секунд.`, 'ok');
    } catch (err) {
        reportError(err);
    } finally {
        importRun.disabled = false;
    }
});

buildAnimationControls();
renderHeroes();
// The saved roster and names may differ from the defaults: pick them up in the background so the buttons carry the right names.
fetchPublicStatus().then(status => { if (status) adoptStageSetup(status); });
