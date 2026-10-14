#!/usr/bin/env python3
"""Build docs/news/ja-glossary.json: the official English for the Japanese names in @PalworldOCG posts.

The backend translates the official Japanese account's posts with Cloudflare Workers AI. A general model
does not know this game, so it tends to transliterate the names it meets: アグニドラ can come out as "Agunidora"
rather than Jormuntide Ignis, which tells an English reader nothing. This file gives the backend the
official English for every card, Pal and epithet the app knows, plus a short hand checked list of set
and product names. It is served at https://spheredex.app/news/ja-glossary.json by GitHub Pages, so a
new set reaches the translator with a pull request and no backend deploy.

WHERE THE NAMES COME FROM
-------------------------
Both languages are read from src/paldeck.html, the file every build bakes in, so the glossary can never
name a card differently from the app:

  English   c.name of each card, which mkCard takes from the RAW and RAW2 tables. They are parsed
            with tools/catalogue.py, the same parser the native catalogue and the backend payload use.
  Japanese  CARD_TEXT_JA, the printed Japanese name per card id, written by tools/bake_card_text_ja.py
            from the official Japanese site's card list. That bake verifies every pairing on cost,
            power and strike, which is what makes pairing the two languages by card id safe.

THE TWO LANGUAGES ORDER A NAME DIFFERENTLY
------------------------------------------
A Japanese Pal card prints "epithet – Pal" (荒ぶる溶岩竜 – アグニドラ) and the English one prints
"Pal – epithet" (Jormuntide Ignis – Savage Lava Dragon). Each such card gives three pairs: the full
name, the Pal and the epithet. Reading one side the wrong way round would pair every epithet with a
Pal name and nothing in the output would look wrong, so the build measures the order against the data
(the same Pal recurs with many epithets, so the right order is the one where each Japanese Pal name
keeps one English name) and refuses to write when the other order fits better.

WHAT IS LEFT OUT
----------------
A Japanese term that maps to two different English ones is left out rather than guessed. Every Japanese
Soul card prints the single name ソウル whatever Pals are on it, for example, so as a card name it says
nothing about which English card is meant. The hand checked FIXED_TERMS below always win over anything
derived, which is how ソウル still means Soul. A term with no Japanese in it, or a single character,
is never worth matching and is dropped too.

The output is sorted longest Japanese first, so a translator that walks the list matches the full card
name before the Pal name inside it. updated_at only moves when the terms change, so a rerun with
nothing new leaves the file exactly as it was.

Run:  python tools/build_ja_glossary.py           (writes docs/news/ja-glossary.json)
      python tools/build_ja_glossary.py --check   (exit 1 when the committed file is out of date)
"""
from __future__ import annotations

import argparse
import datetime as _dt
import io
import json
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

# The bake owns the markers around CARD_TEXT_JA and catalogue.py owns the table parser. Importing both
# rather than copying them means a change to either is picked up here instead of silently diverging.
from bake_card_text_ja import BEGIN, END  # noqa: E402
from catalogue import js_array  # noqa: E402

APP = os.path.join(ROOT, "src", "paldeck.html")
OUT = os.path.join(ROOT, "docs", "news", "ja-glossary.json")

KINDS = ("pal", "card", "epithet", "set", "term")
# When the same pair turns up as more than one kind, the more specific meaning is the one kept. A Pal
# card printed with no epithet has a full name that is just the Pal's name, and "pal" says more.
KIND_ORDER = {"set": 0, "term": 1, "pal": 2, "epithet": 3, "card": 4}
# Both languages print an en dash with a space either side between the two halves of a Pal card's name.
SEP = " – "
# Any hiragana, katakana or CJK ideograph. A term without one can never appear in a Japanese post as
# Japanese, so there is nothing for the translator to look up.
JAPANESE = re.compile(r"[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]")

