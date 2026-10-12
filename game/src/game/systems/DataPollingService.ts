import { EventBus, GameEvents, LeadersChangedPayload, MoneyInPayload, ProgressChangedPayload, RosterChangedPayload } from '../core/EventBus';
import { GameState, StatusResponse } from '../core/GameState';
import { DRAGON, HERO, HERO_SLUGS, POLL } from '../core/Constants';
import { RosterConfig } from './RosterConfig';

interface RuntimeConfig {
    appsScriptUrl: string;
    useMock?: boolean;
}

/** Pause after the last hit animation of a poll before the dragon starts losing heads, so the blow reads first. */
const HEAD_LOSS_LEAD_MS = 600;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let consecutiveFailures = 0;
/** A poll is still waiting for its answer — the next one must not start (two answers could arrive out of order). */
let pollInFlight = false;
let config: RuntimeConfig | null = null;
/** Highest admin command id this display has already seen; null until the first poll (the baseline). */
let lastCommandId: number | null = null;

async function loadRuntimeConfig(): Promise<RuntimeConfig> {
    const res = await fetch('config.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`config.json fetch failed: ${res.status}`);
    const loaded: RuntimeConfig = await res.json();
    // Dev only: `?backend=http://localhost:8787/exec` points the game at the local mock backend (game/tools/mock-backend.mjs).
    if (import.meta.env.DEV) {
        const backend = new URLSearchParams(location.search).get('backend');
        if (backend) return { appsScriptUrl: backend, useMock: false };
    }
    return loaded;
}

async function fetchStatus(): Promise<StatusResponse> {
    if (!config) throw new Error('DataPollingService not started');

    if (config.useMock || !config.appsScriptUrl) {
        const res = await fetch('assets/mock/mock-status.json', { cache: 'no-store' });
        return res.json();
    }

    return fetchWithHedge(config.appsScriptUrl);
}

/**
 * GET the status with a safety net for Apps Script's slow tail: a second request joins in when the first is
 * slow (POLL.HEDGE_AFTER_MS) or fails, the first success wins and the other is abandoned. Rejects only when
 * every attempt (POLL.MAX_ATTEMPTS) has failed.
 */
function fetchWithHedge(url: string): Promise<StatusResponse> {
    return new Promise<StatusResponse>((resolve, reject) => {
        const controllers: AbortController[] = [];
        let pending = 0;
        let settled = false;
        let lastError: unknown = new Error('no attempt made');
        let hedgeTimer: ReturnType<typeof setTimeout> | null = null;

        const finish = () => {
            settled = true;
            if (hedgeTimer !== null) clearTimeout(hedgeTimer);
            controllers.forEach(c => c.abort()); // the loser (and the finished winner) — nothing left to wait for
        };

        const launch = () => {
            if (settled || controllers.length >= POLL.MAX_ATTEMPTS) return;
            const controller = new AbortController();
            controllers.push(controller);
            pending++;
            const timeout = setTimeout(() => controller.abort(), POLL.TIMEOUT_MS);

            fetch(url, { signal: controller.signal })
                .then(res => {
                    if (!res.ok) throw new Error(`status fetch failed: ${res.status}`);
                    return res.json() as Promise<StatusResponse>;
                })
                .then(status => {
                    if (settled) return;
                    finish();
                    resolve(status);
                })
                .catch(err => {
                    pending--;
                    if (settled) return;
                    lastError = err;
                    if (controllers.length < POLL.MAX_ATTEMPTS) launch(); // failed outright: retry now instead of waiting for the hedge timer
                    else if (pending === 0) {
                        finish();
                        reject(lastError);
                    }
                })
                .finally(() => clearTimeout(timeout));
        };

        hedgeTimer = setTimeout(launch, POLL.HEDGE_AFTER_MS);
        launch();
    });
}

function diffAndEmit(previous: Record<string, number> | null, status: StatusResponse) {
    let hitCount = 0;

    if (previous !== null) {
        // One blow per hero and poll, even when its group's money came under two spellings of the name (or the
        // poll caught several payments, e.g. right after an import): the deltas of a slot are added up.
        const bySlot = new Map<string, MoneyInPayload>();
        for (const row of status.byRop) {
            const delta = row.amount - (previous[row.ropName] ?? 0);
            if (delta <= 0) continue;
            const heroSlug = RosterConfig.heroSlugForRop(row.ropName) ?? 'overflow';
            const key = heroSlug === 'overflow' ? `overflow:${row.ropName}` : heroSlug;
            const earlier = bySlot.get(key);
            if (earlier) earlier.delta += delta;
            else bySlot.set(key, { heroSlug, ropName: row.ropName, delta });
        }
        // Left to right across the stage, one hero after another — each blow lands on its own (HIT_STAGGER_MS).
        const order = (p: MoneyInPayload) => {
            const i = (HERO_SLUGS as readonly string[]).indexOf(p.heroSlug);
            return i < 0 ? HERO_SLUGS.length : i;
        };
        [...bySlot.values()].sort((a, b) => order(a) - order(b)).forEach((payload, i) => {
            hitCount++;
            setTimeout(() => EventBus.emit(GameEvents.MONEY_IN, payload), i * HERO.HIT_STAGGER_MS);
        });
    }

    // Head loss / victory should only play once every staggered hit from this
    // poll has had time to land — otherwise it steals attention from the blow.
    const hitsFinishAt = hitCount > 0 ? (hitCount - 1) * HERO.HIT_STAGGER_MS + HERO.HIT_DURATION_MS : 0;
    const settleDelayMs = hitCount > 0 ? hitsFinishAt + HEAD_LOSS_LEAD_MS : 0;

    const isBaseline = previous === null;
    const heads = GameState.headsRemaining;
    const previousHeads = GameState.lastHeads;

    const progress: ProgressChangedPayload = {
        ratio: GameState.ratio,
        totalThisWeek: status.totalThisWeek,
        plan: status.plan,
        headsRemaining: heads,
    };
    EventBus.emit(GameEvents.PROGRESS_CHANGED, progress);
    EventBus.emit(GameEvents.DATA_UPDATED, status);

    // The first poll after page load is only a baseline: PenScene puts the
    // dragon straight into the right state, no head-loss animation for
    // progress that was made before this tab opened.
    let lostCount = 0;
    if (!isBaseline && heads < previousHeads) {
        for (let h = previousHeads - 1; h >= heads; h--) {
            const delayMs = settleDelayMs + lostCount * DRAGON.HEAD_LOSS_STAGGER_MS;
            lostCount++;
            EventBus.emit(GameEvents.DRAGON_HEAD_LOST, { heads: h, delayMs });
        }
    }
    GameState.lastHeads = heads;

    if (GameState.ratio >= 1 && !GameState.dragonDefeated) {
        GameState.dragonDefeated = true;
        const delayMs = isBaseline ? 0 : settleDelayMs + lostCount * DRAGON.HEAD_LOSS_STAGGER_MS;
        EventBus.emit(GameEvents.DRAGON_DEFEATED, { delayMs });
    } else if (GameState.ratio < 1 && GameState.dragonDefeated) {
        // New week (or a raised plan) dropped us back under 100% — un-latch so
        // crossing the goal again later re-fires the victory.
        GameState.dragonDefeated = false;
    }
}

/**
 * Plays the animations the admin page asked for. Like the money diff, the first poll only sets the
 * baseline: commands issued before this page opened are history, not something to replay on every reload.
 */
function dispatchCommands(status: StatusResponse) {
    const commands = [...(status.commands ?? [])].sort((a, b) => a.id - b.id);
    const newest = commands.length > 0 ? commands[commands.length - 1].id : 0;

    if (lastCommandId === null) {
        lastCommandId = newest;
        return;
    }
    // The ids only ever grow. If the newest one is *lower* than what this display has seen, the backend's
    // counter was reset (its properties were cleared): start over from there, or every new command would be
    // ignored until the counter caught up again.
    if (commands.length > 0 && newest < lastCommandId) lastCommandId = newest - commands.length;

    let staggerIndex = 0;
    for (const command of commands) {
        if (command.id <= lastCommandId) continue;
        // Age by the backend's own clock, so a wrong clock on this computer cannot swallow (or replay) commands.
        const ageMs = status.serverNow !== undefined ? status.serverNow - command.issuedAt : 0;
        if (ageMs > POLL.COMMAND_MAX_AGE_MS) continue;
        const payload = { type: command.type, args: command.args ?? {} };
        setTimeout(() => EventBus.emit(GameEvents.ADMIN_COMMAND, payload), staggerIndex++ * POLL.COMMAND_STAGGER_MS);
    }
    lastCommandId = Math.max(lastCommandId, newest);
}

/**
 * The admin picks which characters stand on the stage; the backend hands the choice out with every status.
 * Only a *changed* choice causes anything (RosterConfig compares it with what is shown now).
 */
function applyRoster(status: StatusResponse) {
    if (status.roster) {
        const slots = RosterConfig.applySelection(status.roster);
        if (slots.length > 0) EventBus.emit(GameEvents.ROSTER_CHANGED, { slots } satisfies RosterChangedPayload);
    }
    if (status.leaders) {
        const slots = RosterConfig.applyLeaders(status.leaders);
        if (slots.length > 0) EventBus.emit(GameEvents.LEADERS_CHANGED, { slots } satisfies LeadersChangedPayload);
    }
}

async function tick() {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
        const status = await fetchStatus();
        const previous = GameState.applyStatus(status);
        consecutiveFailures = 0;
        applyRoster(status);
        diffAndEmit(previous, status);
        dispatchCommands(status);
    } catch (err) {
        console.error('[DataPollingService] tick failed:', err);
        consecutiveFailures++;
        GameState.lastFetchOk = false;
        EventBus.emit(GameEvents.FETCH_ERROR, { consecutiveFailures, error: String(err) });
        // Keep polling regardless of failure count — a long-lived kiosk tab should
        // recover on its own once connectivity/the endpoint comes back.
    } finally {
        pollInFlight = false;
    }
}

export const DataPollingService = {
    async start() {
        if (intervalHandle !== null) return;
        config = await loadRuntimeConfig();
        await tick();
        intervalHandle = setInterval(tick, POLL.INTERVAL_MS);
    },

    /** Dev-only entry point: runs a synthetic status through exactly the same apply/diff path as a real poll. */
    applyForDebug(status: StatusResponse) {
        const previous = GameState.applyStatus(status);
        diffAndEmit(previous, status);
    },

    stop() {
        if (intervalHandle !== null) {
            clearInterval(intervalHandle);
            intervalHandle = null;
        }
    },
};
