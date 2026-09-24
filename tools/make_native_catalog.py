#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Regenerate the NATIVE card catalog from the app's own card table.

The Android scanner (BinderStore), the iOS scanner (CardResolver) and the web app each
ship a card list. The web app bakes its table into the built HTML; the native apps read
a JSON file (paldeck_cards.json). The JSON was hand-made once and never regenerated, so
35 promo cards baked into the web build were invisible to the native scanners: a Code-mode
scan of EPR-002 did not resolve, and Full-card mode fell back to the wrong printing.

This script derives the JSON FROM THE SAME ROWS the build bakes in (var RAW / RAW2 in
src/paldeck.html), so the two can never drift again. It reuses the table parsing from
tools/catalogue.py (same var RAW / RAW2 / SETS shapes), then converts each row to the
native JSON card object:

  {number, name, kind, sub, rare, color, type, aptitude, cost, power, attack, set, image}

`image` is the card's OFFICIAL-SITE artwork URL (the same URL the web app falls back to
via imgURL()); it is metadata only. The native apps render art from the bundled img/
files via window.CARD_IMG, and the Android CardImageMatcher hashes those same files.

Outputs are written deterministically (sorted keys, compact separators, no trailing
newline) so a re-run with no source change produces a byte-identical file.

Targets (all three are kept byte-identical):
  app/src/main/assets/paldeck_cards.json          (Android)
  ios/SphereDex/SphereDex/Resources/paldeck_cards.json  (iOS)
  ../shared/paldeck_cards.json                    (sibling of the repo, for reference)

Usage:
  python tools/make_native_catalog.py            # regenerate all three
  python tools/make_native_catalog.py --check    # exit 1 if any would change (for CI)

Release step: run this after baking new cards into src/paldeck.html (the same moment you
bump CATALOGUE_VERSION), so the native scanners know the new cards on the next app build.
"""
import argparse, io, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# catalogue.py already knows how to pull RAW / RAW2 / SETS out of the app source and how
# to strip the // comments between rows; reusing it guarantees identical parsing.
from catalogue import SRC, js_array, sets_table, strip_js_comments  # noqa: E402

ANDROID_JSON = os.path.join(HERE, "..", "app", "src", "main", "assets", "paldeck_cards.json")
IOS_JSON = os.path.join(HERE, "..", "ios", "SphereDex", "SphereDex", "Resources", "paldeck_cards.json")
SHARED_JSON = os.path.join(HERE, "..", "..", "shared", "paldeck_cards.json")


def official_image_url(pic):
    """The official-site artwork URL for a RAW row's pic field.

    Rows either carry a full https URL (later promos) or a cardlist-relative path, exactly
    like the web app's imgURL(): IMG_BASE + pic. That URL is where the bundled art originally
    came from, so it is the right value for the JSON's `image` field too.
    """
    IMG_BASE = "https://en.palworld-official-cardgame.com/wordpress/wp-content/images/cardlist/"
    if pic.startswith("http://") or pic.startswith("https://"):
        return pic
    return IMG_BASE + pic


def build_catalog():
    src = io.open(SRC, encoding="utf-8").read()
    raw = js_array(src, "RAW")      # EBP01 rows: set code is not in the row
    raw2 = js_array(src, "RAW2")    # every other set: set code at index 12
    sets_table_src = sets_table(src)

    cards = []
    for r in raw:
        rows = list(r) + ["EBP01"]
        cards.append(rows)
    for r in raw2:
        r = list(r)
        while len(r) < 13:
            r.append("")
        cards.append(r)

    def set_name(code):
        info = sets_table_src.get(code) or {}
        # The web SETS names read "Booster · Dawn of Palpagos"; the native JSON's historical
        # shape is "<kind> · <title>", which is the same string. Keep it verbatim.
        return info.get("name", code)

    out_cards = []
    for row in cards:
        num, name, kind, sub, rare, color, typ, apt, cost, power, attack, pic, setcode = row[:13]
        out_cards.append({
            "number": num,
            "name": name,
            "kind": kind,
            "sub": sub,
            "rare": rare,
            "color": color or "Colorless",
            "type": typ,
            "aptitude": apt,
            "cost": cost,
            "power": power,
            "attack": attack,
            "set": setcode,
            "image": official_image_url(pic),
        })

    codes = []
    for c in out_cards:
        if c["set"] not in codes:
            codes.append(c["set"])
    sets = [{"key": code, "name": set_name(code)} for code in codes]

    return {"sets": sets, "cards": out_cards}


def serialize(catalog):
    # Compact, deterministic, one line: the file is an asset, not something humans edit.
    return json.dumps(catalog, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="exit 1 if any target would change; write nothing")
    a = ap.parse_args()

    text = serialize(build_catalog())

    targets = [t for t in (ANDROID_JSON, IOS_JSON, SHARED_JSON) if os.path.exists(os.path.dirname(t))]
    changed = []
    for path in targets:
        current = io.open(path, encoding="utf-8").read() if os.path.exists(path) else None
        if current != text:
            changed.append(path)
    if not changed:
        print("native catalog up to date across %d targets" % len(targets))
        return
    if a.check:
        sys.exit("stale native catalog (%d of %d targets need regenerating): %s"
                 % (len(changed), len(targets), ", ".join(os.path.relpath(p, HERE) for p in changed)))
    for path in changed:
        io.open(path, "w", encoding="utf-8", newline="\n").write(text)
        print("regenerated %s" % os.path.relpath(path, HERE))
    catalog = json.loads(text)
    print("%d cards across %d sets; %d target(s) updated" % (len(catalog["cards"]), len(catalog["sets"]), len(changed)))


if __name__ == "__main__":
    main()
