#!/usr/bin/env python3
"""Fetch Pal creature artwork for the PalDex screen.

PalDex shows one tile per Pal (the creature), not per printing, so the tile wants the Pal itself
rather than a card scan. This downloads each Pal's render from the Palworld wiki (palworld.wiki.gg,
CC BY-SA; the artwork itself is Pocketpair's, covered by the app's existing attribution line) and
writes it to docs/app/img/, which rebuild.py already mirrors into the Android and iOS asset folders.

Output files are named PAL_<Name_With_Underscores>.webp and are square, transparent, and never
upscaled: a 179px render stays 179px. The app carries a name -> file table (PAL_ART in
src/paldeck.html) and falls back to the card art for any Pal that has no render here, so a missing
file is a soft failure rather than a hole in the grid.

Usage:
  python tools/fetch_pal_art.py --dry-run          # resolve and report, download nothing
  python tools/fetch_pal_art.py                    # download what is missing
  python tools/fetch_pal_art.py --force            # re-download and re-encode everything
  python tools/fetch_pal_art.py --table            # print the PAL_ART JS table for src/paldeck.html
"""
import argparse, io, json, os, re, sys, time
import urllib.error, urllib.parse, urllib.request

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
CATALOGUE = os.path.join(REPO, "app", "src", "main", "assets", "paldeck_cards.json")
IMG_OUT = os.path.join(REPO, "docs", "app", "img")
RAW_CACHE = os.path.join(REPO, "stage", "pals", "raw")
MAP_OUT = os.path.join(REPO, "stage", "pals", "pal_art.json")

WIKI_API = "https://palworld.wiki.gg/api.php"
UA = "SphereDex/1.0 (+https://spheredex-backend.craigjayedit.workers.dev)"
BOX = 288          # longest side of the saved square, before padding
PAD = 10           # transparent breathing room so the render never touches the tile edge
QUALITY = 82


def http_json(url, tries=3):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=45) as r:
                return json.load(r)
        except Exception as e:                                    # noqa: BLE001 - reported to the caller
            last = e
            time.sleep(0.8 * (i + 1))
    raise last


def http_bytes(url, tries=3):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                if r.status == 200:
                    return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None                                       # genuinely missing; do not retry
            last = e
        except Exception as e:                                    # noqa: BLE001
            last = e
        time.sleep(0.7 * (i + 1))
    if last:
        raise last
    return None


def pal_names():
    """Base Pal names from the card catalogue, in catalogue order (deduped)."""
    data = json.load(io.open(CATALOGUE, encoding="utf-8"))
    if isinstance(data, dict):
        data = data.get("cards") or data.get("rows") or []
    out = []
    for c in data:
        if (c.get("kind") or "") != "Pal":
            continue
        name = (c.get("name") or "").split(" \u2013 ")[0].strip()
        if name and name not in out:
            out.append(name)
    return out


def file_title(name):
    return "File:" + name + ".png"


def resolve(names):
    """Wiki page title -> {name: (url, width, height)}. Batched, 50 titles per request."""
    found, missing = {}, []
    for i in range(0, len(names), 50):
        batch = names[i:i + 50]
        titles = "|".join(urllib.parse.quote(file_title(n)) for n in batch)
        url = ("%s?action=query&format=json&prop=imageinfo&iiprop=url|size&titles=%s" % (WIKI_API, titles))
        js = http_json(url)
        pages = (js.get("query") or {}).get("pages") or {}
        by_title = {}
        for page in pages.values():
            t = (page.get("title") or "").replace("File:", "").replace(".png", "").replace("_", " ")
            info = (page.get("imageinfo") or [{}])[0]
            if info.get("url"):
                by_title[t] = (info["url"], info.get("width"), info.get("height"))
        for n in batch:
            if n in by_title:
                found[n] = by_title[n]
            else:
                missing.append(n)
        time.sleep(0.2)
    return found, missing


def slug(name):
    return re.sub(r"[^A-Za-z0-9]+", "_", name).strip("_")


