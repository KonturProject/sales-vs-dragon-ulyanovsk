import { Scene } from 'phaser';
import { GAME } from './Constants';

/**
 * Make a scene's main camera show the logical GAME.WIDTH × GAME.HEIGHT world on a
 * canvas that is GAME.RENDER_SCALE times larger. Every scene must call this once
 * at the start (Preloader, PenScene, HUDScene), otherwise it would only fill the
 * top-left corner of the bigger canvas. Zoom pivots on the camera origin, so the
 * origin is moved to the top-left corner — world (0,0) stays at buffer (0,0).
 */
export function fitCameraToGame(scene: Scene) {
    scene.cameras.main.setOrigin(0, 0).setZoom(GAME.RENDER_SCALE).setScroll(0, 0);
}
