"""Tests for the Japanese card text bake. Small saved inputs only, no network.

The committed card-text-ja.json is pinned by tools/test_card_language.cjs. These tests cover the parts that
produce it: resolve, reconcile and main's refusal to write, which are what stop a card receiving another Pal's
name and effect. The fixtures in fixtures/bake_card_text_ja are a cut down catalogue with the same traps the
real one has: a promo series that runs out of step, two Pals with identical printed numbers, a card with no
Japanese print, and a card nothing can place.
"""
import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import bake_card_text_ja as bake

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "bake_card_text_ja"


def load(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def catalogue(extra=()):
    return load("catalogue.json")["cards"] + list(extra)


def japanese():
    return load("japanese.json")


def ambiguous():
    return load("ambiguous.json")["cards"]


class BakeTestCase(unittest.TestCase):
    def setUp(self):
        # source_numbers reads card-text.json from the repo; point it at the saved hints instead.
        patcher = mock.patch.object(bake, "CARD_TEXT", str(FIXTURES / "card-text.json"))
        patcher.start()
        self.addCleanup(patcher.stop)

    def resolve(self, extra=()):
        resolved, unverified, unresolved, vocab, absent = bake.resolve(catalogue(extra), japanese())
        mapped = {num: rec.get("card_number") for num, (rec, _how) in resolved.items()}
        how = {num: h for num, (_rec, h) in resolved.items()}
        return mapped, how, unverified, unresolved, vocab, absent


class ResolveTests(BakeTestCase):
    def test_hints_skip_english_promo_numbers(self):
        self.assertEqual(bake.source_numbers(), {"EBP01-010": "BP01-010", "EPR-001": "PR-017"})

    def test_reordered_promos_follow_the_stats_not_the_number(self):
        mapped, how, _, unresolved, _, _ = self.resolve()
        # EPR-002 is Flambelle, which Japan printed as PR-001. PR-002 is a different card altogether.
        self.assertEqual(mapped["EPR-002"], "PR-001")
        self.assertEqual(how["EPR-002"], "re solved on cost, power and strike")
        # EPR-001 is PR-017 in Japan: the hand checked hint is accepted because the stats agree.
        self.assertEqual(mapped["EPR-001"], "PR-017")
        self.assertEqual(how["EPR-001"], "card-text.json mapping, stats agree")
        self.assertEqual(unresolved, [])

    def test_a_hint_whose_stats_disagree_is_not_trusted(self):
        with mock.patch.object(bake, "source_numbers", return_value={"EPR-002": "PR-002"}):
            resolved = bake.resolve(catalogue(), japanese())[0]
        self.assertEqual(resolved["EPR-002"][0]["card_number"], "PR-001")

    def test_matching_numbers_and_stats_are_taken_as_they_are(self):
        mapped, how, _, _, _, _ = self.resolve()
        self.assertEqual(mapped["EBP01-001"], "BP01-001")
        self.assertEqual(how["EBP01-001"], "number and stats agree")
        self.assertEqual(mapped["ETD02-023"], "TD02-023")

    def test_vocab_is_learned_only_from_agreeing_cards(self):
        vocab = self.resolve()[4]
        self.assertEqual(vocab[("color", "Green")], "緑")
        self.assertEqual(vocab[("color", "Red")], "赤")
        self.assertEqual(vocab[("aptitude", "Mining")], "採掘")
        self.assertNotIn(("color", "Blue"), vocab)

    def test_souls_map_by_number_and_are_reported_as_unverified(self):
        mapped, how, unverified, _, _, _ = self.resolve()
        self.assertEqual(mapped["ESOUL-001"], "SOUL-001")
        self.assertEqual(how["ESOUL-001"], "number only, card carries no stats")
        self.assertEqual(unverified, ["ESOUL-001"])

    def test_a_card_with_no_japanese_print_is_absent_not_guessed(self):
        mapped, _, _, unresolved, _, absent = self.resolve()
        self.assertNotIn("EBP01-099", mapped)
        self.assertEqual(absent, [("EBP01-099", "Unprinted Pal")])
        self.assertEqual(unresolved, [])

    def test_an_ambiguous_card_is_left_unresolved_with_its_candidates(self):
        mapped, _, _, unresolved, _, _ = self.resolve(ambiguous())
        self.assertNotIn("EPR-021", mapped)
        self.assertEqual(len(unresolved), 1)
        num, name, guess, cands = unresolved[0]
        self.assertEqual((num, name, guess), ("EPR-021", "Depresso", "PR-021"))
        self.assertEqual(sorted(cands), ["PR-017", "PR-018", "PR-019"])

    def test_variant_suffix_survives_a_re_solve(self):
        extra = [{"number": "EPR-002SR", "name": "Flambelle", "cost": "3", "power": "400", "attack": "1",
                  "color": "Red", "type": "Fire", "aptitude": "Kindling"}]
        mapped, _, _, _, _, absent = self.resolve(extra)
        # PR-001 is the base print; an SR must never be mapped onto it. With no PR SR in the fixture, the
        # honest answer is that this printing has no Japanese twin.
        self.assertNotIn("EPR-002SR", mapped)
        self.assertIn(("EPR-002SR", "Flambelle"), absent)


class ReconcileTests(BakeTestCase):
    def test_a_coincidental_number_match_loses_to_stronger_evidence(self):
        # EPR-018 is Lamball. PR-018 is Chikipi, with identical printed numbers, so pass one accepts it.
        # Chikipi holds that Japanese name on a hand checked hint, so Lamball must be moved off it.
        mapped, how, _, unresolved, _, _ = self.resolve()
        self.assertEqual(mapped["EPR-018"], "PR-017")
        self.assertEqual(how["EPR-018"], "re solved after a Japanese name collision")
        self.assertEqual(mapped["EBP01-010"], "BP01-010")
        self.assertEqual(unresolved, [])

    def test_no_two_english_cards_share_a_japanese_name_except_souls(self):
        cards = {c["number"]: c["name"] for c in catalogue()}
        resolved = bake.resolve(catalogue(), japanese())[0]
        by_name = {}
        for num, (rec, _how) in resolved.items():
            by_name.setdefault(rec["card_name"], set()).add(cards[num])
        for ja_name, english in by_name.items():
            self.assertEqual(len(english), 1, "%s is worn by %s" % (ja_name, sorted(english)))

    def test_a_collision_with_no_free_candidate_is_dropped_and_reported(self):
        # Take モコロン out of the promo set: nothing is left for EPR-018 once Chikipi keeps クルリス.
        jp = [r for r in japanese() if r["card_number"] != "PR-017"]
        with mock.patch.object(bake, "source_numbers", return_value={"EBP01-010": "BP01-010"}):
            resolved, _, unresolved, _, _ = bake.resolve(catalogue(), jp)
        self.assertNotIn("EPR-018", resolved)
        hit = [u for u in unresolved if u[0] == "EPR-018"]
        self.assertEqual(len(hit), 1)
        self.assertIn("collision on クルリス", hit[0][3])

    def test_souls_may_share_the_one_japanese_soul_name(self):
        cards = [{"number": "ESOUL-001", "name": "Soul A", "cost": "", "power": "", "attack": ""},
                 {"number": "ESOUL-002", "name": "Soul B", "cost": "", "power": "", "attack": ""}]
        jp = [{"card_number": "SOUL-001", "card_name": "ソウル"}, {"card_number": "SOUL-002", "card_name": "ソウル"}]
        with mock.patch.object(bake, "source_numbers", return_value={}):
            resolved, _, unresolved, _, _ = bake.resolve(cards, jp)
        self.assertEqual(sorted(resolved), ["ESOUL-001", "ESOUL-002"])
        self.assertEqual(unresolved, [])


class MainTests(BakeTestCase):
    """main() with the network and every output path faked into a temp folder."""

    def setUp(self):
        super().setUp()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        d = Path(self.tmp.name)
        self.out, self.raw, self.app, self.cat = d / "card-text-ja.json", d / "raw.json", d / "app.html", d / "cat.json"
        self.app.write_text("<script>\n  var RELEASE_ART = {\n  };\n</script>\n", encoding="utf-8", newline="\n")
        for name, value in (("OUT", self.out), ("RAW_CACHE", self.raw), ("APP", self.app), ("CATALOGUE", self.cat)):
            p = mock.patch.object(bake, name, str(value))
            p.start()
            self.addCleanup(p.stop)
        p = mock.patch.object(bake, "fetch_japanese", side_effect=japanese)
        p.start()
        self.addCleanup(p.stop)

    def run_main(self, cards, *argv):
        self.cat.write_text(json.dumps({"cards": cards}), encoding="utf-8")
        printed = io.StringIO()
        with mock.patch("sys.argv", ["bake_card_text_ja.py"] + list(argv)), contextlib.redirect_stdout(printed):
            code = bake.main()
        return code, printed.getvalue()

    def test_unresolved_matches_refuse_to_write_anything(self):
        before = self.app.read_text(encoding="utf-8")
        code, printed = self.run_main(catalogue(ambiguous()))
        self.assertEqual(code, 1)
        self.assertIn("UNRESOLVED, refusing to write", printed)
        self.assertIn("EPR-021", printed)
        self.assertFalse(self.out.exists())
        self.assertFalse(self.raw.exists())
        self.assertEqual(self.app.read_text(encoding="utf-8"), before)

    def test_unresolved_matches_fail_the_check_too(self):
        code, _ = self.run_main(catalogue(ambiguous()), "--check")
        self.assertEqual(code, 1)
        self.assertFalse(self.out.exists())

    def test_a_clean_bake_writes_the_verified_mapping(self):
        code, printed = self.run_main(catalogue())
        self.assertEqual(code, 0, printed)
        doc = json.loads(self.out.read_text(encoding="utf-8"))
        cards = doc["cards"]
        self.assertEqual(cards["EPR-001"]["name"], "モコロン")
        self.assertEqual(cards["EPR-002"]["name"], "フランベル")
        self.assertEqual(cards["EPR-002"]["sourceNumber"], "PR-001")
        self.assertEqual(cards["EPR-018"]["name"], "モコロン")
        self.assertNotIn("EBP01-099", cards)
        app = self.app.read_text(encoding="utf-8")
        self.assertIn(bake.BEGIN, app)
        self.assertIn('"EPR-018":{"n":"モコロン"', app)
        self.assertNotIn("\r", self.out.read_bytes().decode("utf-8"))
        # And the check now agrees the file is current.
        self.assertEqual(self.run_main(catalogue(), "--check")[0], 0)


if __name__ == "__main__":
    unittest.main()
