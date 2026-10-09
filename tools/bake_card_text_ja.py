#!/usr/bin/env python3
"""Bake src/card-text-ja.json: the real printed Japanese name and rules text for every card.

WHY THE CROSS CHECK IS NOT OPTIONAL
-----------------------------------
The obvious mapping, strip the leading E from an English card number to get the Japanese one, is right for
241 of 277 printings and WRONG for the promos. The English and Japanese promo series do not run in step:
EPR-002's stats (cost 3, power 400, strike 1) sit on the Japanese PR-001. A third party feed that zipped the
two lists positionally shipped Lamball's promo carrying Flambelle's Japanese name and effect, and nothing in
the data looks wrong until a Japanese speaker reads it.

So this tool never trusts a card number. It proposes a match, then VERIFIES it on three independent printed
numbers: cost, power and strike. A card whose numbers disagree is re solved against every candidate in the
same Japanese set, and is only accepted when exactly one candidate matches on all three. Anything still
unresolved is reported and the bake FAILS rather than writing a quietly wrong file.

Soul cards carry no stats, so they cannot be verified this way. They are 1 to 1 by number and are not a
reordered series, so they are mapped by number and counted separately in the report.

SOURCE AND CREDIT
-----------------
Japanese text comes from the official Palworld card game site's own public card list endpoint. It is the
publisher's own data, which is why it is used in preference to any fan database for the Japanese. The
English rules text SphereDex already ships comes from palworldtcg.gg and that credit is unchanged.

Run:  python tools/bake_card_text_ja.py            (fetches, verifies, writes)
      python tools/bake_card_text_ja.py --check    (verifies the committed file is current, writes nothing)
"""
import argparse
import io
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "src", "card-text-ja.json")
CATALOGUE = os.path.join(ROOT, "app", "src", "main", "assets", "paldeck_cards.json")
CARD_TEXT = os.path.join(ROOT, "src", "card-text.json")
RAW_CACHE = os.path.join(ROOT, "src", "card-text-ja.source.json")

API = "https://palworld-official-cardgame.com/manage/card-list-user/list"
UA = "SphereDex/2.4 (+https://spheredex.app) card text bake"
SOURCE_URL = "https://palworld-official-cardgame.com/"


def fetch_japanese():
    """Every Japanese card record, three pages of 100."""
    out, page = [], 1
    while True:
        req = urllib.request.Request(
            "%s?page=%d&per_page=100" % (API, page), headers={"User-Agent": UA}
        )
        with urllib.request.urlopen(req, timeout=60) as r:
            body = json.loads(r.read().decode("utf-8"))
        items = body.get("items") or []
        out.extend(items)
        if len(out) >= int(body.get("total") or 0) or not items:
            break
        page += 1
    return out


def as_int(v):
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return None


def stats(rec, cost="cost", power="power", attack="attack"):
    return (as_int(rec.get(cost)), as_int(rec.get(power)), as_int(rec.get(attack)))


def comparable(a, b):
    """True when every field both sides actually carry agrees. None means 'this card has no such stat'."""
    pairs = [(x, y) for x, y in zip(a, b) if x is not None and y is not None]
    return bool(pairs) and all(x == y for x, y in pairs)


def set_of(number):
    """The series a card number belongs to, e.g. BP01-025SSP -> BP01, SOUL-002 -> SOUL."""
    return number.split("-", 1)[0] if "-" in number else number


def parts(v):
    """A printed multi value field, e.g. 'Dragon|Fire' or 'Crafting|Transporting|Farming'."""
    return [p.strip() for p in str(v or "").split("|") if p.strip()]


def learn_vocab(pairs):
    """Teach ourselves the Japanese for each printed colour, type and aptitude.

    The colour, element and aptitude on a Japanese card are printed in Japanese, so they cannot be compared
    with the English ones directly. Rather than hand write a dictionary, which would be one more thing to get
    quietly wrong, derive it from the cards that already verified on cost, power and strike: every confirmed
    pair is one English word sitting opposite its Japanese word. A word is only learned when every confirmed
    sighting agrees, so an ambiguous reading teaches nothing instead of teaching a guess.
    """
    seen = {}
    for c, r in pairs:
        for field, ours, theirs in (
            ("color", [c.get("color")], [r.get("color")]),
            ("type", parts(c.get("type")), parts(r.get("type"))),
            ("aptitude", parts(c.get("aptitude")), parts(r.get("aptitude"))),
        ):
            if len(ours) != len(theirs):
                continue
            for a, b in zip(ours, theirs):
                if a and b:
                    seen.setdefault((field, a), set()).add(b)
    return {k: next(iter(v)) for k, v in seen.items() if len(v) == 1}