def save_webp(raw, dst):
    """Normalise a render: fit into BOX (never upscale), pad to a transparent square, save webp."""
    from PIL import Image                                     # imported here so --dry-run needs no Pillow
    src = io.BytesIO(raw)
    im = Image.open(src).convert("RGBA")
    box = BOX - PAD * 2
    if max(im.size) > box:
        im.thumbnail((box, box), Image.LANCZOS)
    canvas = Image.new("RGBA", (BOX, BOX), (0, 0, 0, 0))
    canvas.paste(im, ((BOX - im.width) // 2, (BOX - im.height) // 2), im)
    canvas.save(dst, "WEBP", quality=QUALITY, method=6)


def main():
    ap = argparse.ArgumentParser(description="Fetch Pal artwork for PalDex (docs/app/img/PAL_*.webp).")
    ap.add_argument("--dry-run", action="store_true", help="resolve and report only")
    ap.add_argument("--force", action="store_true", help="re-download and re-encode existing files")
    ap.add_argument("--table", action="store_true", help="print the PAL_ART table and exit")
    ap.add_argument("--delay", type=float, default=0.2, help="seconds between downloads")
    args = ap.parse_args()

    names = pal_names()
    mp = {}
    if os.path.exists(MAP_OUT):
        try:
            mp = json.load(io.open(MAP_OUT, encoding="utf-8"))
        except Exception:                                      # noqa: BLE001
            mp = {}

    if args.table:
        table = {n: f for n, f in sorted(mp.items(), key=lambda kv: kv[0])}
        print("  var PAL_ART = " + json.dumps(table, ensure_ascii=False, indent=2).replace("\n", "\n  ") + ";")
        return

    print("== Pal artwork ==  %d Pals in the catalogue" % len(names))
    found, missing = resolve(names)
    print("resolved: %d   no wiki render: %d" % (len(found), len(missing)))
    if missing:
        print("  without a render (these fall back to card art): " + ", ".join(missing))
    if args.dry_run:
        for n, (url, w, h) in list(found.items())[:8]:
            print("  e.g. %-20s %sx%s %s" % (n, w, h, url))
        return

    os.makedirs(IMG_OUT, exist_ok=True)
    os.makedirs(RAW_CACHE, exist_ok=True)
    os.makedirs(os.path.dirname(MAP_OUT), exist_ok=True)
    added = skipped = failed = 0
    for name, (url, w, h) in found.items():
        dst = os.path.join(IMG_OUT, "PAL_" + slug(name) + ".webp")
        if os.path.exists(dst) and not args.force:
            mp[name] = os.path.basename(dst)
            skipped += 1
            continue
        cache = os.path.join(RAW_CACHE, slug(name) + ".png")
        raw = None
        if os.path.exists(cache) and not args.force:
            raw = io.open(cache, "rb").read()
        else:
            try:
                raw = http_bytes(url)
            except Exception as e:                             # noqa: BLE001
                print("  !! %s: %s" % (name, e))
            if raw:
                io.open(cache, "wb").write(raw)
            time.sleep(args.delay)
        if not raw:
            failed += 1
            continue
        try:
            save_webp(raw, dst)
        except Exception as e:                                 # noqa: BLE001
            print("  !! %s could not be encoded: %s" % (name, e))
            failed += 1
            continue
        mp[name] = os.path.basename(dst)
        added += 1

    for name in list(mp):
        if name not in found:
            del mp[name]                                       # a Pal the catalogue has dropped
    io.open(MAP_OUT, "w", encoding="utf-8", newline="\n").write(
        json.dumps(mp, ensure_ascii=False, indent=2, sort_keys=True) + "\n")

    total = 0
    for f in os.listdir(IMG_OUT):
        if f.startswith("PAL_"):
            total += os.path.getsize(os.path.join(IMG_OUT, f))
    print("wrote %d, kept %d, failed %d -> %s (%.1f MB of PAL_*.webp)"
          % (added, skipped, failed, IMG_OUT, total / 1048576.0))
    print("table: %d entries -> %s" % (len(mp), MAP_OUT))
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