# Hand checked set, product and rules words. Each line says where it was confirmed. The set names were
# checked on 2026-10-14 against the official Japanese site (palworld-official-cardgame.com/products) and
# the English one (en.palworld-official-cardgame.com/products): the same product page slug and the same
# release date on both. Anything that could not be confirmed that way is left out on purpose; a wrong
# official name is worse than none, because the translator would then repeat it with confidence.
FIXED_TERMS: list[tuple[str, str, str]] = [
    # bp01, on sale 30 Jul 2026 on both sites; also BP01's expansion_name in src/card-text-ja.source.json.
    ("パルパゴスの夜明け", "Dawn of Palpagos", "set"),
    # bp02, on sale 30 Oct 2026 on both sites.
    ("目覚めし伝説", "Legends Awaken", "set"),
    # Booster pack 3, on sale 29 Jan 2027 on both sites, and the td03 trial decks of 18 Dec 2026, which
    # the Japanese site sells as 果てなき飛翔 レッド・グリーン/ブルー・パープル and the English one as
    # Eternal Ascent Red・Green and Blue・Purple.
    ("果てなき飛翔", "Eternal Ascent", "set"),
    # ss01, SS01's expansion_name in src/card-text-ja.source.json; the English site's own spelling.
    ("スリーブ＆カードセット Vol.1", "Sleeve & Card Set Vol.1", "set"),
    # The game's name as each site's title prints it, then the shorter form posts use.
    ("パルワールド オフィシャルカードゲーム", "Palworld OFFICIAL CARD GAME", "term"),
    ("パルワールドカードゲーム", "Palworld Card Game", "term"),
    ("パルワールド", "Palworld", "term"),
    # Product lines. The English products are "Booster Pack" and "Trial Deck", never Starter Deck.
    ("ブースターパック", "Booster Pack", "term"),
    ("トライアルデッキ", "Trial Deck", "term"),
    # Card kinds: card_kind and card_kind_sub in src/card-text-ja.source.json against the catalogue's
    # kind and sub, which agree on every verified card. The bare パル and イベント are left out: パル
    # starts dozens of unrelated words, and イベント is as often a real world event as an Event card.
    ("ラッキーパル", "Lucky Pal", "term"),
    ("ノーマルパル", "Normal Pal", "term"),
    ("建築物", "Structure", "term"),
    ("ギア", "Gear", "term"),
    ("ソウル", "Soul", "term"),
]


def card_names(src: str) -> dict[str, str]:
    """Card id to English name, exactly as the app builds c.name (mkCard takes it from row[1])."""
    out: dict[str, str] = {}
    for row in js_array(src, "RAW") + js_array(src, "RAW2"):
        if len(row) > 1 and str(row[0]).strip() and str(row[1]).strip():
            out[str(row[0]).strip()] = str(row[1]).strip()
    return out


def japanese_names(src: str) -> dict[str, str]:
    """Card id to printed Japanese name, read from the CARD_TEXT_JA block the bake writes."""
    if BEGIN not in src or END not in src:
        raise SystemExit("cannot find CARD_TEXT_JA in src/paldeck.html; run tools/bake_card_text_ja.py first")
    block = src.split(BEGIN, 1)[1].split(END, 1)[0].strip()
    prefix = "var CARD_TEXT_JA = "
    if not block.startswith(prefix) or not block.endswith(";"):
        raise SystemExit("CARD_TEXT_JA in src/paldeck.html is not in the shape the bake writes")
    data = json.loads(block[len(prefix):-1])
    out: dict[str, str] = {}
    for cid, row in (data.items() if isinstance(data, dict) else []):
        name = str((row or {}).get("n") or "").strip() if isinstance(row, dict) else ""
        if name:
            out[str(cid)] = name
    return out


def halves(name: str) -> tuple[str, str] | None:
    """The two halves of an "a – b" name, or None unless it is exactly one such pair."""
    parts = name.split(SEP)
    if len(parts) != 2:
        return None
    first, second = parts[0].strip(), parts[1].strip()
    return (first, second) if first and second else None


def card_pairs(english: dict[str, str], japanese: dict[str, str],
               swapped: bool = False) -> list[tuple[str, str, str]]:
    """(ja, en, kind) for every card both languages name: the full name, then the Pal and the epithet.

    swapped reads the Japanese halves the other way round. It exists only so check_order can measure
    which reading the data supports.
    """
    out: list[tuple[str, str, str]] = []
    for cid in sorted(set(english) & set(japanese)):
        en, ja = english[cid], japanese[cid]
        out.append((ja, en, "card"))
        en_halves, ja_halves = halves(en), halves(ja)
        if en_halves and ja_halves:
            pal_en, epithet_en = en_halves
            epithet_ja, pal_ja = (ja_halves[1], ja_halves[0]) if swapped else ja_halves
            out.append((pal_ja, pal_en, "pal"))
            out.append((epithet_ja, epithet_en, "epithet"))
    return out


def conflicts(pairs: list[tuple[str, str, str]]) -> int:
    """How many Japanese terms map to more than one English one."""
    seen: dict[str, set[str]] = {}
    for ja, en, _kind in pairs:
        seen.setdefault(ja, set()).add(en)
    return sum(1 for values in seen.values() if len(values) > 1)


def check_order(english: dict[str, str], japanese: dict[str, str]) -> tuple[int, int]:
    """(conflicts as documented, conflicts swapped), refusing to go on when swapped fits better.

    Only the Pal and epithet halves are counted: the full names are the same either way round.
    """
    def halves_only(swapped: bool) -> list[tuple[str, str, str]]:
        return [p for p in card_pairs(english, japanese, swapped) if p[2] != "card"]

    documented, other = conflicts(halves_only(False)), conflicts(halves_only(True))
    if documented > other:
        raise SystemExit(
            "the card names no longer read Japanese 'epithet – Pal' and English 'Pal – epithet' "
            f"({documented} conflicting terms that way round, {other} the other way); refusing to write "
            "a glossary that pairs epithets with Pal names")
    return documented, other


