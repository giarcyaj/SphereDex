"""Tests for the release sweep (official announcements -> app release data)."""
import datetime as dt
import importlib.util
import json
import unittest
from pathlib import Path

_dt = dt

import release_sweep as rs

HAVE_IMAGING = bool(importlib.util.find_spec("numpy") and importlib.util.find_spec("PIL"))
TODAY = dt.date(2026, 9, 27)


class ParseTests(unittest.TestCase):
    def test_title_gives_product_type_and_set(self):
        self.assertEqual(rs.parse_title('Booster Pack "Eternal Ascent" Preorders Now Available!'),
                         ("Booster Pack", "Eternal Ascent"))
        self.assertEqual(rs.parse_title("Trial Deck &#8220;Eternal Ascent Red·Green&#8221; revealed"),
                         ("Trial Deck", "Eternal Ascent Red·Green"))
        self.assertEqual(rs.parse_title("Sleeve & Card Set “Vol. 2” announced")[0], "Sleeve & Card Set")

    def test_non_product_titles_are_ignored(self):
        for title in ("Palworld OFFICIAL CARD GAME officially hits 4.4 million pack sales worldwide!",
                      "Reprint Announcement Updates!", "Shop tournament results"):
            self.assertIsNone(rs.parse_title(title), title)

    def test_code_from_banner_file_name_or_text(self):
        self.assertEqual(rs.find_code("BP03-ordersheet-banner-template.png"), "BP03")
        self.assertEqual(rs.find_code("", "Trial Deck ETD04 details"), "TD04")
        self.assertEqual(rs.find_code("1920x1080-1.png", "no code here"), "")

    def test_release_date_prefers_a_signalled_date(self):
        self.assertEqual(rs.parse_date("PALWORLD\nOFFICIAL CARD GAME\nOn sale January 29, 2027"), "Jan 29, 2027")
        text = "Preorders opened September 11, 2026. Release date: Dec 18, 2026."
        self.assertEqual(rs.parse_date(text), "Dec 18, 2026")
        self.assertEqual(rs.parse_date("Announced Sept 4, 2026"), "Sep 4, 2026")
        self.assertEqual(rs.parse_date("late October"), "")
        self.assertEqual(rs.parse_date("February 30, 2027"), "")

    def test_colours_split_off_the_set_name(self):
        self.assertEqual(rs.split_colours("Eternal Ascent Red·Green"), ("Eternal Ascent", ["Red", "Green"]))
        self.assertEqual(rs.split_colours("Legends Awaken"), ("Legends Awaken", []))


class ProductsTests(unittest.TestCase):
    def test_a_booster_becomes_box_and_pack_like_the_app(self):
        rows = rs.products_for("Booster Pack", "Eternal Ascent", "BP03", "Jan 29, 2027",
                               "https://x.test/post", "REL_BANNER_BP03", TODAY)
        self.assertEqual([r["id"] for r in rows], ["box-bp03", "pack-bp03"])
        self.assertEqual(rows[0]["code"], "BP03")
        self.assertEqual(rows[1]["code"], "", "only the box carries the code, as in the app")
        self.assertTrue(all(r["pre"] and r["set"] == "Eternal Ascent" and r["banner"] == "REL_BANNER_BP03" for r in rows))

    def test_a_trial_deck_keeps_its_colours(self):
        [row] = rs.products_for("Trial Deck", "Eternal Ascent Red·Green", "TD03", "Dec 18, 2026", "https://x.test/p", "", TODAY)
        self.assertEqual(row["id"], "td-td03")
        self.assertEqual(row["name"], "Trial Deck, Red · Green")
        self.assertEqual(row["set"], "Eternal Ascent")

    def test_released_products_are_not_preorders(self):
        [box, _] = rs.products_for("Booster Pack", "Dawn of Palpagos", "BP01", "Jul 30, 2026", "https://x.test/p", "", TODAY)
        self.assertFalse(box["pre"])

    def test_no_code_falls_back_to_a_slug(self):
        [row] = rs.products_for("Card Set", "Vol. 2", "", "", "https://x.test/p", "", TODAY)
        self.assertEqual(row["id"], "vol-2-card-set")


class FakeSieve:
    def __init__(self, date="", code=""):
        self.result, self.calls = (date, code), []

    def release(self, link, set_name):
        self.calls.append(link)
        return self.result


def post(title, link, image="", content="", modified_gmt="", date_gmt=""):
    row = {"title": {"rendered": title}, "link": link, "content": {"rendered": content},
           "_embedded": {"wp:featuredmedia": [{"source_url": image}]} if image else {}}
    # GMT fields as WordPress returns them: UTC with no suffix. Site-local modified/date are not set.
    if modified_gmt:
        row["modified_gmt"] = modified_gmt
    if date_gmt:
        row["date_gmt"] = date_gmt
    return row


