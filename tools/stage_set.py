#!/usr/bin/env python3
"""
stage_set.py - Tier B: stage a Palworld TCG set into a paste-ready bundle for SphereDex.

Given an expansion code from the official product list (EBP01, ETD01, ETD02, PR2026, or a
future EBP02 / ETD03 ...), this:
  1. pulls the full card list from the official card DB (the same source the app validates against),
  2. maps every card to the app's 12-field RAW row (proven byte-for-byte identical to the
     shipped catalogue), appending the set code so rows drop straight into RAW2,
  3. downloads each card's artwork and resizes it to the app's 315x440 JPEG,
  4. emits everything you paste/copy into a build, plus a report with exact wiring steps.

Pure Python 3 stdlib + macOS `sips` for image work. No pip installs.

Usage:
  python3 tools/stage_set.py EBP01                 # stage the whole set
  python3 tools/stage_set.py EBP01 --limit 5       # first 5 cards (quick test)
  python3 tools/stage_set.py EBP02 --out /tmp/bp02 # custom output dir
  python3 tools/stage_set.py EBP01 --no-images     # data only, skip artwork
"""
import argparse, base64, json, os, subprocess, sys, time, urllib.request, urllib.error

OFFICIAL = "https://en.palworld-official-cardgame.com"
LIST = OFFICIAL + "/manage/card-list-user/list"
PRODUCTS = OFFICIAL + "/manage/card-list-user/products"
IMG_BASE = OFFICIAL + "/wordpress/wp-content/images/cardlist/"
UA = "SphereDex/1.0 (+https://spheredex-backend.craigjayedit.workers.dev)"
# repo layout: <paldeck-app>/android/tools/stage_set.py -> REPO is the paldeck-app root (parent of android)
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))

# app RAW row order (12 fields) <- official field
FIELDMAP = [
    ("id",        "card_number"),
    ("name",      "card_name"),
    ("type",      "card_kind"),
    ("subtype",   "card_kind_sub"),
    ("rarity",    "rare"),
    ("color",     "color"),
    ("elements",  "type"),        # pipe-joined already
    ("keywords",  "aptitude"),    # pipe-joined already
    ("cost",      "cost"),
    ("power",     "power"),
    ("attack",    "attack"),
    ("imagePath", "picture"),
]
TARGET_W, TARGET_H, JPEG_Q = 315, 440, 60  # q60 ~= shipped ~42KB at 315x440 (matched to existing bundle)


def http_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.load(r)


def http_bytes(url, tries=3):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=45) as r:
                if r.status == 200:
                    return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None            # genuinely missing, don't retry
            last = e
        except Exception as e:
            last = e
        time.sleep(0.6 * (i + 1))
    if last:
        raise last
    return None


def fetch_products():
    out = {}
    for grp in http_json(PRODUCTS).get("products", []):
        for it in grp.get("items", []):
            if it.get("code"):
                out[it["code"]] = it
    return out


PER_PAGE = 100
KNOWN_KINDS = {"Pal", "Structure", "Gear", "Event", "Soul"}

# Cards the official card list leaves out. A later stage of the same set must keep them: the list is
# the source for everything else, and pasting a fresh raw_rows.js over the catalogue would drop a card
# that was added by hand. Once the list starts returning the number, the official row wins and this
# copy is not appended. ESOUL-011 is the gold SSS Soul in Legends Awaken (Jetragon foil), the same
# shape as Dawn of Palpagos ESOUL-002. The artwork is published; the list is not.
OMITTED_NOTE = "Added by hand because the official list omits it."
OMITTED_BY_SET = {
    "EBP02": [{
        "card_number": "ESOUL-011",
        "card_name": "Soul",
        "card_kind": "Soul",
        "card_kind_sub": "",
        "rare": "SSS",
        "color": "",
        "type": "",
        "aptitude": "",
        "cost": "",
        "power": "",
        "attack": "",
        "picture": "EBP02/ESOUL-011.png",
        # Japanese list number and printed name. The Japanese list omits this card too.
        "ja_number": "SOUL-011",
        "ja_name": "ソウル",
        "ja_text": "",
        "ja_kind": "ソウル",
    }],
}


def merge_omitted(code, cards):
    """Append hand-kept cards the official list did not return. Never duplicates a number it did."""
    have = {c.get("card_number") for c in cards}
    extra = []
    for card in OMITTED_BY_SET.get(code, []):
        if card.get("card_number") not in have:
            extra.append(dict(card))
    return list(cards) + extra


def japanese_record(card):
    """One hand-kept card in the Japanese list's shape, or None when it has no Japanese twin."""
    number = card.get("ja_number") or ""
    if not number:
        return None
    return {
        "card_number": number,
        "card_name": card.get("ja_name") or "",
        "text": card.get("ja_text") or "",
        "rare": card.get("rare") or "",
        "cost": card.get("cost") or "",
        "power": card.get("power") or "",
        "attack": card.get("attack") or "",
        "card_kind": card.get("ja_kind") or "ソウル",
        # resolve() reads this and does not copy it into the baked file.
        "_hand": True,
    }


