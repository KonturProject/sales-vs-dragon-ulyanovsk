import { Display, GameObjects, Scene, Tweens } from 'phaser';
import { HeroDef } from '../systems/RosterConfig';
import { FX, GAME, HERO } from '../core/Constants';
import { emitBurst, emitSparkles, emitShockwaveRing, emitComicText, Swayable } from '../systems/Fx';
import { AudioSystem } from '../systems/Audio';
import { idleKeyOf } from '../systems/CharacterLoader';

/**
 * A department mascot. The sprite is anchored at its feet (bottom-center) and
 * every texture — standing and strike frames alike — is already at one common
 * pixel scale and centred on the feet (tools/build-characters.py), so swapping
 * textures never changes the character's size or makes it jump sideways, and
 * squash/stretch tweens pivot around the feet.
 *
 * The object belongs to a *slot* (a department's place on the stage); which character
 * looks out of it can change at any time (setCharacter — the admin picks the heroes).
 *
 * Standing, the hero never moves vertically (no bob) — it stands on the floor.
 */
export class HeroSprite extends GameObjects.Container implements Swayable {
    readonly slug: string;
    private sprite: GameObjects.Image;
    private baseX: number;
    private baseY: number;
    private baseScale: number;
    private busy = false;
    /** Standing up, keeled over on the floor, or dozing on its feet (see IdleMood). */
    private posture: 'standing' | 'down' | 'dozing' = 'standing';
    /** Which way it fell / leans: +1 toward the dragon (right), -1 away from it. */
    private lean: 1 | -1 = -1;
    private zzz: GameObjects.Text | null = null;
    private tintColor: number;
    private defaultTexture: string;
    /** Strike frames in order: wind-up first, the blow (weapon fully out) last. */
    private hitPoses: string[] = [];
    private characterId: string;
    /** The breathing loop (a spritesheet strip), stepped by PenScene's shared timer; null if the character has none. */
    private idleKey: string | null = null;
    private idleFrames = 0;
    private idleFrame = 0;
    /** It is this hero's turn in the live-stand rotation (systems/LiveStand.ts). */
    private breathing = false;

    constructor(scene: Scene, x: number, y: number, def: HeroDef, scaleMul = 1) {
        super(scene, x, y);
        this.slug = def.slug;
        this.baseX = x;
        this.baseY = y;
        this.baseScale = HERO.TEXTURE_SCALE * scaleMul;
        this.tintColor = Display.Color.HexStringToColor(def.color).color;
        this.defaultTexture = def.sprite;
        this.characterId = def.characterId;
        this.collectHitPoses(def);
        this.setupIdle(def);

        this.sprite = scene.add.image(0, 0, def.sprite).setOrigin(0.5, 1);
        this.add(this.sprite);
        this.setScale(this.baseScale);

        scene.add.existing(this);
    }

    /** The strike frames `<sprite>_hit1..N` that actually loaded, in order. */
    private collectHitPoses(def: HeroDef) {
        this.hitPoses = [];
        for (let i = 1; i <= def.hits; i++) {
            const key = `${def.sprite}_hit${i}`;
            if (this.scene.textures.exists(key)) this.hitPoses.push(key);
        }
    }

    private setupIdle(def: HeroDef) {
        this.idleKey = def.idle && this.scene.textures.exists(idleKeyOf(def)) ? idleKeyOf(def) : null;
        this.idleFrames = def.idle?.frames ?? 0;
        this.idleFrame = this.idleFrames > 0 ? Math.floor(Math.random() * this.idleFrames) : 0; // heroes do not breathe in step
    }

    isAtEase() {
        return !this.busy && this.posture === 'standing' && this.idleKey !== null;
    }

    /** Its turn begins or ends; at the end it returns to the static standing frame. */
    setBreathing(on: boolean) {
        this.breathing = on;
        if (!on && this.isAtEase()) this.sprite.setTexture(this.defaultTexture);
    }

    /** One step of the breathing loop; only on its turn and only while standing at ease (not striking, not asleep, not mid-swap). */
    idleStep() {
        if (!this.breathing || !this.idleKey || this.busy || this.posture !== 'standing') return;
        this.idleFrame = (this.idleFrame + 1) % this.idleFrames;
        this.sprite.setTexture(this.idleKey, this.idleFrame);
    }