class SweepTests(unittest.TestCase):
    def test_only_new_announcements_are_processed(self):
        posts = [
            post('Booster Pack "Eternal Ascent" Preorders Now Available!', "https://site.test/news/post-10",
                 content="<p>On sale January 29, 2027</p>"),
            post("Reprint Announcement Updates!", "https://site.test/news/post-9"),
            post('Booster Pack "Legends Awaken" Preorders', "https://site.test/news/post-8"),
        ]
        sieve = FakeSieve()
        payload, images = rs.sweep(posts, {"https://site.test/news/post-8": ""}, force=False, sieve=sieve,
                                   get=lambda *a, **k: b"", today=TODAY)
        self.assertEqual(sieve.calls, ["https://site.test/news/post-10"], "seen posts cost no Sieve run")
        self.assertEqual([p["id"] for p in payload["products"]], ["box-eternal-ascent", "pack-eternal-ascent"])
        self.assertEqual(payload["products"][0]["date"], "Jan 29, 2027", "post text is the last fallback")
        self.assertEqual(payload["sets"], {"Eternal Ascent": {"logo": "", "release": "Jan 29, 2027"}})
        self.assertIn("https://site.test/news/post-10", payload["posts"])
        self.assertEqual(images, {})

    def test_sieve_date_and_code_win(self):
        posts = [post('Booster Pack "Eternal Ascent" Preorders', "https://site.test/news/p", content="Coming soon")]
        payload, _ = rs.sweep(posts, {}, force=False, sieve=FakeSieve("Jan 29, 2027", "BP03"),
                              get=lambda *a, **k: b"", today=TODAY)
        self.assertEqual(payload["products"][0]["id"], "box-bp03")
        self.assertEqual(payload["products"][0]["date"], "Jan 29, 2027")

    def test_force_reprocesses_seen_posts(self):
        posts = [post('Booster Pack "Eternal Ascent" Preorders', "https://site.test/news/p")]
        payload, _ = rs.sweep(posts, {"https://site.test/news/p": ""}, force=True, sieve=FakeSieve(),
                              get=lambda *a, **k: b"", today=TODAY)
        self.assertEqual(len(payload["products"]), 2)


DELAY = (
    'The Palworld Official Card Game Booster Pack "Eternal Ascent", originally scheduled for release '
    "on Friday, January 29, 2027, will be slightly delayed. "
    "(Before) Scheduled for release on Friday, January 29, 2027 "
    "(After) Scheduled for release on Saturday, January 30, 2027"
)
# Verified WordPress GMT fields, not site-local date/modified. post-10's modified_gmt is later
# than post-15, and its current text asserts no street day.
POST10_DATE_GMT = "2026-09-11T10:00:37"
POST10_MODIFIED_GMT = "2026-11-06T06:46:13"
DELAY_GMT = "2026-11-06T03:13:14"
DELAY_ASOF = "2026-11-06T03:13:14Z"
LIVE = {
    "products": [
        {"id": "box-bp03", "set": "Eternal Ascent", "name": "Booster Box", "code": "BP03",
         "date": "Jan 29, 2027", "link": "https://en.palworld-official-cardgame.com/news/post-10"},
        {"id": "pack-bp03", "set": "Eternal Ascent", "name": "Booster Pack", "code": "",
         "date": "Jan 29, 2027", "link": "https://en.palworld-official-cardgame.com/news/post-10"},
        {"id": "box-eternal-ascent", "set": "Eternal Ascent", "name": "Booster Box", "code": "",
         "date": "Jan 29, 2027", "link": "https://en.palworld-official-cardgame.com/news/post-10"},
        {"id": "pack-eternal-ascent", "set": "Eternal Ascent", "name": "Booster Pack", "code": "",
         "date": "Jan 29, 2027", "link": "https://en.palworld-official-cardgame.com/news/post-10"},
        {"id": "box-bp02", "set": "Legends Awaken", "name": "Booster Box", "code": "BP02",
         "date": "Oct 30, 2026", "link": "https://en.palworld-official-cardgame.com/news/post-7"},
        {"id": "box-tba", "set": "Future Set", "name": "Booster Box", "code": "BP99", "date": ""},
    ],
    "sets": {"Eternal Ascent": {"logo": "REL_LOGO_BP03", "release": "Jan 29, 2027"}},
}


