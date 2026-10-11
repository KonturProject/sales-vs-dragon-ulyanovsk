import { GameObjects, Scene, Tweens } from 'phaser';
import { HERO, IDLE_ANIM } from '../core/Constants';
import { emitSparkles, Swayable } from '../systems/Fx';
import { HeroDef } from '../systems/RosterConfig';
import { idleKeyOf } from '../systems/CharacterLoader';

/**
 * The branch lead. Not tied to any department: stands apart from the fighters, never
 * throws a punch. Breathes like the heroes (IdleAnimator steps the loop), and on every sale
 * runs a few steps toward the heroes to cheer them on and comes back; on victory it runs on the spot.
 * Which character it is can change at any time (setCharacter — the admin picks).
 */
export class LeadSprite extends GameObjects.Container implements Swayable {
    private sprite: GameObjects.Image;
    private victoryTween?: Tweens.Tween;
    private baseScale: number;
    private baseX: number;
    private defaultTexture: string;
    /** The run cycle (the strike frames without the last, "blow" one). */
    private runFrames: string[] = [];
    private idleKey: string | null = null;
    private idleFrames = 0;
    private idleFrame = 0;
    /** A cheering dash is in progress. */
    private busy = false;
    /** It is the lead's turn in the live-stand rotation (systems/LiveStand.ts). */
    private breathing = false;

    constructor(scene: Scene, x: number, y: number, def: HeroDef, scaleMul = 1) {
        super(scene, x, y);
        this.baseX = x;
        this.baseScale = HERO.TEXTURE_SCALE * scaleMul;
        this.defaultTexture = def.sprite;
        this.sprite = scene.add.image(0, 0, def.sprite).setOrigin(0.5, 1);
        this.setupFrames(def);
        this.add(this.sprite);
        this.setScale(this.baseScale);
        scene.add.existing(this);
    }

    private setupFrames(def: HeroDef) {
        this.runFrames = [];
        for (let i = 1; i < def.hits; i++) {
            const key = `${def.sprite}_hit${i}`;
            if (this.scene.textures.exists(key)) this.runFrames.push(key);
        }
        this.idleKey = def.idle && this.scene.textures.exists(idleKeyOf(def)) ? idleKeyOf(def) : null;
        this.idleFrames = def.idle?.frames ?? 0;
        this.idleFrame = this.idleFrames > 0 ? Math.floor(Math.random() * this.idleFrames) : 0;
    }

    canSway() {
        return !this.victoryTween && !this.busy;
    }

    isAtEase() {
        return !this.busy && !this.victoryTween && this.idleKey !== null;
    }

    /** Its turn begins or ends; at the end it returns to the static standing frame. */
    setBreathing(on: boolean) {
        this.breathing = on;
        if (!on && this.isAtEase()) this.sprite.setTexture(this.defaultTexture);
    }

    /** One step of the breathing loop (called by the live-stand rotation, only on the lead's turn). */
    idleStep() {
        if (!this.breathing || !this.idleKey || this.busy || this.victoryTween) return;
        this.idleFrame = (this.idleFrame + 1) % this.idleFrames;
        this.sprite.setTexture(this.idleKey, this.idleFrame);
    }

    /** Horizontal extent on screen. */
    span(): [number, number] {
        const half = (this.sprite.width * this.baseScale) / 2;
        return [this.x - half, this.x + half];
    }

    /** Another character takes the lead's place: pops in with a small scale-up. */
    setCharacter(def: HeroDef) {
        if (this.defaultTexture === def.sprite || !this.scene.textures.exists(def.sprite)) return;
        this.defaultTexture = def.sprite;
        this.setupFrames(def);
        this.sprite.setTexture(def.sprite).setFlipX(false);
        const s = this.baseScale;
        this.scene.tweens.killTweensOf(this);
        this.victoryTween = undefined;
        this.busy = false;
        this.setPosition(this.baseX, this.y);
        this.setScale(s * 0.3);
        this.scene.tweens.add({ targets: this, scaleX: s, scaleY: s, duration: 380, ease: 'Back.easeOut' });
    }

