"""Tests for the tournament deck transcriber. Saved fixtures only, no network."""
import json
import os
import tempfile
import unittest
from pathlib import Path

import fetch_tournament_decks as ftd

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "tournament_decks"
PAGE_URL = "https://en.palworld-official-cardgame.com/deckrecipe/grand-challengers-cup_expokl26"


def page():
    return (FIXTURES / "event_page.html").read_text(encoding="utf-8")


def recipe():
    return json.loads((FIXTURES / "recipe_34.json").read_text(encoding="utf-8"))


class PageParseTests(unittest.TestCase):
    def test_recipe_ids_title_and_published_date(self):
        html = page()
        self.assertEqual(ftd.parse_recipe_ids(html), [34, 35, 36])
        self.assertEqual(ftd.parse_title(html), "Grand Challengers Cup – Bushiroad EXPO 2026 in Kuala Lumpur")
        self.assertEqual(ftd.parse_published(html), "2026-10-07")

    def test_repeated_ids_are_kept_once_in_page_order(self):
        html = ('<div class="drm-recipe-root x" data-recipe-id="9"></div>'
                '<div class="drm-recipe-root" data-recipe-id="3"></div>'
                '<div class="drm-recipe-root" data-recipe-id="9"></div>')
        self.assertEqual(ftd.parse_recipe_ids(html), [9, 3])

    def test_published_date_formats(self):
        wrap = '<p class="article-head__date c-single-content__heading-date">%s</p>'
        self.assertEqual(ftd.parse_published(wrap % "Sep. 30, 2026"), "2026-09-30")
        self.assertEqual(ftd.parse_published(wrap % "October 1, 2026"), "2026-10-01")
        self.assertEqual(ftd.parse_published(wrap % "soon"), "")
        self.assertEqual(ftd.parse_published("<p>nothing</p>"), "")


class DeckParseTests(unittest.TestCase):
    def test_real_recipe_becomes_a_deck_with_every_row(self):
        payload = recipe()
        deck, why = ftd.deck_from_detail(payload, 34)
        self.assertEqual(why, "")
        self.assertEqual(deck["placement"], "Champion")
        self.assertEqual(deck["player"], "Heng")
        self.assertEqual(deck["deck_code"], "2MVSF")
        self.assertEqual(deck["source_id"], 34)
        self.assertEqual(deck["source_url"], "https://en.palworld-official-cardgame.com/manage/deckrecipe/detail?id=34")
        self.assertEqual(len(deck["cards"]), len(payload["details"]))
        self.assertEqual(sum(c["count"] for c in deck["cards"]), sum(int(r["num"]) for r in payload["details"]))
        first = payload["details"][0]
        self.assertEqual(deck["cards"][0], {"number": first["card_number"], "count": first["num"],
                                            "zone": ftd.zone_of(first["card_type"])})
        self.assertEqual(list(deck), ["placement", "player", "deck_code", "source_id", "source_url", "cards"])

    def test_zones_follow_the_page_script(self):
        self.assertEqual([ftd.zone_of(t) for t in "abge"], ["pal", "structure", "gear", "event"])
        self.assertEqual([ftd.zone_of(t) for t in "mtr"], ["pal", "gear", "event"])
        self.assertEqual(ftd.zone_of("s"), "s")
        self.assertEqual(ftd.zone_of(""), "unknown")

    def test_a_recipe_without_cards_is_left_out(self):
        payload = recipe()
        payload["details"] = []
        deck, why = ftd.deck_from_detail(payload, 34)
        self.assertIsNone(deck)
        self.assertIn("no card details", why)
        self.assertEqual(ftd.deck_from_detail({"success": False}, 1)[0], None)
        bad = recipe()
        bad["details"][0]["num"] = 0
        self.assertIsNone(ftd.deck_from_detail(bad, 34)[0])
        bad["details"][0]["num"] = "three"
        self.assertIsNone(ftd.deck_from_detail(bad, 34)[0])


class BuildEventTests(unittest.TestCase):
    def test_failed_and_empty_recipes_are_reported_not_counted(self):
        real = recipe()
        empty = recipe()
        empty["deck"]["ranking"] = "Runner-up"
        empty["deck"]["handlename"] = "Image only"
        empty["details"] = []

        def get_json(url):
            if url.endswith("id=34"):
                return real
            if url.endswith("id=35"):
                return empty
            raise OSError("timed out")

        event, skipped = ftd.build_event(PAGE_URL, page(), get_json, "2026-10-04", "https://example.invalid/held")
        self.assertEqual([d["source_id"] for d in event["decks"]], [34])
        self.assertEqual([s["source_id"] for s in skipped], [35, 36])
        self.assertEqual(skipped[0]["player"], "Image only")
        self.assertIn("fetch failed", skipped[1]["reason"])
        self.assertEqual(event["date"], "2026-10-04")
        self.assertEqual(event["date_kind"], "held")
        self.assertEqual(event["date_source"], "https://example.invalid/held")
        self.assertEqual(event["published"], "2026-10-07")
        self.assertEqual(event["source_url"], PAGE_URL)

    def test_without_a_held_date_the_published_date_is_used_and_labelled(self):
        event, _ = ftd.build_event(PAGE_URL, page(), lambda url: recipe())
        self.assertEqual(event["date"], "2026-10-07")
        self.assertEqual(event["date_kind"], "published")
        self.assertNotIn("date_source", event)

    def test_merge_appends_a_new_event_and_replaces_the_same_page(self):
        doc = {"readme": "x", "events": [{"name": "A", "source_url": "https://a.invalid", "decks": []}]}
        ftd.merge_event(doc, {"name": "B", "source_url": "https://b.invalid", "decks": []})
        self.assertEqual([e["name"] for e in doc["events"]], ["A", "B"])
        ftd.merge_event(doc, {"name": "A2", "source_url": "https://a.invalid", "decks": []})
        self.assertEqual([e["name"] for e in doc["events"]], ["A2", "B"])

    def test_dump_is_lf_json_with_one_line_per_card(self):
        event, _ = ftd.build_event(PAGE_URL, page(), lambda url: recipe())
        text = ftd.dump({"readme": ftd.README, "events": [event]})
        self.assertNotIn("\r", text)
        self.assertTrue(text.endswith("\n"))
        self.assertIn('{"number": "', text)
        self.assertEqual(json.loads(text)["events"][0]["decks"][0]["cards"], event["decks"][0]["cards"])
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "decks.json")
            with open(out, "w", encoding="utf-8", newline="\n") as f:
                f.write(text)
            self.assertEqual(json.loads(Path(out).read_text(encoding="utf-8")), json.loads(text))


if __name__ == "__main__":
    unittest.main()
