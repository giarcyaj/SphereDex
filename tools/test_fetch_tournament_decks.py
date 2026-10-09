"""Tests for the tournament deck transcriber. Saved fixtures only, no network."""
import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

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


def recipe_for(rid):
    """The saved recipe, relabelled so each id gives a different deck."""
    payload = recipe()
    payload["deck"]["ranking"] = "Place %d" % rid
    payload["deck"]["handlename"] = "Player %d" % rid
    payload["details"][0]["num"] = rid % 4 + 1
    return payload


class RerunTests(unittest.TestCase):
    """main() run again on an event already in the file. Fetches are faked, no network."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = os.path.join(self.tmp.name, "decks.json")

    def tearDown(self):
        self.tmp.cleanup()

    def save(self, decks):
        event, _ = ftd.build_event(PAGE_URL, page(), lambda url: recipe_for(int(url.rsplit("=", 1)[1])))
        event["decks"] = [d for d in event["decks"] if d["source_id"] in decks]
        other = {"name": "Other", "source_url": "https://other.invalid", "decks": []}
        doc = {"readme": ftd.README, "events": [other, event]}
        with open(self.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(ftd.dump(doc))
        return doc

    def run_main(self, recipe_text, extra=()):
        def fake_fetch(url, tries=3):
            if url == PAGE_URL:
                return page()
            text = recipe_text(int(url.rsplit("=", 1)[1]))
            if isinstance(text, Exception):
                raise text
            return text

        err = io.StringIO()
        with mock.patch.object(ftd, "fetch", fake_fetch), contextlib.redirect_stderr(err):
            code = ftd.main([PAGE_URL, "--out", self.out] + list(extra))
        return code, err.getvalue(), json.loads(Path(self.out).read_text(encoding="utf-8"))

    def save_held(self, date="2026-10-04", source="https://example.invalid/held"):
        """Save all three decks with a held date that differs from the published 2026-10-07."""
        doc = self.save([34, 35, 36])
        ev = doc["events"][1]
        ev.update({"date": date, "date_kind": "held", "date_source": source})
        with open(self.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(ftd.dump(doc))
        return doc

    def test_a_refresh_keeps_the_saved_held_date_and_its_source(self):
        self.save_held()
        code, _, after = self.run_main(lambda rid: json.dumps(recipe_for(rid)))
        self.assertEqual(code, 0)
        ev = after["events"][1]
        self.assertEqual(ev["date"], "2026-10-04")
        self.assertEqual(ev["date_kind"], "held")
        self.assertEqual(ev["date_source"], "https://example.invalid/held")
        self.assertEqual(ev["published"], "2026-10-07")

    def test_held_date_flags_replace_the_saved_ones(self):
        self.save_held()
        _, _, after = self.run_main(lambda rid: json.dumps(recipe_for(rid)),
                                    ["--held-date", "2026-10-03", "--held-date-source", "https://example.invalid/new"])
        ev = after["events"][1]
        self.assertEqual((ev["date"], ev["date_kind"], ev["date_source"]),
                         ("2026-10-03", "held", "https://example.invalid/new"))

    def test_a_new_source_alone_keeps_the_saved_held_date(self):
        self.save_held()
        _, _, after = self.run_main(lambda rid: json.dumps(recipe_for(rid)),
                                    ["--held-date-source", "https://example.invalid/better"])
        ev = after["events"][1]
        self.assertEqual((ev["date"], ev["date_kind"], ev["date_source"]),
                         ("2026-10-04", "held", "https://example.invalid/better"))

    def test_a_new_held_date_without_a_source_drops_the_old_source(self):
        # The saved source states the old day, so it cannot vouch for a different one.
        self.save_held()
        _, _, after = self.run_main(lambda rid: json.dumps(recipe_for(rid)), ["--held-date", "2026-10-02"])
        ev = after["events"][1]
        self.assertEqual((ev["date"], ev["date_kind"]), ("2026-10-02", "held"))
        self.assertNotIn("date_source", ev)

    def test_a_saved_published_date_still_follows_the_page(self):
        self.save([34, 35, 36])
        _, _, after = self.run_main(lambda rid: json.dumps(recipe_for(rid)))
        ev = after["events"][1]
        self.assertEqual((ev["date"], ev["date_kind"]), ("2026-10-07", "published"))
        self.assertNotIn("date_source", ev)

    def test_a_saved_deck_that_fails_is_kept_unchanged_with_a_warning(self):
        before = self.save([34, 35, 36])
        old_35 = before["events"][1]["decks"][1]
        failures = {
            "network": OSError("timed out"),
            "bad json": "<html>maintenance</html>",
            "no success": json.dumps({"success": False}),
            "no cards": json.dumps(dict(recipe_for(35), details=[])),
        }
        for label, failure in failures.items():
            with self.subTest(label):
                self.save([34, 35, 36])

                def recipe_text(rid):
                    if rid == 35:
                        return failure
                    fresh = recipe_for(rid)
                    fresh["deck"]["handlename"] = "New %d" % rid
                    return json.dumps(fresh)

                code, err, after = self.run_main(recipe_text)
                self.assertEqual(code, 0)
                decks = after["events"][1]["decks"]
                self.assertEqual([d["source_id"] for d in decks], [34, 35, 36])
                self.assertEqual(decks[1], old_35)
                self.assertEqual([decks[0]["player"], decks[2]["player"]], ["New 34", "New 36"])
                self.assertEqual(after["events"][0]["name"], "Other")
                self.assertIn("KEPT SAVED COPY", err)
                self.assertIn("id 35", err)
                self.assertIn("Place 35 | Player 35", err)
                self.assertIn("Grand Challengers Cup", err)
                self.assertNotIn("SKIPPED", err)

    def test_a_new_recipe_that_fails_is_reported_and_exits_non_zero(self):
        self.save([34, 36])

        def recipe_text(rid):
            return OSError("timed out") if rid == 35 else json.dumps(recipe_for(rid))

        code, err, after = self.run_main(recipe_text)
        self.assertEqual(code, 1)
        self.assertEqual([d["source_id"] for d in after["events"][1]["decks"]], [34, 36])
        self.assertIn("SKIPPED (type in by hand)", err)
        self.assertIn("id 35", err)
        self.assertNotIn("KEPT SAVED COPY", err)

    def test_a_full_rerun_replaces_every_deck_in_page_order(self):
        self.save([36, 34, 35])

        def recipe_text(rid):
            fresh = recipe_for(rid)
            fresh["deck"]["handlename"] = "New %d" % rid
            return json.dumps(fresh)

        code, err, after = self.run_main(recipe_text)
        self.assertEqual(code, 0)
        decks = after["events"][1]["decks"]
        self.assertEqual([d["source_id"] for d in decks], [34, 35, 36])
        self.assertEqual([d["player"] for d in decks], ["New 34", "New 35", "New 36"])
        self.assertNotIn("SKIPPED", err)
        self.assertNotIn("KEPT", err)


if __name__ == "__main__":
    unittest.main()
