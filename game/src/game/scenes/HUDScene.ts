import { Display, GameObjects, Scene } from 'phaser';
import { EventBus, GameEvents, ProgressChangedPayload, FetchErrorPayload, DragonHeadLostPayload, DragonDefeatedPayload, MoneyInPayload, AdminCommandPayload } from '../core/EventBus';
import { GameState } from '../core/GameState';
import { fitCameraToGame } from '../core/Render';
import { DAYS, DRAGON, GAME, HUD, HeroSlug, POLL } from '../core/Constants';
import { emitConfettiBurst, flashScreen } from '../systems/Fx';
import { RosterConfig } from '../systems/RosterConfig';
import { Leaderboard } from '../objects/Leaderboard';
import { AudioSystem } from '../systems/Audio';

const BAR_X = HUD.BAR_X;
const BAR_Y = HUD.BAR_Y;
const BAR_WIDTH = HUD.BAR_WIDTH;
const BAR_HEIGHT = HUD.BAR_HEIGHT;
const BAR_RADIUS = 15;

const STATUS_X = GAME.WIDTH - 16;
const STATUS_Y = GAME.HEIGHT - 16;
const STATUS_TICK_MS = 30000;
const MUTE_X = STATUS_X - 190;
const MUTE_Y = GAME.HEIGHT - 16;

export class HUDScene extends Scene {
    private track!: GameObjects.Graphics;
    private fill!: GameObjects.Graphics;
    private label!: GameObjects.Text;
    private title!: GameObjects.Text;
    private headsText!: GameObjects.Text;
    private banner: GameObjects.Container | null = null;
    private statusDot!: GameObjects.Arc;
    private statusText!: GameObjects.Text;
    private muteIcon!: GameObjects.Text;
    private leaderboard!: Leaderboard;
    private displayedRatio = 0;
    private displayedTotal = 0;
    private displayedPlan = 0;
    private consecutiveFailures = 0;
    private lastGoodAt = Date.now();

    constructor() {
        super('HUDScene');
    }

