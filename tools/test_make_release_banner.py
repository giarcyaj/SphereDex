"""The release banner generator takes a version and its highlights, draws the five-row layout,
and refuses copy that would ship a dash or a missing glyph. Rendering needs Noto Sans CJK on the
machine; the source checks run without it."""

import contextlib
import hashlib
import io
import tempfile
import unittest
from pathlib import Path

try:
    import make_release_banner as banner
except ImportError as exc:  # Pillow is not part of the stdlib CI image
    banner = None
    _IMPORT_ERROR = exc
else:
    _IMPORT_ERROR = None

ROOT = Path(__file__).resolve().parent.parent
SOURCE = Path(__file__).resolve().parent / "make_release_banner.py"

ROWS = [
    "Print your collection|With prices, or without",
    "Find your cards|Grouped by where you keep them",
    "Share wants and spares|Prices only if you choose",
    "Closest winning decks|Built decks hold their copies",
    "Track grading|Log the grade when it returns",
]
HIGHLIGHTS = [
    "Print your whole collection",
    "Share wants and spares",
    "Find your closest winning decks",
]


LIVE_SHA = "997f7832c868e7eb8c0dfc65fec78425015ff1d0a7eb0e4b5fd598af0becf332"
PREVIEW_SHA = "c6a1578beb7a01599692f2f2fd21cf3c2b388c76eaeca3d9c139d75a4f0ceb7f"
SHIPPED = (
    ROOT / "docs" / "app" / "img" / "UPDATE_2_4_8.webp",
    ROOT / "app" / "src" / "main" / "assets" / "img" / "UPDATE_2_4_8.webp",
    ROOT / "ios" / "SphereDex" / "SphereDex" / "Resources" / "img" / "UPDATE_2_4_8.webp",
)


def argv_for(caption, webp, png):
    args = ["2.4.8", *HIGHLIGHTS]
    for row in ROWS:
        args.extend(["--row", row])
    args.extend(["--caption", caption, "--out-webp", str(webp), "--out-png", str(png)])
    return args


@unittest.skipIf(banner is None, "banner generator import failed: %s" % _IMPORT_ERROR)
class BannerSourceTests(unittest.TestCase):
    def test_generator_uses_app_fonts_and_noto_instead_of_yu_gothic(self):
        text = SOURCE.read_text(encoding="utf-8")
        self.assertNotIn("YuGoth", text)
        self.assertNotIn("Windows/Fonts", text)
        self.assertIn('chakra-petch-%d.woff2', text)
        self.assertIn("for weight in (500, 600, 700)", text)
        self.assertIn("NotoSansCJK", text)
        self.assertIn("CARDS © POCKETPAIR / BUSHIROAD", text)

    def test_highlights_and_rows_are_required(self):
        with self.assertRaises(SystemExit):
            with contextlib.redirect_stderr(io.StringIO()):
                banner.parse_args(["2.4.8", "Only one"])
        with self.assertRaises(SystemExit):
            with contextlib.redirect_stderr(io.StringIO()):
                banner.parse_args(["2.4.8", *HIGHLIGHTS, "--row", "Title|Subtitle"])

    def test_a_dash_in_copy_is_refused(self):
        args = ["2.4.8", "Print your whole collection", "Share wants and spares", "Built-in decks"]
        for row in ROWS:
            args.extend(["--row", row])
        with self.assertRaises(SystemExit):
            with contextlib.redirect_stderr(io.StringIO()):
                banner.parse_args(args)

    def test_release_art_points_at_the_new_banner(self):
        source = (ROOT / "src" / "paldeck.html").read_text(encoding="utf-8")
        self.assertIn('"2.4.8": "img/UPDATE_2_4_8.webp"', source)
        # The three lines already written for 2.4.8 stay the app's highlights.
        self.assertIn("Print your collection, share wants and spares, and track cards out for grading", source)
        self.assertEqual(source.count('"2.4.8": ['), 1)
        self.assertEqual(source.count('var APP_VERSION = "2.4.9"'), 1)


class ShippedBannerTests(unittest.TestCase):
    def test_shipped_copies_are_the_live_banner(self):
        digests = []
        for path in SHIPPED:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            digests.append(digest)
            self.assertEqual(digest, LIVE_SHA, str(path))
            self.assertNotEqual(digest, PREVIEW_SHA, str(path))
        self.assertEqual(len(set(digests)), 1)
        self.assertFalse((ROOT / "release-notes" / "held" / "UPDATE_2_4_8.webp").exists())


@unittest.skipIf(banner is None, "banner generator import failed: %s" % _IMPORT_ERROR)
class BannerRenderTests(unittest.TestCase):
    def setUp(self):
        try:
            from PIL import Image
        except ImportError as exc:
            self.skipTest("Pillow is not installed: %s" % exc)
        self.Image = Image
        try:
            self.faces = banner.load_faces()
        except SystemExit as exc:
            self.skipTest(str(exc))

    def test_review_and_held_are_1600x900_and_differ_only_by_caption(self):
        notes = banner.prove_fallback(self.faces)
        self.assertTrue(any(note.startswith("fallback ok") for note in notes), notes)
        self.assertTrue(any("© draws" in note for note in notes), notes)
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            review_webp = directory / "review.webp"
            review_png = directory / "review.png"
            held_webp = directory / "held.webp"
            held_png = directory / "held.png"
            review = banner.main(argv_for("UPDATE PREVIEW", review_webp, review_png))
            held = banner.main(argv_for("LIVE IN THE APP", held_webp, held_png) + ["--held"])
            self.assertEqual(review["caption"], "UPDATE PREVIEW")
            self.assertEqual(held["caption"], "LIVE IN THE APP")
            review_image = self.Image.open(review_png)
            held_image = self.Image.open(held_png)
            with self.Image.open(review_webp) as opened:
                self.assertEqual(opened.size, (1600, 900))
            self.assertEqual(review_image.size, (1600, 900))
            self.assertEqual(held_image.size, (1600, 900))
            # PNG is lossless, so the launch file matches the review file everywhere except the caption.
            review_rgb = review_image.convert("RGB")
            held_rgb = held_image.convert("RGB")
            diff = 0
            for y in list(range(0, 740)) + list(range(780, 900)):
                for x in range(0, 1600, 2):
                    if review_rgb.getpixel((x, y)) != held_rgb.getpixel((x, y)):
                        diff += 1
                        if diff > 5:
                            break
                if diff > 5:
                    break
            self.assertEqual(diff, 0, "review and held banners diverged outside the caption band")
            caption_diff = False
            for y in range(745, 775):
                for x in range(1100, 1520, 4):
                    if review_rgb.getpixel((x, y)) != held_rgb.getpixel((x, y)):
                        caption_diff = True
                        break
                if caption_diff:
                    break
            self.assertTrue(caption_diff, "the held caption did not change the caption band")


if __name__ == "__main__":
    unittest.main()