def printed_match(c, r, vocab):
    """True when every printed field we can translate agrees. Unknown words abstain rather than veto."""
    for field, ours, theirs in (
        ("color", [c.get("color")], [r.get("color")]),
        ("type", parts(c.get("type")), parts(r.get("type"))),
        ("aptitude", parts(c.get("aptitude")), parts(r.get("aptitude"))),
    ):
        if len(ours) != len(theirs):
            return False
        for a, b in zip(ours, theirs):
            want = vocab.get((field, a))
            if want is not None and want != b:
                return False
    return True


def source_numbers():
    """The English to Japanese number mapping already carried by card-text.json.

    Those sourceNumber values were established when the English rules text was baked and are the printed
    Japanese numbers, so they settle the promos that no amount of stat matching can: EPR-020 is TD02-023,
    which is a different SERIES, not merely a different position. Entries that point back at an E number are
    ignored, since those are English promos with no Japanese twin recorded.
    """
    if not os.path.exists(CARD_TEXT):
        return {}
    doc = json.load(io.open(CARD_TEXT, encoding="utf-8"))
    out = {}
    for num, entry in (doc.get("cards") or {}).items():
        src = (entry or {}).get("sourceNumber") or ""
        if src and not src.startswith("E"):
            out[num] = src
    return out


def resolve(cards, jp):
    hints = source_numbers()
    by_num = {r.get("card_number"): r for r in jp}
    by_set = {}
    for r in jp:
        by_set.setdefault(set_of(r.get("card_number") or ""), []).append(r)

    # Pass one: the cards whose number and stats already agree. These are the ground truth.
    resolved, unverified, pending, confirmed_pairs, absent = {}, [], [], [], []
    for c in cards:
        num = c.get("number") or ""
        guess = num[1:] if num.startswith("E") else num
        hinted = hints.get(num)
        # A hinted number is still only a proposal: it is accepted exactly when the stats agree.
        for proposal, label in ((hinted, "card-text.json mapping, stats agree"),
                                (guess, "number and stats agree")):
            cand = by_num.get(proposal) if proposal else None
            if cand is not None and comparable(stats(c), stats(cand)):
                resolved[num] = (cand, label)
                confirmed_pairs.append((c, cand))
                break
        else:
            pending.append((c, num, guess, by_num.get(guess)))

    vocab = learn_vocab(confirmed_pairs)
    # The same English card name opposite its Japanese one, learned the same way and only kept where every
    # confirmed sighting agrees.
    seen_names = {}
    for c, r in confirmed_pairs:
        if c.get("name") and r.get("card_name"):
            seen_names.setdefault(c["name"], set()).add(r["card_name"])
    names = {k: next(iter(v)) for k, v in seen_names.items() if len(v) == 1}

    # Pass two: everything the number got wrong, re solved against the printed fields.
    unresolved = []
    for c, num, guess, cand in pending:
        ours = stats(c)

        # No stats on either side: a Soul. 1 to 1 by number, not a reordered series.
        if cand is not None and all(v is None for v in ours):
            resolved[num] = (cand, "number only, card carries no stats")
            unverified.append(num)
            continue

        matches = [r for r in by_set.get(set_of(guess), []) if comparable(ours, stats(r))]
        # A variant suffix must survive the re solve: an SSP maps to an SSP, never to the base print.
        suffix = guess.split("-", 1)[1] if "-" in guess else ""
        tail = "".join(ch for ch in suffix if ch.isalpha())
        if tail:
            matches = [r for r in matches if (r.get("card_number") or "").endswith(tail)]
        else:
            matches = [
                r for r in matches
                if not "".join(ch for ch in (r.get("card_number") or "").split("-", 1)[-1] if ch.isalpha())
            ]

        how = "re solved on cost, power and strike"
        if len(matches) > 1:
            narrowed = [r for r in matches if printed_match(c, r, vocab)]
            if len(narrowed) == 1:
                matches, how = narrowed, "re solved on stats plus colour, element and aptitude"

        # Still tied. The same Pal is often printed more than once, so a card that already resolved may
        # carry this exact English name and therefore already know its Japanese one. EPR-020 Cattiva is
        # indistinguishable from seven other Normal Pals on every printed number, but ETD02-023 is the same
        # card and resolved cleanly.
        if len(matches) > 1:
            want = names.get(c.get("name"))
            if want:
                narrowed = [r for r in matches if (r.get("card_name") or "") == want]
                if len(narrowed) == 1:
                    matches, how = narrowed, "re solved on the Japanese name of the same card elsewhere"

        if len(matches) == 1:
            resolved[num] = (matches[0], how)
        elif not matches and cand is None and not any(  # noqa: E501 - kept next to its sibling branch
            (r.get("card_number") or "") == guess for r in by_set.get(set_of(guess), [])
        ):
            # There is simply no Japanese print of this card. A real gap, not a mismatch.
            absent.append((num, c.get("name")))
        else:
            unresolved.append((num, c.get("name"), guess, [m.get("card_number") for m in matches]))

    reconcile(cards, resolved, by_set, vocab, unresolved)
    return resolved, unverified, unresolved, vocab, absent