class PostponeTests(unittest.TestCase):
    def test_a_delay_notice_uses_the_later_day(self):
        self.assertEqual(rs.best_date(DELAY, "Booster Pack"), "Jan 30, 2027")
        self.assertEqual(rs.parse_date("On sale January 29, 2027"), "Jan 29, 2027")

    def test_mixed_dates_stay_on_their_own_products(self):
        text = (
            'Trial Deck "Eternal Ascent Red·Green" (TD03) goes on sale December 18, 2026. '
            'Booster Pack "Eternal Ascent" (BP03) releases on January 30, 2027.'
        )
        posts = [post('Booster Pack "Eternal Ascent" details', "https://en.example/mixed", content=text)]
        payload, _ = rs.sweep(posts, {}, force=False, sieve=FakeSieve(), get=lambda *a, **k: b"", today=TODAY)
        by_id = {p["id"]: p for p in payload["products"]}
        self.assertEqual(by_id["box-bp03"]["date"], "Jan 30, 2027")
        self.assertEqual(by_id["pack-bp03"]["date"], "Jan 30, 2027")
        self.assertEqual(by_id["td-ea-rg"]["date"], "Dec 18, 2026")
        self.assertNotIn("td-td03", by_id)
        self.assertNotEqual(by_id["box-bp03"]["date"], by_id["td-ea-rg"]["date"])
        self.assertEqual(payload["sets"]["Eternal Ascent"]["release"], "Dec 18, 2026",
                         "the set date is the first product, and it is not copied onto the booster")

    def test_seen_delay_corrects_the_canonical_ids_and_a_rerun_is_empty(self):
        delay = post('Notice of Release Date Delay for Booster Pack "Eternal Ascent"',
                     "https://en.palworld-official-cardgame.com/news/post-15", content=DELAY, modified_gmt=DELAY_GMT)
        preorder = post('Booster Pack "Eternal Ascent" Preorders Now Available!',
                        "https://en.palworld-official-cardgame.com/news/post-10",
                        content="More details will be announced soon.", modified_gmt=POST10_MODIFIED_GMT)
        seen = {
            "https://en.palworld-official-cardgame.com/news/post-15": "",
            "https://en.palworld-official-cardgame.com/news/post-10": "https://cdn.example/old-banner.png",
        }
        payload, _ = rs.sweep([delay, preorder], seen, force=False, sieve=FakeSieve(),
                              get=lambda *a, **k: b"", today=dt.date(2026, 11, 6), catalog=LIVE)
        ids = [p["id"] for p in payload["products"]]
        self.assertEqual(ids, ["box-bp03", "pack-bp03"])
        self.assertTrue(all(p["date"] == "Jan 30, 2027" and p["pre"] for p in payload["products"]))
        self.assertTrue(all(p["link"].endswith("/news/post-15") for p in payload["products"]))
        self.assertTrue(all(p.get("asOf") == DELAY_ASOF for p in payload["products"]),
                        "post-10's later modified_gmt is not the stamp, because that text asserts no day")
        self.assertEqual(payload["sets"]["Eternal Ascent"]["release"], "Jan 30, 2027")
        self.assertEqual(payload["sets"]["Eternal Ascent"]["logo"], "REL_LOGO_BP03")
        self.assertEqual(payload["retire"], ["box-eternal-ascent", "pack-eternal-ascent"])
        self.assertNotIn("box-bp02", ids)
        self.assertNotIn("box-tba", ids)
        self.assertNotIn("box-eternal-ascent", ids)

        again, _ = rs.sweep([delay, preorder], {**seen, **payload["posts"]}, force=False, sieve=FakeSieve(),
                            get=lambda *a, **k: b"", today=dt.date(2026, 11, 6), catalog=LIVE)
        self.assertEqual(again["products"], [])

        forced, _ = rs.sweep([delay, preorder], {**seen, **payload["posts"]}, force=True, sieve=FakeSieve(),
                             get=lambda *a, **k: b"", today=dt.date(2026, 11, 6), catalog=LIVE)
        self.assertEqual([p["id"] for p in forced["products"]], ["box-bp03", "pack-bp03"])
        self.assertTrue(all(p["date"] == "Jan 30, 2027" for p in forced["products"]))

    def test_an_older_post_does_not_replace_a_newer_correction(self):
        # The street day on the old post is earlier. That is not why it loses: its revision is older.
        catalog = {"products": [
            {"id": "box-bp03", "set": "Eternal Ascent", "name": "Booster Box", "code": "BP03",
             "date": "Jan 30, 2027", "link": "https://en.example/correction", "asOf": DELAY_ASOF},
            {"id": "pack-bp03", "set": "Eternal Ascent", "name": "Booster Pack", "code": "",
             "date": "Jan 30, 2027", "link": "https://en.example/correction", "asOf": DELAY_ASOF},
        ], "sets": {}}
        posts = [post('Booster Pack "Eternal Ascent" Preorders Now Available!', "https://site.test/old",
                      content="On sale January 29, 2027", modified_gmt=POST10_DATE_GMT)]
        payload, _ = rs.sweep(posts, {}, force=False, sieve=FakeSieve(), get=lambda *a, **k: b"",
                              today=TODAY, catalog=catalog)
        self.assertEqual(payload["products"], [])

    def test_a_missing_banner_does_not_reopen_a_seen_post_as_a_new_id(self):
        posts = [post('Booster Pack "Eternal Ascent" Preorders Now Available!',
                      "https://en.palworld-official-cardgame.com/news/post-10")]
        seen = {"https://en.palworld-official-cardgame.com/news/post-10": "https://cdn.example/banner.png"}
        payload, _ = rs.sweep(posts, seen, force=False, sieve=FakeSieve(), get=lambda *a, **k: b"",
                              today=TODAY, catalog=LIVE)
        self.assertEqual(payload["products"], [])

    def test_trial_decks_keep_the_set_date_when_the_booster_moves(self):
        catalog = {"products": LIVE["products"] + [
            {"id": "td-ea-rg", "set": "Eternal Ascent", "name": "Trial Deck, Red · Green", "code": "TD03",
             "date": "Dec 18, 2026"},
            {"id": "td-ea-bp", "set": "Eternal Ascent", "name": "Trial Deck, Blue · Purple", "code": "TD04",
             "date": "Dec 18, 2026"},
        ], "sets": {"Eternal Ascent": {"logo": "REL_LOGO_BP03", "release": "Dec 18, 2026"}}}
        delay = post('Notice of Release Date Delay for Booster Pack "Eternal Ascent"',
                     "https://en.palworld-official-cardgame.com/news/post-15", content=DELAY, modified_gmt=DELAY_GMT)
        payload, _ = rs.sweep([delay], {delay["link"]: ""}, force=False, sieve=FakeSieve(),
                              get=lambda *a, **k: b"", today=dt.date(2026, 11, 6), catalog=catalog)
        self.assertEqual({p["id"]: p["date"] for p in payload["products"]},
                         {"box-bp03": "Jan 30, 2027", "pack-bp03": "Jan 30, 2027"})
        self.assertEqual(payload["sets"]["Eternal Ascent"]["release"], "Dec 18, 2026")

    def test_review_fixture_matches_the_correction_sweep(self):
        import json
        from pathlib import Path
        delay = post('Notice of Release Date Delay for Booster Pack "Eternal Ascent"',
                     "https://en.palworld-official-cardgame.com/news/post-15", content=DELAY, modified_gmt=DELAY_GMT)
        payload, _ = rs.sweep([delay], {delay["link"]: ""}, force=False, sieve=FakeSieve(),
                              get=lambda *a, **k: b"", today=dt.date(2026, 11, 6), catalog=LIVE)
        fixture = json.loads((Path(__file__).parent / "fixtures" / "releases" / "en-eternal-ascent-2026-11-06.json").read_text(encoding="utf-8"))
        self.assertEqual(payload["products"], fixture["post_body"]["products"])
        self.assertTrue(all(row.get("asOf") == DELAY_ASOF for row in payload["products"]))
        self.assertEqual(payload["sets"], fixture["post_body"]["sets"])
        self.assertEqual(payload["retire"], fixture["review_retire"])
        self.assertNotIn("box-bp02", [p["id"] for p in payload["products"]])
        self.assertNotIn("box-tba", [p["id"] for p in payload["products"]])