    create() {
        fitCameraToGame(this);

        this.title = this.add.text(GAME.WIDTH / 2, 4, 'НЕДЕЛЬНЫЙ ПЛАН — ПОБЕДИ ДРАКОНА', {
            fontFamily: 'Arial Black, Arial, sans-serif',
            fontSize: '13px',
            resolution: GAME.RENDER_SCALE,
            color: '#8fb8d9',
        }).setOrigin(0.5, 0).setAlpha(0.9);
        this.title.setLetterSpacing?.(2);

        this.track = this.add.graphics();
        this.drawTrack();

        this.fill = this.add.graphics();
        this.drawDayMarks();

        this.headsText = this.add.text(GAME.WIDTH - 32, BAR_Y + BAR_HEIGHT + 24, '', {
            fontFamily: 'Arial Black, Arial, sans-serif',
            fontSize: '16px',
            resolution: GAME.RENDER_SCALE,
            color: '#ff9a7a',
        }).setOrigin(1, 0).setShadow(0, 1, '#000000', 3, false, true);
        this.renderHeads(GameState.headsRemaining);

        this.label = this.add.text(BAR_X + BAR_WIDTH / 2, BAR_Y + BAR_HEIGHT / 2, '', {
            fontFamily: 'Arial Black, Arial, sans-serif',
            fontSize: '18px',
            resolution: GAME.RENDER_SCALE,
            color: '#ffffff',
        }).setOrigin(0.5).setShadow(0, 1, '#000000', 3, false, true);

        this.statusText = this.add.text(STATUS_X - 12, STATUS_Y, '', {
            fontFamily: 'Arial, sans-serif',
            fontSize: '12px',
            resolution: GAME.RENDER_SCALE,
            color: '#8fb8d9',
        }).setOrigin(1, 0.5).setAlpha(0.9);
        this.statusDot = this.add.circle(STATUS_X, STATUS_Y, 4, 0x36e08a);
        this.renderStatus();

        this.muteIcon = this.add.text(MUTE_X, MUTE_Y, '', {
            fontFamily: 'Arial, sans-serif',
            fontSize: '16px',
            resolution: GAME.RENDER_SCALE,
        }).setOrigin(0.5).setAlpha(0.9).setInteractive({ useHandCursor: true });
        this.renderMuteIcon();
        this.muteIcon.on('pointerdown', () => {
            AudioSystem.init();
            AudioSystem.toggleMute();
            this.renderMuteIcon();
        });

        this.leaderboard = new Leaderboard(this, 16, 70);
        this.leaderboard.update(GameState.byRop);

        const handler = (payload: ProgressChangedPayload) => this.render(payload);
        EventBus.on(GameEvents.PROGRESS_CHANGED, handler);

        const onDataUpdated = () => {
            this.consecutiveFailures = 0;
            this.lastGoodAt = Date.now();
            this.renderStatus();
            this.leaderboard.update(GameState.byRop);
        };
        EventBus.on(GameEvents.DATA_UPDATED, onDataUpdated);

        const onFetchError = (payload: FetchErrorPayload) => {
            this.consecutiveFailures = payload.consecutiveFailures;
            this.renderStatus();
        };
        EventBus.on(GameEvents.FETCH_ERROR, onFetchError);

        const statusTimer = this.time.addEvent({
            delay: STATUS_TICK_MS,
            loop: true,
            callback: () => this.renderStatus(),
        });

        const onDragonDefeated = (payload: DragonDefeatedPayload) => {
            this.time.delayedCall(payload.delayMs + DRAGON.HEAD_LOSS_DURATION_MS, () => {
                if (!GameState.dragonDefeated) return; // ratio dropped back while we were waiting
                emitConfettiBurst(this, 120);
                flashScreen(this, 0xffe89a, 0.35, 220, 3);
                this.showVictoryBanner();
            });
        };
        EventBus.on(GameEvents.DRAGON_DEFEATED, onDragonDefeated);

        // Brief full-screen tint in the scoring department's color — reads as
        // "who just sold" even out of the corner of your eye across a room.
        const onMoneyIn = (payload: MoneyInPayload) => {
            const def = RosterConfig.heroDef(payload.heroSlug as HeroSlug);
            if (def) flashScreen(this, Display.Color.HexStringToColor(def.color).color, 0.18, 80);
        };
        EventBus.on(GameEvents.MONEY_IN, onMoneyIn);

        // A hero in some slot was swapped in the admin page — its colour belongs to the leaderboard row too.
        const onRosterChanged = () => this.leaderboard.refreshColors();
        EventBus.on(GameEvents.ROSTER_CHANGED, onRosterChanged);

        // Each lost head is a daily plan cleared — a quick confetti burst and a
        // bright pulse right on the bar (the final head also gets the full victory).
        const onHeadLost = (payload: DragonHeadLostPayload) => {
            this.time.delayedCall(payload.delayMs, () => {
                if (payload.heads < GameState.headsRemaining) return; // stale: the ratio dropped back meanwhile
                this.renderHeads(payload.heads);
                emitConfettiBurst(this, 30);
                const pulse = this.add.rectangle(
                    BAR_X + BAR_WIDTH / 2, BAR_Y + BAR_HEIGHT / 2, BAR_WIDTH, BAR_HEIGHT, 0xffffff, 0
                );
                this.tweens.add({
                    targets: pulse,
                    alpha: 0.5,
                    duration: 150,
                    yoyo: true,
                    onComplete: () => pulse.destroy(),
                });
            });
        };
        EventBus.on(GameEvents.DRAGON_HEAD_LOST, onHeadLost);

        // Full-screen celebration on request from the admin page (visual only).
        const onAdminCommand = (cmd: AdminCommandPayload) => {
            if (cmd.type !== 'confetti' && cmd.type !== 'celebrate') return;
            emitConfettiBurst(this, 120);
            flashScreen(this, 0xffe89a, 0.3, 200, 2);
        };
        EventBus.on(GameEvents.ADMIN_COMMAND, onAdminCommand);

        this.events.once('shutdown', () => {
            EventBus.off(GameEvents.ADMIN_COMMAND, onAdminCommand);
            EventBus.off(GameEvents.PROGRESS_CHANGED, handler);
            EventBus.off(GameEvents.DATA_UPDATED, onDataUpdated);
            EventBus.off(GameEvents.FETCH_ERROR, onFetchError);
            EventBus.off(GameEvents.DRAGON_DEFEATED, onDragonDefeated);
            EventBus.off(GameEvents.MONEY_IN, onMoneyIn);
            EventBus.off(GameEvents.ROSTER_CHANGED, onRosterChanged);
            EventBus.off(GameEvents.DRAGON_HEAD_LOST, onHeadLost);
            statusTimer.remove();
        });
    }

