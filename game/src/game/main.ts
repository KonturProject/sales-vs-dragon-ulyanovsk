import { Boot } from './scenes/Boot';
import { Preloader } from './scenes/Preloader';
import { PenScene } from './scenes/PenScene';
import { HUDScene } from './scenes/HUDScene';
import { AUTO, Game, Scale } from 'phaser';
import { GAME } from './core/Constants';
import { QUALITY } from './core/Quality';
import { PowerSaver } from './core/PowerSaver';

//  Find out more information about the Game Config at:
//  https://docs.phaser.io/api-documentation/typedef/types-core#gameconfig
const config: Phaser.Types.Core.GameConfig = {
    type: AUTO,
    width: Math.round(GAME.WIDTH * GAME.RENDER_SCALE),
    height: Math.round(GAME.HEIGHT * GAME.RENDER_SCALE),
    parent: 'game-container',
    backgroundColor: '#0b1220',
    pixelArt: true,
    roundPixels: true,
    // `limit` makes Phaser run the game step only that often (default: every browser frame, i.e. 60–144 times a second);
    // PowerSaver retunes it at run time — fast while something moves, slow while the picture is still.
    fps: { target: QUALITY.activeFps, limit: QUALITY.activeFps },
    scale: {
        mode: Scale.FIT,
        autoCenter: Scale.CENTER_BOTH
    },
    scene: [
        Boot,
        Preloader,
        PenScene,
        HUDScene
    ]
};

/** Set once the game is running; exposed for the dev `__debug` hook and diagnostics. */
export let powerSaver: PowerSaver | null = null;

const StartGame = (parent: string) => {

    const game = new Game({ ...config, parent });
    game.events.once('ready', () => {
        powerSaver = new PowerSaver(game);
    });
    return game;

}

export default StartGame;
