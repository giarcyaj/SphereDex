"""Tests for the official X API v2 post fetcher."""
import contextlib
import datetime as dt
import io
import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlparse

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

    def test_every_row_carries_its_exact_publish_time_and_keeps_its_day(self):
        self.assertEqual([r["published"] for r in self.rows],
                         ["2026-09-25T10:00:00Z", "2026-09-24T09:00:00Z",
                          "2026-09-23T08:00:00Z", "2026-09-22T08:00:00Z"])
        self.assertEqual([r["date"] for r in self.rows],
                         ["Sep 25, 2026", "Sep 24, 2026", "Sep 23, 2026", "Sep 22, 2026"])

    def test_a_post_without_a_usable_created_at_has_no_published(self):
        rows = fetch_x_posts.rows_from_payload({"data": [
            {"id": "1", "text": "No time at all"},
            {"id": "2", "text": "Only a day", "created_at": "2026-09-25"},
            {"id": "3", "text": "Not a time", "created_at": "soon"},
        ]})
        self.assertEqual([("published" in r) for r in rows], [False, False, False])

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
        self.assertEqual(items[0]["published"], "2026-09-25T10:00:00Z")


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

    def test_since_id_is_passed_and_an_incremental_read_asks_for_the_api_minimum(self):
        calls = []
        fetch_x_posts.fetch_rows("tok", user_id="42", since_id="1234567890",
                                 get=lambda url, token: calls.append(url) or {"meta": {"result_count": 0}})
        query = parse_qs(urlparse(calls[0]).query)
        self.assertEqual(query["since_id"], ["1234567890"])
        self.assertEqual(query["max_results"], ["5"])

    def test_a_full_read_sends_no_since_id(self):
        calls = []
        fetch_x_posts.fetch_rows("tok", user_id="42", get=lambda url, token: calls.append(url) or PAYLOAD)
        self.assertNotIn("since_id", parse_qs(urlparse(calls[0]).query))

    def test_newest_post_id_compares_ids_as_numbers_and_prefers_nothing_over_junk(self):
        self.assertEqual(fetch_x_posts.newest_post_id({"data": [{"id": "9"}, {"id": "10"}]}), "10")
        self.assertEqual(fetch_x_posts.newest_post_id({"meta": {"newest_id": "12"}, "data": [{"id": "11"}]}), "12")
        self.assertEqual(fetch_x_posts.newest_post_id({"meta": {"result_count": 0}}), "")
        self.assertEqual(fetch_x_posts.newest_post_id({"data": [{"id": "1; DROP"}]}), "")

    def test_api_errors_raise(self):
        with self.assertRaises(ValueError):
            fetch_x_posts.fetch_rows("tok", user_id="42", get=lambda u, t: {"errors": [{"detail": "Unauthorized"}]})
        with self.assertRaises(ValueError):
            fetch_x_posts.resolve_user_id("tok", get=lambda u, t: {"errors": [{"title": "Not Found Error"}]})