    private sparkleOrigin() {
        return {
            x: this.x,
            y: this.y - this.sprite.height * this.baseScale * 0.6,
            spread: this.sprite.width * this.baseScale * 0.9,
        };
    }

    /** Run-cycle frame for `progress` (0..1) of a dash — about one and a half laps of the cycle. */
    private showRun(progress: number) {
        if (this.runFrames.length === 0) return;
        const i = Math.floor(progress * this.runFrames.length * 1.5) % this.runFrames.length;
        const key = this.runFrames[i];
        if (this.sprite.texture.key !== key) this.sprite.setTexture(key);
    }

    private showStanding() {
        this.sprite.setTexture(this.defaultTexture);
    }

    /**
     * On every sale: a small pulse and sparkles, and a few running steps toward the heroes and back (x only —
     * the pulse owns the scale). A second sale while it is still running only gets the pulse.
     */
    playCheer() {
        const s = this.baseScale;
        this.scene.tweens.add({ targets: this, scaleX: s * 1.06, scaleY: s * 1.06, duration: 220, yoyo: true, ease: 'Quad.easeOut' });
        const o = this.sparkleOrigin();
        emitSparkles(this.scene, o.x, o.y, o.spread, 6);
        this.dash();
    }

    private dash() {
        if (this.busy || this.victoryTween || this.runFrames.length === 0) return;
        this.busy = true;
        this.scene.tweens.add({
            targets: this,
            x: this.baseX + IDLE_ANIM.LEAD_DASH_PX,
            duration: IDLE_ANIM.LEAD_DASH_MS,
            ease: 'Quad.easeOut',
            onUpdate: (tween: Tweens.Tween) => this.showRun(tween.progress),
            onComplete: () => {
                const o = this.sparkleOrigin();
                emitSparkles(this.scene, o.x, o.y, o.spread, 5);
                this.sprite.setFlipX(true);
                this.scene.tweens.add({
                    targets: this,
                    x: this.baseX,
                    duration: IDLE_ANIM.LEAD_DASH_MS * 1.1,
                    ease: 'Sine.easeInOut',
                    onUpdate: (tween: Tweens.Tween) => this.showRun(tween.progress),
                    onComplete: () => {
                        this.sprite.setFlipX(false);
                        this.showStanding();
                        this.busy = false;
                    },
                });
            },
        });
    }

    /** Held victory pulse (and running on the spot) until resetPose() (ratio dropped back under 100%). */
    playVictory() {
        this.victoryTween?.stop();
        if (this.busy) {
            // cut a cheering dash short: back to the post at once
            this.scene.tweens.killTweensOf(this);
            this.sprite.setFlipX(false);
            this.setPosition(this.baseX, this.y);
            this.busy = false;
        }
        const s = this.baseScale;
        this.setScale(s);
        const started = this.scene.time.now;
        this.victoryTween = this.scene.tweens.add({
            targets: this,
            scaleX: s * 1.08,
            scaleY: s * 1.08,
            duration: 500,
            yoyo: true,
            repeat: -1,
            ease: 'Sine.easeInOut',
            // The same endless tween drives the run-on-the-spot frames: no extra timer, no extra wake-ups.
            onUpdate: () => {
                if (this.runFrames.length === 0) return;
                const key = this.runFrames[Math.floor((this.scene.time.now - started) / 110) % this.runFrames.length];
                if (this.sprite.texture.key !== key) this.sprite.setTexture(key);
            },
        });
        const o = this.sparkleOrigin();
        emitSparkles(this.scene, o.x, o.y, o.spread * 1.4, 20);
    }

    resetPose() {
        this.victoryTween?.stop();
        this.victoryTween = undefined;
        this.setScale(this.baseScale);
        this.showStanding();
    }
}
