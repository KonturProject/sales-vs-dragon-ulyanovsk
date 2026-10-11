import { GameObjects, Scene } from 'phaser';
import { GAME } from '../core/Constants';

/** Tweened-circle particle burst — no particle plugin needed. */
export function emitBurst(scene: Scene, x: number, y: number, color: number, count = 10) {
    for (let i = 0; i < count; i++) {
        const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
        const speed = 50 + Math.random() * 70;
        const particle = scene.add.circle(x, y, 2 + Math.random() * 3, color, 1);
        scene.tweens.add({
            targets: particle,
            x: x + Math.cos(angle) * speed,
            y: y + Math.sin(angle) * speed - 20,
            alpha: 0,
            scale: 0.2,
            duration: 380 + Math.random() * 220,
            ease: 'Quad.easeOut',
            onComplete: () => particle.destroy(),
        });
    }
}

/** Small sparkle-shaped burst for celebratory moments (goal reached). */
export function emitSparkles(scene: Scene, x: number, y: number, spread: number, count = 18) {
    for (let i = 0; i < count; i++) {
        const sx = x + (Math.random() - 0.5) * spread;
        const sy = y + (Math.random() - 0.5) * spread * 0.6;
        const star = scene.add.star(sx, sy, 4, 2, 5, 0xffe89a, 1).setScale(0);
        scene.tweens.add({
            targets: star,
            scale: { from: 0, to: 0.8 + Math.random() * 0.6 },
            angle: -90 + Math.random() * 180,
            y: sy - 30 - Math.random() * 40,
            alpha: { from: 1, to: 0 },
            duration: 700 + Math.random() * 500,
            delay: Math.random() * 200,
            ease: 'Cubic.easeOut',
            onComplete: () => star.destroy(),
        });
    }
}

const CONFETTI_COLORS = [0x2fd0e0, 0x36e08a, 0xffe89a, 0xff6688, 0xc9a227];

/** Full-screen falling confetti burst for the weekly-goal finale. */
export function emitConfettiBurst(scene: Scene, count = 120) {
    for (let i = 0; i < count; i++) {
        const x = Math.random() * GAME.WIDTH;
        const color = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
        const piece = scene.add.rectangle(x, -10, 6, 10, color, 1).setAngle(Math.random() * 360);
        scene.tweens.add({
            targets: piece,
            y: GAME.HEIGHT + 20,
            angle: piece.angle + (Math.random() > 0.5 ? 360 : -360),
            x: x + (Math.random() - 0.5) * 120,
            duration: 1800 + Math.random() * 1200,
            delay: Math.random() * 500,
            ease: 'Sine.easeIn',
            onComplete: () => piece.destroy(),
        });
    }
}

/** Brief full-screen color pulse(s) — used for both the goal-finale vignette and per-hit color flashes. */
export function flashScreen(scene: Scene, color: number, alpha: number, duration: number, pulses = 1) {
    const rect = scene.add.rectangle(GAME.WIDTH / 2, GAME.HEIGHT / 2, GAME.WIDTH, GAME.HEIGHT, color, 0)
        .setDepth(2000);
    scene.tweens.add({
        targets: rect,
        alpha,
        duration,
        yoyo: true,
        repeat: pulses - 1,
        ease: 'Sine.easeInOut',
        onComplete: () => rect.destroy(),
    });
}

/** Expanding ring outline at an impact point — reads as a "shockwave" alongside the particle burst. */
export function emitShockwaveRing(scene: Scene, x: number, y: number, color: number): GameObjects.Arc {
    const ring = scene.add.circle(x, y, 6, 0x000000, 0).setStrokeStyle(3, color, 0.9);
    scene.tweens.add({
        targets: ring,
        radius: 40,
        alpha: 0,
        duration: 350,
        ease: 'Quad.easeOut',
        onComplete: () => ring.destroy(),
    });
    return ring;
}

const ONOMATOPOEIA = ['БАМ!', 'ХРЯСЬ!', 'БАХ!', 'ХЛОП!'];