    /**
     * Another character takes this slot (the admin changed the hero). Waits out a strike in progress;
     * a sleeper is woken first. The new one pops in with a small puff.
     */
    setCharacter(def: HeroDef, attempt = 0) {
        if (def.characterId === this.characterId) return;
        if (!this.scene.textures.exists(def.sprite)) return;
        if (this.busy && attempt < 20) {
            this.scene.time.delayedCall(500, () => this.setCharacter(def, attempt + 1));
            return;
        }
        if (this.posture !== 'standing') this.wakeInstant();
        this.characterId = def.characterId;
        this.tintColor = Display.Color.HexStringToColor(def.color).color;
        this.defaultTexture = def.sprite;
        this.collectHitPoses(def);
        this.setupIdle(def);
        this.sprite.setTexture(def.sprite).setFlipX(false);

        const s = this.baseScale;
        this.scene.tweens.killTweensOf(this);
        this.setScale(s * 0.3);
        this.scene.tweens.add({ targets: this, scaleX: s, scaleY: s, duration: 380, ease: 'Back.easeOut' });
        emitBurst(this.scene, this.baseX, this.baseY - this.sprite.height * s * 0.5, this.tintColor, 12);
    }

    canSway() {
        return !this.busy && this.posture === 'standing';
    }

    get isAsleep() {
        return this.posture !== 'standing';
    }

    /** Keeled over on the floor (takes up room, unlike dozing on its feet). */
    get isLying() {
        return this.posture === 'down';
    }

    /** Horizontal extent it covers right now (standing, or lying if it has fallen) — IdleMood uses it to pick a fall direction that lands on nobody. */
    coveredSpan(): [number, number] {
        if (this.posture === 'down') return this.lyingSpan(this.lean);
        const half = (this.sprite.width * this.baseScale) / 2;
        return [this.baseX - half, this.baseX + half];
    }

    lyingSpan(dir: 1 | -1): [number, number] {
        const length = this.sprite.height * this.baseScale;
        return dir > 0 ? [this.baseX, this.baseX + length] : [this.baseX - length, this.baseX];
    }

    /**
     * Keel over: a stagger, a topple to the floor about the feet (rotate ±90°), a bounce.
     * The body is lifted by half its thickness so it lies *on* the floor line instead of
     * sinking a half-width below it. Static afterwards (a "Zzz" label), no endless motion.
     */
    fallOver(dir: 1 | -1): boolean {
        if (this.busy || this.posture !== 'standing') return false;
        this.busy = true;
        this.posture = 'down';
        this.lean = dir;
        this.sprite.setTexture(this.defaultTexture);
        this.scene.tweens.killTweensOf(this);

        const lying = dir * 90;
        const halfThickness = (this.sprite.width * this.baseScale) / 2;
        this.scene.tweens.chain({
            targets: this,
            tweens: [
                { angle: -dir * 5, duration: 220, ease: 'Sine.easeOut' },
                { angle: dir * 3, duration: 240, ease: 'Sine.easeInOut' },
                {
                    angle: lying, y: this.baseY - halfThickness, duration: 400, ease: 'Quad.easeIn',
                    onComplete: () => {
                        const [from, to] = this.lyingSpan(dir);
                        emitBurst(this.scene, (from + to) / 2, this.baseY - 6, 0xcfc6b8, 9);
                        AudioSystem.playFall();
                    },
                },
                { angle: lying - dir * 6, duration: 110, ease: 'Sine.easeOut' },
                { angle: lying, duration: 160, ease: 'Bounce.easeOut' },
            ],
            onComplete: () => {
                this.busy = false;
                this.showZzz();
            },
        });
        return true;
    }

    /** Doze off on its feet: slowly slumps to one side with its head drooping. */
    doze(dir: 1 | -1): boolean {
        if (this.busy || this.posture !== 'standing') return false;
        this.busy = true;
        this.posture = 'dozing';
        this.lean = dir;
        this.sprite.setTexture(this.defaultTexture);
        this.scene.tweens.killTweensOf(this);

        const s = this.baseScale;
        this.scene.tweens.chain({
            targets: this,
            tweens: [
                { angle: dir * 9, scaleX: s * 1.02, scaleY: s * 0.92, duration: 1100, ease: 'Sine.easeInOut' },
                { angle: dir * 7, duration: 500, ease: 'Sine.easeInOut' },
            ],
            onComplete: () => {
                this.busy = false;
                this.showZzz();
            },
        });
        return true;
    }

