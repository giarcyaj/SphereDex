"""The point of these is the failure paths: a post must survive every one of them, in Japanese."""
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path

import translate_posts as T

JP = {"title": "⿺　パルワールド 大会情報",
      "summary": "チャレンジャーズカップ season1",
      "link": "https://x.com/PalworldOCG/status/1"}
EN = {"title": "Card Reveals", "summary": "Two new cards", "link": "https://x.com/PalworldOCG_EN/status/2"}


def reply(headlines):
    """Shape of a real chat/completions body."""
    payload = json.dumps([{"n": i, "headline": h} for i, h in enumerate(headlines)], ensure_ascii=False)
    return {"choices": [{"message": {"content": payload}}]}


class DetectionTests(unittest.TestCase):
    def test_japanese_is_detected_and_english_is_not(self):
        self.assertTrue(T.needs_translation(JP))
        self.assertFalse(T.needs_translation(EN))

    def test_an_english_post_never_reaches_the_api(self):
        calls = []
        with tempfile.TemporaryDirectory() as d:
            rows, stats = T.translate_rows([EN], Path(d) / "c.json", key="k",
                                           post=lambda *a: calls.append(a) or reply(["x"]))
        self.assertEqual(calls, [], "an English post must cost nothing")
        self.assertEqual(stats["considered"], 0)
        self.assertEqual(rows[0]["title"], "Card Reveals")


class CopyRuleTests(unittest.TestCase):
    def test_dashes_are_stripped_whatever_the_model_returns(self):
        for raw in ("Booster Pack - Vol. 2", "Booster Pack – Vol. 2", "Booster Pack — Vol. 2"):
            out = T.tidy_headline(raw)
            self.assertNotRegex(out, r"[-‐-―]", f"dash survived in {out!r}")

    def test_headline_is_capped(self):
        self.assertLessEqual(len(T.tidy_headline("a" * 500)), T.HEADLINE_MAX)


class FallbackTests(unittest.TestCase):
    """Every one of these must leave the post publishable, in Japanese."""

    def _untouched(self, post):
        with tempfile.TemporaryDirectory() as d:
            rows, stats = T.translate_rows([dict(JP)], Path(d) / "c.json", key="k", post=post)
        self.assertEqual(rows[0]["title"], JP["title"], "the original must survive")
        self.assertEqual(stats["failed"], 1)

    def test_http_error(self):
        def boom(*_):
            raise urllib.error.HTTPError("u", 429, "Too Many Requests", {}, None)
        self._untouched(boom)

    def test_network_error(self):
        def boom(*_):
            raise OSError("connection reset")
        self._untouched(boom)

    def test_garbage_reply(self):
        self._untouched(lambda *_: {"choices": [{"message": {"content": "I cannot do that"}}]})

    def test_empty_reply(self):
        self._untouched(lambda *_: {})

    def test_blank_headline_is_not_accepted(self):
        self._untouched(lambda *_: reply([""]))

    def test_no_key_leaves_the_post_alone_and_costs_nothing(self):
        calls = []
        with tempfile.TemporaryDirectory() as d:
            rows, stats = T.translate_rows([dict(JP)], Path(d) / "c.json", key="",
                                           post=lambda *a: calls.append(a) or reply(["x"]))
        self.assertEqual(calls, [])
        self.assertEqual(rows[0]["title"], JP["title"])
        self.assertEqual(stats["skipped_no_key"], 1)


class CacheTests(unittest.TestCase):
    def test_second_run_costs_nothing(self):
        calls = []

        def counted(*a):
            calls.append(a)
            return reply(["Challengers Cup Season 1 starts October 1"])

        with tempfile.TemporaryDirectory() as d:
            cache = Path(d) / "c.json"
            first, s1 = T.translate_rows([dict(JP)], cache, key="k", post=counted)
            second, s2 = T.translate_rows([dict(JP)], cache, key="k", post=counted)
        self.assertEqual(len(calls), 1, "the cached run must not call the API again")
        self.assertEqual(s1["translated"], 1)
        self.assertEqual(s2["cached"], 1)
        self.assertEqual(first[0]["title"], second[0]["title"])

    def test_original_is_kept_alongside(self):
        with tempfile.TemporaryDirectory() as d:
            rows, _ = T.translate_rows([dict(JP)], Path(d) / "c.json", key="k",
                                       post=lambda *_: reply(["Tournament news"]))
        self.assertEqual(rows[0]["title"], "Tournament news")
        self.assertEqual(rows[0]["title_original"], JP["title"])

    def test_a_corrupt_cache_file_is_ignored_not_fatal(self):
        with tempfile.TemporaryDirectory() as d:
            cache = Path(d) / "c.json"
            cache.write_text("{not json", encoding="utf-8")
            rows, stats = T.translate_rows([dict(JP)], cache, key="k",
                                           post=lambda *_: reply(["Tournament news"]))
        self.assertEqual(stats["translated"], 1)
        self.assertEqual(rows[0]["title"], "Tournament news")


class BatchTests(unittest.TestCase):
    def test_a_partial_reply_translates_what_it_can(self):
        rows = [dict(JP, link=f"https://x.com/PalworldOCG/status/{i}") for i in range(3)]
        # the model answers for 0 and 2 only
        body = {"choices": [{"message": {"content": json.dumps(
            [{"n": 0, "headline": "First"}, {"n": 2, "headline": "Third"}])}}]}
        with tempfile.TemporaryDirectory() as d:
            out, stats = T.translate_rows(rows, Path(d) / "c.json", key="k", post=lambda *_: body)
        self.assertEqual(out[0]["title"], "First")
        self.assertEqual(out[1]["title"], JP["title"], "the unanswered one keeps its original")
        self.assertEqual(out[2]["title"], "Third")
        self.assertEqual((stats["translated"], stats["failed"]), (2, 1))

    def test_an_out_of_range_index_is_discarded(self):
        body = {"choices": [{"message": {"content": json.dumps([{"n": 9, "headline": "Nope"}])}}]}
        with tempfile.TemporaryDirectory() as d:
            out, stats = T.translate_rows([dict(JP)], Path(d) / "c.json", key="k", post=lambda *_: body)
        self.assertEqual(out[0]["title"], JP["title"])
        self.assertEqual(stats["failed"], 1)

    def test_fenced_json_is_still_read(self):
        body = {"choices": [{"message": {"content": '```json\n[{"n":0,"headline":"Fenced"}]\n```'}}]}
        with tempfile.TemporaryDirectory() as d:
            out, _ = T.translate_rows([dict(JP)], Path(d) / "c.json", key="k", post=lambda *_: body)
        self.assertEqual(out[0]["title"], "Fenced")


if __name__ == "__main__":
    unittest.main()