/** Comic-book impact text, Reserved for bigger sales — see FX.COMIC_TEXT_MIN_DELTA. */
export function emitComicText(scene: Scene, x: number, y: number): GameObjects.Text {
    const text = ONOMATOPOEIA[Math.floor(Math.random() * ONOMATOPOEIA.length)];
    const t = scene.add.text(x, y, text, {
        fontFamily: 'Arial Black, Arial, sans-serif',
        fontSize: '26px',
        resolution: GAME.RENDER_SCALE,
        fontStyle: 'bold',
        color: '#fff5f5',
    }).setOrigin(0.5).setAngle(-8).setStroke('#d23a3a', 5);
    scene.tweens.add({
        targets: t,
        y: y - 30,
        angle: 4,
        scale: { from: 0.6, to: 1.1 },
        alpha: { from: 1, to: 0 },
        duration: 550,
        ease: 'Back.easeOut',
        onComplete: () => t.destroy(),
    });
    return t;
}

/** "+50 000 ₽" text that flies from a hero toward the HUD bar and fades — visually ties the hit to the number going up. */
export function emitFloatingAmount(scene: Scene, x: number, y: number, amount: number, targetX: number, targetY: number): GameObjects.Text {
    const t = scene.add.text(x, y, `+${Math.round(amount).toLocaleString('ru-RU')} ₽`, {
        fontFamily: 'Arial Black, Arial, sans-serif',
        fontSize: '18px',
        resolution: GAME.RENDER_SCALE,
        color: '#36e08a',
    }).setOrigin(0.5).setDepth(1500).setShadow(0, 1, '#000000', 3, false, true);
    scene.tweens.add({
        targets: t,
        x: targetX,
        y: targetY,
        alpha: 0,
        scale: 0.7,
        duration: 900,
        ease: 'Cubic.easeIn',
        onComplete: () => t.destroy(),
    });
    return t;
}

export interface Swayable {
    angle: number;
    /** False while the character is busy (mid-strike, victory pose) — it is skipped this round. */
    canSway(): boolean;
}

/**
 * Rare idle sway so standing art doesn't read as a frozen photo: every 10–16 s two or
 * three random characters tilt a little about their feet, a fraction of a second apart.
 * Only `angle` changes — the feet never leave the floor (an up/down bob was removed
 * because the characters looked like they hovered).
 *
 * One shared schedule instead of a timer per character on purpose: each sway is an
 * animation, and animations make the game render at its full frame rate (PowerSaver);
 * seven independent timers kept it out of the low-rate idle mode about a quarter of the time.
 */
export function startIdleSway(scene: Scene, sprites: Swayable[]) {
    const schedule = () => scene.time.delayedCall(10000 + Math.random() * 6000, () => {
        const ready = sprites.filter(s => s.canSway()).sort(() => Math.random() - 0.5);
        ready.slice(0, 2 + Math.floor(Math.random() * 2)).forEach(sprite => {
            scene.time.delayedCall(Math.random() * 500, () => {
                if (!sprite.canSway()) return;
                scene.tweens.chain({
                    targets: sprite,
                    tweens: [
                        { angle: -6, duration: 140, ease: 'Quad.easeOut' },
                        { angle: 0, duration: 260, ease: 'Sine.easeOut' },
                    ],
                });
            });
        });
        schedule();
    });
    schedule();
}

/** Slow, narrow-range alpha drift — reads as ambient life (neon flicker, twinkling stars) without being distracting on an always-on display. */
export function addIdleFlicker(scene: Scene, target: { alpha: number }, minAlpha: number, maxAlpha: number, duration = 4000, delay = 0) {
    target.alpha = maxAlpha;
    scene.tweens.add({
        targets: target,
        alpha: minAlpha,
        duration,
        delay,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
    });
}

/** Gold coins flung out of the dragon's hoard toward the attacker — "winning the gold back". Gravity-arc tween, no particle plugin. */
export function emitCoinBurst(scene: Scene, x: number, y: number, count = 8, towardLeft = true) {
    const dir = towardLeft ? -1 : 1;
    for (let i = 0; i < count; i++) {
        const coin = scene.add.circle(x, y, 3 + Math.random() * 2, 0xf5c518, 1).setStrokeStyle(1, 0xb8860b, 1).setDepth(900);
        const duration = 520 + Math.random() * 260;
        const fall = 70 + Math.random() * 40;
        const peak = 50 + Math.random() * 60;
        scene.tweens.add({
            targets: coin,
            x: x + dir * (50 + Math.random() * 130),
            duration,
            ease: 'Quad.easeOut',
        });
        // Rise to `peak` then fall `fall` below the start: vertical offset = fall*t - peak*4t(1-t).
        scene.tweens.add({
            targets: coin,
            y: y + fall,
            duration,
            ease: (t: number) => t - (peak / fall) * 4 * t * (1 - t),
            onComplete: () => coin.destroy(),
        });
    }
}
