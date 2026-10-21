import { plateText, sanitiseLeaders } from '../src/game/systems/Groups';
import { paymentsText } from '../src/game/systems/Units';
import { BackendError, callAsGroup, newRequestId } from '../src-admin/api';
import { DayCounter, dayCaption, dayName, daysBetween, shortDay } from '../src-admin/dayCounter';

/**
 * The group leaders' page: one thing only — how many payments the leader's own group has on a day of this week.
 * The PIN says which group it is (apps-script/Code.gs, groupLogin / groupSetCount); the leader never picks a group,
 * so cannot touch another one. The game counts payments, not money: there is no amount here.
 */

interface GroupView {
    group: { slot: string; code: string; leader: string | null };
    week: { start: string; today: string; total: number; days: Record<string, number> };
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const pinForm = $<HTMLFormElement>('pin-form');
const pinInput = $<HTMLInputElement>('pin');
const panel = $<HTMLDivElement>('panel');
const statusEl = $<HTMLParagraphElement>('status');
const title = $<HTMLHeadingElement>('title');
const weekEl = $<HTMLParagraphElement>('rg-week');
const daysEl = $<HTMLDivElement>('rg-days');

/** Kept in memory only for this page's lifetime — never stored, never in a URL. */
let pin = '';
let view: GroupView | null = null;
let day = '';

const counter = new DayCounter(saveCount);
$('rg-counter').append(counter.el);

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
    weekEl.textContent = `Группа за неделю: ${paymentsText(v.week.total)}`;
    const days = daysBetween(v.week.start, v.week.today);
    if (!days.includes(day)) day = v.week.today;
    daysEl.replaceChildren(...days.map(d => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'day-chip' + (d === day ? ' active' : '');
        chip.textContent = d === v.week.today ? `${shortDay(d)} · сегодня` : shortDay(d);
        chip.setAttribute('aria-pressed', String(d === day));
        chip.addEventListener('click', () => {
            if (!view || d === day) return;
            day = d;
            show(view);
            setStatus('');
        });
        return chip;
    }));
    counter.setCaption(dayCaption(day));
    counter.setBase(v.week.days[day] ?? 0);
}

function showLogin(message = '') {
    pin = '';
    view = null;
    day = '';
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
                ? 'Можно только дни текущей недели до сегодняшнего. Обновите страницу, если неделя сменилась.'
                : 'Число оплат — от 0 до 999.', 'error');
            break;
        default:
            setStatus(`Ошибка: ${err.code}`, 'error');
    }
}

async function saveCount(count: number) {
    if (!view) return;
    const savedDay = day;
    setStatus('Сохраняю…');
    try {
        const res = await callAsGroup<GroupView & { saved: { count: number; previous: number } }>('groupSetCount', pin, {
            date: savedDay,
            count,
            requestId: newRequestId(),
        });
        show(res);
        const grew = res.saved.count > res.saved.previous;
        setStatus(`Сохранено: ${dayName(savedDay)} — ${paymentsText(res.saved.count)}.`
            + (grew ? ' Герой группы ударит на экранах в течение ~15 секунд.' : ''), 'ok');
    } catch (err) {
        reportError(err);
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
    } catch (err) {
        reportError(err);
    }
});

$('logout').addEventListener('click', () => showLogin());
