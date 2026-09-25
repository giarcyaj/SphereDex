"""Regression checks for rebuilding dirty worktrees without losing injected assets."""
import contextlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import rebuild


def canonical(version, extra=""):
    return ("<title>" + version + "</title><style>" + rebuild.FM +
            "body{color:" + version + "}</style>" + rebuild.CM +
            '<script>var APP_VERSION="' + version + '";</script>' + extra)


def legacy(source, wrapper):
    a, b, c = rebuild.split_canonical(source)
    prefix, font, card, suffix = wrapper
    return prefix + a + font + b + card + c + suffix


class RebuildTests(unittest.TestCase):
    def setUp(self):
        self.wrapper = ("<!doctype html><html><head>", "@font-face{src:url(font)}",
                        '<script>window.CARD_IMG={"one":"img/one.jpg"};</script>',
                        "</head></html>")

    def test_repeated_source_changes_preserve_current_assets_and_wrappers(self):
        old = legacy(canonical("old"), self.wrapper)
        parts = rebuild.extract_wrapper(old, [canonical("old")])
        first = rebuild.build(canonical("first"), *parts)
        # A newly added card-art entry and font changes must survive the next rebuild too.
        first = first.replace("img/one.jpg", "img/new.jpg").replace("url(font)", "url(newfont)")
        parts = rebuild.extract_wrapper(first, [])
        second = rebuild.build(canonical("second"), *parts)
        expected = (self.wrapper[0], self.wrapper[1].replace("font)", "newfont)"),
                    self.wrapper[2].replace("one.jpg", "new.jpg"), self.wrapper[3])
        self.assertEqual(rebuild.extract_wrapper(second, []), expected)
        self.assertEqual(rebuild.build(canonical("second"), *expected), second)
        self.assertNotIn("first", second)

    def test_bad_boundaries_fail_even_with_a_baseline(self):
        good = rebuild.build(canonical("old"), *self.wrapper)
        for bad in (good.replace(rebuild.BUILD_MARKERS[1], ""),
                    good + rebuild.BUILD_MARKERS[0],
                    good.replace(rebuild.BUILD_MARKERS[1], "TEMP_BOUNDARY")
                        .replace(rebuild.BUILD_MARKERS[2], rebuild.BUILD_MARKERS[1])
                        .replace("TEMP_BOUNDARY", rebuild.BUILD_MARKERS[2])):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                rebuild.extract_wrapper(bad, [canonical("old")])

    def test_unknown_legacy_source_requires_baseline(self):
        old = legacy(canonical("old"), self.wrapper)
        with self.assertRaisesRegex(ValueError, "--baseline"):
            rebuild.extract_wrapper(old, [canonical("new")])
        self.assertEqual(rebuild.extract_wrapper(old, [canonical("old")]), self.wrapper)

    def test_removing_legacy_registration_keeps_other_wrapper_scripts(self):
        suffix = "<script>platformBridge();</script><script>navigator.serviceWorker.register('sw.js');</script></html>"
        self.assertEqual(rebuild.SW_REG_RE.sub("", suffix), "<script>platformBridge();</script></html>")

    def test_build_preflights_every_platform_before_writing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.html"
            source.write_text(canonical("new"), encoding="utf-8")
            baseline = root / "baseline.html"
            baseline.write_text(canonical("old"), encoding="utf-8")
            web = root / rebuild.WEB_HTML
            android = root / rebuild.ANDROID_HTML
            web.parent.mkdir(parents=True)
            android.parent.mkdir(parents=True)
            before = legacy(canonical("old"), self.wrapper)
            web.write_text(before, encoding="utf-8")
            android.write_text("unknown previous build", encoding="utf-8")
            with patch.object(rebuild, "REPO", tmp), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    rebuild.main(["--src", str(source), "--baseline", str(baseline)])
            self.assertEqual(web.read_text(encoding="utf-8"), before)
            self.assertEqual(android.read_text(encoding="utf-8"), "unknown previous build")

    PALDEX = '<section class="page" id="page-paldex"></section>'

    def prepare(self, root, source, images=("one.jpg",)):
        """Write a matching source + legacy bundles, plus the web img files the wrapper references."""
        source_path = root / "src/paldeck.html"
        source_path.parent.mkdir(parents=True, exist_ok=True)
        source_path.write_text(source, encoding="utf-8")
        built = legacy(source, self.wrapper)
        pages = {}
        for rel in (rebuild.WEB_HTML, rebuild.ANDROID_HTML, rebuild.IOS_HTML):
            target = root / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(built, encoding="utf-8")
            pages[rel] = built
        img = root / rebuild.WEB_IMG
        img.mkdir(parents=True, exist_ok=True)
        for name in images:
            (img / name).write_bytes(b"test image")
        return pages

    def run_main(self, tmp, out=None, err=None):
        """Run the real entry point hermetically (no Git) and hand back both streams."""
        out = out if out is not None else io.StringIO()
        err = err if err is not None else io.StringIO()
        with patch.object(rebuild, "REPO", tmp), \
             patch.object(rebuild.subprocess, "run", side_effect=OSError), \
             contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rebuild.main([])
        return out.getvalue(), err.getvalue()

    def test_missing_artwork_fails_before_anything_is_written(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pages = self.prepare(root, canonical("old"))
            app_img = root / rebuild.APP_IMG[0][1]
            app_img.mkdir(parents=True)
            (app_img / "one.jpg").write_bytes(b"test image")     # what the last build mirrored
            (root / rebuild.WEB_IMG / "one.jpg").unlink()        # …and the source has since lost it
            err = io.StringIO()
            with self.assertRaises(SystemExit):
                self.run_main(tmp, err=err)
            self.assertIn("img/one.jpg", err.getvalue())
            self.assertIn(rebuild.WEB_IMG, err.getvalue())
            for rel in (rebuild.WEB_HTML, rebuild.ANDROID_HTML, rebuild.IOS_HTML):
                self.assertEqual((root / rel).read_text(encoding="utf-8"), pages[rel])
            # Nothing was mirrored, so the app folder still holds the copy the failed build could not confirm.
            self.assertTrue((app_img / "one.jpg").is_file())

    def test_paldex_without_a_readable_pal_art_map_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.prepare(root, canonical("old", self.PALDEX))
            err = io.StringIO()
            with self.assertRaises(SystemExit):
                self.run_main(tmp, err=err)
            self.assertIn("PAL_ART", err.getvalue())

    def test_missing_pal_art_fails_then_mirrors_once_the_render_exists(self):
        art = '<script>var PAL_ART={"Lamball":"PAL_Lamball.webp"};</script>'
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.prepare(root, canonical("old", self.PALDEX + art))   # the render itself is not there yet
            err = io.StringIO()
            with self.assertRaises(SystemExit):
                self.run_main(tmp, err=err)
            self.assertIn("PAL_Lamball.webp", err.getvalue())
            (root / rebuild.WEB_IMG / "PAL_Lamball.webp").write_bytes(b"test render")
            self.run_main(tmp)
            for _, rel in rebuild.APP_IMG:
                self.assertEqual((root / rel / "PAL_Lamball.webp").read_bytes(), b"test render")

    def test_artwork_is_verified_in_the_app_folders_after_mirroring(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pages = self.prepare(root, canonical("old"))
            with patch.object(rebuild, "REPO", tmp), \
                 patch.object(rebuild.subprocess, "run", side_effect=OSError), \
                 patch.object(rebuild, "mirror", lambda src, dst: (1, 0, 0, 0)), \
                 contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                # A SystemExit the caller catches is never printed by the interpreter, so the payload itself
                # has to name what went wrong.
                with self.assertRaises(SystemExit) as exit_error:
                    rebuild.main([])
            message = str(exit_error.exception)
            self.assertIn("FAILED after writing", message)
            for _, rel in rebuild.APP_IMG:
                self.assertIn(rel, message)
            # The pages were written first, so the failure has to say so rather than pretend otherwise.
            self.assertNotEqual((root / rebuild.WEB_HTML).read_text(encoding="utf-8"),
                                pages[rebuild.WEB_HTML])

    def test_two_full_builds_need_no_git_and_sync_the_platforms(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "src/paldeck.html"
            source.parent.mkdir(parents=True)
            source.write_text(canonical("old"), encoding="utf-8")
            for rel in (rebuild.WEB_HTML, rebuild.ANDROID_HTML, rebuild.IOS_HTML):
                target = root / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(legacy(canonical("old"), self.wrapper), encoding="utf-8")
            images = root / rebuild.WEB_IMG
            images.mkdir()
            (images / "one.jpg").write_bytes(b"test image")
            sw = root / "docs/app/sw.js"
            sw.write_text("const BUILD = 'old';", encoding="utf-8")
            with patch.object(rebuild, "REPO", tmp), contextlib.redirect_stdout(io.StringIO()):
                # This first migration can match the source on disk, even without a Git executable.
                with patch.object(rebuild.subprocess, "run", side_effect=OSError):
                    rebuild.main([])
                first_stamp = sw.read_text(encoding="utf-8")
                source.write_text(canonical("new"), encoding="utf-8")
                with patch.object(rebuild.subprocess, "run", side_effect=AssertionError("Git called")):
                    rebuild.main([])
            self.assertNotEqual(first_stamp, sw.read_text(encoding="utf-8"))
            for rel in (rebuild.WEB_HTML, rebuild.ANDROID_HTML, rebuild.IOS_HTML):
                self.assertEqual((root / rel).read_text(encoding="utf-8"),
                                 rebuild.build(canonical("new"), *self.wrapper))
            for _, rel in rebuild.APP_IMG:
                self.assertEqual((root / rel / "one.jpg").read_bytes(), b"test image")


if __name__ == "__main__":
    unittest.main()
