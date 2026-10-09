"""Render the Home "latest update" banner for a SphereDex release.

Run from the repo root:

    python tools/make_release_banner.py

Writes docs/app/img/UPDATE_2_4.webp (1600x900, the file RELEASE_ART points at) and a PNG copy at
tmp/banner-2.4.png for review. tools/rebuild.py mirrors docs/app/img into the Android and iOS bundles.

The layout follows the earlier banners (UPDATE_2_3.webp): dark navy with a faint grid, a huge faint
version number behind, the SPHEREDEX label and the cyan version number, a mock app panel on the right
with corner brackets, coloured bullet lines bottom left, a thin rule and the Pocketpair / Bushiroad
credit. Latin text uses the app's Chakra Petch (docs/fonts, which Pillow reads as woff2); Japanese text
uses Yu Gothic from Windows. The card names come from the real data (CARD_TEXT_JA in src/paldeck.html
and app/src/main/assets/paldeck_cards.json), never typed in here. No prices or money figures.
"""

import json
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
VERSION = "2.4"
OUT_WEBP = ROOT / "docs" / "app" / "img" / "UPDATE_2_4.webp"
OUT_PNG = ROOT / "tmp" / "banner-2.4.png"
W, H = 1600, 900

FONTS = ROOT / "docs" / "fonts"
WIN_FONTS = Path("C:/Windows/Fonts")
LATIN = {w: str(FONTS / f"chakra-petch-{w}.woff2") for w in (500, 600, 700)}
JAPANESE = {"bold": str(WIN_FONTS / "YuGothB.ttc"), "medium": str(WIN_FONTS / "YuGothM.ttc")}

BG = (8, 22, 31)
GRID = (14, 34, 44)
FAINT_NUMBER = (9, 47, 58)
CYAN = (18, 227, 245)
LABEL = (236, 227, 214)
WHITE = (240, 244, 246)
MUTED = (133, 165, 189)
CAPTION = (102, 145, 173)
PANEL = (17, 30, 39)
PANEL_EDGE = (36, 52, 62)
RULE = (31, 52, 61)
DOTS = [(55, 200, 103), (255, 176, 32), (18, 227, 245), (176, 124, 255)]

# The panel rows: the headline card first. Numbers only; names are read from the data.
PANEL_CARDS = ["EBP01-025", "EBP01-001"]
BULLETS = ["Japanese card names", "Price history", "Stock at a glance", "Import from other trackers"]


def font(path, size):
    return ImageFont.truetype(path, size)


def card_names(number):
    """(Japanese name, English name) for a catalogue number, from the shipped data."""
    source = (ROOT / "src" / "paldeck.html").read_text(encoding="utf-8")
    m = re.search(r"var CARD_TEXT_JA = (\{.*?\});\n", source)
    if not m:
        sys.exit("CARD_TEXT_JA not found in src/paldeck.html")
    ja = json.loads(m.group(1))
    catalogue = json.loads((ROOT / "app" / "src" / "main" / "assets" / "paldeck_cards.json").read_text(encoding="utf-8"))
    english = {c["number"]: c["name"] for c in catalogue["cards"]}
    if number not in ja or number not in english:
        sys.exit(f"{number} has no Japanese or English name in the data")
    return ja[number]["n"], english[number]


def has_glyph(f, ch):
    """True when the font draws ch itself rather than its missing glyph box (the woff2 faces are subsets)."""
    if ch.isspace():
        return True
    return glyph_pixels(f, ch) != glyph_pixels(f, "\uffff")


def glyph_pixels(f, ch):
    left, top, right, bottom = f.getbbox(ch)
    im = Image.new("L", (max(1, right - left), max(1, bottom - top)))
    ImageDraw.Draw(im).text((-left, -top), ch, font=f, fill=255)
    return (left, top, right, bottom), im.tobytes()


def draw_runs(draw, xy, text, primary, fallback, fill, spacing=0.0, anchor_right=False):
    """Draw text a character at a time, using the fallback face for any glyph the primary lacks, with
    optional letter spacing. Returns the drawn width."""
    chars = [(ch, primary if has_glyph(primary, ch) else fallback) for ch in text]
    widths = [f.getlength(ch) for ch, f in chars]
    total = sum(widths) + spacing * max(0, len(chars) - 1)
    x, y = xy
    if anchor_right:
        x -= total
    for (ch, f), w in zip(chars, widths):
        draw.text((x, y), ch, font=f, fill=fill, anchor="ls")
        x += w + spacing
    return total


def fit(path, text, size, max_width, minimum=12):
    """The largest size up to `size` at which text fits max_width."""
    while size > minimum and font(path, size).getlength(text) > max_width:
        size -= 1
    return font(path, size)


def glow(img, box, colour, radius, strength):
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).ellipse(box, fill=colour + (strength,))
    layer = layer.filter(ImageFilter.GaussianBlur(radius))
    img.alpha_composite(layer)