    /** Get back on its feet with a small squash-and-stretch pop. (Mid-fall/mid-wake it snaps up instead.) */
    wakeUp() {
        if (this.posture === 'standing') return;
        if (this.busy) {
            this.wakeInstant();
            return;
        }
        this.busy = true;
        this.clearZzz();
        const s = this.baseScale;
        this.scene.tweens.chain({
            targets: this,
            tweens: [
                { angle: 0, y: this.baseY, scaleX: s * 0.94, scaleY: s * 1.06, duration: 320, ease: 'Back.easeOut' },
                { scaleX: s, scaleY: s, duration: 160, ease: 'Sine.easeOut' },
            ],
            onComplete: () => {
                this.posture = 'standing';
                this.busy = false;
            },
        });
        emitSparkles(this.scene, this.baseX, this.baseY - this.sprite.height * s * 0.5, this.sprite.width * s, 4);
    }

    /** Straight back to standing, no animation — used when a sale needs this hero right now. */
    wakeInstant() {
        this.scene.tweens.killTweensOf(this);
        this.clearZzz();
        this.setAngle(0).setPosition(this.baseX, this.baseY).setScale(this.baseScale);
        this.posture = 'standing';
        this.busy = false;
    }

    /** A "Z" drifts up from a sleeper — a rare, short animation (see IDLE.SNORE_*). */
    snore() {
        if (!this.zzz) return;
        const z = this.scene.add.text(this.zzz.x, this.zzz.y, 'Z', {
            fontFamily: 'Arial Black, Arial, sans-serif',
            fontSize: '20px',
            resolution: GAME.RENDER_SCALE,
            color: '#cfe3f5',
        }).setOrigin(0.5).setDepth(1400).setStroke('#0d1220', 3);
        this.scene.tweens.add({
            targets: z,
            y: z.y - 38,
            x: z.x + this.lean * 8,
            alpha: 0,
            scale: 1.35,
            duration: 1500,
            ease: 'Sine.easeOut',
            onComplete: () => z.destroy(),
        });
    }

    /** Static "Zzz" above the sleeper — costs nothing to keep on screen (no tween). */
    private showZzz() {
        this.clearZzz();
        const h = this.sprite.height * this.baseScale;
        const w = this.sprite.width * this.baseScale;
        const [x, y] = this.posture === 'down'
            ? [this.baseX + this.lean * h * 0.5, this.baseY - w - 14]
            : [this.baseX + this.lean * h * 0.16, this.baseY - h * 0.92 - 8];
        this.zzz = this.scene.add.text(x, y, 'Zzz', {
            fontFamily: 'Arial Black, Arial, sans-serif',
            fontSize: '17px',
            resolution: GAME.RENDER_SCALE,
            color: '#cfe3f5',
        }).setOrigin(0.5).setDepth(1400).setStroke('#0d1220', 3).setAlpha(0.92);
    }

    private clearZzz() {
        this.zzz?.destroy();
        this.zzz = null;
    }

    private setPose(textureKey: string) {
        this.sprite.setTexture(textureKey);
    }

