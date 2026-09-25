# -*- coding: utf-8 -*-
"""Tests for the sieve CLI's secret handling. Run with: python tools/test_sieve_run.py

The migration off a local .env rests on two facts that are easy to get wrong and hard
to see: which of the two sources actually answered, and whether the key ever leaks into
output. Both are asserted here. Nothing in this file touches the network, and every
assertion is made against a throwaway key - never a real one.
"""
import argparse
import contextlib
import io
import os
import shutil
import tempfile
import unittest

import sieve
import sieve_run


class KeyOriginTests(unittest.TestCase):
    """sieve_run._key_origin: the environment wins, then the dotenv file, then nothing."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="sieve-run-test-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        original = os.environ.pop("SIEVE_API_KEY", None)
        self.addCleanup(self._restore_key, original)

    @staticmethod
    def _restore_key(original):
        os.environ.pop("SIEVE_API_KEY", None)
        if original is not None:
            os.environ["SIEVE_API_KEY"] = original

    def _env_file(self, value):
        path = os.path.join(self.tmp, ".env")
        sieve.write_env_secret(path, "SIEVE_API_KEY", value)
        return path

    def test_a_file_answer_is_reported_as_the_file(self):
        path = self._env_file("throwaway-file-key")
        self.assertEqual(sieve_run._key_origin(path), path)

    def test_the_environment_shadows_the_file(self):
        path = self._env_file("throwaway-file-key")
        os.environ["SIEVE_API_KEY"] = "throwaway-env-key"
        self.assertEqual(sieve_run._key_origin(path), "environment")

    def test_nothing_configured_is_none_rather_than_an_empty_key(self):
        self.assertIsNone(sieve_run._key_origin(os.path.join(self.tmp, ".env")))

    def test_a_missing_env_file_is_not_an_error(self):
        self.assertIsNone(sieve_run._key_origin(os.path.join(self.tmp, "nope", ".env")))


class DoctorTests(unittest.TestCase):
    """sieve_run.cmd_doctor: says where the key came from, never what it is."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="sieve-run-test-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        original = os.environ.pop("SIEVE_API_KEY", None)
        self.addCleanup(KeyOriginTests._restore_key, original)

    def _doctor(self, env_path):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = sieve_run.cmd_doctor(argparse.Namespace(env_file=env_path))
        return code, out.getvalue()

    def test_a_key_from_disk_is_reported_without_the_value_and_asks_for_a_migration(self):
        path = os.path.join(self.tmp, ".env")
        sieve.write_env_secret(path, "SIEVE_API_KEY", "throwaway-file-key")
        code, text = self._doctor(path)
        self.assertEqual(code, 0)
        self.assertIn("still a file on this machine", text)
        self.assertIn("Still reading a file", text)
        self.assertNotIn("throwaway-file-key", text)

    def test_an_injected_key_is_reported_as_coming_from_the_environment(self):
        os.environ["SIEVE_API_KEY"] = "throwaway-env-key"
        code, text = self._doctor(os.path.join(self.tmp, ".env"))
        self.assertEqual(code, 0)
        self.assertIn("from the environment", text)
        self.assertIn("Good: the key was injected", text)
        self.assertNotIn("throwaway-env-key", text)

    def test_the_length_is_reported_so_a_wrong_key_can_be_spotted(self):
        os.environ["SIEVE_API_KEY"] = "x" * 47
        _code, text = self._doctor(os.path.join(self.tmp, ".env"))
        self.assertIn("(47 chars)", text)

    def test_no_key_at_all_is_non_zero_so_it_can_gate_a_script(self):
        code, text = self._doctor(os.path.join(self.tmp, ".env"))
        self.assertEqual(code, 1)
        self.assertIn("missing", text)


class FallbackWarningTests(unittest.TestCase):
    """sieve_run._client: a dotenv answer still works, but says so on stderr."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="sieve-run-test-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        original = os.environ.pop("SIEVE_API_KEY", None)
        self.addCleanup(KeyOriginTests._restore_key, original)

    def _build(self, env_path):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            client = sieve_run._client(argparse.Namespace(env_file=env_path))
        return client, err.getvalue()

    def test_reading_a_local_file_still_works_but_warns(self):
        path = os.path.join(self.tmp, ".env")
        sieve.write_env_secret(path, "SIEVE_API_KEY", "throwaway-file-key")
        client, err = self._build(path)
        self.assertTrue(client.configured)
        self.assertIn("not the environment", err)
        self.assertIn("infisical run", err)
        self.assertNotIn("throwaway-file-key", err)

    def test_an_injected_key_is_silent(self):
        os.environ["SIEVE_API_KEY"] = "throwaway-env-key"
        client, err = self._build(os.path.join(self.tmp, ".env"))
        self.assertTrue(client.configured)
        self.assertEqual(err, "")


if __name__ == "__main__":
    unittest.main()
