import { Events } from 'phaser';

export interface MoneyInPayload {
    heroSlug: string;
    ropName: string;
    delta: number;
    /** A strike shown on request from the admin page — it is not a real sale, so it must not count as one (idle timer etc.). */
    demo?: boolean;
}

/**
 * An animation the admin page asked the displays to play (see apps-script/Code.gs, action 'command').
 * Purely visual — handlers must not touch GameState.
 *   hit {rop, amount} | fall {hero, mode} | wake | growl | confetti | celebrate
 */
export interface AdminCommandPayload {
    type: string;
    args: Record<string, unknown>;
}

export interface ProgressChangedPayload {
    ratio: number;
    totalThisWeek: number;
    plan: number;
    /** Dragon heads left after this poll (DAYS at 0%, 0 at 100%). */
    headsRemaining: number;
}

export interface FetchErrorPayload {
    consecutiveFailures: number;
    error: string;
}

export interface DragonHeadLostPayload {
    /** Heads left once this one is gone. */
    heads: number;
    /** Wait this long before playing it — lets the hit animations from the same poll read first. */
    delayMs: number;
}

export interface DragonDefeatedPayload {
    delayMs: number;
}

export interface LiveStandPayload {
    active: boolean;
}

/** The admin chose other characters for some slots (slot ids as in HERO_SLUGS). */
export interface RosterChangedPayload {
    slots: string[];
}

/**
 * Single shared emitter connecting DataPollingService (data layer) to the
 * Phaser scenes (PenScene draws hits and the dragon, HUDScene draws the bar and the victory banner).
 */
export const EventBus = new Events.EventEmitter();

export const GameEvents = {
    DATA_UPDATED: 'data:updated',
    MONEY_IN: 'money:in',
    PROGRESS_CHANGED: 'progress:changed',
    FETCH_ERROR: 'data:fetch-error',
    DRAGON_HEAD_LOST: 'dragon:head-lost',
    DRAGON_DEFEATED: 'dragon:defeated',
    ADMIN_COMMAND: 'admin:command',
    ROSTER_CHANGED: 'roster:changed',
    /** Someone is breathing (the live-stand rotation): the game should draw at least at the ambient frame rate. */
    LIVE_STAND: 'stand:live',
} as const;
