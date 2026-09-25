# -*- coding: utf-8 -*-
"""Tests for the sieve client. Run with: python tools/test_sieve.py

Only the HTTP boundary is faked (a recording Transport); every branch under test is the
real client code. No network calls and no credits are spent here.
"""
import json
import os
import shutil
import tempfile
import unittest

import sieve

BASE = "https://scrape.test"
KEY = "dc_sk_test_key"


def resp(payload=None, status=200, headers=None, raw=None):
    if raw is not None:
        body = raw
    elif payload is None:
        body = b""
    else:
        body = json.dumps(payload).encode("utf-8")
    return (status, headers or {}, body)


class FakeTransport(sieve.Transport):
    """Returns queued responses and records every call. An Exception item is raised."""

    def __init__(self, responses, on_request=None):
        self.responses = list(responses)
        self.calls = []
        self.on_request = on_request

    def request(self, method, url, headers, body, timeout):
        call = {"method": method, "url": url, "headers": dict(headers),
                "body": body, "timeout": timeout}
        self.calls.append(call)
        if self.on_request:
            self.on_request(call)
        if not self.responses:
            raise AssertionError("unexpected request: %s %s" % (method, url))
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def make_client(transport, sleeps=None, **kwargs):
    sleeps = sleeps if sleeps is not None else []
    client = sieve.SieveClient(KEY, base_url=BASE, transport=transport,
                               sleep=sleeps.append, **kwargs)
    return client, sleeps


class RequestBuildingTests(unittest.TestCase):
    def test_start_run_builds_the_documented_request(self):
        transport = FakeTransport([resp({"status": "queued", "session_id": "s1",
                                         "poll": "/api/scrapes/s1"}, 202)])
        client, _ = make_client(transport)
        out = client.start_run("Extract the text and author of each quote",
                               target_urls=["https://quotes.toscrape.com"],
                               fields=["quote", "author"], table_shape="long")
        self.assertEqual(out["session_id"], "s1")
        call = transport.calls[0]
        self.assertEqual(call["method"], "POST")
        self.assertEqual(call["url"], BASE + "/api/scrapes")
        self.assertEqual(call["headers"]["Authorization"], "Bearer " + KEY)
        self.assertEqual(call["headers"]["Content-Type"], "application/json")
        body = json.loads(call["body"])
        self.assertEqual(body["instruction"], "Extract the text and author of each quote")
        self.assertEqual(body["target_urls"], ["https://quotes.toscrape.com"])
        self.assertEqual(body["fields"], ["quote", "author"])
        self.assertEqual(body["table_shape"], "long")
        self.assertEqual(body["compliance_mode"], "regular")

    def test_optional_fields_are_omitted_and_compliance_defaults_to_regular(self):
        transport = FakeTransport([resp({"status": "queued", "session_id": "s1"}, 202)])
        client, _ = make_client(transport)
        client.start_run("Just the instruction")
        body = json.loads(transport.calls[0]["body"])
        self.assertEqual(set(body), {"instruction", "compliance_mode"})
        self.assertEqual(body["compliance_mode"], "regular")

    def test_instruction_is_required(self):
        client, _ = make_client(FakeTransport([]))
        with self.assertRaises(ValueError):
            client.start_run("   ")

    def test_output_schema_is_capped_at_32kb(self):
        client, _ = make_client(FakeTransport([]))
        big = json.dumps({"type": "object", "note": "x" * (33 * 1024)})
        with self.assertRaises(ValueError):
            client.start_run("x", output_schema=big)
        transport = FakeTransport([resp({"status": "queued", "session_id": "s1"}, 202)])
        client, _ = make_client(transport)
        client.start_run("x", output_schema={"type": "object"})
        self.assertEqual(json.loads(transport.calls[0]["body"])["output_schema"],
                         {"type": "object"})

    def test_document_uses_multipart_with_a_file_field(self):
        transport = FakeTransport([resp({"status": "queued", "session_id": "s2"}, 202)])
        client, _ = make_client(transport)
        client.start_run("Summarise this", document=b"%PDF-1.4 payload", document_name="file.pdf")
        call = transport.calls[0]
        self.assertTrue(call["headers"]["Content-Type"].startswith("multipart/form-data; boundary="))
        self.assertIn(b'name="instruction"', call["body"])
        self.assertIn(b'name="file"; filename="file.pdf"', call["body"])
        self.assertIn(b"%PDF-1.4 payload", call["body"])

    def test_start_run_without_a_session_id_is_an_error(self):
        transport = FakeTransport([resp({"status": "queued"}, 202)])
        client, _ = make_client(transport)
        with self.assertRaises(sieve.SieveError):
            client.start_run("x")


