import { DAYS } from './Constants';

/** A group's total this week. The Ulyanovsk game counts payments: `amount` is a NUMBER OF PAYMENTS, not money. */
export interface RopAmount {
    ropName: string;
    amount: number;
}

/** An admin "play this animation" request as the backend hands it to the displays. */
export interface BackendCommand {
    /** Rising counter — each display plays every id once. */
    id: number;
    type: string;
    args: Record<string, unknown>;
    /** Backend clock, ms. */
    issuedAt: number;
}

export interface StatusResponse {
    ok: boolean;
    weekStart: string;
    weekEnd: string;
    plan: number;
    totalThisWeek: number;
    totalMeters?: number;
    metersRemaining?: number;
    byRop: RopAmount[];
    lastUpdated: string;
    /** Recent admin animation requests (absent on an older backend). */
    commands?: BackendCommand[];
    /** Backend clock, ms — compared with `issuedAt` so a display's own clock does not matter. */
    serverNow?: number;
    /** Which character stands in each slot (slot -> character id), as chosen in the admin page; null/absent = defaults. */
    roster?: Record<string, string> | null;
    /** Group leader on each department's nameplate (slot -> «Фамилия И.»), edited in the admin page; null/absent = defaults. */
    leaders?: Record<string, string> | null;
    error?: string;
}

/**
 * Centralized mutable state, shared between the polling system and every scene.
 * Not a Phaser object — plain singleton, following the game-creator EventBus/GameState pattern.
 */
class GameStateStore {
    plan = 0;
    totalThisWeek = 0;
    byRop: Record<string, number> = {};
    /** true once at least one poll has landed — first poll is a baseline, never diffed */
    hasBaseline = false;
    /** Heads the dragon had after the previous poll — diffed to fire head-loss animations. */
    lastHeads = DAYS;
    /** Latched once the weekly plan is closed; released when ratio drops back under 1 (new week / raised plan). */
    dragonDefeated = false;
    lastFetchOk = false;
    lastUpdated: string | null = null;

    /**
     * Applies a fresh status response and returns the previous byRop snapshot
     * (for the caller to diff against) — null on the very first call.
     */
    applyStatus(status: StatusResponse): Record<string, number> | null {
        const previous = this.hasBaseline ? this.byRop : null;

        const nextByRop: Record<string, number> = {};
        for (const row of status.byRop) {
            nextByRop[row.ropName] = row.amount;
        }

        this.byRop = nextByRop;
        this.plan = status.plan;
        this.totalThisWeek = status.totalThisWeek;
        this.lastUpdated = status.lastUpdated;
        this.lastFetchOk = true;
        this.hasBaseline = true;

        return previous;
    }

    get ratio(): number {
        if (this.plan <= 0) return 0;
        return Math.min(1, Math.max(0, this.totalThisWeek / this.plan));
    }

    /**
     * Dragon heads left: one is lost each time the cumulative total crosses another
     * 1/DAYS of the weekly plan, so 0% -> DAYS heads and 100% -> 0 heads.
     */
    get headsRemaining(): number {
        return DAYS - Math.floor(this.ratio * DAYS + 1e-9);
    }

    reset() {
        this.plan = 0;
        this.totalThisWeek = 0;
        this.byRop = {};
        this.hasBaseline = false;
        this.lastHeads = DAYS;
        this.dragonDefeated = false;
        this.lastFetchOk = false;
        this.lastUpdated = null;
    }
}

export const GameState = new GameStateStore();