    private renderMuteIcon() {
        this.muteIcon.setText(AudioSystem.isMuted ? '🔇' : '🔊');
    }

    private renderStatus() {
        const minutesAgo = Math.floor((Date.now() - this.lastGoodAt) / 60000);

        // A single missed poll is routine (Apps Script sometimes answers very slowly) and is not shown.
        if (this.consecutiveFailures < POLL.OFFLINE_AFTER_FAILURES) {
            this.statusDot.setFillStyle(0x36e08a);
            this.statusText.setText('в эфире');
        } else {
            const color = this.consecutiveFailures >= POLL.MAX_CONSECUTIVE_FAILURES ? 0xe0483a : 0xe0b23a;
            this.statusDot.setFillStyle(color);
            this.statusText.setText(`офлайн, обновлено ${minutesAgo} мин назад`);
        }
    }

    private drawTrack() {
        this.track.clear();
        this.track.fillStyle(0x0d1220, 0.85);
        this.track.fillRoundedRect(BAR_X, BAR_Y, BAR_WIDTH, BAR_HEIGHT, BAR_RADIUS);
        this.track.lineStyle(2, 0x3a5a7a, 0.9);
        this.track.strokeRoundedRect(BAR_X, BAR_Y, BAR_WIDTH, BAR_HEIGHT, BAR_RADIUS);
    }

    private render(payload: ProgressChangedPayload) {
        const target = Math.min(1, Math.max(0, payload.ratio));
        const isFirstRender = !this.hasBaseline; // hasBaseline is flipped below; the label must be drawn once even for 0 / 0

        // Regrown heads (new week / raised plan) show immediately; lost heads
        // are shown by the delayed head-loss handler so the counter matches the art.
        if (!this.hasBaseline || payload.headsRemaining > this.shownHeads) this.renderHeads(payload.headsRemaining);
        this.hasBaseline = true;
        if (payload.ratio < 1) this.hideVictoryBanner();

        // Every poll lands here, changed data or not. Starting a tween for an
        // unchanged value would wake the renderer (PowerSaver) for nothing.
        if (isFirstRender || this.displayedRatio !== target) {
            this.tweens.add({
                targets: this,
                displayedRatio: target,
                duration: 500,
                ease: 'Sine.easeOut',
                onUpdate: () => this.drawFill(this.displayedRatio),
            });
        }

        // Odometer-style count-up instead of snapping the number instantly —
        // same tween-a-plain-property trick already used for displayedRatio.
        if (isFirstRender || this.displayedTotal !== payload.totalThisWeek || this.displayedPlan !== payload.plan) {
            this.tweens.add({
                targets: this,
                displayedTotal: payload.totalThisWeek,
                displayedPlan: payload.plan,
                duration: 500,
                ease: 'Sine.easeOut',
                onUpdate: () => this.drawLabel(),
            });
        }
    }

    private shownHeads = DAYS;
    private hasBaseline = false;

