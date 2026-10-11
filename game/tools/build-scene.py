"""Builds the stage background (game/public/assets/sprites/bg_scene.jpg, 1280x720) from the CC0 'Rocky Pass' layers.

    python tools/build-scene.py

Sky, far mountains and the rock arch are the pack's three parallax layers at 3x (nearest, crisp pixels). The floor the
heroes stand on is generated: sandy ground in the pack's own palette, from FLOOR_TOP down (heroes' feet are at
y 508..578, the gold mountain's foot at y 530 — see HERO.SLOTS / DRAGON in core/Constants.ts), with a few props.
"""
import os
import random

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
GAME = os.path.dirname(HERE)
SRC = os.path.join(GAME, 'assets-source', 'scene')
OUT = os.path.join(GAME, 'public', 'assets', 'sprites', 'bg_scene.jpg')

W, H = 1280, 720
K = 3  # layer upscale (source layers are 240 px tall: 240*3 = 720)
FLOOR_TOP = 438
SAND = [(192, 128, 80), (176, 104, 64), (176, 104, 64), (144, 80, 48), (144, 80, 48), (128, 64, 32)]
LIP = (96, 37, 12)


def layer(name, dx=0):
    im = Image.open(os.path.join(SRC, name + '.png')).convert('RGBA')
    im = im.resize((im.width * K, im.height * K), Image.NEAREST)
    out = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    out.alpha_composite(im, (-dx, 0))
    return out


def prop(name, x, y, flip=False):
    im = Image.open(os.path.join(SRC, 'props', name + '.png')).convert('RGBA')
    if flip:
        im = im.transpose(Image.FLIP_LEFT_RIGHT)
    return im.resize((im.width * K, im.height * K), Image.NEAREST), (x - im.width * K // 2, y - im.height * K)


def floor():
    rnd = random.Random(7)
    cw, ch = W // K + 1, (H - FLOOR_TOP) // K + 1
    cells = np.zeros((ch, cw, 3), dtype=np.uint8)
    for y in range(ch):
        for x in range(cw):
            # mostly mid sand, with clumps of lighter/darker grains (a cheap blue-noise-ish look)
            c = rnd.choice(SAND)
            if rnd.random() < 0.55 and x > 0:
                c = tuple(cells[y, x - 1])  # horizontal runs read as strata
            cells[y, x] = c
    # a few pebbles
    for _ in range(46):
        px, py = rnd.randrange(2, cw - 6), rnd.randrange(3, ch - 4)
        w, h = rnd.choice([(3, 2), (4, 2), (2, 2), (3, 3)])
        cells[py:py + h, px:px + w] = (144, 80, 48)
        cells[py:py + 1, px:px + w] = (192, 128, 80)
        cells[py + h:py + h + 1, px + 1:px + w + 1] = (96, 37, 12)
    img = Image.fromarray(cells, 'RGB').resize((cw * K, ch * K), Image.NEAREST).convert('RGBA')
    # darker toward the bottom edge (far -> near light falloff), brighter just below the lip
    a = np.array(img).astype(float)
    ys = np.linspace(1.08, 0.72, a.shape[0])[:, None, None]
    a[:, :, :3] = np.clip(a[:, :, :3] * ys, 0, 255)
    img = Image.fromarray(a.astype(np.uint8), 'RGBA')
    # the lip: a dark rim then a light edge, where the plateau meets the rock behind it
    px = np.array(img)
    px[0:K * 2, :, :3] = LIP
    px[K * 2:K * 3, :, :3] = (192, 128, 80)
    return Image.fromarray(px, 'RGBA').crop((0, 0, W, H - FLOOR_TOP))


# ---- mood: the pack is a bright pink sunset; the game wants a darker, grimmer lair -----------------------------------
DARKEN = 0.60          # overall brightness
DESATURATE = 0.72      # 1 = as drawn
TINT = (0.90, 0.84, 1.06)  # multiplied in: cooler, more violet shadows
VIGNETTE = 0.48        # how dark the corners get (0 = none)
GLOW_AT = (955, 470)   # the gold pile: it lights the floor and the rock around it
GLOW_RADIUS = 420
GLOW_COLOR = (255, 150, 60)
GLOW_STRENGTH = 0.34


def grade(img):
    """Darken, desaturate and cool the whole picture, add a vignette and the warm glow of the gold pile."""
    a = np.array(img.convert('RGB')).astype(np.float32) / 255.0
    h, w = a.shape[:2]
    lum = (a * np.array([0.299, 0.587, 0.114], dtype=np.float32)).sum(axis=2, keepdims=True)
    a = lum + (a - lum) * DESATURATE
    a = a * np.array(TINT, dtype=np.float32)
    a = np.power(np.clip(a, 0, 1), 1.18) * DARKEN                      # a touch more contrast, then darker
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    # vignette (elliptical, stronger toward the corners)
    d = np.sqrt(((xx - w / 2) / (w * 0.62)) ** 2 + ((yy - h * 0.46) / (h * 0.72)) ** 2)
    a *= (1.0 - VIGNETTE * np.clip(d, 0, 1.2) ** 2)[..., None]
    # extra darkness on the lower floor (the light dies away toward the viewer)
    a *= np.interp(yy[:, 0], [0, FLOOR_TOP, h], [1.0, 0.95, 0.62])[:, None, None]
    # warm glow from the gold, added (screen-like) so the dragon's pile stays the brightest thing in the picture
    g = np.exp(-(((xx - GLOW_AT[0]) / GLOW_RADIUS) ** 2 + ((yy - GLOW_AT[1]) / (GLOW_RADIUS * 0.62)) ** 2) * 2.2)
    glow = g[..., None] * (np.array(GLOW_COLOR, dtype=np.float32) / 255.0) * GLOW_STRENGTH
    a = 1.0 - (1.0 - np.clip(a, 0, 1)) * (1.0 - glow)
    return Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8), 'RGB')


def main():
    scene = Image.new('RGBA', (W, H), (0, 0, 0, 255))
    scene.alpha_composite(layer('back'))
    scene.alpha_composite(layer('middle'))
    scene.alpha_composite(layer('near', dx=60))
    scene.alpha_composite(floor(), (0, FLOOR_TOP))
    # props: dry grass along the back edge of the floor, crystals at the corners (out of the way of the heroes)
    for name, x, y, flip in [('plant-1', 70, FLOOR_TOP + 22, False), ('plant-2', 420, FLOOR_TOP + 16, False),
                             ('plant-1', 860, FLOOR_TOP + 14, True), ('plant-2', 1200, FLOOR_TOP + 24, True),
                             ('crystal-1', 40, 690, False), ('crystal-2', 150, 704, True),
                             ('crystal-2', 1230, 700, False), ('crystal-1', 1120, 712, True)]:
        im, pos = prop(name, x, y, flip)
        scene.alpha_composite(im, pos)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    grade(scene).save(OUT, quality=93)
    print('wrote', OUT)


if __name__ == '__main__':
    main()