def merge_omitted_japanese(records):
    """Append Japanese rows for hand-kept cards the Japanese list did not return.

    The same rule as merge_omitted: a number the list has started returning is left as the
    official record, so a later bake does not keep a stale hand copy over the real one.
    """
    have = {r.get("card_number") for r in records}
    extra = []
    for group in OMITTED_BY_SET.values():
        for card in group:
            row = japanese_record(card)
            if row and row["card_number"] not in have:
                extra.append(row)
                have.add(row["card_number"])
    return list(records) + extra


def fetch_is_complete(official_count, upstream_total, limited=False):
    """True when the official list was fetched in full.

    Hand-kept rows are not part of this count. A fetch short by exactly those rows must stay
    incomplete, even though adding them makes the staged length equal the upstream total.
    """
    return (not limited) and upstream_total is not None and official_count == upstream_total


def cards_of_total_line(official_count, upstream_total, complete):
    return (f"- Cards: **{official_count}** of upstream total **{upstream_total}**"
            f"  ->  complete: **{complete}**")


def incomplete_warning(official_count, upstream_total):
    return (f"- !! INCOMPLETE: fetched {official_count} of upstream total {upstream_total}."
            " Re-run before shipping.")


def fetch_set(code):
    """Paginate the expansion. A short page (< PER_PAGE) is the definitive last-page signal -
    do NOT rely on `total` alone (a missing/0 total would otherwise truncate to the first page)."""
    cards, page, total = [], 1, None
    while page <= 60:  # generous cap; real sets are far smaller
        d = http_json(f"{LIST}?expansion={code}&per_page={PER_PAGE}&page={page}")
        items = d.get("items", []) or []
        if total is None:
            total = d.get("total")
        cards += items
        if len(items) < PER_PAGE:          # last page reached
            break
        page += 1
    else:
        print(f"!! hit page cap at {len(cards)} cards - set may be truncated")
    return cards, total


def to_row(card, set_code):
    row = [str(card.get(off, "")) for _, off in FIELDMAP]
    row.append(set_code)  # 13th field for RAW2
    return row