class PollingTests(unittest.TestCase):
    def test_running_backs_off_from_5s_to_about_30s_then_done(self):
        transport = FakeTransport([resp({"status": "running"}) for _ in range(8)] +
                                  [resp({"status": "done", "summary": {"rows": 1}})])
        client, sleeps = make_client(transport)
        run = client.poll("s1")
        self.assertEqual(run["status"], "done")
        self.assertEqual(sleeps, [5.0, 10.0, 20.0, 30.0, 30.0, 30.0, 30.0, 30.0])

    def test_refused_is_terminal_and_carries_the_reason(self):
        transport = FakeTransport([resp({"status": "refused",
                                         "refusal": {"code": "quota", "message": "no credits"}})])
        client, _ = make_client(transport)
        with self.assertRaises(sieve.RunRefused) as caught:
            client.poll("s1")
        self.assertEqual(caught.exception.code, "quota")
        self.assertEqual(len(transport.calls), 1)

    def test_unknown_status_is_an_error(self):
        transport = FakeTransport([resp({"status": "paused"})])
        client, _ = make_client(transport)
        with self.assertRaises(sieve.UnexpectedStatus):
            client.poll("s1")

    def test_get_is_retried_on_5xx(self):
        transport = FakeTransport([resp({}, 500), resp({"status": "running"})])
        client, _ = make_client(transport)
        self.assertEqual(client.get_run("s1")["status"], "running")
        self.assertEqual(len(transport.calls), 2)


class FollowUpTests(unittest.TestCase):
    def test_follow_up_waits_until_turns_advance(self):
        transport = FakeTransport([
            resp({"status": "done", "turns": 1}),          # before the turn
            resp({"ok": True}),                            # POST .../messages
            resp({"status": "done", "turns": 1}),          # still the previous answer
            resp({"status": "done", "turns": 2}),          # the new answer
        ])
        client, sleeps = make_client(transport)
        run = client.follow_up("s1", "add the author column")
        self.assertEqual(run["turns"], 2)
        self.assertEqual([c["method"] for c in transport.calls], ["GET", "POST", "GET", "GET"])
        self.assertEqual(sleeps, [5.0])

    def test_follow_up_keeps_polling_while_a_turn_is_running(self):
        transport = FakeTransport([
            resp({"status": "done", "turns": 1}),
            resp({"ok": True}),
            resp({"status": "running", "turns": 1}),       # schema repair reads running
            resp({"status": "done", "turns": 2}),
        ])
        client, _ = make_client(transport)
        self.assertEqual(client.follow_up("s1", "more")["turns"], 2)

    def test_message_conflict_waits_then_resends(self):
        transport = FakeTransport([resp({"error": "turn in flight"}, 409), resp({"ok": True})])
        client, sleeps = make_client(transport)
        client.send_message("s1", "more")
        self.assertEqual(len(transport.calls), 2)
        self.assertEqual(sleeps, [5.0])


class RetrySemanticsTests(unittest.TestCase):
    def test_post_run_is_never_retried_on_a_timeout(self):
        transport = FakeTransport([sieve.NetworkError("timed out")])
        client, _ = make_client(transport)
        with self.assertRaises(sieve.SieveError):
            client.start_run("x")
        self.assertEqual(len(transport.calls), 1, "a timeout must not re-POST and re-spend credits")

    def test_post_run_is_retried_on_5xx_because_no_run_was_created(self):
        transport = FakeTransport([resp({"error": "boom"}, 500),
                                   resp({"status": "queued", "session_id": "s3"}, 202)])
        client, _ = make_client(transport)
        self.assertEqual(client.start_run("x")["session_id"], "s3")
        self.assertEqual(len(transport.calls), 2)

    def test_post_run_is_retried_on_429(self):
        transport = FakeTransport([resp({}, 429, {"Retry-After": "2"}),
                                   resp({"status": "queued", "session_id": "s4"}, 202)])
        client, sleeps = make_client(transport)
        self.assertEqual(client.start_run("x")["session_id"], "s4")
        self.assertEqual(sleeps, [2.0])

    def test_network_error_on_a_get_is_retried(self):
        transport = FakeTransport([sieve.NetworkError("reset"), resp({"status": "running"})])
        client, _ = make_client(transport)
        self.assertEqual(client.get_run("s1")["status"], "running")
        self.assertEqual(len(transport.calls), 2)


