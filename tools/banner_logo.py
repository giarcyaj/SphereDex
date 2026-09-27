"""Cut a set logo out of an official announcement banner.

The official site announces products with a template banner: a plain beige, lightly patterned
background, the PALWORLD OFFICIAL CARD GAME header at the top, the set logo in the middle and a
line of date text under it (e.g. BP03-ordersheet-banner-template.png). This finds the logo as the
tallest block of foreground rows in the middle band, removes the background by flood-filling
beige-hued pixels in from the crop edge (so the banner's drop shadow, which is the beige darkened,
goes too, while light highlights inside the logo's outline stay), and cleans the beige out of the
semi-transparent edge pixels.

Anything that does not look like that template (a busy background, no clear logo block, an odd
aspect ratio) returns None, so a key-visual banner never becomes a broken "logo".
"""
from __future__ import annotations

import io

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

LOGO_WIDTH = 660
CHROMA_IN, CHROMA_OUT = 0.03, 0.08
MIN_BRIGHTNESS = 0.45


def _background(a: np.ndarray) -> tuple[np.ndarray, float]:
    border = np.concatenate([a[0], a[-1], a[:, 0], a[:, -1]])
    return np.median(border, axis=0), float(border.std(axis=0).mean())


def _bg_mask(a: np.ndarray, bg: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(edge-connected background mask, chromaticity distance) for an RGB float array."""
    chroma = a / np.maximum(a.sum(axis=2, keepdims=True), 1)
    dist = np.sqrt(((chroma - bg / bg.sum()) ** 2).sum(axis=2))
    k = a.sum(axis=2) / bg.sum()
    h, w = dist.shape
    # copy(): fromarray shares the array's read-only buffer, and floodfill silently writes nothing to it.
    fill = Image.fromarray((((dist < CHROMA_IN) & (k > MIN_BRIGHTNESS)) * 255).astype(np.uint8)).copy()
    step = max(1, min(h, w) // 150)
    seeds = [(x, 0) for x in range(0, w, step)] + [(x, h - 1) for x in range(0, w, step)] + \
            [(0, y) for y in range(0, h, step)] + [(w - 1, y) for y in range(0, h, step)]
    for sx, sy in seeds:
        if fill.getpixel((sx, sy)) == 255:
            ImageDraw.floodfill(fill, (sx, sy), 128)
    return np.asarray(fill) == 128, dist


def find_logo_box(im: Image.Image) -> tuple[int, int, int, int] | None:
    """Bounding box of the logo in full-resolution coordinates, or None when not a template banner."""
    scale = 1600 / im.width
    small = im.convert("RGB").resize((1600, max(1, round(im.height * scale))))
    a = np.asarray(small).astype(np.float32)
    bg, spread = _background(a)
    if spread > 30 or bg.mean() < 120:           # busy or dark border: a key visual, not the template
        return None
    bgmask, _ = _bg_mask(a, bg)
    fg = ~bgmask
    h, w = fg.shape
    top, bottom = int(h * 0.33), int(h * 0.88)
    rows = fg[top:bottom].sum(axis=1) > w * 0.01
    runs, start, gap = [], None, 0
    max_gap = max(2, int(h * 0.015))
    for i, on in enumerate(list(rows) + [False] * (max_gap + 1)):
        if on:
            start = i if start is None else start
            gap = 0
        elif start is not None:
            gap += 1
            if gap > max_gap:
                runs.append((start, i - gap + 1))
                start, gap = None, 0
    if not runs:
        return None
    y0, y1 = max(runs, key=lambda r: r[1] - r[0])
    if (y1 - y0) < h * 0.12:
        return None
    y0, y1 = y0 + top, y1 + top
    cols = np.where(fg[y0:y1].sum(axis=0) > (y1 - y0) * 0.02)[0]
    if not len(cols):
        return None
    x0, x1 = int(cols[0]), int(cols[-1]) + 1
    aspect = (x1 - x0) / (y1 - y0)
    if not 1.1 <= aspect <= 6:
        return None
    pad = int(h * 0.02)
    x0, y0, x1, y1 = max(0, x0 - pad), max(0, y0 - pad), min(w, x1 + pad), min(h, y1 + pad)
    return tuple(round(v / scale) for v in (x0, y0, x1, y1))


def cut_logo(im: Image.Image, width: int = LOGO_WIDTH) -> Image.Image | None:
    """The logo as a transparent RGBA image `width` px wide, or None."""
    box = find_logo_box(im)
    if not box:
        return None
    a = np.asarray(im.convert("RGB").crop(box)).astype(np.float32)
    bg, _ = _background(a)
    bgmask, dist = _bg_mask(a, bg)
    near = np.asarray(Image.fromarray((bgmask * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(7))) > 0
    alpha = np.ones(dist.shape, np.float32)
    ramp = np.clip((dist - CHROMA_IN) / (CHROMA_OUT - CHROMA_IN), 0, 1)
    alpha[near] = ramp[near]
    alpha[bgmask] = 0
    coverage = float((alpha > 0.5).mean())
    if not 0.2 <= coverage <= 0.97:
        return None
    rgb = a.copy()
    edge = (alpha > 0.02) & (alpha < 0.999)
    aa = alpha[edge][:, None]
    rgb[edge] = np.clip((a[edge] - (1 - aa) * bg) / aa, 0, 255)
    logo = Image.fromarray(np.dstack([rgb, alpha * 255]).astype(np.uint8), "RGBA")
    bbox = logo.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    if not bbox:
        return None
    logo = logo.crop(bbox)
    return logo.resize((width, max(1, round(logo.height * width / logo.width))), Image.LANCZOS)


def banner_thumb(im: Image.Image, width: int = 960) -> Image.Image:
    im = im.convert("RGB")
    return im.resize((width, max(1, round(im.height * width / im.width))), Image.LANCZOS)


def webp_bytes(im: Image.Image, quality: int = 85) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=quality, method=6)
    return buf.getvalue()
