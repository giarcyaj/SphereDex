# -*- coding: utf-8 -*-
"""Transcribe official tournament deck recipes into docs/paldex/tournament-decks.json.

The official site renders each deck with JavaScript. An event page holds one
<div class="drm-recipe-root" data-recipe-id="N"> per deck, and the page script
(deck-recipe-manager/assets/deckrecipe-front.js) fetches each one as JSON from
  https://en.palworld-official-cardgame.com/manage/deckrecipe/detail?id=N
This script does the same, so every card count comes straight from that JSON.

Usage
  python tools/fetch_tournament_decks.py PAGE_URL [--held-date YYYY-MM-DD --held-date-source URL]
  python tools/fetch_tournament_decks.py PAGE_URL --dry-run

The event is appended to the file, or replaced in place when an event with the
same source_url is already there. A deck that cannot be fetched, or that has no
card details (an image only recipe, say), keeps its saved copy unchanged when the
event already has one (with a warning on stderr). Otherwise it is left out and
reported on stderr so it can be typed in by hand, and the script exits 1 so the
gap is noticed. Nothing is ever guessed.

card_type values, as the page script reads them:
  a Pals, b Structures, g Gear, e Events (labels from the page's DRM_FRONT config)
  m, t, r are aliases of a, g, e; p and s are not drawn on the official page.
Every row is recorded with its zone, and a deck counts as containing a card when
it lists it in any zone.
"""
import argparse
import html as htmllib
import io
import json
import os
import re
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "docs", "paldex", "tournament-decks.json")
DETAIL_URL = "https://en.palworld-official-cardgame.com/manage/deckrecipe/detail?id={id}"
UA = "SphereDex tournament deck transcriber (+https://spheredex.app)"

README = (
    "Winning deck recipes from official Palworld OFFICIAL CARD GAME events, transcribed from the "
    "official deck recipe pages by tools/fetch_tournament_decks.py. Every card count comes from the "
    "official recipe JSON; a deck with no card list is left out, never guessed. To add an event, run "
    "the script with the event page URL (it appends a new object to events). date is the day the event "
    "was held when date_kind is \"held\" (date_source says where that is stated), or the day the recipes "
    "were published when date_kind is \"published\". zone is the official card_type: pal, structure, gear, "
    "event, or the raw code for anything else. SphereDex counts a deck as containing a card when it lists "
    "it in any zone, and parallel printings share their base card's figure. Card names and decks belong "
    "to Pocketpair / Bushiroad."
)

ZONES = {"a": "pal", "m": "pal", "b": "structure", "g": "gear", "t": "gear", "e": "event", "r": "event"}
MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8,
    "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}


def fetch(url, tries=3):
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:  # network errors are reported, never papered over
            last = e
            time.sleep(1 + attempt)
    raise last


def parse_recipe_ids(page):
    """Recipe ids in page order, each once."""
    out = []
    for m in re.finditer(r'class="[^"]*\bdrm-recipe-root\b[^"]*"[^>]*data-recipe-id="(\d+)"', page):
        n = int(m.group(1))
        if n not in out:
            out.append(n)
    return out


def parse_title(page):
    m = re.search(r'<h1 class="c-single-content__heading-title">(.*?)</h1>', page, re.S)
    if not m:
        return ""
    text = re.sub(r"<[^>]+>", "", m.group(1))
    return re.sub(r"\s+", " ", htmllib.unescape(text)).strip()


def parse_published(page):
    """The article date shown above the title, as YYYY-MM-DD ("Oct. 5, 2026" -> "2026-10-05")."""
    m = re.search(r'c-single-content__heading-date">\s*([^<]+?)\s*</p>', page)
    if not m:
        return ""
    d = re.match(r"([A-Za-z]+)\.?\s+(\d{1,2}),\s*(\d{4})$", m.group(1).strip())
    if not d:
        return ""
    month = MONTHS.get(d.group(1).lower()[:3])
    if not month:
        return ""
    return "%s-%02d-%02d" % (d.group(3), month, int(d.group(2)))


def zone_of(card_type):
    t = str(card_type or "").strip().lower()
    return ZONES.get(t, t or "unknown")


def deck_from_detail(payload, recipe_id):
    """One deck from the recipe JSON, or (None, reason) when it has no usable card list."""
    if not isinstance(payload, dict) or not payload.get("success") or not isinstance(payload.get("deck"), dict):
        return None, "recipe JSON did not report success"
    deck = payload["deck"]
    cards = []
    for row in payload.get("details") or []:
        if not isinstance(row, dict):
            continue
        number = str(row.get("card_number") or "").strip().upper()
        try:
            count = int(row.get("num"))
        except (TypeError, ValueError):
            return None, "card %s has no whole number count" % (number or "?")
        if not number or count <= 0:
            return None, "a card row has no number or a count below 1"
        cards.append({"number": number, "count": count, "zone": zone_of(row.get("card_type"))})
    if not cards:
        return None, "recipe has no card details"
    out = {
        "placement": str(deck.get("ranking") or "").strip(),
        "player": str(deck.get("handlename") or "").strip(),
    }
    code = str(deck.get("deck_code") or "").strip()
    if code:
        out["deck_code"] = code
    out["source_id"] = int(recipe_id)
    out["source_url"] = DETAIL_URL.format(id=int(recipe_id))
    out["cards"] = cards
    return out, ""