class ProvenanceTests(unittest.TestCase):
    """Synthetic clocks and street days. None of these dates are an official product date."""

    def catalog(self, day, asof, link="https://example.test/old"):
        stamp = asof if str(asof).endswith("Z") else str(asof) + "Z"
        return {"products": [
            {"id": "box-bp99", "set": "Sample Set", "name": "Booster Box", "code": "BP99",
             "date": day, "link": link, "asOf": stamp},
            {"id": "pack-bp99", "set": "Sample Set", "name": "Booster Pack", "code": "",
             "date": day, "link": link, "asOf": stamp},
            {"id": "td-td99", "set": "Sample Set", "name": "Trial Deck, Red · Green", "code": "TD99",
             "date": "Apr 4, 2027", "link": "https://example.test/deck", "asOf": "2026-01-01T00:00:00Z"},
        ], "sets": {"Sample Set": {"logo": "", "release": "Apr 4, 2027"}}}

    def test_gmt_clock_is_utc_and_site_local_time_is_not_a_stamp(self):
        # Real post-15 shape: modified_gmt has no suffix. The asOf we send appends Z and does not
        # invent milliseconds. The backend may store .000Z; that is the same instant.
        self.assertEqual(rs.serialize_wp_gmt(DELAY_GMT), DELAY_ASOF)
        self.assertEqual(rs.asof_utc(DELAY_ASOF), rs.asof_utc("2026-11-06T03:13:14.000Z"))
        self.assertEqual(rs.asof_utc(DELAY_ASOF), rs.asof_utc("2026-11-06T12:13:14+09:00"))
        self.assertIsNone(rs.asof_utc(DELAY_GMT), "a naive _gmt value is not itself an asOf")
        self.assertEqual(rs.stored_asof({"asOf": DELAY_GMT}), "")
        now = _dt.datetime(2026, 11, 6, 12, 0, tzinfo=_dt.timezone.utc)
        within = post("Booster Pack \"Sample Set\" note", "https://example.test/soon",
                      modified_gmt="2026-11-07T11:00:00")
        self.assertEqual(rs.post_asof(within, now), "2026-11-07T11:00:00Z")
        too_far = post("Booster Pack \"Sample Set\" note", "https://example.test/far",
                       modified_gmt="2026-11-07T12:00:01")
        self.assertEqual(rs.post_asof(too_far, now), "")
        both = post("Booster Pack \"Sample Set\" note", "https://example.test/both",
                    modified_gmt=DELAY_GMT, date_gmt="2026-11-06T02:50:21")
        both["modified"] = "2026-11-06T12:13:14"
        self.assertEqual(rs.post_asof(both), DELAY_ASOF)
        broken = post("Booster Pack \"Sample Set\" note", "https://example.test/broken",
                      modified_gmt="not-a-time", date_gmt=DELAY_GMT)
        self.assertEqual(rs.post_asof(broken), "", "a present modified_gmt does not fall through")
        only_published = post("Booster Pack \"Sample Set\" note", "https://example.test/published",
                              date_gmt=DELAY_GMT)
        only_published["date"] = "2026-11-06T11:50:21"
        self.assertEqual(rs.post_asof(only_published), DELAY_ASOF)

    def test_a_later_edit_with_no_street_day_does_not_restamp_a_cached_day(self):
        # Verified clocks: post-10 modified_gmt is later than post-15, and the current text
        # asserts no day. That clock must not be attached to the cached Jan 29.
        quiet = post('Booster Pack "Eternal Ascent" Preorders Now Available!',
                     "https://en.palworld-official-cardgame.com/news/post-10",
                     content="More details will be announced soon.",
                     modified_gmt=POST10_MODIFIED_GMT)
        catalog = {"products": [
            {"id": "box-bp03", "set": "Eternal Ascent", "name": "Booster Box", "code": "BP03",
             "date": "Jan 29, 2027", "link": quiet["link"]},
            {"id": "pack-bp03", "set": "Eternal Ascent", "name": "Booster Pack",
             "date": "Jan 29, 2027", "link": quiet["link"]},
        ], "sets": {}}
        payload, _ = rs.sweep([quiet], {}, force=False, sieve=FakeSieve(), get=lambda *a, **k: b"",
                              today=dt.date(2026, 11, 6), catalog=catalog)
        self.assertEqual(payload["products"], [])

    def test_a_later_delay_from_a_newer_post_moves_the_day_forward(self):
        text = ("Booster Pack \"Sample Set\" was scheduled for June 1, 2027. "
                "(After) Scheduled for release on August 8, 2027.")
        notice = post('Notice of Release Date Delay for Booster Pack "Sample Set"',
                      "https://example.test/delay", content=text, modified_gmt="2026-07-01T00:00:00")
        payload, _ = rs.sweep([notice], {}, force=False, sieve=FakeSieve(), get=lambda *a, **k: b"",
                              today=TODAY, catalog=self.catalog("Jun 1, 2027", "2026-05-01T00:00:00"))
        dates = {p["id"]: p["date"] for p in payload["products"]}
        self.assertEqual(dates["box-bp99"], "Aug 8, 2027")
        self.assertEqual(dates["pack-bp99"], "Aug 8, 2027")
        self.assertNotIn("td-td99", dates)

    def test_a_newer_correction_to_an_earlier_day_replaces_the_stale_day(self):
        text = ("Booster Pack \"Sample Set\" release date corrected to March 2, 2027, "
                "instead of the original date of June 20, 2027.")
        self.assertEqual(rs.best_date(text, "Booster Pack"), "Mar 2, 2027")
        notice = post('Booster Pack "Sample Set" date correction',
                      "https://example.test/correction", content=text, modified_gmt="2026-10-01T00:00:00")
        payload, _ = rs.sweep([notice], {}, force=False, sieve=FakeSieve(), get=lambda *a, **k: b"",
                              today=TODAY, catalog=self.catalog("Jun 20, 2027", "2026-08-01T00:00:00"))
        self.assertEqual({p["id"]: p["date"] for p in payload["products"]},
                         {"box-bp99": "Mar 2, 2027", "pack-bp99": "Mar 2, 2027"})

    def test_replaying_the_unchanged_original_does_not_undo_the_correction(self):
        original = post('Booster Pack "Sample Set" Preorders Now Available!',
                        "https://example.test/old", content="On sale June 20, 2027",
                        modified_gmt="2026-08-01T00:00:00")
        catalog = self.catalog("Mar 2, 2027", "2026-10-01T00:00:00", "https://example.test/correction")
        seen = {original["link"]: rs.announcement_stamp("", original["title"]["rendered"],
                                                        "On sale June 20, 2027")}
        payload, _ = rs.sweep([original], seen, force=False, sieve=FakeSieve(), get=lambda *a, **k: b"",
                              today=TODAY, catalog=catalog)
        self.assertEqual(payload["products"], [])
        # A seen value from before stamps existed still must not replay over the newer correction.
        payload, _ = rs.sweep([original], {original["link"]: "legacy"}, force=False, sieve=FakeSieve(),
                              get=lambda *a, **k: b"", today=TODAY, catalog=catalog)
        self.assertEqual(payload["products"], [])

    def test_an_edited_old_post_is_a_new_revision_and_can_move_the_day_earlier(self):
        edited = post('Booster Pack "Sample Set" Preorders Now Available!',
                      "https://example.test/old",
                      content="Release date corrected to February 2, 2027, instead of the original date of June 20, 2027.",
                      modified_gmt="2026-11-01T00:00:00")
        catalog = self.catalog("Jun 20, 2027", "2026-08-01T00:00:00", "https://example.test/old")
        old_stamp = rs.announcement_stamp("", edited["title"]["rendered"], "On sale June 20, 2027")
        payload, _ = rs.sweep([edited], {edited["link"]: old_stamp}, force=False, sieve=FakeSieve(),
                              get=lambda *a, **k: b"", today=TODAY, catalog=catalog)
        self.assertEqual({p["id"]: p["date"] for p in payload["products"]},
                         {"box-bp99": "Feb 2, 2027", "pack-bp99": "Feb 2, 2027"})

    def test_mixed_products_and_regions_keep_each_date_on_its_own_row(self):
        # March 1 is a synthetic Japanese stand-in, not an official date.
        text = (
            'Trial Deck "Sample Set Red·Green" (TD99) goes on sale April 4, 2027. '
            'Booster Pack "Sample Set" (BP99) English release January 30, 2027. '
            'Japanese release March 1, 2027.'
        )
        self.assertEqual(rs.best_date(
            'Japanese release date: March 1, 2027.', "Booster Pack"), "")
        notice = post('Booster Pack "Sample Set" details', "https://en.example/mixed", content=text,
                      modified_gmt="2026-09-01T00:00:00")
        catalog = self.catalog("Jun 1, 2027", "2026-05-01T00:00:00")
        catalog["products"][2]["date"] = "Jan 1, 2027"
        payload, _ = rs.sweep([notice], {}, force=False, sieve=FakeSieve(), get=lambda *a, **k: b"",
                              today=TODAY, catalog=catalog)
        by_id = {p["id"]: p["date"] for p in payload["products"]}
        self.assertEqual(by_id["box-bp99"], "Jan 30, 2027")
        self.assertEqual(by_id["pack-bp99"], "Jan 30, 2027")
        self.assertEqual(by_id.get("td-td99"), "Apr 4, 2027")
        self.assertNotIn("Mar 1, 2027", by_id.values())


