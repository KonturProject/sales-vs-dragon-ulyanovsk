import { Game } from 'phaser';
import { EventBus, GameEvents } from './EventBus';
import { QUALITY } from './Quality';

/** After a real happening (a hit, a lost head, the victory), stay active this long, plus the event's own delay. */
const EVENT_AWAKE_MS = 4000;
/** Pointer input (mute button) needs one prompt redraw, not a long burst. */
const INPUT_AWAKE_MS = 1500;
/** The loading screen and the first frames after start should look smooth. */
const STARTUP_AWAKE_MS = 8000;
/** Frame-rate ceiling while only endless "breathing" tweens run (the victory banner and the branch lead pulse for as long as the week stays won — days). */
const AMBIENT_FPS = 20;
type Mode = 'active' | 'ambient' | 'idle';
/** Phaser advances a frame once the accumulated time reaches the limit; on a 60 Hz display a frame is 16.6 ms, which would miss a 16.67 ms limit every few frames. */
const LIMIT_HEADROOM = 0.92;

/**
 * Renders the game at a low frame rate while it is still and at the full rate
 * while anything moves. An office display shows the same picture for minutes at a
 * stretch; redrawing it 60 times a second is what kept weak laptops at 100 % CPU.
 *
 * Three rates: "active" (a finite tween is running in any scene, or a game event
 * arrived recently — events carry delayed follow-ups such as head loss and victory
 * that start tweens later), "ambient" (only endless pulsing tweens run) and "idle"
 * (nothing moves). The frame limit is Phaser's own `fps.limit`, retuned at run
 * time; it only decides how often the *game step* runs, the browser's animation
 * frame callback stays a near-free no-op in between.
 */
export class PowerSaver {
    private awakeUntil = performance.now() + STARTUP_AWAKE_MS;
    private mode: Mode = 'active';
    private framesThisSecond = 0;
    private secondStartedAt = performance.now();
    private renderedFps = 0;
    /** A hero is breathing (the live-stand rotation): draw at the ambient rate even though no tween loops. */
    private liveStand = false;

    constructor(private game: Game) {
        if (!this.hasLimiter()) return; // Phaser started without fps.limit — nothing to tune

        this.applyRate('active');

        game.events.on('postrender', this.onFrame, this);

        const wakeForEvent = (payload?: { delayMs?: number }) => this.wake(EVENT_AWAKE_MS + (payload?.delayMs ?? 0));
        // Only real happenings wake it. Data/error events arrive on every poll (every 15 s)
        // even when nothing changed; whatever they do change (a number, a status line) is
        // drawn by the next idle-rate frame, and any tween they start is seen by onFrame().
        EventBus.on(GameEvents.MONEY_IN, wakeForEvent);
        EventBus.on(GameEvents.DRAGON_HEAD_LOST, wakeForEvent);
        EventBus.on(GameEvents.DRAGON_DEFEATED, wakeForEvent);
        EventBus.on(GameEvents.ADMIN_COMMAND, wakeForEvent);
        EventBus.on(GameEvents.LIVE_STAND, (payload: { active: boolean }) => { this.liveStand = payload.active; });
        game.canvas.addEventListener('pointerdown', () => this.wake(INPUT_AWAKE_MS));
    }

    /** Keep (or return to) the active frame rate for at least `ms` from now. */
    wake(ms: number) {
        this.awakeUntil = Math.max(this.awakeUntil, performance.now() + ms);
        if (this.mode !== 'active') this.applyRate('active');
    }

    /** For `__debug` / diagnosing: which rate is in force and how fast frames really are drawn. */
    stats() {
        return {
            mode: this.mode,
            renderedFps: Math.round(this.renderedFps * 10) / 10,
            limitFps: Math.round((1000 / this.limitMs()) * 10) / 10,
            awakeForMs: Math.max(0, Math.round(this.awakeUntil - performance.now())),
        };
    }

    private hasLimiter(): boolean {
        return (this.game.loop as unknown as { hasFpsLimit: boolean }).hasFpsLimit === true;
    }

    private limitMs(): number {
        return (this.game.loop as unknown as { _limitRate: number })._limitRate;
    }

    private applyRate(mode: Mode) {
        this.mode = mode;
        const fps = mode === 'active' ? QUALITY.activeFps : mode === 'ambient' ? Math.min(QUALITY.activeFps, AMBIENT_FPS) : QUALITY.idleFps;
        (this.game.loop as unknown as { _limitRate: number })._limitRate = (1000 / fps) * LIMIT_HEADROOM;
    }

    /** Runs once per drawn frame (not per browser frame), so it only costs anything when the game actually renders. */
    private onFrame() {
        const now = performance.now();

        this.framesThisSecond++;
        if (now - this.secondStartedAt >= 1000) {
            this.renderedFps = (this.framesThisSecond * 1000) / (now - this.secondStartedAt);
            this.framesThisSecond = 0;
            this.secondStartedAt = now;
        }

        const motion = this.tweenMotion();
        if (motion === 'finite') this.awakeUntil = Math.max(this.awakeUntil, now + 300);

        const wanted: Mode = now < this.awakeUntil ? 'active' : motion === 'endless' || this.liveStand ? 'ambient' : 'idle';
        if (wanted !== this.mode) this.applyRate(wanted);
    }

    /** 'finite' if any ordinary tween runs, 'endless' if every running tween loops forever, 'none' otherwise. */
    private tweenMotion(): 'finite' | 'endless' | 'none' {
        let endless = false;
        for (const scene of this.game.scene.scenes) {
            if (!scene.sys.isActive()) continue;
            for (const tween of scene.tweens.getTweens()) {
                if ((tween as { isInfinite?: boolean }).isInfinite !== true) return 'finite'; // chains report no flag: treated as finite
                endless = true;
            }
        }
        return endless ? 'endless' : 'none';
    }
}
