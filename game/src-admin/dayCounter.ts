import { paymentsText } from '../src/game/systems/Units';

/** Payments of one group on one day, as the backend bounds it (apps-script/Code.gs, MAX_DAY_COUNT). */
const MAX_COUNT = 999;

/**
 * The counter of the group leaders' page and of the admin's «Внести оплату»: « −  3  + » and
 * «Сохранить · было 2, станет 3». The number is what the sheet holds for the chosen group and day; −/+ only change it
 * here, the save button sends it (the user chose a save button over saving on every click: the backend sometimes
 * answers in 5–10 s, and a stray click must not write anything).
 */
export class DayCounter {
    readonly el: HTMLDivElement;
    private readonly caption: HTMLDivElement;
    private readonly valueEl: HTMLOutputElement;
    private readonly minus: HTMLButtonElement;
    private readonly plus: HTMLButtonElement;
    private readonly saveBtn: HTMLButtonElement;
    /** What the sheet holds; null while it is being read. */
    private base: number | null = null;
    private current = 0;
    private busy = false;

    constructor(private readonly onSave: (count: number) => Promise<void>) {
        this.el = document.createElement('div');
        this.el.className = 'counter';
        this.caption = document.createElement('div');
        this.caption.className = 'counter-caption';

        const row = document.createElement('div');
        row.className = 'counter-row';
        this.minus = this.button('−', 'counter-btn minus', 'Одной оплатой меньше', () => this.step(-1));
        this.valueEl = document.createElement('output');
        this.valueEl.className = 'counter-value';
        this.valueEl.setAttribute('aria-live', 'polite');
        this.plus = this.button('+', 'counter-btn plus', 'Одной оплатой больше', () => this.step(1));
        row.append(this.minus, this.valueEl, this.plus);

        this.saveBtn = this.button('', 'primary-btn counter-save', '', () => this.save());
        this.el.append(this.caption, row, this.saveBtn);
        this.render();
    }

    /** «Оплат за среду, 21.10». */
    setCaption(text: string) {
        this.caption.textContent = text;
    }

    /** What the sheet holds for the chosen day (the number starts from it); null = still reading. */
    setBase(count: number | null) {
        this.base = count;
        this.current = count ?? 0;
        this.render();
    }

    private button(text: string, className: string, label: string, onClick: () => void) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = className;
        b.textContent = text;
        if (label) b.setAttribute('aria-label', label);
        b.addEventListener('click', onClick);
        return b;
    }

    private step(delta: number) {
        if (this.base === null || this.busy) return;
        this.current = Math.max(0, Math.min(MAX_COUNT, this.current + delta));
        this.render();
    }

    private async save() {
        if (this.base === null || this.busy || this.current === this.base) return;
        this.busy = true;
        this.render();
        try {
            await this.onSave(this.current);
        } finally {
            this.busy = false;
            this.render();
        }
    }

    private render() {
        const loading = this.base === null;
        this.valueEl.textContent = loading ? '…' : String(this.current);
        this.minus.disabled = loading || this.busy || this.current <= 0;
        this.plus.disabled = loading || this.busy || this.current >= MAX_COUNT;
        const changed = !loading && this.current !== this.base;
        this.saveBtn.disabled = !changed || this.busy;
        this.saveBtn.textContent = this.busy
            ? 'Сохраняю…'
            : changed
                ? `Сохранить · было ${this.base}, станет ${this.current}`
                : loading ? 'Читаю таблицу…' : `В таблице: ${paymentsText(this.current)}`;
    }
}

const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const WEEKDAYS_ACCUSATIVE = ['воскресенье', 'понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу'];

/** 'yyyy-MM-dd' -> Date at local midnight (only the weekday and the day number are read from it). */
function asDate(day: string) {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(y, m - 1, d);
}

/** «Ср 21». */
export function shortDay(day: string) {
    const date = asDate(day);
    const name = WEEKDAYS[date.getDay()];
    return `${name[0].toUpperCase()}${name.slice(1)} ${date.getDate()}`;
}

const WEEKDAYS_NOMINATIVE = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

const ddmm = (date: Date) => `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}`;

/** «Оплат за среду, 21.10». */
export function dayCaption(day: string) {
    const date = asDate(day);
    return `Оплат за ${WEEKDAYS_ACCUSATIVE[date.getDay()]}, ${ddmm(date)}`;
}

/** «среда, 21.10». */
export function dayName(day: string) {
    const date = asDate(day);
    return `${WEEKDAYS_NOMINATIVE[date.getDay()]}, ${ddmm(date)}`;
}

/** Every day from `start` to `end` (inclusive), 'yyyy-MM-dd'. */
export function daysBetween(start: string, end: string): string[] {
    const out: string[] = [];
    const d = asDate(start);
    const last = asDate(end).getTime();
    for (let i = 0; i < 31 && d.getTime() <= last; i++) {
        out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
        d.setDate(d.getDate() + 1);
    }
    return out;
}