def render():
    img = Image.new("RGBA", (W, H), BG + (255,))

    # Faint grid.
    grid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    g = ImageDraw.Draw(grid)
    for x in range(0, W, 48):
        g.line([(x, 0), (x, H)], fill=GRID + (90,), width=1)
    for y in range(0, H, 48):
        g.line([(0, y), (W, y)], fill=GRID + (90,), width=1)
    img.alpha_composite(grid)

    glow(img, (760, -80, 1680, 620), (12, 120, 140), 140, 70)

    d = ImageDraw.Draw(img)
    # Huge faint version number behind everything on the left.
    d.text((-30, 438), VERSION, font=font(LATIN[700], 600), fill=FAINT_NUMBER, anchor="ls")

    # SPHEREDEX label and the version.
    draw_runs(d, (80, 120), "SPHEREDEX", font(LATIN[600], 40), font(JAPANESE["bold"], 40), LABEL, spacing=8)
    d.text((76, 318), VERSION, font=font(LATIN[700], 230), fill=CYAN, anchor="ls")

    # Mock app panel.
    panel = (848, 118, 1520, 475)
    glow(img, (panel[0] - 40, panel[1] - 40, panel[2] + 40, panel[3] + 40), (8, 70, 84), 60, 120)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle(panel, radius=18, fill=PANEL, outline=PANEL_EDGE, width=2)
    # Corner brackets.
    d.line([(826, 96), (882, 96)], fill=CYAN, width=3)
    d.line([(826, 96), (826, 152)], fill=CYAN, width=3)
    d.line([(1486, 497), (1542, 497)], fill=CYAN, width=3)
    d.line([(1542, 441), (1542, 497)], fill=CYAN, width=3)

    # The language tag, styled like the app's pill.
    tag_jp = font(JAPANESE["bold"], 26)
    tag_en = font(LATIN[600], 24)
    tag_w = tag_jp.getlength("日本語") + 16 + tag_en.getlength("JAPANESE") + 3 * 7 + 44
    d.rounded_rectangle((877, 145, 877 + tag_w, 201), radius=10, fill=(41, 50, 33), outline=(255, 176, 32), width=2)
    d.text((899, 183), "日本語", font=tag_jp, fill=(255, 196, 80), anchor="ls")
    draw_runs(d, (899 + tag_jp.getlength("日本語") + 16, 182), "JAPANESE", tag_en, tag_jp, (255, 196, 80), spacing=3)

    rows = [(220, 345), (345, 470)]
    for i, (number, (top, bottom)) in enumerate(zip(PANEL_CARDS, rows)):
        if i:
            d.line([(877, top), (1491, top)], fill=PANEL_EDGE, width=2)
        jp_name, en_name = card_names(number)
        num_font = font(LATIN[500], 26)
        draw_runs(d, (877, top + 52), number, num_font, font(JAPANESE["medium"], 26), CYAN if i == 0 else MUTED)
        name_x, name_w = 1078, 1491 - 1078
        jp_font = fit(JAPANESE["bold"], jp_name, 36 if i == 0 else 32, name_w)
        d.text((name_x, top + 54), jp_name, font=jp_font, fill=WHITE if i == 0 else (205, 214, 220), anchor="ls")
        en_font = fit(LATIN[500], en_name, 25, name_w)
        draw_runs(d, (name_x, top + 92), en_name, en_font, font(JAPANESE["medium"], en_font.size), MUTED)

    draw_runs(d, (1518, 528), "LIVE IN THE APP", font(LATIN[600], 26), font(JAPANESE["bold"], 26), CAPTION,
              spacing=7, anchor_right=True)

    # Bullet lines.
    bullet_font = font(LATIN[500], 54)
    for i, (line, colour) in enumerate(zip(BULLETS, DOTS)):
        cy = 512 + i * 66
        glow(img, (76, cy - 18, 100, cy + 6), colour, 8, 120)
        d = ImageDraw.Draw(img)
        d.ellipse((80, cy - 14, 96, cy + 2), fill=colour)
        draw_runs(d, (128, cy + 12), line, bullet_font, font(JAPANESE["medium"], 54), WHITE)

    d.line([(80, 783), (1520, 783)], fill=RULE, width=2)
    draw_runs(d, (1518, 830), "CARDS © POCKETPAIR / BUSHIROAD", font(LATIN[600], 28), font(JAPANESE["bold"], 28),
              (169, 188, 203), spacing=6, anchor_right=True)
    return img.convert("RGB")


def main():
    img = render()
    OUT_WEBP.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT_WEBP, "WEBP", quality=90, method=6)
    OUT_PNG.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT_PNG, "PNG")
    print(f"{OUT_WEBP.relative_to(ROOT)}: {OUT_WEBP.stat().st_size} bytes, {img.size[0]}x{img.size[1]}")
    print(f"{OUT_PNG.relative_to(ROOT)} (review copy)")


if __name__ == "__main__":
    main()
