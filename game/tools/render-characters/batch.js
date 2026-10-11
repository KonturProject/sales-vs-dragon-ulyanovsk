// Paste into the console of http://localhost:8090 after the page loaded: renders every character from characters.src.json
// (standing pose + three strike frames) and POSTs the PNGs to the helper server (RENDER_OUT).
(async () => {
    const list = (await (await fetch('/characters.src.json')).json()).characters;
    const TONES = ['#f2c9a5', '#e9b48f', '#d9a074', '#c68a60', '#a86f48'];
    const STRIKE_T = [0.18, 0.30, 0.42]; // seconds into the Punch clip: wind-up, mid, the blow
    for (let i = 0; i < list.length; i++) {
        const { id, file } = list[i];
        const info = await R.load(file + '.fbx');
        // the models' skin is black: give it a skin tone, unless it is a designed colour (goblin, zombie ...)
        const skin = info.mats.find(m => m.startsWith('Skin:'));
        const lum = skin ? parseInt(skin.slice(5, 7), 16) + parseInt(skin.slice(7, 9), 16) + parseInt(skin.slice(9, 11), 16) : 999;
        if (lum < 150) R.setColor('Skin', TONES[i % TONES.length]);
        const frame = R.pose('CharacterArmature|Idle', 0.3).frame; // one framing for all poses of a character
        await R.save(id + '_idle.png');
        for (let k = 0; k < STRIKE_T.length; k++) {
            R.pose('CharacterArmature|Punch', STRIKE_T[k], frame);
            await R.save(id + '_hit' + (k + 1) + '.png');
        }
        console.log('rendered', id);
    }
})();