class MainHarness(unittest.TestCase):
    """A temp directory and a main() runner shared by the tests below; no tests of its own."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="x-api-main-")
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def run_main(self, *argv, env=None, get=None):
        out = io.StringIO()
        # Never the real X API (billed per post) or xAI: an unstubbed call fails the test loudly.
        base = {"XAI_API_KEY": "", "X_USER_ID": ""}
        with mock.patch.dict(os.environ, {**base, **(env or {})}, clear=False), \
                mock.patch.object(fetch_x_posts, "_get_json", side_effect=AssertionError("network call in a test")), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            code = fetch_x_posts.main(list(argv), get=get)
        return code, out.getvalue()


class MainTests(MainHarness):
    def test_missing_token_skips_cleanly_and_stages_nothing(self):
        gh = self.dir / "gh.txt"
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("X_BEARER_TOKEN", None)
            code, out = self.run_main("--root", str(self.dir / "sieve"), "--github-output", str(gh))
        self.assertEqual(code, 0)
        self.assertIn("skipping", out)
        self.assertFalse((self.dir / "sieve").exists())
        self.assertEqual(gh.read_text(encoding="utf-8").splitlines(),
                         ["status=skipped", "posts=0", "posts_PalworldOCG_EN=0", "posts_PalworldOCG=0"])

    def test_fetch_failure_returns_1_without_printing_the_token(self):
        gh = self.dir / "gh.txt"
        with mock.patch.object(fetch_x_posts, "fetch_account", side_effect=OSError("network down")):
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


EN_ID, JP_ID = "100", "200"
USER_IDS = {"PalworldOCG_EN": EN_ID, "PalworldOCG": JP_ID}


def timeline(*ids, newest=None, next_token=None):
    """A raw /2/users/:id/tweets payload holding plain English posts with the given ids."""
    payload = {"meta": {"result_count": len(ids)}}
    if ids:
        payload["data"] = [{"id": i, "created_at": "2026-10-14T02:00:01.000Z",
                            "text": f"Card reveal number {i} for Legends Awaken"} for i in ids]
        payload["meta"]["newest_id"] = newest or max(ids, key=int)
    if next_token:
        payload["meta"]["next_token"] = next_token
    return payload


def ids(newest, count):
    """count post ids counting down from newest, newest first, the order the API returns them in."""
    return [str(newest - n) for n in range(count)]


def counts(en, jp):
    """The per account lines of --github-output, as run_x reads them back."""
    return {"posts_PalworldOCG_EN": str(en), "posts_PalworldOCG": str(jp)}


class FakeX:
    """Stands in for the X API: records every URL it is asked for and answers from canned timelines."""

    def __init__(self, timelines):
        self.timelines = timelines          # user id -> payload, a list of pages, or an exception
        self.calls = []

    def __call__(self, url, token):
        self.calls.append(url)
        if "/users/by/username/" in url:
            return {"data": {"id": USER_IDS[url.rsplit("/", 1)[-1]]}}
        answer = self.timelines[re.search(r"/users/(\d+)/tweets", url).group(1)]
        if isinstance(answer, Exception):
            raise answer
        return answer.pop(0) if isinstance(answer, list) else answer

    def reads(self, uid):
        return [parse_qs(urlparse(u).query) for u in self.calls if f"/users/{uid}/tweets" in u]

    def lookups(self):
        return [u for u in self.calls if "/users/by/username/" in u]


def stamp(hours_ago):
    when = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=hours_ago)
    return when.strftime("%Y-%m-%dT%H:%M:%SZ")


class CursorTests(MainHarness):
    """Full versus incremental reads, and where the cursor moves to (no network, stubbed get)."""

    def setUp(self):
        super().setUp()
        self.cursor = self.dir / "sieve" / "x_cursor.json"

    def write_cursor(self, full_hours_ago=2, en="1001", jp="2001", ids=True):
        accounts = {"PalworldOCG_EN": {"since_id": en}, "PalworldOCG": {"since_id": jp}}
        if ids:
            accounts["PalworldOCG_EN"]["user_id"] = EN_ID
            accounts["PalworldOCG"]["user_id"] = JP_ID
        data = {"accounts": accounts}
        if full_hours_ago is not None:
            data["full_at"] = stamp(full_hours_ago)
        self.cursor.parent.mkdir(parents=True, exist_ok=True)
        self.cursor.write_text(json.dumps(data), encoding="utf-8")
        return data

    def run_x(self, fake, *extra):
        gh = self.dir / "gh.txt"
        if gh.exists():
            gh.unlink()
        code, out = self.run_main("--root", str(self.dir / "sieve"), "--cursor", str(self.cursor),
                                  "--github-output", str(gh), *extra,
                                  env={"X_BEARER_TOKEN": "tok"}, get=fake)
        result = dict(line.split("=", 1) for line in gh.read_text(encoding="utf-8").splitlines())
        return code, out, result

    def saved(self):
        return json.loads(self.cursor.read_text(encoding="utf-8"))

    def test_read_mode_decision(self):
        now = dt.datetime(2026, 10, 14, 2, 0, tzinfo=dt.timezone.utc)
        at = lambda **ago: {"full_at": (now - dt.timedelta(**ago)).strftime("%Y-%m-%dT%H:%M:%SZ")}
        self.assertEqual(fetch_x_posts.read_mode({}, now)[0], "full")
        self.assertEqual(fetch_x_posts.read_mode({"full_at": "yesterday"}, now)[0], "full")
        self.assertEqual(fetch_x_posts.read_mode(at(hours=4), now)[0], "incremental")
        self.assertEqual(fetch_x_posts.read_mode(at(hours=19, minutes=59), now)[0], "incremental")
        self.assertEqual(fetch_x_posts.read_mode(at(hours=20, minutes=1), now)[0], "full")
        self.assertEqual(fetch_x_posts.read_mode(at(hours=-3), now)[0], "full")       # dated in the future
        self.assertEqual(fetch_x_posts.read_mode(at(hours=4), now, force_full=True)[0], "full")

    def test_no_cursor_file_means_a_full_read_that_records_full_at(self):
        fake = FakeX({EN_ID: timeline("1001", "1000", "999"), JP_ID: timeline("2001", "2000", "1999")})
        code, _, result = self.run_x(fake)
        self.assertEqual(code, 0)
        self.assertEqual(result, {"status": "ok", "posts": "6", **counts(3, 3)})
        for uid in (EN_ID, JP_ID):
            (query,) = fake.reads(uid)
            self.assertNotIn("since_id", query)
            self.assertEqual(query["max_results"], ["10"])
        saved = self.saved()
        self.assertLess(abs((fetch_x_posts.parse_instant(saved["full_at"])
                             - dt.datetime.now(dt.timezone.utc)).total_seconds()), 120)
        self.assertEqual(saved["accounts"], {"PalworldOCG_EN": {"since_id": "1001", "user_id": EN_ID},
                                             "PalworldOCG": {"since_id": "2001", "user_id": JP_ID}})

    def test_a_recent_full_read_means_an_incremental_read_from_each_since_id(self):
        before = self.write_cursor(full_hours_ago=4)
        fake = FakeX({EN_ID: timeline("1002"), JP_ID: timeline()})
        code, out, result = self.run_x(fake)
        self.assertEqual(code, 0)
        self.assertEqual(result, {"status": "incremental", "posts": "1", **counts(1, 0)})
        self.assertIn("incremental read", out)
        (en,) = fake.reads(EN_ID)
        (jp,) = fake.reads(JP_ID)
        self.assertEqual((en["since_id"], en["max_results"]), (["1001"], ["5"]))
        self.assertEqual((jp["since_id"], jp["max_results"]), (["2001"], ["5"]))
        self.assertEqual(fake.lookups(), [], "a remembered user id must not be looked up again")
        saved = self.saved()
        self.assertEqual(saved["full_at"], before["full_at"], "an incremental read never moves full_at")
        self.assertEqual(saved["accounts"]["PalworldOCG_EN"]["since_id"], "1002")
        self.assertEqual(saved["accounts"]["PalworldOCG"]["since_id"], "2001", "nothing new keeps the old id")

    def test_an_old_full_read_or_the_full_flag_means_a_full_read(self):
        for hours, extra in ((21, ()), (2, ("--full",))):
            with self.subTest(hours=hours, extra=extra):
                before = self.write_cursor(full_hours_ago=hours)
                fake = FakeX({EN_ID: timeline("1004", "1003", "1002"), JP_ID: timeline("2004", "2003", "2002")})
                code, _, result = self.run_x(fake, *extra)
                self.assertEqual(code, 0)
                self.assertEqual(result["status"], "ok")
                for uid in (EN_ID, JP_ID):
                    (query,) = fake.reads(uid)
                    self.assertNotIn("since_id", query)
                    self.assertEqual(query["max_results"], ["10"])
                saved = self.saved()
                self.assertGreater(saved["full_at"], before["full_at"])
                self.assertEqual(saved["accounts"]["PalworldOCG_EN"]["since_id"], "1004")

    def test_the_cursor_advances_to_meta_newest_id_even_when_the_feed_drops_that_post(self):
        self.write_cursor(full_hours_ago=4)
        page = timeline("1004", newest="1005")
        # The newest post is the link only half of a split Japanese announcement: tidy_rows drops it,
        # but the API has billed for it, so the cursor must still move past it.
        page["data"].insert(0, {"id": "1005", "created_at": "2026-10-14T02:05:00.000Z",
                                "text": "\u8a73\u7d30\u306f\u3053\u3061\u3089 https://t.co/abc"})
        fake = FakeX({EN_ID: page, JP_ID: {"data": [{"id": "2003", "text": "Countdown to Legends Awaken"},
                                                     {"id": "2004", "text": "Card reveal: Pengullet"}]}})
        code, _, result = self.run_x(fake)
        self.assertEqual(code, 0)
        # posts counts the staged rows, the per account lines what the API returned (the dropped post too).
        self.assertEqual(result, {"status": "incremental", "posts": "3", **counts(2, 2)})
        staged = json.loads(next((self.dir / "sieve").glob("x-api-*/files/scrape_results.json"))
                            .read_text(encoding="utf-8"))
        self.assertNotIn("https://x.com/PalworldOCG_EN/status/1005", [r["link"] for r in staged])
        accounts = self.saved()["accounts"]
        self.assertEqual(accounts["PalworldOCG_EN"]["since_id"], "1005", "meta.newest_id, not the newest kept row")
        self.assertEqual(accounts["PalworldOCG"]["since_id"], "2004", "no meta: the highest id in data")

    def test_a_failed_account_keeps_its_cursor_and_the_run_reports_partial(self):
        self.write_cursor(full_hours_ago=4)
        fake = FakeX({EN_ID: timeline("1002"), JP_ID: OSError("connection reset")})
        code, _, result = self.run_x(fake)
        self.assertEqual(code, 0)
        self.assertEqual(result, {"status": "partial", "posts": "1", **counts(1, 0)})
        accounts = self.saved()["accounts"]
        self.assertEqual(accounts["PalworldOCG_EN"], {"since_id": "1002", "user_id": EN_ID})
        # The old since_id stays; the remembered user id is forgotten so a stale one cannot lock it out.
        self.assertEqual(accounts["PalworldOCG"], {"since_id": "2001"})

    def test_a_full_read_with_a_failed_account_does_not_record_full_at(self):
        fake = FakeX({EN_ID: timeline("1001"), JP_ID: OSError("connection reset")})
        code, _, result = self.run_x(fake)
        self.assertEqual(code, 0)
        self.assertEqual(result["status"], "partial")
        saved = self.saved()
        self.assertNotIn("full_at", saved, "the next run must try the full read again")
        self.assertEqual(saved["accounts"]["PalworldOCG_EN"]["since_id"], "1001")
        self.assertNotIn("PalworldOCG", saved["accounts"])

    def test_every_account_failing_reports_failed_and_keeps_the_cursor(self):
        before = self.write_cursor(full_hours_ago=4)
        fake = FakeX({EN_ID: OSError("down"), JP_ID: OSError("down")})
        code, _, result = self.run_x(fake)
        self.assertEqual(code, 1)
        self.assertEqual(result, {"status": "failed", "posts": "0", **counts(0, 0)})
        saved = self.saved()
        self.assertEqual(saved["full_at"], before["full_at"])
        self.assertEqual(saved["accounts"]["PalworldOCG_EN"]["since_id"], "1001")
        self.assertEqual(saved["accounts"]["PalworldOCG"]["since_id"], "2001")

    def test_an_incremental_read_never_reports_ok(self):
        for en, jp in ((timeline("1002", "1003"), timeline("2002")), (timeline(), timeline())):
            with self.subTest(posts=len(en.get("data", [])) + len(jp.get("data", []))):
                self.write_cursor(full_hours_ago=4)
                code, _, result = self.run_x(FakeX({EN_ID: en, JP_ID: jp}))
                self.assertEqual(code, 0)
                self.assertEqual(result["status"], "incremental")

    def test_a_corrupt_cursor_file_means_a_full_read(self):
        for content in (b"{not json", b"[]", b'"just a string"', b"\xff\xfe\x00garbage",
                        b'{"full_at": 5, "accounts": []}'):
            with self.subTest(content=content):
                self.cursor.parent.mkdir(parents=True, exist_ok=True)
                self.cursor.write_bytes(content)
                fake = FakeX({EN_ID: timeline(*ids(1003, 3)), JP_ID: timeline(*ids(2003, 3))})
                code, out, result = self.run_x(fake)
                self.assertEqual(code, 0)
                self.assertEqual(result["status"], "ok")
                self.assertIn("full read", out)
                self.assertNotIn("since_id", fake.reads(EN_ID)[0])
                self.assertEqual(self.saved()["accounts"]["PalworldOCG_EN"]["since_id"], "1003")

    def test_a_junk_since_id_is_never_sent_to_the_api(self):
        self.write_cursor(full_hours_ago=4, en="1; DROP TABLE")
        fake = FakeX({EN_ID: timeline("1001"), JP_ID: timeline()})
        code, _, result = self.run_x(fake)
        self.assertEqual(code, 0)
        self.assertEqual(result["status"], "incremental")
        (query,) = fake.reads(EN_ID)
        self.assertNotIn("since_id", query)
        self.assertEqual(self.saved()["accounts"]["PalworldOCG_EN"]["since_id"], "1001")

    def test_an_incremental_read_follows_the_next_page_up_to_max(self):
        self.write_cursor(full_hours_ago=4)
        first = timeline("1010", "1009", "1008", "1007", "1006", next_token="page2")
        second = timeline("1005", "1004", next_token="page3")
        fake = FakeX({EN_ID: [first, second], JP_ID: timeline()})
        code, _, result = self.run_x(fake)
        self.assertEqual(code, 0)
        self.assertEqual(result, {"status": "incremental", "posts": "7", **counts(7, 0)})
        reads = fake.reads(EN_ID)
        self.assertEqual(len(reads), 2, "two pages of 5 reach --max 10, so page3 is never asked for")
        self.assertEqual(reads[1]["pagination_token"], ["page2"])
        self.assertEqual(reads[1]["since_id"], ["1001"])
        self.assertEqual(self.saved()["accounts"]["PalworldOCG_EN"]["since_id"], "1010")

    def test_the_cursor_is_written_atomically(self):
        before = self.write_cursor(full_hours_ago=4)
        fake = FakeX({EN_ID: timeline("1002"), JP_ID: timeline()})
        with mock.patch.object(fetch_x_posts.os, "replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.run_x(fake)
        self.assertEqual(json.loads(self.cursor.read_text(encoding="utf-8")), before, "old cursor intact")
        self.assertEqual(list(self.cursor.parent.glob("*.tmp")), [], "no half written file left behind")
        code, _, _ = self.run_x(FakeX({EN_ID: timeline("1002"), JP_ID: timeline()}))
        self.assertEqual(code, 0)
        self.assertEqual(list(self.cursor.parent.glob("*.tmp")), [])
        self.assertEqual(self.saved()["accounts"]["PalworldOCG_EN"]["since_id"], "1002")

    def test_without_cursor_every_run_is_a_full_read_and_nothing_is_saved(self):
        gh = self.dir / "gh.txt"
        fake = FakeX({EN_ID: timeline(*ids(1003, 3)), JP_ID: timeline(*ids(2003, 3))})
        code, _ = self.run_main("--root", str(self.dir / "sieve"), "--github-output", str(gh),
                                env={"X_BEARER_TOKEN": "tok"}, get=fake)
        self.assertEqual(code, 0)
        self.assertIn("status=ok", gh.read_text(encoding="utf-8"))
        self.assertFalse(self.cursor.exists())

    # A full read is the only kind that prunes stored posts, so an account that answered a working call
    # with almost nothing must not be trusted: the other account's posts made the batch look complete,
    # and the quiet account's stored posts were all deleted.

    def test_a_full_read_where_one_account_comes_back_empty_reports_partial(self):
        fake = FakeX({EN_ID: timeline(*ids(1010, 10)), JP_ID: timeline()})
        code, out, result = self.run_x(fake)
        self.assertEqual(code, 0)
        self.assertEqual(result, {"status": "partial", "posts": "10", **counts(10, 0)})
        self.assertIn("@PalworldOCG returned only 0 post(s) on a full read", out)
        saved = self.saved()
        self.assertNotIn("full_at", saved, "the next run must try the full read again")
        self.assertEqual(saved["accounts"]["PalworldOCG_EN"]["since_id"], "1010")
        self.assertEqual(saved["accounts"]["PalworldOCG"], {"user_id": JP_ID}, "nothing returned, nothing to move to")
        staged = json.loads(next((self.dir / "sieve").glob("x-api-*/files/scrape_results.json"))
                            .read_text(encoding="utf-8"))
        self.assertEqual(len(staged), 10, "the posts that did arrive are still staged")

    def test_a_full_read_where_one_account_returns_two_posts_reports_partial_until_a_good_one(self):
        before = self.write_cursor(full_hours_ago=21)
        fake = FakeX({EN_ID: timeline(*ids(1010, 10)), JP_ID: timeline("2003", "2002")})
        code, _, result = self.run_x(fake)
        self.assertEqual(code, 0)
        self.assertEqual(result, {"status": "partial", "posts": "12", **counts(10, 2)})
        saved = self.saved()
        self.assertEqual(saved["full_at"], before["full_at"], "a short full read never moves full_at")
        self.assertEqual(saved["accounts"]["PalworldOCG"]["since_id"], "2003", "its since_id still moves on")
        # The old full_at is still over 20 hours old, so the next run reads both accounts in full again.
        fake = FakeX({EN_ID: timeline(*ids(1012, 10)), JP_ID: timeline(*ids(2012, 10))})
        _, out, result = self.run_x(fake)
        self.assertIn("full read", out)
        self.assertEqual(result, {"status": "ok", "posts": "20", **counts(10, 10)})
        self.assertNotIn("since_id", fake.reads(JP_ID)[0])
        self.assertGreater(self.saved()["full_at"], before["full_at"])

    def test_a_full_read_where_both_accounts_return_ten_reports_ok(self):
        fake = FakeX({EN_ID: timeline(*ids(1010, 10), next_token="more"), JP_ID: timeline(*ids(2010, 10))})
        code, _, result = self.run_x(fake)
        self.assertEqual(code, 0)
        self.assertEqual(result, {"status": "ok", "posts": "20", **counts(10, 10)})
        self.assertEqual(len(fake.reads(EN_ID)), 1, "ten posts is --max, so the next page is never asked for")
        self.assertIn("full_at", self.saved())

    def test_a_short_first_page_on_a_full_read_follows_the_next_token(self):
        # Two posts survived the API's reply filter on the first page: too few on their own.
        first = timeline("1010", "1009", next_token="page2")
        second = timeline("1008", "1007", "1006", "1005")
        fake = FakeX({EN_ID: [first, second], JP_ID: timeline(*ids(2010, 10))})
        code, _, result = self.run_x(fake)
        self.assertEqual(code, 0)
        self.assertEqual(result, {"status": "ok", "posts": "16", **counts(6, 10)})
        reads = fake.reads(EN_ID)
        self.assertEqual(len(reads), 2)
        self.assertEqual(reads[1]["pagination_token"], ["page2"])
        self.assertEqual(reads[1]["max_results"], ["10"], "a later page keeps the page size of the chain")
        self.assertNotIn("since_id", reads[1])
        saved = self.saved()
        self.assertIn("full_at", saved)
        self.assertEqual(saved["accounts"]["PalworldOCG_EN"]["since_id"], "1010")

    def test_a_full_read_follows_at_most_three_pages(self):
        for per_page, status in ((1, "ok"), (0, "partial")):
            with self.subTest(per_page=per_page):
                pages = [timeline(*ids(1010 - n, per_page), next_token=f"page{n + 2}") for n in range(5)]
                fake = FakeX({EN_ID: pages, JP_ID: timeline(*ids(2010, 10))})
                code, _, result = self.run_x(fake, "--full")
                self.assertEqual(code, 0)
                self.assertEqual(len(fake.reads(EN_ID)), 3)
                self.assertEqual(len(pages), 2, "the pages past the cap are never asked for")
                self.assertEqual(result["posts_PalworldOCG_EN"], str(3 * per_page))
                self.assertEqual(result["status"], status)


if __name__ == "__main__":
    unittest.main()
