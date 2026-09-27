"""Tests for the official X API v2 post fetcher."""
import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import fetch_x_posts
import news_feed

PAYLOAD = {
    "data": [
        {"id": "111", "created_at": "2026-09-25T10:00:00.000Z",
         "text": "Card reveal: Jormuntide Ignis &amp; friends!\nComing in Eternal Ascent https://t.co/abc123",
         "attachments": {"media_keys": ["3_1"]}},
        {"id": "222", "created_at": "2026-09-24T09:00:00.000Z",
         "text": "Watch the trailer https://t.co/vid",
         "attachments": {"media_keys": ["7_2"]}},
        {"id": "333", "created_at": "2026-09-23T08:00:00.000Z", "text": "Tournament results are up."},
        {"id": "444", "created_at": "2026-09-22T08:00:00.000Z", "text": "short",
         "note_tweet": {"text": "The long version of this post, which is over 280 characters."}},
        {"id": "111", "created_at": "2026-09-25T10:00:00.000Z", "text": "duplicate id"},
    ],
    "includes": {"media": [
        {"media_key": "3_1", "type": "photo", "url": "https://pbs.twimg.com/media/reveal.jpg"},
        {"media_key": "7_2", "type": "video", "preview_image_url": "https://pbs.twimg.com/ext_tw_video_thumb/2/pu/img/t.jpg"},
    ]},
}


class RowsFromPayloadTests(unittest.TestCase):
    def setUp(self):
        self.rows = fetch_x_posts.rows_from_payload(PAYLOAD)

    def test_each_post_becomes_one_row_and_duplicate_ids_collapse(self):
        self.assertEqual([r["link"].rsplit("/", 1)[-1] for r in self.rows], ["111", "222", "333", "444"])

    def test_title_is_the_first_line_without_shortlinks_or_entities(self):
        self.assertEqual(self.rows[0]["title"], "Card reveal: Jormuntide Ignis & friends!")
        self.assertNotIn("t.co", self.rows[0]["summary"])
        self.assertEqual(self.rows[0]["date"], "Sep 25, 2026")
        self.assertEqual(self.rows[0]["link"], "https://x.com/PalworldOCG_EN/status/111")

    def test_photo_url_is_used_and_video_falls_back_to_its_preview(self):
        self.assertEqual(self.rows[0]["image"], "https://pbs.twimg.com/media/reveal.jpg")
        self.assertIn("ext_tw_video_thumb", self.rows[1]["image"])
        self.assertEqual(self.rows[2]["image"], "")

    def test_long_posts_use_note_tweet_text(self):
        self.assertTrue(self.rows[3]["title"].startswith("The long version"))

    def test_long_titles_are_truncated(self):
        rows = fetch_x_posts.rows_from_payload({"data": [{"id": "9", "text": "a" * 300}]})
        self.assertEqual(len(rows[0]["title"]), fetch_x_posts.TITLE_MAX)
        self.assertTrue(rows[0]["title"].endswith("…"))

    def test_empty_or_error_payloads_give_no_rows(self):
        self.assertEqual(fetch_x_posts.rows_from_payload({}), [])
        self.assertEqual(fetch_x_posts.rows_from_payload({"data": [{"id": "1", "text": "https://t.co/x"}]}), [])


class StageAndConsolidateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="x-api-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "sieve"

    def test_staged_posts_classify_as_x_in_the_feed(self):
        fetch_x_posts.stage_session(fetch_x_posts.rows_from_payload(PAYLOAD), self.root, stamp="T")
        items, counts = news_feed.build_news_feed(self.root)
        self.assertEqual(counts["x"], 4)
        self.assertEqual(counts["official"], 0)
        self.assertTrue(all(i["source"] == "x:PalworldOCG_EN" for i in items))


class FetchTests(unittest.TestCase):
    def test_fetch_resolves_the_user_then_reads_posts_with_media(self):
        calls = []

        def fake_get(url, token):
            calls.append(url)
            self.assertEqual(token, "tok")
            return {"data": {"id": "42"}} if "/users/by/username/" in url else PAYLOAD

        rows = fetch_x_posts.fetch_rows("tok", get=fake_get)
        self.assertEqual(len(rows), 4)
        self.assertIn("/users/by/username/PalworldOCG_EN", calls[0])
        self.assertIn("/users/42/tweets?", calls[1])
        self.assertIn("exclude=retweets%2Creplies", calls[1])
        self.assertIn("expansions=attachments.media_keys", calls[1])

    def test_a_configured_user_id_skips_the_lookup(self):
        calls = []
        fetch_x_posts.fetch_rows("tok", user_id="42", get=lambda url, token: calls.append(url) or PAYLOAD)
        self.assertEqual(len(calls), 1)

    def test_max_results_is_clamped_to_the_api_range(self):
        calls = []
        fetch_x_posts.fetch_rows("tok", user_id="42", max_results=1, get=lambda url, token: calls.append(url) or {})
        self.assertIn("max_results=5", calls[0])

    def test_api_errors_raise(self):
        with self.assertRaises(ValueError):
            fetch_x_posts.fetch_rows("tok", user_id="42", get=lambda u, t: {"errors": [{"detail": "Unauthorized"}]})
        with self.assertRaises(ValueError):
            fetch_x_posts.resolve_user_id("tok", get=lambda u, t: {"errors": [{"title": "Not Found Error"}]})


class MainTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="x-api-main-")
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def run_main(self, *argv, env=None):
        out = io.StringIO()
        with mock.patch.dict(os.environ, env or {}, clear=False), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(out):
            code = fetch_x_posts.main(list(argv))
        return code, out.getvalue()

    def test_missing_token_skips_cleanly_and_stages_nothing(self):
        gh = self.dir / "gh.txt"
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("X_BEARER_TOKEN", None)
            code, out = self.run_main("--root", str(self.dir / "sieve"), "--github-output", str(gh))
        self.assertEqual(code, 0)
        self.assertIn("skipping", out)
        self.assertFalse((self.dir / "sieve").exists())
        self.assertIn("status=skipped", gh.read_text(encoding="utf-8"))

    def test_fetch_failure_returns_1_without_printing_the_token(self):
        gh = self.dir / "gh.txt"
        with mock.patch.object(fetch_x_posts, "fetch_rows", side_effect=OSError("network down")):
            code, out = self.run_main("--root", str(self.dir / "sieve"), "--github-output", str(gh),
                                      env={"X_BEARER_TOKEN": "secret-token-value"})
        self.assertEqual(code, 1)
        self.assertNotIn("secret-token-value", out)
        self.assertIn("status=failed", gh.read_text(encoding="utf-8"))

    def test_offline_payload_is_staged(self):
        payload = self.dir / "payload.json"
        payload.write_text(json.dumps(PAYLOAD), encoding="utf-8")
        gh = self.dir / "gh.txt"
        code, out = self.run_main("--root", str(self.dir / "sieve"), "--offline", str(payload),
                                  "--github-output", str(gh))
        self.assertEqual(code, 0)
        self.assertIn("staged 4 post(s)", out)
        self.assertIn("posts=4", gh.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
