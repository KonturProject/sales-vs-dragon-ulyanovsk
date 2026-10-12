import { GameObjects, Scene } from 'phaser';
import { GAME } from '../core/Constants';

const FONT_PX = 12;
const PAD_X = 10;
export const PLATE_HEIGHT = 21;

/**
 * A department's nameplate — «ВШ1 • Измайлова И.» on a dark wooden plate with a thin gold frame and cream lettering
 * (the style the branch asked for, without the coat of arms). Static: drawn once, redrawn only when the text changes.
 */
export class NamePlate extends GameObjects.Container {
    private readonly frame: GameObjects.Graphics;
    private readonly label: GameObjects.Text;

    constructor(scene: Scene, x: number, y: number, text: string) {
        super(scene, x, y);
        this.frame = scene.add.graphics();
        this.label = scene.add.text(0, 0.5, '', {
            fontFamily: 'Georgia, "Palatino Linotype", "Book Antiqua", "Times New Roman", serif',
            fontStyle: 'bold',
            fontSize: `${FONT_PX}px`,
            color: '#f3dfb0',
            resolution: GAME.RENDER_SCALE,
        }).setOrigin(0.5).setShadow(0, 1, '#000000', 2, false, true);
        this.add([this.frame, this.label]);
        this.setText(text);
        scene.add.existing(this);
    }

    setText(text: string): this {
        if (this.label.text === text) return this;
        this.label.setText(text);

        const w = Math.ceil(this.label.width) + PAD_X * 2;
        const h = PLATE_HEIGHT;
        const g = this.frame.clear();
        // Wooden rim.
        g.fillStyle(0x3b2513, 0.96);
        g.fillRoundedRect(-w / 2, -h / 2, w, h, 4);
        g.lineStyle(1, 0x140b05, 0.9);
        g.strokeRoundedRect(-w / 2, -h / 2, w, h, 4);
        // Thin gold frame.
        g.lineStyle(1.2, 0xb8924f, 1);
        g.strokeRoundedRect(-w / 2 + 2, -h / 2 + 2, w - 4, h - 4, 3);
        // Dark field the name sits on.
        g.fillStyle(0x1b120b, 0.95);
        g.fillRoundedRect(-w / 2 + 3, -h / 2 + 3, w - 6, h - 6, 2);
        return this;
    }
}
