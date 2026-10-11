import { GameObjects, Scene, Tweens } from 'phaser';
import { HERO } from '../core/Constants';
import { emitSparkles, Swayable } from '../systems/Fx';

/**
 * The branch lead. Not tied to any department: stands apart from the fighters, never
 * throws a punch, cheers on every sale and celebrates the victory. Uses only the
 * standing frame of a character, so all reactions are code-driven (scale/sparkles).
 * Which character it is can change at any time (setCharacter — the admin picks).
 */
export class LeadSprite extends GameObjects.Container implements Swayable {
    private sprite: GameObjects.Image;
    private victoryTween?: Tweens.Tween;
    private baseScale: number;

    constructor(scene: Scene, x: number, y: number, textureKey: string, scaleMul = 1) {
        super(scene, x, y);
        this.baseScale = HERO.TEXTURE_SCALE * scaleMul;
        this.sprite = scene.add.image(0, 0, textureKey).setOrigin(0.5, 1);
        this.add(this.sprite);
        this.setScale(this.baseScale);
        scene.add.existing(this);
    }

    canSway() {
        return !this.victoryTween;
    }

    /** Another character takes the lead's place: pops in with a small scale-up. */
    setCharacter(textureKey: string) {
        if (this.sprite.texture.key === textureKey || !this.scene.textures.exists(textureKey)) return;
        this.sprite.setTexture(textureKey);
        const s = this.baseScale;
        this.scene.tweens.killTweensOf(this);
        this.setScale(s * 0.3);
        this.victoryTween = undefined;
        this.scene.tweens.add({ targets: this, scaleX: s, scaleY: s, duration: 380, ease: 'Back.easeOut' });
    }

    /** Horizontal extent on screen. */
    span(): [number, number] {
        const half = (this.sprite.width * this.baseScale) / 2;
        return [this.x - half, this.x + half];
    }

    private sparkleOrigin() {
        return {
            x: this.x,
            y: this.y - this.sprite.height * this.baseScale * 0.6,
            spread: this.sprite.width * this.baseScale * 0.9,
        };
    }

    /** Small motivating flourish on every sale (scale only — the idle bob owns `y`). */
    playCheer() {
        const s = this.baseScale;
        this.scene.tweens.add({ targets: this, scaleX: s * 1.06, scaleY: s * 1.06, duration: 220, yoyo: true, ease: 'Quad.easeOut' });
        const o = this.sparkleOrigin();
        emitSparkles(this.scene, o.x, o.y, o.spread, 6);
    }

    /** Held victory pulse until resetPose() (ratio dropped back under 100%). */
    playVictory() {
        this.victoryTween?.stop();
        const s = this.baseScale;
        this.setScale(s);
        this.victoryTween = this.scene.tweens.add({
            targets: this,
            scaleX: s * 1.08,
            scaleY: s * 1.08,
            duration: 500,
            yoyo: true,
            repeat: -1,
            ease: 'Sine.easeInOut',
        });
        const o = this.sparkleOrigin();
        emitSparkles(this.scene, o.x, o.y, o.spread * 1.4, 20);
    }

    resetPose() {
        this.victoryTween?.stop();
        this.victoryTween = undefined;
        this.setScale(this.baseScale);
    }
}
