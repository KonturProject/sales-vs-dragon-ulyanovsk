import { Scene } from 'phaser';
import { EventBus, GameEvents, MoneyInPayload } from '../core/EventBus';
import { DRAGON, IDLE } from '../core/Constants';
import { HeroSprite } from '../objects/HeroSprite';
import { Dragon } from '../objects/Dragon';

type Span = [number, number];

/** Left edge of the gold mountain on the floor — a hero cannot lie down on the pile. */
const MOUNTAIN_SPAN: Span = [DRAGON.MOUNT_X - 195 * DRAGON.SCALE, DRAGON.MOUNT_X + 195 * DRAGON.SCALE];

function overlap(a: Span, b: Span): number {
    return Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
}

/**
 * The mood of an idle office. Two things happen "from time to time" when nothing is going on:
 *  - no sale for an hour (game time, whole team) -> one random hero keels over or dozes off,
 *    one more with every further hour, at most IDLE.MAX_DOWN; any sale wakes everybody;
 *  - the dragon growls and trembles menacingly, more often the longer the silence.
 *
 * The idle time is *not* per department on purpose: a quiet hour is the team's, and a hero
 * lying on the floor must not read as "this department is failing".
 *
 * It counts game time (a timer in the scene), so it stands still while the tab is hidden or
 * the laptop sleeps, and it starts from zero whenever the page loads — the page only sees
 * sales that arrive while it is open.
 */
export class IdleMood {
    private idleMs = 0;

    constructor(
        private scene: Scene,
        private heroes: HeroSprite[],
        private dragon: Dragon,
        /** Things a fallen hero should avoid lying on (the branch lead's extent). */
        private obstacles: Span[] = [],
    ) {
        scene.time.addEvent({ delay: IDLE.CHECK_MS, loop: true, callback: () => this.tick(false) });
        EventBus.on(GameEvents.MONEY_IN, this.onSale, this);
        EventBus.on(GameEvents.DRAGON_DEFEATED, this.wakeAll, this);
        scene.events.once('shutdown', () => {
            EventBus.off(GameEvents.MONEY_IN, this.onSale, this);
            EventBus.off(GameEvents.DRAGON_DEFEATED, this.wakeAll, this);
        });

        this.scheduleGrowl();
        this.scheduleSnore();
    }

    /** For diagnosing / `__debug`. */
    state() {
        return {
            idleMinutes: Math.round(this.idleMs / 6000) / 10,
            asleep: this.heroes.filter(h => h.isAsleep).length,
            due: this.dueCount(),
        };
    }

    /** `__debug` / demo: pretend this much quiet time has passed and act on it right away. */
    advance(ms: number) {
        this.idleMs += ms;
        this.tick(true);
    }

    private dueCount() {
        if (this.idleMs < IDLE.FIRST_MS) return 0;
        return Math.min(IDLE.MAX_DOWN, 1 + Math.floor((this.idleMs - IDLE.FIRST_MS) / IDLE.STEP_MS));
    }

    private asleepCount() {
        return this.heroes.filter(h => h.isAsleep).length;
    }

    private tick(force: boolean) {
        this.idleMs += force ? 0 : IDLE.CHECK_MS;
        if (this.asleepCount() < this.dueCount() && (force || Math.random() < IDLE.DROP_CHANCE)) this.dropOne();
    }

    /** One random standing hero falls over or dozes off; the dragon takes notice. */
    dropOne(): boolean {
        return this.drop('random', 'random');
    }

    /**
     * `heroSlug`: a hero's slug or 'random'; `mode`: 'fall', 'doze' or 'random' (a random pick honours
     * IDLE.MAX_LYING; an explicit 'fall' — from the admin page — does not). False if that hero is not
     * standing free right now.
     */
    drop(heroSlug: string, mode: string): boolean {
        const standing = this.heroes.filter(h => h.canSway());
        const hero = heroSlug === 'random'
            ? standing[Math.floor(Math.random() * standing.length)]
            : standing.find(h => h.slug === heroSlug);
        if (!hero) return false;

        const dir = this.freerDirection(hero);
        const roomOnFloor = this.heroes.filter(h => h.isLying).length < IDLE.MAX_LYING;
        const fall = mode === 'fall' || (mode !== 'doze' && roomOnFloor && Math.random() < IDLE.FALL_SHARE);
        const done = fall ? hero.fallOver(dir) : hero.doze(dir);
        if (done) this.scene.time.delayedCall(1300, () => this.dragon.growl());
        return done;
    }

    /** The side where lying down would cover the least of everyone else (and never the gold pile). */
    private freerDirection(hero: HeroSprite): 1 | -1 {
        const others: Span[] = [
            ...this.heroes.filter(h => h !== hero).map(h => h.coveredSpan()),
            ...this.obstacles,
            MOUNTAIN_SPAN,
        ];
        const cost = (dir: 1 | -1) => others.reduce((sum, span) => sum + overlap(hero.lyingSpan(dir), span), 0);
        const left = cost(-1);
        const right = cost(1);
        if (left === right) return Math.random() < 0.5 ? 1 : -1;
        return left < right ? -1 : 1;
    }

    private onSale(payload: MoneyInPayload) {
        if (payload.demo) return; // a strike shown from the admin page is not a sale
        this.idleMs = 0;
        this.wakeAll();
    }

    /** Everybody who is down gets up, one after another. */
    wakeAll() {
        this.heroes.filter(h => h.isAsleep).forEach((hero, i) => {
            this.scene.time.delayedCall(i * IDLE.WAKE_STAGGER_MS, () => hero.wakeUp());
        });
    }

    private scheduleGrowl() {
        const quiet = this.idleMs >= IDLE.FIRST_MS;
        const min = quiet ? DRAGON.GROWL_IDLE_MIN_MS : DRAGON.GROWL_MIN_MS;
        const max = quiet ? DRAGON.GROWL_IDLE_MAX_MS : DRAGON.GROWL_MAX_MS;
        this.scene.time.delayedCall(min + Math.random() * (max - min), () => {
            this.dragon.growl();
            this.scheduleGrowl();
        });
    }

    private scheduleSnore() {
        this.scene.time.delayedCall(IDLE.SNORE_MIN_MS + Math.random() * (IDLE.SNORE_MAX_MS - IDLE.SNORE_MIN_MS), () => {
            const sleepers = this.heroes.filter(h => h.isAsleep);
            if (sleepers.length > 0) sleepers[Math.floor(Math.random() * sleepers.length)].snore();
            this.scheduleSnore();
        });
    }
}