class PublishTests(unittest.TestCase):
    def test_images_upload_first_and_their_paths_go_in_the_payload(self):
        calls = []

        def call(method, path, key, body, base):
            calls.append((method, path))
            if method == "PUT":
                return {"path": path.replace("/admin/", "/") + "?v=abc123"}
            self.assertEqual(body["img"], {"REL_LOGO_BP03": "/api/release-img/REL_LOGO_BP03?v=abc123"})
            self.assertEqual(body["products"][0]["asOf"], "2026-11-06T03:13:14Z")
            self.assertNotIn("asOf", body["products"][1])
            self.assertNotIn("retire", body)
            self.assertEqual(body["products"][0]["date"], "Jan 30, 2027")
            return {"products": 2, "sets": 1}

        res = rs.publish({"products": [
            {"id": "box-bp03", "set": "Eternal Ascent", "date": "Jan 30, 2027",
             "asOf": "2026-11-06T03:13:14Z", "link": "https://example.test/p"},
            {"id": "pack-bp03", "set": "Eternal Ascent", "date": "Jan 30, 2027",
             "asOf": "2026-11-06T11:50:21", "link": "https://example.test/p"}],
                          "sets": {}, "posts": {}, "retire": ["box-eternal-ascent"]},
                         {"REL_LOGO_BP03": b"webp"}, "k", "https://b.test", call)
        self.assertEqual(calls, [("PUT", "/api/admin/release-img/REL_LOGO_BP03"), ("POST", "/api/admin/releases")])
        self.assertEqual(res["sets"], 1)


