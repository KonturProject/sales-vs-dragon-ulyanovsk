"""Builds the selectable heroes (standing frame + strike frames) from the CC0 AutoSprite free library.

    python tools/build-characters.py <folder with the unzipped packs, one sub-folder per pack key>  [--contact preview.png]

The packs are downloaded from the URLs in tools/characters.src.json (`zipUrlTemplate`); unzip each into
<folder>/<key>/x/ (the sheets `<name>.png` + atlas `<name>.json` end up directly in x/).

Per hero: every frame is cropped to its bounding box, padded so that the figure's centre (taken from the standing frame)
is the middle of the texture and the standing frame's feet are the bottom edge (so swapping the strike frame in never
makes the hero jump), and all frames of one hero get ONE scale — the standing figure is TARGET_H texture px tall (the game
draws these textures at HERO.TEXTURE_SCALE = 0.75 -> ~215 px on screen). Colour variants are the same frames with the hue
turned (skin tones can be protected). Writes game/public/assets/sprites/chars/<id>.png, <id>_hit1..N.png and
game/src/game/config/characters.json (id, Russian name, swatch colour, number of strike frames).
"""
import colorsys
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
GAME = os.path.dirname(HERE)
SRC = os.path.join(HERE, 'characters.src.json')
OUT = os.path.join(GAME, 'public', 'assets', 'sprites', 'chars')
CONFIG = os.path.join(GAME, 'src', 'game', 'config', 'characters.json')

TARGET_H = 290          # standing figure height, texture px
CYCLE_FRAMES = 4        # run-cycle frames shown during the dash, before the blow frame
PALETTE = ['#e0524a', '#e8883a', '#e8c53a', '#7ac943', '#3fc2a0', '#45a5e5', '#6f7de8', '#b26fe0', '#e86fb0', '#9aa7b4']


def sheet_frames(folder, name):
    sheet = Image.open(os.path.join(folder, name + '.png')).convert('RGBA')
    data = json.load(open(os.path.join(folder, name + '.json'), encoding='utf-8'))
    out = []
    for k in sorted(data['frames'], key=lambda s: int(s)):
        f = data['frames'][k]
        out.append(sheet.crop((f['x'], f['y'], f['x'] + f['w'], f['y'] + f['h'])))
    return out


def bbox(img):
    return img.getchannel('A').getbbox()


def forward_reach(img):
    """How far the figure reaches to the right of its own mass centre — the weapon thrust forward scores high."""
    a = np.array(img)[:, :, 3] > 40
    xs = np.where(a.any(axis=0))[0]
    if len(xs) == 0:
        return 0
    cols = a.sum(axis=0)
    centre = (cols * np.arange(len(cols))).sum() / cols.sum()
    return xs.max() - centre


def recolor(img, hue=0.0, sat=1.0, val=1.0, protect_skin=False):
    """Turn the hue of everything coloured; near-greys (outlines, metal highlights) and, optionally, skin tones stay."""
    a = np.array(img).astype(np.float32) / 255.0
    rgb = a[:, :, :3]
    mx, mn = rgb.max(axis=2), rgb.min(axis=2)
    d = mx - mn
    v = mx
    s = np.where(mx > 0, d / np.maximum(mx, 1e-6), 0)
    h = np.zeros_like(mx)
    dd = np.maximum(d, 1e-6)
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    h = np.where(mx == r, ((g - b) / dd) % 6, np.where(mx == g, (b - r) / dd + 2, (r - g) / dd + 4)) / 6.0
    h = np.where(d < 1e-6, 0, h)
    change = (s > 0.14) & (a[:, :, 3] > 0.05)
    if protect_skin:
        skin = (h > 0.02) & (h < 0.12) & (s > 0.12) & (s < 0.7) & (v > 0.45)
        change &= ~skin
    h2 = np.where(change, (h + hue) % 1.0, h)
    s2 = np.where(change, np.clip(s * sat, 0, 1), s)
    v2 = np.where(change, np.clip(v * val, 0, 1), v)
    # hsv -> rgb
    i = np.floor(h2 * 6).astype(np.int32) % 6
    f = h2 * 6 - np.floor(h2 * 6)
    p, q, t = v2 * (1 - s2), v2 * (1 - f * s2), v2 * (1 - (1 - f) * s2)
    out = np.zeros_like(rgb)
    for k, (cr, cg, cb) in enumerate([(v2, t, p), (q, v2, p), (p, v2, t), (p, q, v2), (t, p, v2), (v2, p, q)]):
        m = i == k
        out[:, :, 0] = np.where(m, cr, out[:, :, 0])
        out[:, :, 1] = np.where(m, cg, out[:, :, 1])
        out[:, :, 2] = np.where(m, cb, out[:, :, 2])
    res = np.concatenate([out, a[:, :, 3:4]], axis=2)
    return Image.fromarray((np.clip(res, 0, 1) * 255 + 0.5).astype(np.uint8), 'RGBA')


