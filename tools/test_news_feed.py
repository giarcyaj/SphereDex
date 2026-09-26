"""Tests for turning staged Sieve session output into the application news feed."""
import csv
import json
import tempfile
import unittest
from pathlib import Path

import news_feed


class NewsFeedTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="news-feed-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "sieve"
        self.root.mkdir()

    def session(self, name, instruction=""):
        path = self.root / name
        (path / "files").mkdir(parents=True)
        (self.root / (name + ".json")).write_text(json.dumps({
            "session_id": name, "instruction": instruction,
        }), encoding="utf-8")
        return path

    def test_reads_downloaded_json_and_separates_official_and_x(self):
        official = self.session("official-session", "Extract Palworld TCG official news")
        (official / "files" / "scrape_results.json").write_text(json.dumps([
            {"title": "Official update", "date": "2026-09-26", "link": "https://en.palworld-official-cardgame.com/news/post-1", "image": "https://example.test/official.jpg"}
        ]), encoding="utf-8")
        x_session = self.session("x-session", "Extract latest card reveals")
        (x_session / "files" / "scrape_results.json").write_text(json.dumps({"items": [
            {"title": "New reveal", "date": "2026-09-26", "link": "https://x.com/PalworldOCG_EN/status/1", "image": "https://pbs.twimg.com/media/card.jpg"}
        ]}), encoding="utf-8")
        items, counts = news_feed.build_news_feed(self.root)
        self.assertEqual(counts["official"], 1)
        self.assertEqual(counts["x"], 1)
        self.assertEqual([item["source"] for item in items], ["official", "x:PalworldOCG_EN"])
        self.assertEqual(items[1]["image"], "https://pbs.twimg.com/media/card.jpg")

    def test_classifies_x_rows_by_media_host_when_permalink_missing(self):
        session = self.session("x-session", "Extract card reveals")
        (session / "result.json").write_text(json.dumps([
            {"title": "New reveal", "date": "2026-09-26", "image": "https://pbs.twimg.com/media/card.jpg"}
        ]), encoding="utf-8")
        items, counts = news_feed.build_news_feed(self.root)
        self.assertEqual(counts["x"], 1)
        self.assertEqual(items[0]["source"], "x:PalworldOCG_EN")
        self.assertEqual(items[0]["link"], "https://x.com/PalworldOCG_EN")

    def test_reads_root_result_and_csv_downloads_and_deduplicates(self):
        session = self.session("session")
        row = {"title": "Update", "link": "https://en.palworld-official-cardgame.com/news/post-1", "image": "https://example.test/card.png"}
        (session / "result.json").write_text(json.dumps([row]), encoding="utf-8")
        with (session / "files" / "scrape_results.csv").open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=["title", "link", "image"])
            writer.writeheader()
            writer.writerow(row)
        items, counts = news_feed.build_news_feed(self.root)
        self.assertEqual(len(items), 1)
        self.assertEqual(counts["official"], 1)

    def test_does_not_publish_schema_unverified_result_or_files(self):
        session = self.session("session", "Extract news")
        record_path = self.root / "session.json"
        record = json.loads(record_path.read_text(encoding="utf-8"))
        record["schema_conformance"] = {"status": "fail"}
        record_path.write_text(json.dumps(record), encoding="utf-8")
        (session / "result.unverified.json").write_text(json.dumps([
            {"title": "Unverified post", "link": "https://x.com/PalworldOCG_EN/status/2", "image": "https://pbs.twimg.com/media/card.jpg"}
        ]), encoding="utf-8")
        (session / "files" / "scrape_results.json").write_text(json.dumps([
            {"title": "Also unverified", "link": "https://en.palworld-official-cardgame.com/news/post-3"}
        ]), encoding="utf-8")
        items, counts = news_feed.build_news_feed(self.root)
        self.assertEqual(items, [])
        self.assertEqual(counts["x"], 0)
        self.assertEqual(counts["official"], 0)
        self.assertEqual(counts["unverified"], 2)

    def test_accepts_multiple_rows_in_clean_inline_result(self):
        session = self.session("session", "Extract posts from X")
        (session / "result.json").write_text(json.dumps([
            {"title": "X update", "link": "https://x.com/PalworldOCG_EN/status/3"},
            {"title": "", "link": "https://x.com/PalworldOCG_EN/status/4"},
        ]), encoding="utf-8")
        items, counts = news_feed.build_news_feed(self.root)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["source"], "x:PalworldOCG_EN")
        self.assertEqual(items[0]["image"], "")
        self.assertEqual(counts["invalid"], 1)

    def test_reports_refusal_details_from_session_record(self):
        self.session("x-session", "Extract latest X card reveals")
        record_path = self.root / "x-session.json"
        record = json.loads(record_path.read_text(encoding="utf-8"))
        record["refusal"] = {"code": "compliance", "message": "X.com robots.txt Disallow: /; Conservative policy refuses."}
        record_path.write_text(json.dumps(record), encoding="utf-8")
        messages = news_feed._unusable_session_summaries(self.root)
        self.assertEqual(len(messages), 1)
        self.assertIn("robots.txt", messages[0])
        self.assertIn("Conservative", messages[0])

    def test_write_feed_always_emits_valid_json(self):
        output = Path(self.tmp.name) / "out" / "feed.json"
        counts = news_feed.write_news_feed(self.root, output)
        self.assertEqual(counts["x"], 0)
        self.assertEqual(json.loads(output.read_text(encoding="utf-8")), [])


if __name__ == "__main__":
    unittest.main()
