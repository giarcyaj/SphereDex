"""Tests for the Japanese to English name list the backend translator reads. No network.

Most tests build a small app source in memory with the same three tables the real one has (RAW, RAW2
with a note between rows, and the CARD_TEXT_JA block between the bake's markers), using real card
names so the traps are the real ones: a reprint, an epithet two Pals share, and Soul cards that all
print the same Japanese name. The last few read the committed src/paldeck.html and
docs/news/ja-glossary.json, so a card baked without regenerating the glossary fails here.
"""
import contextlib
import datetime as dt
import io
import json
import re
import tempfile
import unittest
from pathlib import Path

import build_ja_glossary as G

ROOT = Path(__file__).resolve().parent.parent

# (id, English name, Japanese name). None means the card has no Japanese print.
CARDS = [
    ("EBP01-001", "Jormuntide Ignis – Savage Lava Dragon", "荒ぶる溶岩竜 – アグニドラ"),
    ("EBP01-001OSR", "Jormuntide Ignis – Savage Lava Dragon", "荒ぶる溶岩竜 – アグニドラ"),
    ("EBP01-047", "Pal Sphere", "パルスフィア"),
    ("EBP01-020", "Pump-Action Shotgun", "ポンプ式ショットガン"),
    ("EPR-001", "Lamball – My First Pal", "始まりのパル – モコロン"),
    ("ETD02-023", "Cattiva – My First Pal", "始まりのパル – ツッパニャン"),
    ("ESOUL-002", "Soul", "ソウル"),
    ("ESOUL-016", "Depresso & Grizzbolt", "ソウル"),
    ("ESOUL-004", "Soul", None),
]


