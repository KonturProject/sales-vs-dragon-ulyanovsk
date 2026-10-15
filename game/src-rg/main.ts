import { plateText, sanitiseLeaders } from '../src/game/systems/Groups';
import { BackendError, callAsGroup, newRequestId } from '../src-admin/api';

/**
 * The group leaders' page: one thing only — enter a payment of your own group. The PIN says which group it is
 * (apps-script/Code.gs, groupLogin / groupAddSale); the leader never picks a group, so cannot enter one for another.
 */

interface GroupView {
    group: { slot: string; code: string; leader: string | null };
    week: { start: string; today: string; total: number };
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const pinForm = $<HTMLFormElement>('pin-form');
const pinInput = $<HTMLInputElement>('pin');
const panel = $<HTMLDivElement>('panel');
const statusEl = $<HTMLParagraphElement>('status');
const title = $<HTMLHeadingElement>('title');
const weekEl = $<HTMLParagraphElement>('rg-week');
const saleForm = $<HTMLFormElement>('sale-form');
const amountInput = $<HTMLInputElement>('sale-amount');
const dateInput = $<HTMLInputElement>('sale-date');

/** Kept in memory only for this page's lifetime — never stored, never in a URL. */
let pin = '';
let view: GroupView | null = null;

const money = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;
const ruDate = (day: string) => day.split('-').reverse().join('.');

function setStatus(text: string, kind: 'ok' | 'error' | '' = '') {
    statusEl.textContent = text;
    statusEl.className = kind;
}

/** «ВШ1 • Измайлова И.» — the leader's name as edited in the admin page, or the built-in one. */
function groupName(v: GroupView): string {
    const leaders = sanitiseLeaders(v.group.leader !== null ? { [v.group.slot]: v.group.leader } : null);
    return plateText(v.group.slot, leaders);
}

function show(v: GroupView) {
    view = v;
    title.textContent = groupName(v);
    weekEl.textContent = `Группа за неделю с ${ruDate(v.week.start)}: ${money(v.week.total)}`;
    dateInput.min = v.week.start;
    dateInput.max = v.week.today;
}

function showLogin(message = '') {
    pin = '';
    view = null;
    pinInput.value = '';
    panel.hidden = true;
    pinForm.hidden = false;
    title.textContent = 'Оплаты группы';
    setStatus(message, message ? 'error' : '');
}

function reportError(err: unknown) {
    if (!(err instanceof BackendError)) {
        console.error(err);
        setStatus('Что-то пошло не так. Подробности в консоли браузера.', 'error');
        return;
    }
    switch (err.code) {
        case 'invalid_pin':
            showLogin('Неверный PIN. Введите его снова (если PIN недавно меняли — спросите новый у администратора).');
            break;
        case 'locked': {
            const minutes = Math.max(1, Math.ceil((err.detail?.retryAfterSec ?? 600) / 60));
            showLogin(`Слишком много неверных попыток. Подождите примерно ${minutes} мин.`);
            break;
        }
        case 'network':
            setStatus('Не удалось связаться с сервером. Проверьте соединение и попробуйте ещё раз.', 'error');
            break;
        case 'demo':
            setStatus('Демо-режим (config.json.useMock=true): сервер отключён.', 'error');
            break;
        case 'bad_request':
            setStatus(err.detail?.field === 'date'
                ? 'Дата — только текущая неделя и не позже сегодняшнего дня.'
                : 'Введите сумму больше нуля.', 'error');
            break;
        default:
            setStatus(`Ошибка: ${err.code}`, 'error');
    }
}

pinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setStatus('Проверяю…');
    const typed = pinInput.value.trim();
    try {
        const res = await callAsGroup<GroupView>('groupLogin', typed);
        pin = typed;
        pinInput.value = '';
        pinForm.hidden = true;
        panel.hidden = false;
        show(res);
        setStatus('');
        amountInput.focus();
    } catch (err) {
        reportError(err);
    }
});

saleForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!view) return;
    const amount = Number(amountInput.value);
    if (!(amount > 0)) {
        setStatus('Введите сумму больше нуля.', 'error');
        return;
    }
    // Today (or empty) = now, so the payment lands with the current time; an earlier day = that day.
    const day = dateInput.value && dateInput.value !== view.week.today ? dateInput.value : '';
    const when = day ? ruDate(day) : 'сейчас';
    if (!confirm(`Внести оплату ${money(amount)} для ${groupName(view)} (${when})?\n\nЭто настоящая запись: итоги недели изменятся, на экранах ударит герой группы.`)) return;

    setStatus('Записываю…');
    const submit = saleForm.querySelector('button')!;
    submit.disabled = true;
    try {
        const res = await callAsGroup<GroupView & { added: { date: string; amount: number } }>('groupAddSale', pin, {
            amount,
            date: day || undefined,
            requestId: newRequestId(),
        });
        show(res);
        amountInput.value = '';
        dateInput.value = '';
        setStatus(`Записано: ${money(res.added.amount)} (${res.added.date}). Герой группы ударит на экранах в течение ~15 секунд.`, 'ok');
    } catch (err) {
        reportError(err);
    } finally {
        submit.disabled = false;
    }
});

$('logout').addEventListener('click', () => showLogin());