    /**
     * Wind-up, dash along the hero's own row until its leading edge reaches the
     * foot of the dragon's mountain (STRIKE_FRONT_X), blow + recoil there, then
     * walk back to the slot. The colored burst, shake and ring fire when the hero
     * *arrives* (HERO.IMPACT_MS after the call), which is also when PenScene makes
     * the dragon react. Used by the hero whose department (СР-код) the incoming
     * sale is mapped to. The run is along x only — the feet stay on the floor at
     * the slot's y (a front-row hero may cover a back-row one for a moment; that
     * reads better than running everyone down to one spot in front of the gold).
     */
    playHit(delta = 0) {
        if (this.posture !== 'standing') this.wakeInstant(); // a sale needs this hero right now
        if (this.busy) return;
        this.busy = true;
        // The idle sway may be mid-tilt; the chain below takes over angle/scale.
        this.scene.tweens.killTweensOf(this);

        const s = this.baseScale;
        const restDepth = this.depth;
        // Just in front of same-row neighbours the dash passes through, still behind the row in front.
        this.setDepth(restDepth + 1);

        // The strike frames play in order (wind-up -> blow). The last one is the blow: its width decides where
        // the hero has to stop so the weapon/fist — not the hero's centre — touches the dragon.
        const frames = this.hitPoses.length > 0 ? this.hitPoses : [this.defaultTexture];
        const pose = frames[frames.length - 1];
        const poseWidth = this.scene.textures.getFrame(pose).width;
        const strikeX = Math.max(this.baseX, HERO.STRIKE_FRONT_X - (poseWidth * s * 1.12) / 2);
        let ghostTick = 0;

        this.scene.tweens.chain({
            targets: this,
            tweens: [
                // anticipation: brief squat/wind-up, a step back
                { x: this.baseX - HERO.WINDUP_BACK, scaleX: s * 0.92, scaleY: s * 1.06, angle: -3, duration: HERO.WINDUP_MS, ease: 'Quad.easeOut' },
                // dash to the dragon, accelerating into the blow
                {
                    x: strikeX, scaleX: s * 1.12, scaleY: s * 0.92, angle: 6, duration: HERO.RUN_MS, ease: 'Quad.easeIn',
                    onStart: () => this.setPose(frames[0]),
                    onUpdate: (tween: Tweens.Tween) => {
                        // Middle frames take turns during the dash; the blow frame is shown on arrival.
                        if (frames.length > 2) {
                            const mid = Math.min(frames.length - 2, 1 + Math.floor(tween.progress * (frames.length - 2)));
                            if (this.sprite.texture.key !== frames[mid]) this.setPose(frames[mid]);
                        }
                        // Low-alpha afterimage trail, throttled so it doesn't spawn one every frame.
                        if (++ghostTick % 3 !== 0) return;
                        const ghost = this.scene.add.image(this.x, this.y, this.sprite.texture.key)
                            .setOrigin(0.5, 1)
                            .setScale(this.scaleX, this.scaleY)
                            .setAngle(this.angle)
                            .setAlpha(0.22)
                            .setTint(this.tintColor)
                            .setDepth(restDepth - 1);
                        this.scene.tweens.add({
                            targets: ghost,
                            alpha: 0,
                            duration: 220,
                            onComplete: () => ghost.destroy(),
                        });
                    },
                    onComplete: () => {
                        this.setPose(pose);
                        // Contact: effects at the leading edge, where the blow lands.
                        const impactX = this.x + this.sprite.width * this.scaleX * 0.35;
                        const impactY = this.y - this.sprite.height * this.baseScale * 0.55;
                        emitBurst(this.scene, impactX, impactY, this.tintColor, 14);
                        this.scene.cameras.main.shake(100, 0.0035);
                        emitShockwaveRing(this.scene, impactX, impactY, this.tintColor);
                        if (delta >= FX.COMIC_TEXT_MIN_DELTA) emitComicText(this.scene, impactX, impactY - 20);
                    },
                },
                // recoil off the dragon
                { x: strikeX - 8, scaleX: s * 0.98, scaleY: s * 1.02, angle: -1.5, duration: HERO.RECOIL_MS, ease: 'Sine.easeOut' },
                // turn around and walk back to the slot
                {
                    x: this.baseX, scaleX: s, scaleY: s, angle: 0, duration: HERO.RETURN_MS, ease: 'Sine.easeInOut',
                    onStart: () => {
                        this.setPose(this.defaultTexture);
                        this.sprite.setFlipX(true);
                    },
                },
            ],
            onComplete: () => {
                this.sprite.setFlipX(false);
                this.setDepth(restDepth);
                this.busy = false;
            },
        });
    }

    /**
     * Victory bounce — a squash/stretch, repeated a few times. Only scale is
     * touched, so the feet stay planted on the floor.
     */
    playCelebrate() {
        if (this.posture !== 'standing') this.wakeInstant();
        const s = this.baseScale;
        this.scene.tweens.chain({
            targets: this,
            tweens: [
                { scaleX: s * 0.92, scaleY: s * 1.1, duration: 120, ease: 'Quad.easeOut' },
                { scaleX: s * 1.08, scaleY: s * 0.92, duration: 140, ease: 'Quad.easeIn' },
                { scaleX: s, scaleY: s, duration: 200, ease: 'Bounce.easeOut' },
            ],
            repeat: 2,
        });
        emitSparkles(this.scene, this.x, this.y - this.sprite.height * this.baseScale * 0.5, this.sprite.width * this.baseScale * 0.9, 10);
    }
}
