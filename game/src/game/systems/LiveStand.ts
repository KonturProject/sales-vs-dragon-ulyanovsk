import { Scene } from 'phaser';
import { IDLE_ANIM } from '../core/Constants';
import { EventBus, GameEvents } from '../core/EventBus';

/** Something that can breathe on its turn (HeroSprite, LeadSprite). */
export interface Breather {
    /** Standing at ease right now (not striking, not asleep, not being swapped) — a turn is only given to such a figure. */
    isAtEase(): boolean;
    setBreathing(on: boolean): void;
    /** One step of the loop; does nothing unless it is breathing and still at ease. */
    idleStep(): void;
}

/**
 * Passes "the live stand" around: one figure breathes for IDLE_ANIM.TURN_MS, then the next one, round and round.
 * The whole stage is never animated at once — that is what kept the weak laptops busy — yet something is always
 * moving. A figure that is busy or asleep when its turn comes is skipped.
 */
export class LiveStand {
    private current = -1;

    constructor(scene: Scene, private actors: Breather[]) {
        if (actors.length === 0) return;
        this.current = Math.floor(Math.random() * actors.length) - 1; // a random one starts
        scene.time.addEvent({ delay: IDLE_ANIM.FRAME_MS, loop: true, callback: () => this.actors[this.current]?.idleStep() });
        scene.time.addEvent({ delay: IDLE_ANIM.TURN_MS, loop: true, callback: () => this.passOn() });
        scene.events.once('shutdown', () => EventBus.emit(GameEvents.LIVE_STAND, { active: false }));
        this.passOn();
    }

    private passOn() {
        this.actors[this.current]?.setBreathing(false);
        const n = this.actors.length;
        for (let step = 1; step <= n; step++) {
            const i = (((this.current + step) % n) + n) % n;
            if (this.actors[i].isAtEase()) {
                this.current = i;
                this.actors[i].setBreathing(true);
                EventBus.emit(GameEvents.LIVE_STAND, { active: true });
                return;
            }
        }
        EventBus.emit(GameEvents.LIVE_STAND, { active: false }); // nobody is free (a sale is being celebrated, everyone sleeps): the next turn tries again
    }
}