def resize_jpeg(src_png, dst_jpg):
    """PNG on disk -> 315x440 JPEG. macOS `sips` when it is there, Pillow otherwise, so the
    tool also runs on the Windows PC. Both paths produce the same size and quality."""
    try:
        r = subprocess.run(
            ["sips", "-s", "format", "jpeg", "-s", "formatOptions", str(JPEG_Q),
             "-z", str(TARGET_H), str(TARGET_W), src_png, "--out", dst_jpg],
            capture_output=True, text=True)
        if r.returncode == 0 and os.path.exists(dst_jpg):
            return True
    except (OSError, FileNotFoundError):
        pass                      # no sips on this machine: fall through to Pillow
    try:
        from PIL import Image
    except ImportError:
        return False
    with Image.open(src_png) as im:
        im = im.convert("RGB").resize((TARGET_W, TARGET_H), Image.LANCZOS)
        im.save(dst_jpg, "JPEG", quality=JPEG_Q)
    return os.path.exists(dst_jpg)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("code", help="expansion code, e.g. EBP01 / ETD01 / PR2026 / EBP02")
    ap.add_argument("--out", default=None, help="output dir (default: <repo>/stage/<code>)")
    ap.add_argument("--limit", type=int, default=0, help="only first N cards (testing)")
    ap.add_argument("--no-images", action="store_true", help="skip artwork download/resize")
    ap.add_argument("--delay", type=float, default=0.15, help="seconds between image downloads")
    args = ap.parse_args()

    code = args.code.strip()
    out = args.out or os.path.join(REPO, "stage", code)
    imgdir = os.path.join(out, "img")
    os.makedirs(imgdir, exist_ok=True)

    prod = fetch_products().get(code, {})
    print(f"== staging {code} ==  {prod.get('name','(unknown product)')}  release={prod.get('date','?')}")

    cards, total = fetch_set(code)
    if args.limit:
        cards = cards[:args.limit]
    if not cards:
        print("!! no cards returned - is the card list published yet for this set?")
        sys.exit(2)
    # Completeness is official rows only. merge_omitted runs after this, and every warning
    # below keeps using official_n so a short fetch cannot look finished once the hand-kept
    # rows are appended. A --limit run is a sample and does not append those rows.
    official_n = len(cards)
    complete = fetch_is_complete(official_n, total, limited=bool(args.limit))
    if not args.limit and total is not None and not complete:
        print(f"!! WARNING: fetched {official_n} but upstream total={total} - stage may be incomplete")
    kept = []
    if args.limit == 0:
        fetched_ids = {c.get("card_number") for c in cards}
        cards = merge_omitted(code, cards)
        kept = [c.get("card_number") for c in cards if c.get("card_number") not in fetched_ids]
        if kept:
            print("keeping " + ", ".join(kept) + " (" + OMITTED_NOTE[0].lower() + OMITTED_NOTE[1:] + ")")
    unknown_kinds = sorted({c.get("card_kind", "") for c in cards} - KNOWN_KINDS)
    if unknown_kinds:
        print(f"!! NOTE: unseen card_kind(s) {unknown_kinds} - verify empty-field handling for these")
    print(f"fetched {official_n} cards (upstream total: {total})")

    # ---- 1. RAW rows (app catalogue) ----
    rows = [to_row(c, code) for c in cards]
    chunks = []
    for r in rows:
        line = json.dumps(r, ensure_ascii=False, separators=(",", ":"))
        if r[0] in kept:
            # The comment rides above the row so a paste into RAW2 keeps the reason with the card.
            line = "// " + r[0] + " " + OMITTED_NOTE + "\n" + line
        chunks.append(line)
    raw_js = ",\n".join(chunks)
    with open(os.path.join(out, "raw_rows.js"), "w", encoding="utf-8") as f:
        f.write("/* " + code + " - " + str(len(rows)) + " rows. Append to RAW2 in paldeck.html */\n")
        f.write(raw_js + "\n")

    # ---- 1b. backend CardRef rows (spheredex-backend/src/cards.ts) so the new set gets priced ----
    with open(os.path.join(out, "cards_ts.txt"), "w", encoding="utf-8") as f:
        f.write("// " + code + " - append into CARDS in spheredex-backend/src/cards.ts, then redeploy\n")
        for r in rows:
            f.write("  { id: " + json.dumps(r[0]) + ", name: " + json.dumps(r[1], ensure_ascii=False) + " },\n")

    # em-dash guard (app-copy rule: en-dash U+2013 ok, em-dash U+2014 banned) - scan every string cell
    emdash = [r[0] for r in rows if any(isinstance(x, str) and "—" in x for x in r)]

    # ---- 2. images ----
    web_map, bundle_map = {}, {}
    missing_img, dl, skipped = [], 0, 0
    if not args.no_images:
        from collections import Counter
        for i, c in enumerate(cards, 1):
            cid, pic = c["card_number"], c["picture"]
            jpg = os.path.join(imgdir, cid + ".jpg")
            if not os.path.exists(jpg):
                data = http_bytes(IMG_BASE + pic)
                if data is None:
                    missing_img.append(cid)
                    print(f"  [{i}/{len(cards)}] {cid}  MISSING ART (404)")
                    continue
                tmp = os.path.join(imgdir, cid + ".src.png")
                with open(tmp, "wb") as f:
                    f.write(data)
                ok = resize_jpeg(tmp, jpg)
                os.remove(tmp)
                if not ok:
                    missing_img.append(cid)
                    print(f"  [{i}/{len(cards)}] {cid}  RESIZE FAILED")
                    continue
                dl += 1
                time.sleep(args.delay)
            else:
                skipped += 1
            web_map[cid] = "img/" + cid + ".jpg"
            b64 = base64.b64encode(open(jpg, "rb").read()).decode("ascii")
            bundle_map[cid] = "data:image/jpeg;base64," + b64
        with open(os.path.join(out, "card_img_web.json"), "w") as f:
            json.dump(web_map, f, indent=0)
        with open(os.path.join(out, "card_img_bundle.json"), "w") as f:
            json.dump(bundle_map, f)

    # ---- 3. report ----
    from collections import Counter
    kinds = Counter(c["card_kind"] for c in cards)
    name = prod.get("name", "")
    release = prod.get("date", "")
    meta = {
        "code": code, "name": name, "type": prod.get("type", ""),
        "release": release, "cardCount": official_n, "stagedCount": len(cards),
        "upstreamTotal": total,
        "complete": bool(complete), "unknownKinds": unknown_kinds,
        "missingImages": missing_img, "emDash": emdash, "keptByHand": kept,
    }
    # snippets use the REAL app field names (verified against paldeck.html). Official product names
    # can contain literal double-quotes, so emit every display string as a safe JS literal.
    def js(s):
        return json.dumps(str(s).replace('"', "").strip(), ensure_ascii=False)
    disp = name.replace('"', "").strip()
    set_meta_snip = (f'{code}: {{ release:"{release}", box:"BOX_BANNER_{code}", '
                     f'logo:DOP_LOGO, art:/* SET_ART */, blurb:{js(name)} }},')
    sets_snip = f'{code}:{{ name:{js(name)}, short:"{code}" }},'
    sealed_snip = (f'{{ id:"box-{code.lower()}", name:"Booster Box", sub:{js(name)}, '
                   f'box:"BOX_{code}", q:{js("Palworld " + disp + " Booster Box")} }},')
    seal_rrp_snip = f'"box-{code.lower()}": {{ JPY:0, USD:0, GBP:0, EUR:0, AUD:0, CAD:0 }},'

    warn = []
    if not complete:
        warn.append(incomplete_warning(official_n, total))
    if unknown_kinds:
        warn.append(f"- !! UNSEEN card_kind(s): {unknown_kinds}. Confirm empty-field handling matches the app.")
    if missing_img:
        warn.append(f"- !! MISSING ART ({len(missing_img)}): {missing_img}. These cards fall back to the official hotlink.")
    if emdash:
        warn.append(f"- !! EM-DASH in {emdash} (banned in app copy). Fix before pasting.")

    lines = [
        f"# Stage report: {code}", "",
        f"- Product: **{name}**  (`{meta['type']}`, release {release})",
        cards_of_total_line(official_n, total, complete),
        "- Kept by hand: " + (", ".join(kept) if kept else "none") + " (" + OMITTED_NOTE[0].lower() + OMITTED_NOTE[1:] + ")",
        f"- By kind: " + ", ".join(f"{k} {n}" for k, n in kinds.most_common()),
        f"- Artwork: downloaded {dl}, reused {skipped}, missing {len(missing_img)}",
        f"- EM-dash cells (must be 0): {len(emdash)}",
    ] + (["", "## WARNINGS"] + warn if warn else []) + [
        "",
        "## Generated files",
        "- `raw_rows.js` - append to the **RAW2** array in `android/src/paldeck.html`",
        "- `cards_ts.txt` - append to **CARDS** in `spheredex-backend/src/cards.ts` (so the set gets priced), then redeploy",
        "- `img/*.jpg` - copy into `android/docs/app/img/`",
        "- `card_img_web.json` - merge into the **WEB** `window.CARD_IMG={...}` (docs/app/index.html)",
        "- `card_img_bundle.json` - legacy data URIs, NOT needed any more: the Android/iOS apps load the same `img/` files as the web (rebuild.py copies them in)",
        "",
        "## Registration snippets (fill the TODOs)",
        "```js",
        "// SETS  (paldeck.html ~line 1666)",
        sets_snip,
        "// SET_ORDER  (paldeck.html ~line 1666) - append the code:",
        f'"{code}"',
        "// SET_META  (paldeck.html ~line 2836) - box/logo/art are optional visuals",
        set_meta_snip,
        "// SEALED  (paldeck.html ~line 2874) - one entry per purchasable product (box/pack/deck)",
        sealed_snip,
        "// SEAL_RRP  (paldeck.html ~line 1778) - RRP per product id, per currency",
        seal_rrp_snip,
        "```",
        "",
        "## Full wiring checklist",
        "1. **RAW2**: append `raw_rows.js` rows (`android/src/paldeck.html`).",
        "2. **SETS** + **SET_ORDER** (~line 1666): add name/short + append the code (drives Browse-by-Set + SET_TOTAL).",
        "2b. **FILTER_SETS** (next to SET_ORDER): make sure the code sits under its set as a Product (a pack shares its box code, so it gets no entry of its own).",
        "3. **SET_META** (~line 2836): add release/box/logo/art/blurb.",
        "4. **SEALED** (~line 2874) + **SEAL_RRP** (~line 1778): add box/pack/deck products + RRP, and their BOX_/PACK_ images.",
        "5. **Hardcoded help copy** (~lines 1362 & 1368): the '242 printings' / '153 base' / 'How the 242 breaks down' text is NOT auto-computed - update those numbers.",
        "6. **Images**: copy `img/*.jpg` to `android/docs/app/img/` and merge `card_img_web.json` into the WEB CARD_IMG block (`docs/app/index.html`). That is all: never inline base64 into the Android/iOS html.",
        "7. **Backend pricing**: append `cards_ts.txt` to `spheredex-backend/src/cards.ts`, then `npm run deploy` (new cards are unpriced until this ships).",
        "8. **Build**: run rebuild.py. It forces the Android CARD_IMG block to the WEB one, mirrors `docs/app/img` into the Android + iOS img folders, and copies the Android html to iOS.",
        "9. **Verify**: em-dash count 0, WEB img refs increased by the new card count, JS parses, TOTAL updates automatically.",
        "",
        "_TOTAL / MASTER_TOTAL / SET_TOTAL and the rarity/element key grids auto-compute from the rows - no edit needed._",
    ]
    with open(os.path.join(out, "report.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    with open(os.path.join(out, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2)

    print("\n".join(["", "== done =="] + lines[2:8] + (warn if warn else [])))
    print(f"\noutput -> {out}")


if __name__ == "__main__":
    main()