class MainTests(unittest.TestCase):
    def test_missing_admin_key_skips_cleanly(self):
        import os
        import tempfile
        from pathlib import Path
        from unittest import mock
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("BACKEND_ADMIN_KEY", None)
            gh = Path(tmp) / "gh.txt"
            self.assertEqual(rs.main(["--github-output", str(gh)]), 0)
            self.assertIn("status=skipped", gh.read_text(encoding="utf-8"))


@unittest.skipUnless(HAVE_IMAGING, "numpy and Pillow are needed for the logo cut-out")
class BannerLogoTests(unittest.TestCase):
    def banner(self, key_visual=False):
        from PIL import Image, ImageDraw
        im = Image.new("RGB", (1600, 900), (232, 223, 206))
        d = ImageDraw.Draw(im)
        if key_visual:
            for x in range(0, 1600, 40):
                d.rectangle([x, 0, x + 20, 900], fill=(30 + x % 200, 80, 160))
            return im
        d.rectangle([600, 60, 1000, 140], fill=(40, 30, 20))          # header
        d.line([200, 300, 1400, 300], fill=(60, 50, 40), width=3)     # divider
        d.ellipse([450, 380, 1150, 700], fill=(20, 40, 110), outline=(200, 150, 60), width=14)   # logo
        d.rectangle([520, 760, 1080, 800], fill=(30, 30, 30))         # date line
        return im

    def test_template_banner_yields_a_transparent_logo(self):
        import banner_logo
        logo = banner_logo.cut_logo(self.banner())
        self.assertIsNotNone(logo)
        self.assertEqual(logo.mode, "RGBA")
        self.assertEqual(logo.width, banner_logo.LOGO_WIDTH)
        ratio = logo.width / logo.height
        self.assertAlmostEqual(ratio, 700 / 320, delta=0.35, msg="the logo block, not the header or date line")
        self.assertEqual(logo.getpixel((2, 2))[3], 0, "corners are transparent")

    def test_key_visual_banner_yields_no_logo(self):
        import banner_logo
        self.assertIsNone(banner_logo.cut_logo(self.banner(key_visual=True)))


FIXTURES = Path(__file__).parent / "fixtures" / "releases"
TODAY_LIVE = dt.date(2026, 11, 12)


