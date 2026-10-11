import { Loader, Scene, Textures } from 'phaser';
import { HeroDef } from './RosterConfig';

/** Texture keys one character needs: the standing frame and `<sprite>_hit1..N`. */
export function characterTextureKeys(def: HeroDef): string[] {
    const keys = [def.sprite];
    for (let i = 1; i <= def.hits; i++) keys.push(`${def.sprite}_hit${i}`);
    return keys;
}

/** The breathing-loop strip of a character (a spritesheet, see tools/build-characters.py). */
export function idleKeyOf(def: HeroDef): string {
    return `${def.sprite}_idle`;
}

/** Everything one character needs on screen: the standing frame, the strike frames and the idle strip. */
export function allCharacterKeys(def: HeroDef): string[] {
    return def.idle ? [...characterTextureKeys(def), idleKeyOf(def)] : characterTextureKeys(def);
}

/** Puts the files of one character into a loader queue (skipping textures that already exist). */
export function queueCharacter(load: Loader.LoaderPlugin, def: HeroDef, has: (key: string) => boolean) {
    for (const key of characterTextureKeys(def)) {
        if (!has(key)) load.image(key, fileFor(key));
    }
    if (def.idle && !has(idleKeyOf(def))) {
        load.spritesheet(idleKeyOf(def), fileFor(idleKeyOf(def)), { frameWidth: def.idle.width, frameHeight: def.idle.height });
    }
}

/** `char_<id>` -> `chars/<id>.png`, `char_<id>_hit2` -> `chars/<id>_hit2.png` (relative to assets/sprites). */
export function fileFor(key: string): string {
    return `chars/${key.replace(/^char_/, '')}.png`;
}

/**
 * Makes sure the textures of these characters are in memory, loading what is missing, then calls `done`.
 * Only the characters on stage are ever loaded (the other selectable ones stay on the server until picked), so a
 * display's memory does not depend on how many characters exist. A file that fails to load just stays missing —
 * callers check `scene.textures.exists` before using a texture.
 */
export function loadCharacters(scene: Scene, defs: HeroDef[], done: () => void) {
    const missing = defs.flatMap(allCharacterKeys).filter(key => !scene.textures.exists(key));
    if (missing.length === 0) {
        done();
        return;
    }
    scene.load.setPath('assets/sprites');
    for (const def of defs) queueCharacter(scene.load, def, key => scene.textures.exists(key));
    scene.load.once('complete', () => {
        for (const key of missing) {
            if (scene.textures.exists(key)) scene.textures.get(key).setFilter(Textures.FilterMode.LINEAR);
        }
        done();
    });
    scene.load.start();
}
