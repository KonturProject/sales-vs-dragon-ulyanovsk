import { Scene, Display, Loader, Textures } from 'phaser';
import { RosterConfig } from '../systems/RosterConfig';
import { queueCharacter } from '../systems/CharacterLoader';
import { DRAGON, GAME } from '../core/Constants';
import { fitCameraToGame } from '../core/Render';

/** Character, dragon, mountain and background textures (everything except generated text canvases). */
const SMOOTH_TEXTURE_KEY = /^(char_|dragon_|gold_mountain|bg_scene)/;

/**
 * Loads the real cropped sprites from public/assets/sprites/. Any file that
 * doesn't exist yet fails to load — on that
 * specific loaderror we generate a colored-shape placeholder texture under the
 * same key, so the scene is always fully playable regardless of which real
 * assets have landed. Real PNGs simply take priority once present; no code
 * change needed when they're dropped in.
 */
export class Preloader extends Scene {
    constructor() {
        super('Preloader');
    }

    preload() {
        this.drawLoadingScreen();

        this.load.on('loaderror', (file: Loader.File) => this.onLoadError(file.key));

        this.load.setPath('assets/sprites');
        this.load.image('bg_scene', 'bg_scene.jpg');
        this.load.image('gold_mountain', 'gold_mountain.png');
        for (let heads = 0; heads <= DRAGON.HEADS_MAX; heads++) {
            this.load.image(`dragon_heads${heads}`, `dragon_heads${heads}.png`);
        }
        // Only the characters currently on stage; the admin can swap them later (systems/CharacterLoader.ts).
        for (const hero of RosterConfig.heroes) queueCharacter(this.load, hero, () => false);
    }

    create() {
        // The characters are pixel art already enlarged by whole factors in the files (tools/build-characters.py),
        // and the dragon/background are painted. `pixelArt: true` would sample everything with NEAREST, which at a
        // non-integer render scale (1.25×, 1.5× — see core/Quality.ts) leaves jagged, uneven edges; smooth
        // filtering looks the same at 1:1 and better everywhere else.
        for (const key of this.textures.getTextureKeys()) {
            if (SMOOTH_TEXTURE_KEY.test(key)) this.textures.get(key).setFilter(Textures.FilterMode.LINEAR);
        }

        this.scene.start('PenScene');
        this.scene.launch('HUDScene');
    }

    /** Flat Graphics/Text splash + progress bar — same no-asset-needed approach as onLoadError's placeholders. */
    private drawLoadingScreen() {
        const w = GAME.WIDTH;
        const h = GAME.HEIGHT;
        const barW = 320;
        const barH = 18;
        const barX = w / 2 - barW / 2;
        const barY = h / 2 + 20;

        fitCameraToGame(this);
        this.cameras.main.setBackgroundColor('#08090f');

        const title = this.add.text(w / 2, h / 2 - 30, 'ПОБЕДИ ДРАКОНА', {
            fontFamily: 'Arial Black, Arial, sans-serif',
            fontSize: '30px',
            color: '#ffffff',
            resolution: GAME.RENDER_SCALE,
        }).setOrigin(0.5);

        const track = this.add.graphics();
        track.fillStyle(0x0d1220, 0.9);
        track.fillRoundedRect(barX, barY, barW, barH, barH / 2);
        track.lineStyle(2, 0x3a5a7a, 0.9);
        track.strokeRoundedRect(barX, barY, barW, barH, barH / 2);

        const bar = this.add.graphics();

        this.load.on('progress', (value: number) => {
            bar.clear();
            const innerW = Math.max(0, (barW - 6) * value);
            if (innerW <= 1) return;
            bar.fillGradientStyle(0x2fd0e0, 0x2fd0e0, 0x36e08a, 0x36e08a, 1);
            bar.fillRoundedRect(barX + 3, barY + 3, innerW, barH - 6, (barH - 6) / 2);
        });

        this.load.on('complete', () => {
            title.destroy();
            track.destroy();
            bar.destroy();
        });
    }

    private onLoadError(key: string) {
        if (this.textures.exists(key)) return; // real file already loaded fine elsewhere

        // Attack poses and the idle strip are optional (HeroSprite checks texture existence
        // before using them), so a missing one gets no placeholder.
        if (/_(hit\d+|idle)$/.test(key)) return;

        const g = this.make.graphics({ x: 0, y: 0 });

        if (key === 'bg_scene') {
            g.fillGradientStyle(0x08090f, 0x08090f, 0x2a1830, 0x2a1830, 1);
            g.fillRect(0, 0, GAME.WIDTH, GAME.HEIGHT);
            g.generateTexture('bg_scene', GAME.WIDTH, GAME.HEIGHT);
        } else if (key.startsWith('dragon_') || key === 'gold_mountain') {
            g.fillStyle(key === 'gold_mountain' ? 0xc9a227 : 0xc22c2c, 1);
            g.fillRoundedRect(0, 0, 360, 200, 24);
            g.generateTexture(key, 360, 200);
        } else {
            const def = RosterConfig.heroes.find(h => h.sprite === key);
            const color = def ? Display.Color.HexStringToColor(def.color).color : 0x888888;
            g.fillStyle(color, 1);
            g.fillCircle(60, 60, 55);
            g.lineStyle(4, 0xffffff, 1);
            g.strokeCircle(60, 60, 55);
            g.generateTexture(key, 120, 120);
        }

        g.destroy();
    }
}