class ErrorMappingTests(unittest.TestCase):
    CASES = [(400, sieve.BadRequest), (401, sieve.Unauthorized), (402, sieve.PaymentRequired),
             (404, sieve.NotFound), (429, sieve.RateLimited), (503, sieve.ServerError)]

    def test_statuses_map_to_typed_errors(self):
        for status, expected in self.CASES:
            with self.subTest(status=status):
                transport = FakeTransport([resp({"error": "x"}, status)])
                client, _ = make_client(transport, max_attempts=1)
                with self.assertRaises(expected):
                    client.get_run("s1")

    def test_rate_limit_honours_retry_after(self):
        transport = FakeTransport([resp({}, 429, {"Retry-After": "7"}),
                                   resp({"status": "running"})])
        client, sleeps = make_client(transport)
        client.get_run("s1")
        self.assertEqual(sleeps, [7.0])


class FileTests(unittest.TestCase):
    def test_relative_file_url_is_prefixed_and_sent_with_the_key(self):
        transport = FakeTransport([resp(raw=b"a,b\n1,2\n", headers={"Content-Type": "text/csv"})])
        client, _ = make_client(transport)
        data = client.download_file({"name": "q.csv", "url": "/files/q.csv"})
        self.assertEqual(data, b"a,b\n1,2\n")
        call = transport.calls[0]
        self.assertEqual(call["url"], BASE + "/files/q.csv")
        self.assertEqual(call["headers"]["Authorization"], "Bearer " + KEY)

    def test_absolute_file_url_is_left_alone(self):
        client, _ = make_client(FakeTransport([]))
        self.assertEqual(client.file_url({"url": "https://cdn.test/a.csv"}), "https://cdn.test/a.csv")


class StatusHelperTests(unittest.TestCase):
    def test_turns_count_accepts_the_shapes_the_api_can_return(self):
        self.assertEqual(sieve.turns_count({"turns": 3}), 3)
        self.assertEqual(sieve.turns_count({"turns": ["a", "b"]}), 2)
        self.assertEqual(sieve.turns_count({"turns": {"a": 1, "b": 2}}), 2)
        self.assertEqual(sieve.turns_count({}), 0)
        self.assertEqual(sieve.turns_count(None), 0)

    def test_conformance_and_cleanliness(self):
        self.assertEqual(sieve.conformance({"schema_conformance": {"status": "pass"}}), "pass")
        self.assertEqual(sieve.conformance({}), "not_checkable")
        self.assertTrue(sieve.is_clean({"schema_conformance": {"status": "partial"}}))
        self.assertFalse(sieve.is_clean({"schema_conformance": {"status": "fail"}}))


class StageRunTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="sieve-test-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def done_run(self, **extra):
        payload = {"status": "done", "summary": {"rows": 1},
                   "schema_conformance": {"status": "pass"}, "turns": 1}
        payload.update(extra)
        return payload

    def test_session_is_persisted_before_the_first_poll(self):
        store = sieve.SessionStore(self.tmp)
        observed = {}

        def on_request(call):
            if call["method"] == "GET" and "session_id" not in observed:
                observed["session_id"] = store.load("s1")

        transport = FakeTransport([
            resp({"status": "queued", "session_id": "s1", "poll": "/api/scrapes/s1"}, 202),
            resp(self.done_run(result={"a": 1}, files=[{"name": "q.csv", "url": "/files/q.csv"}])),
            resp(raw=b"csv-bytes"),
        ], on_request=on_request)
        client, _ = make_client(transport)
        outcome = sieve.stage_run(client, store, instruction="x", out_root=self.tmp)
        self.assertIsNotNone(observed["session_id"], "session_id must be durable before polling")
        self.assertEqual(observed["session_id"]["session_id"], "s1")
        self.assertEqual(outcome["status"], "done")
        self.assertEqual(store.load("s1")["status"], "done")
        self.assertEqual(outcome["result"], "result.json")
        self.assertEqual(outcome["downloaded"], ["q.csv"])
        with open(os.path.join(self.tmp, "s1", "files", "q.csv"), "rb") as handle:
            self.assertEqual(handle.read(), b"csv-bytes")

    def test_resume_polls_without_starting_a_new_run(self):
        store = sieve.SessionStore(self.tmp)
        store.save("s9", {"session_id": "s9", "status": "running", "instruction": "x"})
        transport = FakeTransport([resp(self.done_run())])
        client, _ = make_client(transport)
        outcome = sieve.stage_run(client, store, instruction="x", out_root=self.tmp, resume="s9")
        self.assertEqual([c["method"] for c in transport.calls], ["GET"])
        self.assertEqual(outcome["session_id"], "s9")

    def test_refused_run_writes_no_result(self):
        store = sieve.SessionStore(self.tmp)
        transport = FakeTransport([
            resp({"status": "queued", "session_id": "s1"}, 202),
            resp({"status": "refused", "refusal": {"code": "quota"}}),
        ])
        client, _ = make_client(transport)
        outcome = sieve.stage_run(client, store, instruction="x", out_root=self.tmp)
        self.assertEqual(outcome["status"], "refused")
        self.assertEqual(outcome["refusal"]["code"], "quota")
        self.assertEqual(store.load("s1")["status"], "refused")
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "s1", "summary.json")))

    def test_fail_conformance_is_never_written_as_clean_data(self):
        store = sieve.SessionStore(self.tmp)
        transport = FakeTransport([
            resp({"status": "queued", "session_id": "s1"}, 202),
            resp({"status": "done", "result": {"rows": []},
                  "schema_conformance": {"status": "fail", "summary": "missing"}}),
        ])
        client, _ = make_client(transport)
        outcome = sieve.stage_run(client, store, instruction="x", out_root=self.tmp)
        self.assertIsNotNone(outcome["warning"])
        self.assertTrue(os.path.exists(os.path.join(self.tmp, "s1", "result.unverified.json")))
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "s1", "result.json")))


class SecretTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="sieve-test-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_write_env_secret_updates_in_place_without_clobbering_other_lines(self):
        path = os.path.join(self.tmp, ".env")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("OTHER=keep\nSIEVE_API_KEY=old\n")
        sieve.write_env_secret(path, "SIEVE_API_KEY", "new-key")
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("OTHER=keep", text)
        self.assertIn("SIEVE_API_KEY=new-key", text)
        self.assertNotIn("old", text)

    def test_write_env_secret_appends_when_absent(self):
        path = os.path.join(self.tmp, ".env")
        sieve.write_env_secret(path, "SIEVE_API_KEY", "abc")
        self.assertEqual(sieve.load_env_file(path)["SIEVE_API_KEY"], "abc")

    def test_client_from_env_prefers_the_real_environment_over_the_file(self):
        path = os.path.join(self.tmp, ".env")
        sieve.write_env_secret(path, "SIEVE_API_KEY", "from-file")
        original = os.environ.pop("SIEVE_API_KEY", None)
        try:
            client = sieve.client_from_env(path, base_url=BASE, transport=FakeTransport([]))
            self.assertEqual(client.api_key, "from-file")
            os.environ["SIEVE_API_KEY"] = "from-env"
            client = sieve.client_from_env(path, base_url=BASE, transport=FakeTransport([]))
            self.assertEqual(client.api_key, "from-env")
        finally:
            os.environ.pop("SIEVE_API_KEY", None)
            if original is not None:
                os.environ["SIEVE_API_KEY"] = original


class DeviceLoginTests(unittest.TestCase):
    CODE = {"user_code": "WDJB-MJHT", "device_code": "dc-1", "interval": 5, "expires_in": 600,
            "verification_uri": "https://scrape.test/device",
            "verification_uri_complete": "https://scrape.test/device?code=WDJB-MJHT"}

    def test_pending_and_slow_down_are_handled_and_the_key_is_never_printed(self):
        transport = FakeTransport([
            resp(self.CODE),
            resp({"error": "authorization_pending"}, 400),
            resp({"error": "slow_down"}, 400),
            resp({"api_key": "dc_sk_secret", "token_type": "Bearer", "key_name": "laptop"}),
        ])
        lines, sleeps = [], []
        key, name = sieve.device_login("SphereDex staging", base_url=BASE, transport=transport,
                                       sleep=sleeps.append, out=lines.append)
        self.assertEqual(key, "dc_sk_secret")
        self.assertEqual(name, "laptop")
        self.assertEqual(sleeps, [5.0, 10.0])                     # slow_down added 5s
        text = "\n".join(lines)
        self.assertNotIn("dc_sk_secret", text)
        self.assertIn("WDJB-MJHT", text)

    def test_access_denied_stops(self):
        transport = FakeTransport([resp(self.CODE), resp({"error": "access_denied"}, 400)])
        with self.assertRaises(sieve.DeviceLoginDenied):
            sieve.device_login("tool", base_url=BASE, transport=transport,
                               sleep=lambda _s: None, out=lambda _s: None)

    def test_expired_token_restarts_at_step_one(self):
        transport = FakeTransport([
            resp(self.CODE),
            resp({"error": "expired_token"}, 400),
            resp(self.CODE),
            resp({"api_key": "dc_sk_second", "key_name": "k"}),
        ])
        key, _ = sieve.device_login("tool", base_url=BASE, transport=transport,
                                    sleep=lambda _s: None, out=lambda _s: None)
        self.assertEqual(key, "dc_sk_second")
        codes = [c["url"] for c in transport.calls if c["url"].endswith("/api/auth/device/code")]
        self.assertEqual(len(codes), 2)


if __name__ == "__main__":
    unittest.main()