def saved_decks(doc, page_url):
    """Decks already saved for this event page, by recipe id."""
    for e in doc.get("events") or []:
        if e.get("source_url") == page_url:
            return {d["source_id"]: d for d in e.get("decks") or [] if isinstance(d, dict) and "source_id" in d}
    return {}


def build_event(page_url, page, get_json, held_date="", held_source="", saved=None):
    """Event dict plus the decks that could not be fetched (each a dict with the reason).

    saved maps recipe id to the deck already in the file for this event. A recipe
    that fails but is in saved keeps that deck unchanged (its skip entry has
    kept=True), so a re-run never drops a deck because of a bad download.
    """
    title = parse_title(page)
    published = parse_published(page)
    saved = saved or {}
    decks, skipped = [], []
    for rid in parse_recipe_ids(page):
        url = DETAIL_URL.format(id=rid)
        try:
            payload = get_json(url)
        except Exception as e:
            payload, deck, why = None, None, "fetch failed: %s" % e
        else:
            deck, why = deck_from_detail(payload, rid)
        if deck is None:
            info = payload.get("deck") if isinstance(payload, dict) and isinstance(payload.get("deck"), dict) else {}
            old = saved.get(rid)
            skipped.append({
                "source_id": rid, "source_url": url, "reason": why, "kept": old is not None,
                "placement": str(info.get("ranking") or (old or {}).get("placement") or ""),
                "player": str(info.get("handlename") or (old or {}).get("player") or ""),
            })
            if old is None:
                continue
            deck = old
        decks.append(deck)
    event = {"name": title, "date": held_date or published, "date_kind": "held" if held_date else "published"}
    if held_date and held_source:
        event["date_source"] = held_source
    event["published"] = published
    event["source_url"] = page_url
    event["decks"] = decks
    return event, skipped


def merge_event(doc, event):
    """Replace the event with the same source_url, or append it. Returns the document."""
    events = doc.setdefault("events", [])
    for i, e in enumerate(events):
        if e.get("source_url") == event["source_url"]:
            events[i] = event
            return doc
    events.append(event)
    return doc


def dump(doc):
    """Two space JSON with each card row on one line, so a deck reads as a list."""
    text = json.dumps(doc, ensure_ascii=False, indent=2)
    text = re.sub(r'\{\n\s+("number": "[^"\n]*"),\n\s+("count": \d+),\n\s+("zone": "[^"\n]*")\n\s+\}',
                  r"{\1, \2, \3}", text)
    return text + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("page_url")
    ap.add_argument("--held-date", default="", help="YYYY-MM-DD the event was held, when a source states it")
    ap.add_argument("--held-date-source", default="", help="URL that states the held date")
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--dry-run", action="store_true", help="print the event instead of writing the file")
    args = ap.parse_args(argv)
    if args.held_date and not re.match(r"^\d{4}-\d{2}-\d{2}$", args.held_date):
        ap.error("--held-date must be YYYY-MM-DD")

    doc = {"readme": README, "events": []}
    if os.path.exists(args.out):
        with io.open(args.out, encoding="utf-8") as f:
            doc = json.load(f)
    page = fetch(args.page_url)
    event, skipped = build_event(args.page_url, page, lambda u: json.loads(fetch(u)),
                                 args.held_date, args.held_date_source, saved_decks(doc, args.page_url))
    for s in skipped:
        label = "KEPT SAVED COPY (fetch failed, saved deck unchanged)" if s["kept"] else "SKIPPED (type in by hand)"
        sys.stderr.write("%s: %s | %s | %s | id %s | %s | %s\n" % (
            label, event["name"], s["placement"], s["player"], s["source_id"], s["source_url"], s["reason"]))
    missing = sum(1 for s in skipped if not s["kept"])
    if not event["decks"]:
        sys.exit("no decks with card details on " + args.page_url)
    if args.dry_run:
        sys.stdout.write(dump(event))
        return 1 if missing else 0
    doc["readme"] = README
    merge_event(doc, event)
    with io.open(args.out, "w", encoding="utf-8", newline="\n") as f:
        f.write(dump(doc))
    sys.stderr.write("%s: %d decks written, %d kept from the saved file, %d missing\n" % (
        event["name"], len(event["decks"]), len(skipped) - missing, missing))
    if missing:
        sys.stderr.write("%d recipe(s) could not be fetched and are not in the file; type them in by hand\n" % missing)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
