import ropMapping from '../src/game/config/ropMapping.json';
import characterList from '../src/game/config/characters.json';
import defaultRoster from '../src/game/config/heroRoster.json';
import { BackendError, callBackend, fetchPublicStatus, newRequestId } from './api';

interface Character { id: string; name: string }
const CHARACTERS = characterList.characters as Character[];
const characterName = (id: string) => CHARACTERS.find(c => c.id === id)?.name ?? id;
const portrait = (id: string) => `assets/sprites/chars/${id}.png`;

/** Which character stands in which slot right now (as the displays show it); refreshed whenever a status is read. */
let roster: Record<string, string> = { ...(defaultRoster.selection as Record<string, string>) };

/** The six departments (short sheet codes, in stage order) and the lead's slot. */
const LABELS = ropMapping.labels as Record<string, string>;
const DEPARTMENTS = Object.entries(LABELS).map(([slug, rop]) => ({
    rop,
    slug,
    get label() { return `${rop} · ${characterName(roster[slug])}`; },
}));
const LEAD = 'lead';

interface Sale { row: number; date: string; amount: number; rop: string }
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
    roster: 'список героев',
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
        case 'bad_request':
            setStatus(`Проверьте поле: ${FIELD_NAMES[err.detail?.field ?? ''] ?? err.detail?.field ?? 'данные'}.`, 'error');
            break;
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
            const cells = [String(sale.row), sale.date, sale.rop, Math.round(sale.amount).toLocaleString('ru-RU')];
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
    if (!confirm(`Внести в таблицу оплату ${money(amount)} для ${addRop.value} (${when})?\n\nЭто настоящая запись: итоги недели изменятся.`)) return;

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
    for (const dep of DEPARTMENTS) animHero.add(new Option(`${dep.rop} · ${characterName(roster[dep.slug])}`, dep.slug));
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
    addRop.replaceChildren(...DEPARTMENTS.map(dep => new Option(dep.label, dep.rop)));
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
/** What the form currently shows (may differ from `roster` until saved). */
let draft: Record<string, string> = { ...roster };

function renderHeroes() {
    rosterRows.replaceChildren(...SLOTS.map(slot => {
        const row = document.createElement('div');
        row.className = 'roster-row' + (slot.slug === activeSlot ? ' active' : '');
        const name = document.createElement('span');
        name.className = 'slot-name';
        name.textContent = slot.name;
        const select = document.createElement('select');
        for (const c of CHARACTERS) select.add(new Option(c.name, c.id));
        select.value = draft[slot.slug];
        select.addEventListener('change', () => { draft[slot.slug] = select.value; activeSlot = slot.slug; renderHeroes(); });
        const img = document.createElement('img');
        img.src = portrait(draft[slot.slug]);
        img.alt = characterName(draft[slot.slug]);
        row.append(name, select, img);
        row.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).tagName === 'SELECT') return;
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

/** Reads what the displays show now (public status), so the form starts from the truth. */
async function loadHeroesTab() {
    const status = await fetchPublicStatus();
    if (status?.roster) {
        roster = { ...roster, ...status.roster };
        draft = { ...roster };
        buildAnimationControls();
    }
    renderHeroes();
}

rosterSave.addEventListener('click', async () => {
    setStatus('Сохраняю героев…');
    rosterSave.disabled = true;
    try {
        const res = await callBackend<{ roster: Record<string, string> }>('setRoster', pin, { roster: draft });
        roster = { ...roster, ...res.roster };
        draft = { ...roster };
        buildAnimationControls();
        renderHeroes();
        setStatus('Герои сохранены. Экраны заменят их в течение ~15 секунд.', 'ok');
    } catch (err) {
        reportError(err);
    } finally {
        rosterSave.disabled = false;
    }
});

buildAnimationControls();
renderHeroes();
// The saved roster may differ from the defaults: pick it up in the background so the buttons carry the right names.
fetchPublicStatus().then(status => {
    if (status?.roster) { roster = { ...roster, ...status.roster }; draft = { ...roster }; buildAnimationControls(); renderHeroes(); }
});