def dominant_color(img, fallback):
    a = np.array(img.resize((max(1, img.width // 3), max(1, img.height // 3)))).reshape(-1, 4)
    best = {}
    for r, g, b, al in a:
        if al < 200:
            continue
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        if s < 0.40 or v < 0.35:
            continue
        key = round(h * 12) % 12
        best[key] = best.get(key, 0) + s * v
    if not best:
        return fallback
    h = max(best, key=best.get) / 12
    r, g, b = colorsys.hsv_to_rgb(h, 0.72, 0.95)
    return '#%02x%02x%02x' % (int(r * 255), int(g * 255), int(b * 255))


def cut(im, centre_x, floor_y, scale):
    b = bbox(im)
    left, right = centre_x - b[0], b[2] - centre_x
    half = max(left, right)
    top = b[1]
    canvas = Image.new('RGBA', (int(np.ceil(half * 2)), int(floor_y - top)), (0, 0, 0, 0))
    canvas.alpha_composite(im.crop((b[0], top, b[2], min(b[3], int(floor_y)))), (int(round(half - left)), 0))
    w, h = max(1, round(canvas.width * scale)), max(1, round(canvas.height * scale))
    return canvas.convert('RGBa').resize((w, h), Image.LANCZOS).convert('RGBA')


def base_frames(root, key, spec):
    folder = os.path.join(root, key, 'x')
    idle = sheet_frames(folder, spec['idle'])[0]
    if 'attack' in spec:
        atk = sheet_frames(folder, spec['attack'])
        strike = [atk[i] for i in spec['strike']]
    else:
        run = sheet_frames(folder, spec['run'])
        blow = max(range(len(run)), key=lambda i: forward_reach(run[i]))
        picks = [round(i * len(run) / CYCLE_FRAMES) % len(run) for i in range(CYCLE_FRAMES)]
        strike = [run[i] for i in picks] + [run[blow]]
    return idle, strike


def main():
    root = sys.argv[1]
    contact = sys.argv[sys.argv.index('--contact') + 1] if '--contact' in sys.argv else None
    spec = json.load(open(SRC, encoding='utf-8'))
    bases = {key: base_frames(root, key, s) for key, s in spec['base'].items()}
    os.makedirs(OUT, exist_ok=True)
    for old in os.listdir(OUT):
        os.remove(os.path.join(OUT, old))

    result, rows = [], []
    for i, v in enumerate(spec['variants']):
        idle, strike = bases[v['base']]
        frames = [idle] + strike
        if 'hue' in v:
            frames = [recolor(f, v['hue'], v.get('sat', 1.0), v.get('val', 1.0), v.get('protect_skin', False)) for f in frames]
        bb = bbox(frames[0])
        cx, floor = (bb[0] + bb[2]) / 2, bb[3]
        scale = TARGET_H / (floor - bb[1])
        outs = [cut(f, cx, floor, scale) for f in frames]
        outs[0].save(os.path.join(OUT, v['id'] + '.png'), optimize=True)
        for k, im in enumerate(outs[1:], 1):
            im.save(os.path.join(OUT, '%s_hit%d.png' % (v['id'], k)), optimize=True)
        result.append({'id': v['id'], 'name': v['name'], 'color': dominant_color(outs[0], PALETTE[i % len(PALETTE)]), 'hits': len(outs) - 1})
        rows.append((v['id'], outs))

    with open(CONFIG, 'w', encoding='utf-8') as f:
        json.dump({'characters': result}, f, ensure_ascii=False, indent=4)
        f.write('\n')
    print('built', len(result), 'heroes ->', OUT)

    if contact:
        cell_w, cell_h, per_row = 330, 320, 6
        sheet = Image.new('RGBA', (cell_w * per_row, cell_h * ((len(rows) + per_row - 1) // per_row)), (58, 44, 62, 255))
        dr = ImageDraw.Draw(sheet)
        for i, (cid, outs) in enumerate(rows):
            x, y = (i % per_row) * cell_w, (i // per_row) * cell_h
            dr.text((x + 4, y + 2), '%d %s' % (i + 1, cid), fill=(255, 255, 0, 255))
            xx = x + 6
            for im in (outs[0], outs[-1]):
                s = im.resize((int(im.width * 0.6), int(im.height * 0.6)), Image.LANCZOS)
                sheet.alpha_composite(s, (xx, y + cell_h - 8 - s.height))
                xx += s.width + 4
        sheet.save(contact)


if __name__ == '__main__':
    main()