def app_source(cards=CARDS):
    """A cut down src/paldeck.html: EBP01 rows in RAW, the rest in RAW2, Japanese in CARD_TEXT_JA."""
    def row(cid, name):
        return json.dumps([cid, name, "Pal", "", "", "", "", "", "", "", "", "", "SET"], ensure_ascii=False)

    raw = [row(cid, en) for cid, en, _ in cards if cid.startswith("EBP01")]
    raw2 = [row(cid, en) for cid, en, _ in cards if not cid.startswith("EBP01")]
    ja = {cid: {"n": name} for cid, _, name in cards if name}
    return ("<script>\n"
            "  var RAW = [" + ",".join(raw) + "];\n"
            "  var RAW2 = [\n    // promos and Souls, a note between rows as the real table has\n    "
            + ",\n    ".join(raw2) + "\n  ];\n"
            + G.BEGIN + "  var CARD_TEXT_JA = "
            + json.dumps(ja, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + ";\n" + G.END
            + "</script>\n")


def by_ja(terms):
    return {t["ja"]: t for t in terms}


def quiet(fn, *args, **kwargs):
    with contextlib.redirect_stdout(io.StringIO()) as out:
        result = fn(*args, **kwargs)
    return result, out.getvalue()


class HalvesTests(unittest.TestCase):
    def test_a_name_splits_only_on_one_spaced_en_dash(self):
        self.assertEqual(G.halves("荒ぶる溶岩竜 – アグニドラ"), ("荒ぶる溶岩竜", "アグニドラ"))
        self.assertIsNone(G.halves("Pump-Action Shotgun"), "a hyphen inside a name is not the separator")
        self.assertIsNone(G.halves("Pal Sphere"))
        self.assertIsNone(G.halves("a – b – c"), "two separators: no safe way to say which half is the Pal")
        self.assertIsNone(G.halves(" – アグニドラ"))


class SourceTests(unittest.TestCase):
    def test_names_come_from_raw_raw2_and_card_text_ja(self):
        src = app_source()
        english, japanese = G.card_names(src), G.japanese_names(src)
        self.assertEqual(english["EBP01-001"], "Jormuntide Ignis – Savage Lava Dragon")
        self.assertEqual(english["ESOUL-016"], "Depresso & Grizzbolt")
        self.assertEqual(japanese["EBP01-001"], "荒ぶる溶岩竜 – アグニドラ")
        self.assertNotIn("ESOUL-004", japanese)

    def test_a_card_with_no_japanese_print_gives_no_pair(self):
        src = app_source()
        pairs = G.card_pairs(G.card_names(src), G.japanese_names(src))
        self.assertEqual(len([p for p in pairs if p[2] == "card"]), 8, "every card but ESOUL-004")
        self.assertTrue(all(ja and en for ja, en, _ in pairs))

    def test_an_app_without_the_card_text_block_refuses(self):
        src = app_source().split(G.BEGIN)[0]
        with self.assertRaises(SystemExit):
            G.japanese_names(src)


class PairTests(unittest.TestCase):
    def setUp(self):
        self.terms, self.ambiguous = G.build(app_source())
        self.by_ja = by_ja(self.terms)

    def test_a_pal_card_gives_its_full_name_its_pal_and_its_epithet_the_right_way_round(self):
        # Japanese prints "epithet – Pal", English "Pal – epithet".
        self.assertEqual(self.by_ja["荒ぶる溶岩竜 – アグニドラ"],
                         {"ja": "荒ぶる溶岩竜 – アグニドラ", "en": "Jormuntide Ignis – Savage Lava Dragon", "kind": "card"})
        self.assertEqual(self.by_ja["アグニドラ"], {"ja": "アグニドラ", "en": "Jormuntide Ignis", "kind": "pal"})
        self.assertEqual(self.by_ja["荒ぶる溶岩竜"], {"ja": "荒ぶる溶岩竜", "en": "Savage Lava Dragon", "kind": "epithet"})

    def test_a_reprint_adds_nothing_new(self):
        self.assertEqual(len(self.terms), len(self.by_ja), "one term per Japanese string")

    def test_an_epithet_two_pals_share_keeps_one_english_and_each_pal_its_own(self):
        self.assertEqual(self.by_ja["始まりのパル"]["en"], "My First Pal")
        self.assertEqual(self.by_ja["モコロン"]["en"], "Lamball")
        self.assertEqual(self.by_ja["ツッパニャン"]["en"], "Cattiva")

    def test_a_name_with_no_separator_is_a_card_name_only(self):
        self.assertEqual(self.by_ja["パルスフィア"], {"ja": "パルスフィア", "en": "Pal Sphere", "kind": "card"})
        self.assertEqual(self.by_ja["ポンプ式ショットガン"]["en"], "Pump-Action Shotgun")

    def test_fixed_terms_win_so_soul_still_means_soul(self):
        # As a card name ソウル is ambiguous (Soul, Depresso & Grizzbolt), but the hand checked term stands.
        self.assertEqual(self.by_ja["ソウル"], {"ja": "ソウル", "en": "Soul", "kind": "term"})
        self.assertIn("目覚めし伝説", self.by_ja)

    def test_longest_japanese_comes_first(self):
        lengths = [len(t["ja"]) for t in self.terms]
        self.assertEqual(lengths, sorted(lengths, reverse=True))
        order = [t["ja"] for t in self.terms]
        self.assertLess(order.index("荒ぶる溶岩竜 – アグニドラ"), order.index("アグニドラ"))


class MergeTests(unittest.TestCase):
    def test_a_japanese_term_with_two_english_ones_is_left_out_and_reported(self):
        derived = [("ソウル", "Soul", "card"), ("ソウル", "Depresso & Grizzbolt", "card"), ("温泉", "Hot Spring", "card")]
        terms, ambiguous = G.merge(derived, fixed=[])
        self.assertEqual([t["ja"] for t in terms], ["温泉"])
        self.assertEqual(ambiguous, ["ソウル"])

    def test_a_pal_name_with_two_english_names_goes_but_the_rest_of_the_card_stays(self):
        cards = CARDS + [("EPR-099", "Chikipi – My First Pal", "始まりのパル – モコロン")]
        src = app_source(cards)
        english, japanese = G.card_names(src), G.japanese_names(src)
        terms, ambiguous = G.merge(G.card_pairs(english, japanese), fixed=[])
        found = by_ja(terms)
        self.assertNotIn("モコロン", found)
        self.assertIn("モコロン", ambiguous)
        self.assertNotIn("始まりのパル – モコロン", found, "the full name is ambiguous too")
        self.assertEqual(found["始まりのパル"]["en"], "My First Pal")
        self.assertEqual(found["ツッパニャン"]["en"], "Cattiva")

    def test_a_fixed_term_replaces_a_derived_one_with_different_english(self):
        terms, ambiguous = G.merge([("ギア", "Gear Card", "card")], fixed=[("ギア", "Gear", "term")])
        self.assertEqual(terms, [{"ja": "ギア", "en": "Gear", "kind": "term"}])
        self.assertEqual(ambiguous, [])

    def test_the_more_specific_kind_wins_for_the_same_pair(self):
        terms, _ = G.merge([("モコロン", "Lamball", "card"), ("モコロン", "Lamball", "pal")], fixed=[])
        self.assertEqual(terms, [{"ja": "モコロン", "en": "Lamball", "kind": "pal"}])

    def test_terms_with_no_japanese_or_one_character_are_dropped(self):
        derived = [("SOUL", "Soul", "card"), ("炉", "Furnace", "card"), ("温泉", "Hot Spring", "card"),
                   ("温泉", "", "card"), ("  警鐘 ", " Alarm Bell ", "card")]
        terms, _ = G.merge(derived, fixed=[])
        self.assertEqual(terms, [{"ja": "温泉", "en": "Hot Spring", "kind": "card"},
                                 {"ja": "警鐘", "en": "Alarm Bell", "kind": "card"}])


class OrderGuardTests(unittest.TestCase):
    def test_the_documented_order_fits_and_the_swapped_one_does_not(self):
        src = app_source()
        documented, swapped = G.check_order(G.card_names(src), G.japanese_names(src))
        self.assertEqual(documented, 0)
        self.assertGreater(swapped, 0, "read the other way, 始まりのパル would be both Lamball and Cattiva")

    def test_english_names_printed_in_the_japanese_order_refuse_to_build(self):
        flipped = [(cid, " – ".join(reversed(en.split(" – "))), ja) for cid, en, ja in CARDS]
        with self.assertRaises(SystemExit):
            G.build(app_source(flipped))


class FixedTermTests(unittest.TestCase):
    def test_the_fixed_list_is_well_formed(self):
        japanese = [ja for ja, _, _ in G.FIXED_TERMS]
        self.assertEqual(len(japanese), len(set(japanese)), "each Japanese term once")
        for ja, en, kind in G.FIXED_TERMS:
            with self.subTest(ja=ja):
                self.assertIn(kind, ("set", "term"))
                self.assertTrue(G.usable(ja, en))
                # These English words are ours, not printed card names, so the copy rule applies.
                self.assertIsNone(re.search(r"[-‐-―−]", en))

    def test_the_names_this_feed_needs_are_there(self):
        fixed = {ja: (en, kind) for ja, en, kind in G.FIXED_TERMS}
        self.assertEqual(fixed["目覚めし伝説"], ("Legends Awaken", "set"))
        self.assertEqual(fixed["パルパゴスの夜明け"], ("Dawn of Palpagos", "set"))
        self.assertEqual(fixed["果てなき飛翔"], ("Eternal Ascent", "set"))
        self.assertEqual(fixed["パルワールドカードゲーム"], ("Palworld Card Game", "term"))
        self.assertEqual(fixed["ブースターパック"], ("Booster Pack", "term"))
        self.assertEqual(fixed["トライアルデッキ"], ("Trial Deck", "term"))
        self.assertNotIn("スターターデッキ", fixed, "the English product is Trial Deck")


class DocumentTests(unittest.TestCase):
    NOW = dt.datetime(2026, 10, 14, 12, 0, 0, tzinfo=dt.timezone.utc)
    LATER = dt.datetime(2026, 10, 15, 9, 30, 0, tzinfo=dt.timezone.utc)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ja-glossary-")
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.app = self.dir / "paldeck.html"
        self.app.write_text(app_source(), encoding="utf-8")
        self.out = self.dir / "news" / "ja-glossary.json"

    def run_main(self, *extra, now=None):
        return quiet(G.main, ["--app", str(self.app), "--out", str(self.out), *extra], now=now)[0]

    def test_the_file_is_json_in_the_documented_shape(self):
        self.assertEqual(self.run_main(now=self.NOW), 0)
        doc = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertEqual(set(doc), {"updated_at", "terms"})
        self.assertEqual(doc["updated_at"], "2026-10-14T12:00:00Z")
        for term in doc["terms"]:
            self.assertEqual(set(term), {"ja", "en", "kind"})
            self.assertIn(term["kind"], G.KINDS)
        self.assertEqual(doc["terms"], G.build(app_source())[0])

    def test_updated_at_only_moves_when_the_terms_change(self):
        self.run_main(now=self.NOW)
        first = self.out.read_bytes()
        self.run_main(now=self.LATER)
        self.assertEqual(self.out.read_bytes(), first, "nothing new: the file is left byte for byte")
        self.app.write_text(app_source(CARDS + [("EBP01-041", "Hot Spring", "温泉")]), encoding="utf-8")
        self.run_main(now=self.LATER)
        doc = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertEqual(doc["updated_at"], "2026-10-15T09:30:00Z")
        self.assertIn("温泉", by_ja(doc["terms"]))

    def test_check_passes_on_a_current_file_and_fails_on_a_stale_or_missing_one(self):
        self.assertEqual(self.run_main("--check"), 1, "no file yet")
        self.assertFalse(self.out.exists(), "--check writes nothing")
        self.run_main(now=self.NOW)
        self.assertEqual(self.run_main("--check"), 0)
        self.app.write_text(app_source(CARDS + [("EBP01-041", "Hot Spring", "温泉")]), encoding="utf-8")
        self.assertEqual(self.run_main("--check"), 1)

    def test_one_term_per_line(self):
        self.run_main(now=self.NOW)
        lines = self.out.read_text(encoding="utf-8").splitlines()
        term_lines = [line for line in lines if line.strip().startswith('{"ja"')]
        self.assertEqual(len(term_lines), len(G.build(app_source())[0]))


class RepoTests(unittest.TestCase):
    """The committed app and the committed glossary, read from disk."""

    @classmethod
    def setUpClass(cls):
        cls.src = (ROOT / "src" / "paldeck.html").read_text(encoding="utf-8")
        cls.terms, cls.ambiguous = G.build(cls.src)
        cls.by_ja = by_ja(cls.terms)

    def test_the_real_cards_give_official_names(self):
        self.assertEqual(self.by_ja["アグニドラ"]["en"], "Jormuntide Ignis")
        self.assertEqual(self.by_ja["荒ぶる溶岩竜"]["en"], "Savage Lava Dragon")
        self.assertEqual(self.by_ja["モコロン"]["en"], "Lamball")
        self.assertEqual(self.by_ja["ファイアーブレス"]["en"], "Ignis Breath", "an official name a model would not guess")

    def test_every_japanese_term_appears_once_and_longest_first(self):
        japanese = [t["ja"] for t in self.terms]
        self.assertEqual(len(japanese), len(set(japanese)))
        self.assertEqual([len(j) for j in japanese], sorted((len(j) for j in japanese), reverse=True))

    def test_the_committed_glossary_is_current(self):
        path = ROOT / "docs" / "news" / "ja-glossary.json"
        doc = json.loads(path.read_text(encoding="utf-8"))
        self.assertRegex(doc["updated_at"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
        self.assertEqual(doc["terms"], self.terms,
                         "docs/news/ja-glossary.json is out of date: run python tools/build_ja_glossary.py")


if __name__ == "__main__":
    unittest.main()