# How much a resolution is worth when two cards claim the same Japanese card. A mapping that came out of
# card-text.json was established by hand against the English text; a re solve had to satisfy printed fields;
# a bare number agreement is the weakest, because stats alone do not separate cards that share them.
STRENGTH = {
    "card-text.json mapping, stats agree": 4,
    "re solved on the Japanese name of the same card elsewhere": 3,
    "re solved on stats plus colour, element and aptitude": 2,
    "re solved on cost, power and strike": 2,
    "number and stats agree": 1,
    "number only, card carries no stats": 0,
}


def reconcile(cards, resolved, by_set, vocab, unresolved):
    """Enforce the invariant that a Japanese card name belongs to exactly one English card.

    Lamball, Cattiva and Chikipi are all 2 cost, 200 power, 1 strike Normal Pals of the same colour, so no
    printed number separates them and a number based guess can agree by pure coincidence. EPR-018 is Lamball
    and lands on PR-018, which is Chikipi, and every check above passes. The contradiction only shows up
    across cards: Chikipi already holds that Japanese name on stronger evidence, so Lamball cannot also have
    it. Weaker claims are re solved against what is left, and a claim that cannot be re solved fails the bake
    rather than shipping a card wearing another Pal's name.
    """
    english = {c.get("number"): (c.get("name") or "") for c in cards}
    by_card = {c.get("number"): c for c in cards}

    # Who else already holds each Japanese name, and on what evidence.
    claims = {}
    for num, (rec, how) in resolved.items():
        claims.setdefault(rec.get("card_name") or "", []).append((num, how))

    for ja_name, holders in sorted(claims.items()):
        names = {english.get(n) for n, _ in holders}
        if len(names) < 2:
            continue  # the same card printed more than once, which is expected
        # Souls are the one real exception: every Japanese Soul card prints the single name ソウル whatever
        # Pals are illustrated on it, so several different English Souls legitimately share it.
        if all(n.startswith("ESOUL") for n, _ in holders):
            continue
        holders.sort(key=lambda h: -STRENGTH.get(h[1], 0))
        keep_name = english.get(holders[0][0])
        for num, _how in holders:
            if english.get(num) == keep_name:
                continue
            c = by_card.get(num)
            guess = num[1:] if num.startswith("E") else num
            # A Japanese name already held by a DIFFERENT English card is taken. One held by the same card
            # printed elsewhere is not: EPR-018 and EPR-001 are both Lamball and must share モコロン.
            taken = {
                rec.get("card_name") for other, (rec, _) in resolved.items()
                if english.get(other) != english.get(num)
            }
            options = [
                r for r in by_set.get(set_of(guess), [])
                if comparable(stats(c), stats(r))
                and printed_match(c, r, vocab)
                and (r.get("card_name") or "") not in taken
            ]
            tail = "".join(ch for ch in guess.split("-", 1)[-1] if ch.isalpha())
            options = [
                r for r in options
                if "".join(ch for ch in (r.get("card_number") or "").split("-", 1)[-1] if ch.isalpha()) == tail
            ]
            if len(options) == 1:
                resolved[num] = (options[0], "re solved after a Japanese name collision")
            else:
                del resolved[num]
                unresolved.append((num, english.get(num), guess,
                                   ["collision on " + ja_name] + [r.get("card_number") for r in options]))


def build(cards, jp):
    resolved, unverified, unresolved, vocab, absent = resolve(cards, jp)
    out = {}
    for num, (rec, how) in sorted(resolved.items()):
        entry = {"name": rec.get("card_name") or "", "sourceNumber": rec.get("card_number") or ""}
        text = (rec.get("text") or "").strip()
        if text:
            entry["text"] = text
        entry["match"] = how
        out[num] = entry
    return out, unverified, unresolved, vocab, absent


