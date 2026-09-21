# -*- coding: utf-8 -*-
"""Build a catalogue payload from the app's own card table.

The card list is compiled into each build, so a user who has not updated does not have a new set at all.
The backend can serve the cards instead (POST /api/admin/catalogue), and the app merges anything newer than
the catalogue it was built with. This script produces that payload FROM THE SAME ROWS the build bakes in,
so the delivered cards and the baked ones can never drift into different shapes.

Usage
  python tools/catalogue.py --sets EBP02 --version 2 > payload.json
  python tools/catalogue.py --all --version 2 --out payload.json

Then, with the admin key:
  curl -X POST -H "X-Admin-Key: KEY" -H "Content-Type: application/json" \
       --data-binary @payload.json https://spheredex-backend.craigjayedit.workers.dev/api/admin/catalogue

Release step: when new cards are baked into a build, bump CATALOGUE_VERSION in src/paldeck.html AND
upload a payload carrying the same version, so older builds catch up and newer ones ignore it.
"""
import argparse, io, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "src", "paldeck.html")


def js_array(src, name):
    """Pull `var NAME = [...];` out of the app file and parse it as JSON."""
    m = re.search(r"var\s+" + name + r"\s*=\s*(\[)", src)
    if not m:
        sys.exit("could not find " + name)
    i = m.start(1)
    depth, j = 0, i
    while True:
        ch = src[j]
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                break
        j += 1
    body = strip_js_comments(src[i:j + 1])        # the table carries // notes between rows
    body = re.sub(r",\s*\]", "]", body)           # tolerate a trailing comma
    return json.loads(body)


def strip_js_comments(text):
    """Remove // line comments that are not inside a string, so the table parses as JSON."""
    out, i, n, in_str = [], 0, len(text), False
    while i < n:
        ch = text[i]
        if in_str:
            out.append(ch)
            if ch == "\\" and i + 1 < n:          # keep an escaped character with its backslash
                out.append(text[i + 1]); i += 2; continue
            if ch == '"':
                in_str = False
            i += 1
            continue
        if ch == '"':
            in_str = True; out.append(ch); i += 1; continue
        if ch == "/" and i + 1 < n and text[i + 1] == "/":
            while i < n and text[i] != "\n":
                i += 1
            continue
        out.append(ch); i += 1
    return "".join(out)


def sets_table(src):
    """The SETS map: code -> {name, short}."""
    m = re.search(r"var\s+SETS\s*=\s*\{", src)
    if not m:
        return {}
    i = src.index("{", m.start())
    depth, j = 0, i
    while True:
        ch = src[j]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                break
        j += 1
    body = src[i:j + 1]
    body = re.sub(r"([{,]\s*)([A-Za-z_][\w]*)\s*:", r'\1"\2":', body)   # quote the bare keys
    body = re.sub(r",\s*\}", "}", body)
    return json.loads(body)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", type=int, required=True, help="catalogue version; must match CATALOGUE_VERSION in the build that bakes these cards in")
    ap.add_argument("--sets", default="", help="comma separated set codes to include, e.g. EBP02,ETD03")
    ap.add_argument("--all", action="store_true", help="include every card the app knows")
    ap.add_argument("--out", default="", help="write here instead of stdout")
    a = ap.parse_args()
    if not a.all and not a.sets:
        sys.exit("give --sets or --all")

    src = io.open(SRC, encoding="utf-8").read()
    raw = js_array(src, "RAW")          # EBP01, no set code in the row
    raw2 = js_array(src, "RAW2")        # every other set, set code at index 12
    all_sets = sets_table(src)

    rows = [list(r) + ["EBP01"] for r in raw]
    for r in raw2:
        r = list(r)
        while len(r) < 13:
            r.append("")
        rows.append(r)

    wanted = None if a.all else set(x.strip().upper() for x in a.sets.split(",") if x.strip())
    picked = [r for r in rows if wanted is None or (r[12] or "").upper() in wanted]
    if not picked:
        sys.exit("no cards matched; sets present: " + ", ".join(sorted({(r[12] or "?") for r in rows})))

    codes = sorted({r[12] for r in picked})
    payload = {
        "version": a.version,
        "rows": picked,
        "sets": {c: all_sets[c] for c in codes if c in all_sets},
        "setOrder": codes,
        "img": {},      # only needed for art that is not bundled with the build, as an absolute https url
    }
    text = json.dumps(payload, ensure_ascii=False)
    if a.out:
        io.open(a.out, "w", encoding="utf-8").write(text)
        print("wrote %s: %d cards across %s (version %d)" % (a.out, len(picked), ", ".join(codes), a.version))
    else:
        sys.stdout.write(text)


if __name__ == "__main__":
    main()