def usable(ja: str, en: str) -> bool:
    """Worth a place in the list: real Japanese of more than one character, and some English."""
    return len(ja) >= 2 and bool(JAPANESE.search(ja)) and bool(en) and ja != en


def merge(derived: list[tuple[str, str, str]],
          fixed: list[tuple[str, str, str]] = FIXED_TERMS) -> tuple[list[dict], list[str]]:
    """One term per Japanese string, fixed terms first, ambiguous ones left out. Returns (terms, ambiguous)."""
    fixed_ja = {ja for ja, _en, _kind in fixed}
    english: dict[str, set[str]] = {}
    kinds: dict[str, set[str]] = {}
    for ja, en, kind in derived:
        ja, en = ja.strip(), en.strip()
        if ja in fixed_ja or not usable(ja, en):
            continue
        english.setdefault(ja, set()).add(en)
        kinds.setdefault(ja, set()).add(kind)
    ambiguous = sorted(ja for ja, values in english.items() if len(values) > 1)
    terms = [{"ja": ja, "en": en, "kind": kind} for ja, en, kind in fixed]
    for ja, values in english.items():
        if len(values) == 1:
            kind = min(kinds[ja], key=lambda k: KIND_ORDER.get(k, len(KIND_ORDER)))
            terms.append({"ja": ja, "en": next(iter(values)), "kind": kind})
    # Longest Japanese first so a longer term wins over one inside it; the rest only makes the order stable.
    terms.sort(key=lambda t: (-len(t["ja"]), t["ja"], t["en"]))
    return terms, ambiguous


def build(src: str) -> tuple[list[dict], list[str]]:
    """(terms, ambiguous) for an app source."""
    english, japanese = card_names(src), japanese_names(src)
    check_order(english, japanese)
    return merge(card_pairs(english, japanese))


def load_previous(path: str) -> dict | None:
    """The file as committed, or None when there is none worth comparing against."""
    try:
        with io.open(path, encoding="utf-8") as handle:
            data = json.loads(handle.read())
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def document(terms: list[dict], previous: dict | None, now: _dt.datetime) -> dict:
    """The file's contents. updated_at keeps its old value when the terms have not changed."""
    stamp = str((previous or {}).get("updated_at") or "")
    if not stamp or (previous or {}).get("terms") != terms:
        stamp = now.astimezone(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"updated_at": stamp, "terms": terms}


def render(doc: dict) -> str:
    """JSON with one term per line, so a new card shows up in a diff as the lines it adds."""
    lines = ["{", '  "updated_at": ' + json.dumps(doc["updated_at"]) + ",", '  "terms": [']
    lines.append(",\n".join("    " + json.dumps(t, ensure_ascii=False) for t in doc["terms"]))
    lines += ["  ]", "}"]
    return "\n".join(line for line in lines if line) + "\n"


def write_atomic(path: str, text: str) -> None:
    """A run killed half way leaves the previous file, never half a file that Pages would then serve."""
    folder = os.path.dirname(os.path.abspath(path))
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=os.path.basename(path) + ".", suffix=".tmp", dir=folder)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def say(text: str) -> None:
    """print, but a console that cannot show Japanese gets escapes instead of a crash."""
    try:
        print(text)
    except UnicodeEncodeError:
        print(text.encode("ascii", "backslashreplace").decode("ascii"))


def main(argv: list[str] | None = None, now: _dt.datetime | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="exit 1 when the committed file is out of date; write nothing")
    ap.add_argument("--app", default=APP, help="app source to read (default: src/paldeck.html)")
    ap.add_argument("--out", default=OUT, help="file to write (default: docs/news/ja-glossary.json)")
    args = ap.parse_args(argv)

    with io.open(args.app, encoding="utf-8") as handle:
        src = handle.read()
    terms, ambiguous = build(src)
    previous = load_previous(args.out)
    by_kind = {kind: sum(1 for t in terms if t["kind"] == kind) for kind in KINDS}
    say("ja glossary: %d terms (%s)" % (len(terms), ", ".join("%d %s" % (n, k) for k, n in by_kind.items())))
    if ambiguous:
        say("  left out as ambiguous, one Japanese term with two English ones: " + ", ".join(ambiguous))

    if args.check:
        if previous is None or previous.get("terms") != terms:
            say("%s is out of date, run python tools/build_ja_glossary.py" % args.out)
            return 1
        say("%s is current" % args.out)
        return 0

    doc = document(terms, previous, now or _dt.datetime.now(_dt.timezone.utc))
    write_atomic(args.out, render(doc))
    say("wrote %s (updated_at %s)" % (args.out, doc["updated_at"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
