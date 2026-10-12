import { Display, GameObjects, Scene } from 'phaser';
import { GAME, HeroSlug } from '../core/Constants';
import { RosterConfig } from '../systems/RosterConfig';

const ROW_HEIGHT = 22;
/** Room for «● ВШ10 • Бордачева В.» plus a seven-digit sum. */
const PANEL_WIDTH = 270;
const PANEL_PADDING = 6;

interface Row {
    row: GameObjects.Container;
    label: GameObjects.Text;
    amountText: GameObjects.Text;
    swatch: GameObjects.Arc;
}

/** Live-updating, re-sorting mini-leaderboard of the 6 ground departments' weekly totals. */
export class Leaderboard extends GameObjects.Container {
    private rows = new Map<HeroSlug, Row>();

    constructor(scene: Scene, x: number, y: number) {
        super(scene, x, y);

        const groundHeroes = RosterConfig.fighters;

        const panel = scene.add.graphics();
        panel.fillStyle(0x0d1220, 0.8);
        panel.fillRoundedRect(0, 0, PANEL_WIDTH, PANEL_PADDING * 2 + groundHeroes.length * ROW_HEIGHT, 8);
        panel.lineStyle(2, 0x3a5a7a, 0.7);
        panel.strokeRoundedRect(0, 0, PANEL_WIDTH, PANEL_PADDING * 2 + groundHeroes.length * ROW_HEIGHT, 8);
        this.add(panel);

        groundHeroes.forEach((def, i) => {
            const rowY = PANEL_PADDING + i * ROW_HEIGHT;
            const color = Display.Color.HexStringToColor(def.color).color;

            const swatch = scene.add.circle(14, ROW_HEIGHT / 2, 6, color);
            const label = scene.add.text(26, ROW_HEIGHT / 2, RosterConfig.plateText(def.slug), {
                fontFamily: 'Arial, sans-serif',
                fontSize: '13px',
                resolution: GAME.RENDER_SCALE,
                color: '#cfe3f5',
            }).setOrigin(0, 0.5);
            const amountText = scene.add.text(PANEL_WIDTH - 10, ROW_HEIGHT / 2, '0 ₽', {
                fontFamily: 'Arial Black, Arial, sans-serif',
                fontSize: '13px',
                resolution: GAME.RENDER_SCALE,
                color: '#ffffff',
            }).setOrigin(1, 0.5);

            const row = scene.add.container(0, rowY, [swatch, label, amountText]);
            this.add(row);
            this.rows.set(def.slug, { row, label, amountText, swatch });
        });

        scene.add.existing(this);
    }

    /** The hero in a slot changed — the swatch takes the new character's colour. */
    refreshColors() {
        for (const def of RosterConfig.fighters) {
            this.rows.get(def.slug)?.swatch.setFillStyle(Display.Color.HexStringToColor(def.color).color);
        }
    }

    /** A group leader was renamed in the admin page — the row reads «ВШ1 • Фамилия И.» like the nameplate. */
    refreshLabels() {
        for (const def of RosterConfig.fighters) {
            const entry = this.rows.get(def.slug);
            const text = RosterConfig.plateText(def.slug);
            if (entry && entry.label.text !== text) entry.label.setText(text);
        }
    }

    /** Re-sorts rows by amount (descending) and tweens each to its new rank, updating displayed totals. */
    update(byRop: Record<string, number>) {
        const amounts = new Map<HeroSlug, number>();
        for (const [ropName, amount] of Object.entries(byRop)) {
            const slug = RosterConfig.heroSlugForRop(ropName);
            if (!slug) continue;
            amounts.set(slug, (amounts.get(slug) ?? 0) + amount);
        }

        const sorted = [...this.rows.keys()].sort(
            (a, b) => (amounts.get(b) ?? 0) - (amounts.get(a) ?? 0)
        );

        sorted.forEach((slug, rank) => {
            const entry = this.rows.get(slug);
            if (!entry) return;

            // Unchanged rank/amount (most polls) => no tween and no text redraw, so an idle display stays idle.
            const targetY = PANEL_PADDING + rank * ROW_HEIGHT;
            if (entry.row.y !== targetY) {
                this.scene.tweens.add({
                    targets: entry.row,
                    y: targetY,
                    duration: 400,
                    ease: 'Sine.easeInOut',
                });
            }
            const amountLabel = `${Math.round(amounts.get(slug) ?? 0).toLocaleString('ru-RU')} ₽`;
            if (entry.amountText.text !== amountLabel) entry.amountText.setText(amountLabel);
        });
    }
}