    private renderHeads(heads: number) {
        this.shownHeads = heads;
        this.headsText.setText(heads > 0 ? `ГОЛОВ У ДРАКОНА: ${heads} / ${DAYS}` : 'ДРАКОН ПОБЕЖДЁН');
    }

    /** Day dividers on the weekly bar — each one is a daily plan (weekly plan / DAYS). */
    private drawDayMarks() {
        const g = this.add.graphics();
        g.lineStyle(2, 0x8fb8d9, 0.55);
        for (let d = 1; d <= DAYS; d++) {
            const x = BAR_X + (BAR_WIDTH * d) / DAYS;
            if (d < DAYS) g.lineBetween(x, BAR_Y + 3, x, BAR_Y + BAR_HEIGHT - 3);
            this.add.text(x - 6, BAR_Y + BAR_HEIGHT + 5, `день ${d}`, {
                fontFamily: 'Arial, sans-serif',
                fontSize: '12px',
                resolution: GAME.RENDER_SCALE,
                color: '#8fb8d9',
            }).setOrigin(1, 0).setAlpha(0.9);
        }
    }

    private showVictoryBanner() {
        if (this.banner) return;
        // Upper-left of the scene: the empty sky between the leaderboard and the dragon,
        // so the banner never covers the dragon or the heroes.
        const cx = 495;
        const cy = 215;
        const panel = this.add.graphics();
        panel.fillStyle(0x0d1220, 0.88);
        panel.fillRoundedRect(-290, -62, 580, 124, 18);
        panel.lineStyle(4, 0xc9a227, 1);
        panel.strokeRoundedRect(-290, -62, 580, 124, 18);
        const title = this.add.text(0, -20, 'ПОБЕДА НАД ДРАКОНОМ!', {
            fontFamily: 'Arial Black, Arial, sans-serif',
            fontSize: '29px',
            resolution: GAME.RENDER_SCALE,
            color: '#ffe89a',
        }).setOrigin(0.5).setStroke('#7a4a00', 6);
        const sub = this.add.text(0, 28, 'План недели выполнен', {
            fontFamily: 'Arial Black, Arial, sans-serif',
            fontSize: '22px',
            resolution: GAME.RENDER_SCALE,
            color: '#ffffff',
        }).setOrigin(0.5).setShadow(0, 2, '#000000', 4, false, true);
        this.banner = this.add.container(cx, cy, [panel, title, sub]).setDepth(3000).setAlpha(0).setScale(0.6);
        this.tweens.add({ targets: this.banner, alpha: 1, scale: 1, duration: 450, ease: 'Back.easeOut' });
        this.tweens.add({ targets: this.banner, scale: 1.03, duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut', delay: 500 });
    }

    private hideVictoryBanner() {
        if (!this.banner) return;
        const b = this.banner;
        this.banner = null;
        this.tweens.killTweensOf(b);
        this.tweens.add({ targets: b, alpha: 0, duration: 300, onComplete: () => b.destroy() });
    }

    private drawLabel() {
        this.label.setText(
            `${Math.round(this.displayedTotal).toLocaleString('ru-RU')} / ${Math.round(this.displayedPlan).toLocaleString('ru-RU')} ₽`
        );
    }

    private drawFill(ratio: number) {
        this.fill.clear();
        const innerW = (BAR_WIDTH - 6) * ratio;
        if (innerW <= 1) return;

        this.fill.fillGradientStyle(0x2fd0e0, 0x2fd0e0, 0x36e08a, 0x36e08a, 1);
        this.fill.fillRoundedRect(BAR_X + 3, BAR_Y + 3, innerW, BAR_HEIGHT - 6, BAR_RADIUS - 3);

        // Glassy highlight along the top edge.
        this.fill.fillStyle(0xffffff, 0.18);
        this.fill.fillRoundedRect(BAR_X + 4, BAR_Y + 4, Math.max(0, innerW - 2), (BAR_HEIGHT - 6) * 0.4, BAR_RADIUS - 4);
    }
}
