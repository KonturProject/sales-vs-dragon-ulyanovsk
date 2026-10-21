import StartGame, { powerSaver } from './game/main';
import type { PenScene } from './game/scenes/PenScene';
import { EventBus, GameEvents } from './game/core/EventBus';
import { GameState, StatusResponse } from './game/core/GameState';
import { DataPollingService } from './game/systems/DataPollingService';
import { AudioSystem } from './game/systems/Audio';
import { RosterConfig } from './game/systems/RosterConfig';

document.addEventListener('DOMContentLoaded', () => {

    const game = StartGame('game-container');

    if (import.meta.env.DEV) {
        // Manual test hook: from the devtools console, e.g.
        //   __debug.hit('slot_1', 2)
        // fires a money:in event (2 payments) without waiting on a real poll cycle.
        (window as any).__debug = {
            EventBus,
            GameEvents,
            GameState,
            game,
            hit: (heroSlug: string, delta = 1) => {
                EventBus.emit(GameEvents.MONEY_IN, { heroSlug, ropName: 'debug', delta });
            },
            /** Simulate the weekly total reaching `ratio` (0..1) of the plan: fires the same diff/events a real poll would. */
            setRatio: (ratio: number) => {
                const plan = GameState.plan || 60;
                const total = Math.round(plan * ratio);
                const rows = Object.keys(GameState.byRop).length
                    ? Object.entries(GameState.byRop).map(([ropName, amount]) => ({ ropName, amount }))
                    : [{ ropName: 'ВШ1', amount: 0 }];
                const first = rows[0];
                first.amount += total - GameState.totalThisWeek;
                (window as any).__debug.injectStatus({
                    ok: true, weekStart: '', weekEnd: '', plan, totalThisWeek: total, byRop: rows,
                    lastUpdated: new Date().toISOString(),
                });
            },
            /** Feed a status object through the real poll pipeline (diff -> hits, head loss, victory) without any network. */
            injectStatus: (status: StatusResponse) => {
                DataPollingService.applyForDebug(status);
            },
            /** `__debug.poller.stop()` freezes real polling so injected states aren't overwritten every 15s. */
            poller: DataPollingService,
            audio: AudioSystem,
            /** `__debug.power()` -> current frame-rate mode and the rate frames are really drawn at. */
            power: () => powerSaver?.stats(),
            /** `__debug.mood()` -> the idle-mood director: `.advance(ms)`, `.dropOne()`, `.wakeAll()`, `.state()`; `.dragon` growl via `__debug.growl()`. */
            mood: () => (game.scene.getScene('PenScene') as PenScene).mood,
            /** `__debug.command('hit', { rop: 'ВШ1', count: 2 })` — what the admin page's animation buttons cause. */
            command: (type: string, args: Record<string, unknown> = {}) => EventBus.emit(GameEvents.ADMIN_COMMAND, { type, args }),
            /** `__debug.roster({ slot_1: 'ninja', lead: 'queen' })` — what a poll does when the admin picked other heroes (no argument: show the current choice). */
            roster: (choice?: Record<string, string>) => {
                if (!choice) return RosterConfig.selection;
                const slots = RosterConfig.applySelection({ ...RosterConfig.selection, ...choice });
                if (slots.length > 0) EventBus.emit(GameEvents.ROSTER_CHANGED, { slots });
                return slots;
            },
            growl: () => ((game.scene.getScene('PenScene') as unknown as { dragon: { growl(): boolean } }).dragon).growl(),
        };
    }

});
