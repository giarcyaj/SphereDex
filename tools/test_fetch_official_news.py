"""Tests for the official-site news fetcher (the Sieve news scrape replacement)."""
import json
import tempfile
import unittest
from pathlib import Path

import fetch_official_news as fon
import news_feed

SITE = "https://en.palworld-official-cardgame.com"
UPLOADS = f"{SITE}/wordpress/wp-content/uploads/2026/09"


def media(full="banner.png", sizes=("large", "medium_large", "medium")):
    return {"source_url": f"{UPLOADS}/{full}",
            "media_details": {"sizes": {name: {"source_url": f"{UPLOADS}/banner-{name}.png"} for name in sizes}}}


def wp_post(pid, title, date="2026-09-11T10:00:37", excerpt=None, content="<p>Body text.</p>", featured=None):
    post = {
        "id": pid,
        "date": date,
        "date_gmt": date,
        "link": f"{SITE}/news/post-{pid}",
        "title": {"rendered": title},
        "content": {"rendered": content},
        "excerpt": {"rendered": f"<p>{title} excerpt</p>" if excerpt is None else excerpt},
    }
    if featured is not None:
        post["_embedded"] = {"wp:featuredmedia": [featured]}
    return post


class PickRowTests(unittest.TestCase):
    def test_every_post_becomes_a_row_with_the_feed_shape(self):
        row = fon.pick_row(wp_post(10, "Booster Pack &#8220;Eternal Ascent&#8221; Preorders Now Available!",
                                   featured=media()))
        self.assertEqual(row, {
            "title": "Booster Pack \u201cEternal Ascent\u201d Preorders Now Available!",
            "date": "Sep 11, 2026",
            "summary": "Booster Pack \u201cEternal Ascent\u201d Preorders Now Available! excerpt",
            "link": f"{SITE}/news/post-10",
            "image": f"{UPLOADS}/banner-large.png",
        })

    def test_image_prefers_a_light_generated_size_then_the_original(self):
        self.assertEqual(fon.featured_image(wp_post(1, "a", featured=media(sizes=("medium_large", "medium")))),
                         f"{UPLOADS}/banner-medium_large.png")
        self.assertEqual(fon.featured_image(wp_post(1, "a", featured=media(sizes=("medium", "thumbnail")))),
                         f"{UPLOADS}/banner.png")

    def test_without_a_featured_image_the_first_official_body_image_is_used(self):
        body = f'<p>Reprint</p><img src="https://pbs.twimg.com/x.jpg"><img src="{UPLOADS}/reprint.png">'
        self.assertEqual(fon.pick_row(wp_post(2, "Reprint", content=body))["image"], f"{UPLOADS}/reprint.png")
        self.assertEqual(fon.pick_row(wp_post(3, "No art"))["image"], "")

    def test_summary_falls_back_to_the_body_and_is_capped(self):
        row = fon.pick_row(wp_post(4, "Long", excerpt="", content="<p>" + "word " * 200 + "</p>"))
        self.assertTrue(row["summary"].startswith("word word"))
        self.assertLessEqual(len(row["summary"]), 300)

    def test_posts_without_title_or_link_are_dropped(self):
        self.assertIsNone(fon.pick_row(wp_post(5, "")))
        post = wp_post(6, "No link")
        post["link"] = ""
        self.assertIsNone(fon.pick_row(post))


class RowsFromPostsTests(unittest.TestCase):
    def test_duplicates_and_junk_are_skipped(self):
        rows = fon.rows_from_posts([wp_post(1, "One"), "junk", wp_post(1, "One again"), wp_post(2, "Two")])
        self.assertEqual([r["title"] for r in rows], ["One", "Two"])

    def test_a_non_list_payload_is_an_error(self):
        with self.assertRaises(ValueError):
            fon.rows_from_posts({"code": "rest_no_route"})


class StageAndCliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "sieve"

    def test_staged_rows_consolidate_as_official_items(self):
        rows = fon.rows_from_posts([wp_post(1, "One", featured=media()), wp_post(2, "Two")])
        fon.stage_session(rows, self.root, stamp="20260927T000000Z")
        feed, counts = news_feed.build_news_feed(self.root)
        self.assertEqual(counts["official"], 2)
        self.assertEqual(counts["x"], 0)
        self.assertEqual({item["source"] for item in feed}, {"official"})
        self.assertEqual(feed[0]["image"], f"{UPLOADS}/banner-large.png")

    def test_offline_run_stages_and_reports_ok(self):
        payload = Path(self.tmp.name) / "posts.json"
        payload.write_text(json.dumps([wp_post(1, "One"), wp_post(2, "Two")]), encoding="utf-8")
        out = Path(self.tmp.name) / "gh.txt"
        self.assertEqual(fon.main(["--root", str(self.root), "--offline", str(payload), "--github-output", str(out)]), 0)
        self.assertEqual(out.read_text(encoding="utf-8"), "status=ok\nitems=2\n")
        self.assertEqual(len(list(self.root.glob("official-news-*/files/scrape_results.json"))), 1)

    def test_a_bad_payload_fails_and_reports_failed(self):
        payload = Path(self.tmp.name) / "posts.json"
        payload.write_text('{"code": "rest_no_route"}', encoding="utf-8")
        out = Path(self.tmp.name) / "gh.txt"
        self.assertEqual(fon.main(["--root", str(self.root), "--offline", str(payload), "--github-output", str(out)]), 1)
        self.assertEqual(out.read_text(encoding="utf-8"), "status=failed\nitems=0\n")


if __name__ == "__main__":
    unittest.main()