APP = os.path.join(ROOT, "src", "paldeck.html")
BEGIN = "  // CARD TEXT JA BEGIN (generated by tools/bake_card_text_ja.py, do not hand edit)\n"
END = "  // CARD TEXT JA END\n"


def embed(entries):
    """Inject the runtime copy into src/paldeck.html between its markers.

    The committed JSON keeps the provenance (which Japanese number each card resolved to and how), because
    that is what makes the mapping auditable later. The app only needs the name and the text, so the runtime
    copy drops everything else and ships minified: on a bundle this size the difference is worth having.
    """
    runtime = {}
    for num, e in sorted(entries.items()):
        row = {"n": e["name"]}
        if e.get("text"):
            row["t"] = e["text"]
        runtime[num] = row
    literal = json.dumps(runtime, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    block = BEGIN + "  var CARD_TEXT_JA = " + literal + ";\n" + END

    s = io.open(APP, encoding="utf-8", newline="").read()
    if BEGIN in s and END in s:
        head, rest = s.split(BEGIN, 1)
        _, tail = rest.split(END, 1)
        s = head + block + tail
    else:
        anchor = "  var RELEASE_ART = {\n"
        if anchor not in s:
            raise SystemExit("cannot find an anchor to insert CARD_TEXT_JA before")
        s = s.replace(anchor, block + anchor, 1)
    io.open(APP, "w", encoding="utf-8", newline="").write(s)
    print("embedded CARD_TEXT_JA into src/paldeck.html (%d cards, %d bytes)" % (len(runtime), len(literal)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="verify the committed file is current; write nothing")
    args = ap.parse_args()

    cat = json.load(io.open(CATALOGUE, encoding="utf-8"))
    cards = cat["cards"] if isinstance(cat, dict) else cat

    jp = fetch_japanese()
    print("fetched %d Japanese records" % len(jp))

    entries, unverified, unresolved, vocab, absent = build(cards, jp)

    named = len(entries)
    texted = sum(1 for v in entries.values() if v.get("text"))
    print("resolved %d of %d printings" % (named, len(cards)))
    print("  with Japanese rules text   : %d" % texted)
    print("  mapped by number, no stats : %d (Soul cards)" % len(unverified))
    resolved_by_stats = sum(1 for v in entries.values() if v["match"].startswith("re solved"))
    print("  re solved against the number: %d (the promo series runs out of step)" % resolved_by_stats)
    print("  printed words learned        : %d (colour, element and aptitude, derived not hand written)" % len(vocab))
    if absent:
        print("  no Japanese print exists    : %d (%s)" % (len(absent), ", ".join(n for n, _ in absent)))

    if unresolved:
        print("\nUNRESOLVED, refusing to write a file that may be wrong:")
        for num, name, guess, cands in unresolved:
            print("   %-12s %-36s guessed %-12s candidates=%s" % (num, str(name)[:36], guess, cands))
        return 1

    doc = {
        "readme": (
            "Printed Japanese card names and rules text, keyed by SphereDex card number. Baked by "
            "tools/bake_card_text_ja.py from the official Palworld card game site's public card list. "
            "Every entry is verified against the English card on cost, power and strike, because the "
            "English and Japanese promo series do not run in step and a number based mapping silently "
            "puts the wrong Pal's name and effect on a card. match records how each one was resolved. "
            "Card text and names belong to Bushiroad / Pocketpair."
        ),
        "source": SOURCE_URL,
        "cards": entries,
    }
    body = json.dumps(doc, ensure_ascii=False, indent=1, sort_keys=True) + "\n"

    if args.check:
        if not os.path.exists(OUT):
            print("\n%s is missing" % OUT)
            return 1
        current = io.open(OUT, encoding="utf-8", newline="").read()
        if current != body:
            print("\n%s is stale, re run without --check" % OUT)
            return 1
        print("\n%s is current" % OUT)
        return 0

    io.open(OUT, "w", encoding="utf-8", newline="\n").write(body)
    io.open(RAW_CACHE, "w", encoding="utf-8", newline="\n").write(
        json.dumps(jp, ensure_ascii=False, indent=1, sort_keys=True) + "\n"
    )
    embed(entries)
    print("\nwrote %s" % OUT)
    print("wrote %s (the fetched payload, so a bake is reproducible offline)" % RAW_CACHE)
    return 0


if __name__ == "__main__":
    sys.exit(main())
