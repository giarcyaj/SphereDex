#!/usr/bin/env python3
"""Make the PalDex renders a consistent size, and cut out the one that never was.

THE TWO PROBLEMS
----------------
1. Scale. Every render sits on a 288x288 canvas, but the creature inside spans anywhere from 41% to 93% of
   it. That is not relative size done deliberately: Teafant, one of the smallest Pals in the game, filled
   93% while Grizzbolt, one of the largest, filled 77%. The cause is upstream. The wiki's own files are
   different canvas sizes (Jolthog 163x163, Shadowbeak 430x430) and the set was built by pasting each one
   onto a 288 square without rescaling, so a small source stayed small.

2. Teafant was never cut out. It is a screen grab: 71% opaque with exactly 0.00% partial alpha, where every
   real cutout has a few percent of soft antialiased edge. The wiki's own Teafant.png has the same dark
   backdrop, so there is nothing better to fetch; it is removed here instead, by flooding in from the
   border so dark detail inside the Pal, its eye, survives.

THE TRADE
---------
Scaling up the smallest renders softens them: Jolthog's art is 118 real pixels and reaching the target makes
it about 2x. The tiles render around 150px, and the canvas is already larger than that, so the softness is
slight, while a Pal at 41% next to one at 93% is obvious at a glance. Consistency wins. NO_UPSCALE below
holds back anything that would need more than LIMIT, so nothing is blown up beyond reason.

Run:  python tools/normalise_pal_art.py            (rewrites docs/app/img/PAL_*.webp in place)
      python tools/normalise_pal_art.py --check    (reports, writes nothing)
"""
import argparse
import collections
import glob
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ART = os.path.join(ROOT, "docs", "app", "img")

CANVAS = 288          # unchanged, so nothing else in the app has to care
TARGET = 0.88         # of the canvas, on the creature's long axis
LIMIT = 2.4           # never enlarge a source by more than this


def cut_background(im):
    """Remove the backdrop of a screen grab, flooding in from the border only.

    A plain luminance threshold would punch holes through dark detail inside the subject. Flooding from the
    edge only takes background that is actually connected to the edge.
    """
    w, h = im.size
    rgb = im.convert("RGB").load()
    px = im.load()
    seen = [[False] * h for _ in range(w)]
    q = collections.deque()
    for x in range(w):
        q.append((x, 0))
        q.append((x, h - 1))
    for y in range(h):
        q.append((0, y))
        q.append((w - 1, y))
    while q:
        x, y = q.popleft()
        if x < 0 or y < 0 or x >= w or y >= h or seen[x][y]:
            continue
        if max(rgb[x, y]) >= 110:        # bright enough to be the subject
            continue
        seen[x][y] = True
        q.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    cut = 0
    for x in range(w):
        for y in range(h):
            if seen[x][y]:
                r, g, b, _ = px[x, y]
                px[x, y] = (r, g, b, 0)
                cut += 1
    return cut


def looks_uncut(im):
    """A real cutout has a soft edge. A pasted rectangle has none."""
    w, h = im.size
    hist = im.getchannel("A").histogram()
    return (sum(hist[1:255]) / (w * h)) < 0.003 and (hist[255] / (w * h)) > 0.5


def normalise(path, write):
    im = Image.open(path).convert("RGBA")
    name = os.path.basename(path)
    note = ""

    if looks_uncut(im):
        cut_background(im)
        note = " background removed"

    box = im.getchannel("A").getbbox()
    if not box:
        return name, "empty, skipped"
    art = im.crop(box)
    aw, ah = art.size
    want = CANVAS * TARGET
    scale = want / max(aw, ah)
    if scale > LIMIT:
        scale = LIMIT
        note += " (held at %.1fx, source is small)" % LIMIT
    nw, nh = max(1, round(aw * scale)), max(1, round(ah * scale))
    art = art.resize((nw, nh), Image.LANCZOS)

    out = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    out.paste(art, ((CANVAS - nw) // 2, (CANVAS - nh) // 2), art)
    before = max(aw, ah) / CANVAS
    after = max(nw, nh) / CANVAS
    if write:
        out.save(path, "WEBP", quality=92, method=6)
    return name, "fill %.0f%% -> %.0f%%%s" % (100 * before, 100 * after, note)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="report only, write nothing")
    args = ap.parse_args()

    files = sorted(glob.glob(os.path.join(ART, "PAL_*.webp")))
    if not files:
        print("no PAL_*.webp found in %s" % ART)
        return 1
    changed = 0
    for p in files:
        name, how = normalise(p, not args.check)
        if "->" in how:
            a, b = how.split("->")[0], how.split("->")[1]
            if a.strip().rstrip("%") != b.strip().split()[0].rstrip("%"):
                changed += 1
                print("  %-30s %s" % (name, how))
    print("\n%d of %d renders %s" % (changed, len(files), "would change" if args.check else "rewritten"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
