"""Tests for the official-site card-reveal fetcher (option A)."""
import json
import tempfile
import unittest
from pathlib import Path

import fetch_card_reveals
import news_feed


def wp_post(pid, title, date, link, content, excerpt=""):
    return {
        "id": pid,
        "date": date,
        "date_gmt": date,
        "link": link,
        "title": {"rendered": title},
        "content": {"rendered": content},
        "excerpt": {"rendered": excerpt or f"<p>{title}</p>"},
    }


REVEAL_CONTENT = (
    '<h2>Card Reveal: Jormuntide Ignis</h2>'
    '<p>A new card reveal from the upcoming set.</p>'
    '<img src="https://en.palworld-official-cardgame.com/wordpress/wp-content/images/cardlist/EBP01/EBP01-001.png">'
)
NEWS_CONTENT = (
    '<p>Booster preorders open now.</p>'
    '<img src="https://en.palworld-official-cardgame.com/wordpress/wp-content/uploads/2026/09/banner.png">'
)
EXTERNAL_IMG = (
    '<p>Card reveal!</p><img src="https://pbs.twimg.com/media/abc.jpg">'
)


class PickRowTests(unittest.TestCase):
    def test_a_reveal_post_with_cardlist_art_becomes_a_row(self):
        post = wp_post(1, "Card Reveal: Jormuntide Ignis", "2026-09-25T10:00:00",
                       "https://en.palworld-official-cardgame.com/news/post-reveal", REVEAL_CONTENT)
        row = fetch_card_reveals.pick_row(post)
        self.assertIsNotNone(row)
        self.assertEqual(row["title"], "Card Reveal: Jormuntide Ignis")
        self.assertEqual(row["date"], "Sep 25, 2026")
        self.assertIn("/cardlist/EBP01/EBP01-001.png", row["image"])
        self.assertTrue(row["link"].endswith("/news/post-reveal"))

    def test_plain_news_without_reveal_wording_is_skipped(self):
        post = wp_post(2, "Booster Preorders", "2026-09-11T10:00:00",
                       "https://en.palworld-official-cardgame.com/news/post-10", NEWS_CONTENT)
        self.assertIsNone(fetch_card_reveals.pick_row(post))

    def test_reveal_wording_without_official_image_is_skipped(self):
        post = wp_post(3, "Card Reveal teaser", "2026-09-20T10:00:00",
                       "https://en.palworld-official-cardgame.com/news/post-t", EXTERNAL_IMG)
        self.assertIsNone(fetch_card_reveals.pick_row(post), "external (X) art must not be published")

    def test_cardlist_art_ranks_above_uploads_art(self):
        content = ('<img src="https://en.palworld-official-cardgame.com/wordpress/wp-content/uploads/2026/09/x.png">'
                   '<img src="https://en.palworld-official-cardgame.com/wordpress/wp-content/images/cardlist/EBP01/EBP01-002.png">')
        post = wp_post(4, "New card reveal batch", "2026-09-21T10:00:00",
                       "https://en.palworld-official-cardgame.com/news/post-r", content)
        row = fetch_card_reveals.pick_row(post)
        self.assertIsNotNone(row)
        self.assertIn("/cardlist/EBP01/EBP01-002.png", row["image"])

    def test_missing_title_or_link_is_skipped(self):
        self.assertIsNone(fetch_card_reveals.pick_row(wp_post(5, "", "2026-09-01T10:00:00",
                       "https://en.palworld-official-cardgame.com/news/x", REVEAL_CONTENT)))
        self.assertIsNone(fetch_card_reveals.pick_row(wp_post(6, "Card reveal", "2026-09-01T10:00:00",
                       "", REVEAL_CONTENT)))


class FormatDateTests(unittest.TestCase):
    def test_iso_dates_become_feed_style(self):
        self.assertEqual(fetch_card_reveals.format_date("2026-09-25T10:00:00"), "Sep 25, 2026")
        self.assertEqual(fetch_card_reveals.format_date("2026-01-05T00:00:00"), "Jan 5, 2026")

    def test_garbage_dates_pass_through(self):
        self.assertEqual(fetch_card_reveals.format_date("nonsense"), "nonsense")


class StageAndConsolidateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="card-reveals-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "sieve"

    def test_staged_session_consolidates_into_the_feed(self):
        rows = [fetch_card_reveals.pick_row(wp_post(1, "Card Reveal: Jormuntide Ignis",
                "2026-09-25T10:00:00", "https://en.palworld-official-cardgame.com/news/post-reveal",
                REVEAL_CONTENT))]
        fetch_card_reveals.stage_session(rows, self.root, stamp="20260926T000000Z")
        items, counts = news_feed.build_news_feed(self.root)
        self.assertEqual(counts["official"], 1)
        self.assertEqual(counts["x"], 0, "official-site rows must classify as official, not x:")
        self.assertEqual(items[0]["title"], "Card Reveal: Jormuntide Ignis")
        self.assertIn("/cardlist/", items[0]["image"])

    def test_staging_is_idempotent_per_stamp(self):
        rows = [{"title": "Card reveal A", "date": "Sep 1, 2026", "summary": "",
                 "link": "https://en.palworld-official-cardgame.com/news/a",
                 "image": "https://en.palworld-official-cardgame.com/wordpress/wp-content/images/cardlist/EBP01/1.png"}]
        first = fetch_card_reveals.stage_session(rows, self.root, stamp="X")
        second = fetch_card_reveals.stage_session(rows, self.root, stamp="X")
        self.assertEqual(first, second)

    def test_empty_fetch_stages_no_rows_and_consolidation_stays_clean(self):
        fetch_card_reveals.stage_session([], self.root, stamp="EMPTY")
        items, counts = news_feed.build_news_feed(self.root)
        self.assertEqual(items, [])
        self.assertEqual(counts["invalid"], 0)


class FetchTests(unittest.TestCase):
    def test_fetch_rows_dedupes_and_orders(self):
        posts = [
            wp_post(1, "Card Reveal one", "2026-09-25T10:00:00", "https://en.palworld-official-cardgame.com/news/1", REVEAL_CONTENT),
            wp_post(2, "Card Reveal one", "2026-09-25T10:00:00", "https://en.palworld-official-cardgame.com/news/1", REVEAL_CONTENT),
        ]
        rows = []
        seen = set()
        for post in posts:
            row = fetch_card_reveals.pick_row(post)
            if row:
                key = (row["title"].casefold(), row["link"].casefold())
                if key not in seen:
                    seen.add(key)
                    rows.append(row)
        self.assertEqual(len(rows), 1)


if __name__ == "__main__":
    unittest.main()