def load_json(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def load_html(name):
    return (FIXTURES / name).read_text(encoding="utf-8")


def page_getter(pages):
    """pages: slug -> html. Image URLs and anything else return empty bytes."""
    def get(url, *args, **kwargs):
        slug = url.rstrip("/").rsplit("/", 1)[-1].lower()
        html = pages.get(slug)
        if html is None:
            return b""
        return html.encode("utf-8")
    return get


# The public /api/releases catalogue after backend PR 37 (12 Nov 2026).
LIVE_NOW = {
    "products": [
        {"id": "box-bp03", "set": "Eternal Ascent", "name": "Booster Box", "sub": "", "code": "BP03",
         "date": "Jan 30, 2027", "pre": True, "banner": "REL_BANNER_BP03", "box": "",
         "q": "Palworld Eternal Ascent Booster Box",
         "link": "https://en.palworld-official-cardgame.com/news/post-15",
         "asOf": "2026-11-06T03:13:14.000Z"},
        {"id": "pack-bp03", "set": "Eternal Ascent", "name": "Booster Pack", "sub": "", "code": "",
         "date": "Jan 30, 2027", "pre": True, "banner": "REL_BANNER_BP03", "box": "",
         "q": "Palworld Eternal Ascent Booster Pack",
         "link": "https://en.palworld-official-cardgame.com/news/post-15",
         "asOf": "2026-11-06T03:13:14.000Z"},
        {"id": "box-eternal-ascent", "set": "Eternal Ascent", "name": "Booster Box", "sub": "", "code": "",
         "date": "Jan 29, 2027", "pre": True, "banner": "REL_BANNER_ETERNAL_ASCENT", "box": "",
         "q": "Palworld Eternal Ascent Booster Box",
         "link": "https://en.palworld-official-cardgame.com/news/post-10"},
        {"id": "pack-eternal-ascent", "set": "Eternal Ascent", "name": "Booster Pack", "sub": "", "code": "",
         "date": "Jan 29, 2027", "pre": True, "banner": "REL_BANNER_ETERNAL_ASCENT", "box": "",
         "q": "Palworld Eternal Ascent Booster Pack",
         "link": "https://en.palworld-official-cardgame.com/news/post-10"},
        {"id": "td-ea-rg", "set": "Eternal Ascent", "name": "Trial Deck, Red \u00b7 Green", "sub": "Starter deck",
         "code": "TD03", "date": "Dec 18, 2026", "pre": True, "banner": "", "box": "",
         "q": "Palworld Eternal Ascent Trial Deck Red Green",
         "link": "https://en.palworld-official-cardgame.com/news/post-7",
         "asOf": "2026-09-24T10:50:36.000Z"},
        {"id": "td-ea-bp", "set": "Eternal Ascent", "name": "Trial Deck, Blue \u00b7 Purple", "sub": "Starter deck",
         "code": "TD04", "date": "Dec 18, 2026", "pre": True, "banner": "", "box": "",
         "q": "Palworld Eternal Ascent Trial Deck Blue Purple",
         "link": "https://en.palworld-official-cardgame.com/news/post-7",
         "asOf": "2026-09-24T10:50:36.000Z"},
    ],
    "sets": {"Eternal Ascent": {"logo": "REL_LOGO_BP03", "release": "Jan 30, 2027"}},
}


class ProductPageTests(unittest.TestCase):
    """Saved copies of the real TD03/TD04 posts and product pages (fetched 2026-11-12)."""

    def setUp(self):
        self.post7 = load_json("en-post-7.json")
        self.post14 = load_json("en-post-14.json")
        self.pages = {
            "td03": load_html("en-product-td03.html"),
            "td04": load_html("en-product-td04.html"),
            "bp03": load_html("en-product-bp03.html"),
            "bp01": load_html("en-product-bp01.html"),
            "bp02": load_html("en-product-bp02.html"),
            "ss01": load_html("en-product-ss01.html"),
            "special-set-zoes-strategy": load_html("en-product-zoe.html"),
        }

    def test_the_english_headlines_are_not_quoted_product_titles(self):
        # This is why the old gate never opened the posts.
        self.assertIsNone(rs.parse_title(rs.strip_html(self.post7["title"]["rendered"])))
        self.assertIsNone(rs.parse_title(rs.strip_html(self.post14["title"]["rendered"])))
        self.assertEqual(
            rs.product_page_urls(self.post7["content"]["rendered"], self.post7["link"]),
            ["https://en.palworld-official-cardgame.com/products/TD03",
             "https://en.palworld-official-cardgame.com/products/TD04"])
        linked = rs.product_page_urls(self.post14["content"]["rendered"], self.post14["link"])
        self.assertIn("https://en.palworld-official-cardgame.com/products/td03", linked)
        self.assertIn("https://en.palworld-official-cardgame.com/products/td04", linked)
        self.assertTrue(all("/events/" not in url for url in linked))

    def test_product_pages_name_the_decks_and_ignore_the_page_date(self):
        td03 = rs.parse_product_page(self.pages["td03"], "https://en.palworld-official-cardgame.com/products/td03")
        td04 = rs.parse_product_page(self.pages["td04"], "https://en.palworld-official-cardgame.com/products/td04")
        self.assertEqual(td03["date"], "Dec 18, 2026", "Aug 19 is when the page was posted, not the street day")
        self.assertEqual((td03["ptype"], td03["code"]), ("Trial Deck", "TD03"))
        self.assertEqual((td04["ptype"], td04["code"]), ("Trial Deck", "TD04"))
        self.assertIn("Red", td03["set_name"])
        self.assertIn("Blue", td04["set_name"])
        ja = rs.parse_product_page(
            load_html("ja-product-td03.html"),
            "https://palworld-official-cardgame.com/products/td03")
        self.assertEqual(ja["ptype"], "Trial Deck")
        self.assertEqual(ja["code"], "TD03")
        self.assertEqual(ja["date"], "Dec 18, 2026")
        self.assertEqual(rs.split_colours(ja["set_name"]), ("Eternal Ascent", ["Red", "Green"]))
        self.assertEqual(
            rs.parse_title('ブースターパック第3弾「果てなき飛翔」'),
            ("Booster Pack", "Eternal Ascent"))

    def test_unquoted_posts_map_to_the_published_deck_ids(self):
        catalog = {"products": [p for p in LIVE_NOW["products"] if not str(p["id"]).startswith("td-")],
                   "sets": LIVE_NOW["sets"]}
        sieve = FakeSieve()
        payload, _ = rs.sweep([self.post7], {}, force=False, sieve=sieve, get=page_getter(self.pages),
                              today=TODAY_LIVE, catalog=catalog)
        self.assertEqual(sieve.calls, [], "a product page already states the day")
        by_id = {p["id"]: p for p in payload["products"]}
        self.assertEqual(list(by_id), ["td-ea-rg", "td-ea-bp"])
        rg, bp = by_id["td-ea-rg"], by_id["td-ea-bp"]
        self.assertEqual(rg["name"], "Trial Deck, Red \u00b7 Green")
        self.assertEqual(bp["name"], "Trial Deck, Blue \u00b7 Purple")
        self.assertEqual(rg["set"], "Eternal Ascent")
        self.assertEqual(bp["set"], "Eternal Ascent")
        self.assertEqual(rg["sub"], "Starter deck")
        self.assertEqual(bp["sub"], "Starter deck")
        self.assertEqual(rg["code"], "TD03")
        self.assertEqual(bp["code"], "TD04")
        self.assertEqual(rg["date"], "Dec 18, 2026")
        self.assertEqual(bp["date"], "Dec 18, 2026")
        self.assertTrue(rg["pre"] and bp["pre"])
        self.assertEqual(rg["q"], "Palworld Eternal Ascent Trial Deck Red Green")
        self.assertEqual(bp["q"], "Palworld Eternal Ascent Trial Deck Blue Purple")
        self.assertEqual(rg["link"], self.post7["link"])
        self.assertEqual(bp["link"], self.post7["link"])
        self.assertEqual(rg["asOf"], "2026-09-24T10:50:36Z")
        self.assertEqual(rg["banner"], "")
        self.assertEqual(rg["box"], "")
        self.assertNotIn("td-td03", by_id)
        self.assertNotIn("td-td04", by_id)
        self.assertNotIn("box-bp03", by_id)
        self.assertNotIn("box-eternal-ascent", by_id)
        self.assertNotIn("pack-eternal-ascent", by_id)
        self.assertEqual(payload["retire"], [])
        # The conference recap links the same pages and maps to the same ids.
        again, _ = rs.sweep([self.post14], {}, force=False, sieve=FakeSieve(), get=page_getter(self.pages),
                            today=TODAY_LIVE, catalog=catalog)
        self.assertEqual([p["id"] for p in again["products"]], ["td-ea-rg", "td-ea-bp"])
        self.assertTrue(all(p["date"] == "Dec 18, 2026" for p in again["products"]))
        self.assertNotIn("box-bp03", [p["id"] for p in again["products"]])

    def test_rows_already_on_file_are_not_duplicated_or_overwritten(self):
        posts = [self.post14, self.post7, load_json("en-post-13.json")]
        before = json.dumps(LIVE_NOW)
        payload, _ = rs.sweep(posts, {}, force=False, sieve=FakeSieve(), get=page_getter(self.pages),
                              today=TODAY_LIVE, catalog=LIVE_NOW)
        self.assertEqual(payload["products"], [])
        self.assertEqual(payload["retire"], [])
        self.assertEqual(json.dumps(LIVE_NOW), before)
        again, _ = rs.sweep(posts, payload["posts"], force=False, sieve=FakeSieve(),
                            get=page_getter(self.pages), today=TODAY_LIVE, catalog=LIVE_NOW)
        self.assertEqual(again["products"], [])

    def test_event_posts_and_the_zoe_page_are_ignored(self):
        zoe_url = "https://en.palworld-official-cardgame.com/products/special-set-zoes-strategy"
        self.assertIsNone(rs.parse_product_page(self.pages["special-set-zoes-strategy"], zoe_url))
        self.assertIsNone(rs.parse_product_page(
            '<title>Special Set "Zoe\'s Strategy" | PRODUCTS</title><p>Release Date: December 1, 2026</p>',
            zoe_url))
        event = post(
            "Masters League 26/27 kicks off",
            "https://en.palworld-official-cardgame.com/news/post-masters",
            content='<a href="/events/masters-league">Masters League 26/27</a>'
                    f'<a href="{zoe_url}">Special Set</a>',
            modified_gmt="2026-11-10T01:33:24")
        payload, _ = rs.sweep(
            [load_json("ja-post-masters.json"), event],
            {}, force=False, sieve=FakeSieve(), get=page_getter(self.pages),
            today=TODAY_LIVE, catalog=LIVE_NOW)
        self.assertEqual(payload["products"], [])

    def test_a_sales_post_does_not_readd_the_back_catalogue(self):
        payload, _ = rs.sweep([load_json("en-post-13.json")], {}, force=False, sieve=FakeSieve(),
                              get=page_getter(self.pages), today=TODAY_LIVE, catalog={"products": [], "sets": {}})
        self.assertEqual(payload["products"], [])


if __name__ == "__main__":
    unittest.main()
