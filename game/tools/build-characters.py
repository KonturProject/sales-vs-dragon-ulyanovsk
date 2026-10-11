"""Builds the game sprites of the 30 selectable characters from their renders (see tools/render-characters/README.md).

    python tools/build-characters.py <folder with <id>_idle.png and <id>_hit1..3.png> [--contact preview.png]

Per character: every frame is cropped to its own bounding box, padded so that the FEET sit in the middle of the texture
and the floor is the bottom edge (so swapping the strike frame in never makes the figure jump), and all frames get ONE
scale, chosen so the standing figure is TARGET_H texture px tall (the game draws textures at 0.5 -> ~180 px on screen, the
size the earlier hero set had). Writes game/public/assets/sprites/chars/<id>.png, <id>_hit1..N.png and
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
SRC_LIST = os.path.join(HERE, 'render-characters', 'characters.src.json')
OUT = os.path.join(GAME, 'public', 'assets', 'sprites', 'chars')
CONFIG = os.path.join(GAME, 'src', 'game', 'config', 'characters.json')

TARGET_H = 430  # standing figure height, texture px (~215 px on screen)
HITS = 3

# fallback swatch colours for characters without a saturated colour of their own (grey knights, black ninjas ...)
PALETTE = ['#e0524a', '#e8883a', '#e8c53a', '#7ac943', '#3fc2a0', '#45a5e5', '#6f7de8', '#b26fe0', '#e86fb0', '#9aa7b4']


def bbox(img):
    return img.getchannel('A').getbbox()


def feet_centre_x(img, rows=6):
    """Horizontal centre of the lowest pixel rows of the figure."""
    a = np.array(img)[:, :, 3] > 24
    ys = np.where(a.any(axis=1))[0]
    low = a[max(ys.max() - rows + 1, 0):ys.max() + 1]
    xs = np.where(low.any(axis=0))[0]
    return (xs.min() + xs.max() + 1) / 2


def dominant_color(img, fallback):
    a = np.array(img.resize((img.width // 4, img.height // 4))).reshape(-1, 4)
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
    """Crop to the figure, pad so centre_x is the texture's middle and floor_y its bottom, then scale (premultiplied)."""
    b = bbox(im)
    left, right = centre_x - b[0], b[2] - centre_x
    half = max(left, right)
    top = b[1]
    canvas = Image.new('RGBA', (int(np.ceil(half * 2)), int(floor_y - top)), (0, 0, 0, 0))
    canvas.alpha_composite(im.crop((b[0], top, b[2], min(b[3], int(floor_y)))), (int(round(half - left)), 0))
    w, h = max(1, round(canvas.width * scale)), max(1, round(canvas.height * scale))
    return canvas.convert('RGBa').resize((w, h), Image.LANCZOS).convert('RGBA')


def main():
    renders = sys.argv[1]
    contact = sys.argv[sys.argv.index('--contact') + 1] if '--contact' in sys.argv else None
    chars = json.load(open(SRC_LIST, encoding='utf-8'))['characters']
    os.makedirs(OUT, exist_ok=True)
    result, rows = [], []
    for i, ch in enumerate(chars):
        cid = ch['id']
        idle = Image.open(os.path.join(renders, cid + '_idle.png')).convert('RGBA')
        hits = [Image.open(os.path.join(renders, '%s_hit%d.png' % (cid, k))).convert('RGBA') for k in range(1, HITS + 1)]
        bb = bbox(idle)
        cx, floor = feet_centre_x(idle), bb[3]
        scale = TARGET_H / (floor - bb[1])
        outs = [cut(idle, cx, floor, scale)] + [cut(h, cx, floor, scale) for h in hits]
        outs[0].save(os.path.join(OUT, cid + '.png'), optimize=True)
        for k, im in enumerate(outs[1:], 1):
            im.save(os.path.join(OUT, '%s_hit%d.png' % (cid, k)), optimize=True)
        result.append({'id': cid, 'name': ch['name'], 'color': dominant_color(outs[0], PALETTE[i % len(PALETTE)]), 'hits': HITS})
        rows.append((cid, outs))
    with open(CONFIG, 'w', encoding='utf-8') as f:
        json.dump({'characters': result}, f, ensure_ascii=False, indent=4)
        f.write('\n')
    print('built', len(result), 'characters ->', OUT)

    if contact:
        cell_w, cell_h, per_row = 250, 250, 6
        sheet = Image.new('RGBA', (cell_w * per_row, cell_h * ((len(rows) + per_row - 1) // per_row)), (110, 90, 110, 255))
        dr = ImageDraw.Draw(sheet)
        for i, (cid, outs) in enumerate(rows):
            x, y = (i % per_row) * cell_w, (i // per_row) * cell_h
            dr.text((x + 4, y + 2), '%d %s' % (i + 1, cid), fill=(255, 255, 0, 255))
            xx = x + 6
            for im in (outs[0], outs[-1]):
                s = im.resize((int(im.width * 0.5), int(im.height * 0.5)), Image.LANCZOS)
                sheet.alpha_composite(s, (xx, y + cell_h - 8 - s.height))
                xx += s.width + 4
        sheet.save(contact)


if __name__ == '__main__':
    main()
