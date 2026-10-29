"""Tests for tools/make_kofi_card.py.

These cover the parts that decide whether a card is right without anyone looking at it: the bullets
really come from the app's release notes, the copy obeys the no dashes rule, and a long bullet is
shrunk rather than allowed to run off the canvas.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import make_kofi_card as k  # noqa: E402

APP = open(k.APP, encoding="utf-8").read()


def headliner(src):
    """Lines for this build, or the newest earlier release when a train bump has none."""
    described = k.described_version(src)
    return described, k.highlights(src, described)


class Highlights(unittest.TestCase):
    def test_this_build_has_them(self):
        version = k.app_version(APP)
        described, lines = headliner(APP)
        self.assertTrue(lines, "no release highlights at or before this build")
        self.assertLessEqual(len(lines), 5)
        self.assertLessEqual(k.ver_num(described), k.ver_num(version))

    def test_a_train_bump_keeps_the_newest_earlier_release(self):
        src = (
            'var APP_VERSION = "2.4.7";\n'
            'var RELEASE_HIGHLIGHTS = {"2.4": ["old"], "2.4.5": ["a"], "2.4.6": ["b", "c"]};'
        )
        self.assertEqual(k.described_version(src), "2.4.6")
        self.assertEqual(k.highlights(src, k.described_version(src)), ["b", "c"])

    def test_js_escapes_are_decoded(self):
        # The app writes its separator as ·, which must reach the card as the character itself.
        _described, lines = headliner(APP)
        joined = " ".join(lines)
        self.assertNotIn("\\u", joined)

    def test_unknown_version_says_so(self):
        with self.assertRaises(SystemExit) as e:
            k.highlights(APP, "0.0.1")
        self.assertIn("--bullet", str(e.exception))


class Fitting(unittest.TestCase):
    def test_short_bullets_use_the_full_size(self):
        self.assertEqual(k.bullet_px(["Trades", "Decks"]), k.BULLET_PX_MAX)

    def test_a_long_bullet_shrinks(self):
        self.assertLess(k.bullet_px(["x" * 120]), k.BULLET_PX_MAX)

    def test_never_below_the_floor(self):
        self.assertGreaterEqual(k.bullet_px(["x" * 4000]), k.BULLET_PX_MIN)

    def test_the_real_bullets_fit_on_one_line(self):
        _described, lines = headliner(APP)
        px = k.bullet_px(lines)
        widest = max(len(b) for b in lines) * k.CHAR_RATIO * px
        self.assertLessEqual(widest, k.BULLET_ROOM)


class Copy(unittest.TestCase):
    def build(self, bullets, version="9.9.9"):
        html = open(k.TEMPLATE, encoding="utf-8").read()
        return (html.replace("__BULLET_PX__", str(k.bullet_px(bullets)))
                    .replace("__ROWS__", k.rows_html(bullets))
                    .replace("__VERSION__", version))

    def test_the_template_itself_is_clean(self):
        seen = k.visible_text(self.build(["Trades and decks"]))
        for bad in k.DASHES:
            self.assertNotIn(bad, seen, "a dash is baked into the template: %r" % bad)

    def test_a_dash_in_a_bullet_is_visible_to_the_check(self):
        seen = k.visible_text(self.build(["Trades and decks — all of it"]))
        self.assertTrue(any(d in seen for d in k.DASHES),
                        "the dash check cannot see bullet copy")

    def test_this_build_passes_the_check(self):
        described, lines = headliner(APP)
        seen = k.visible_text(self.build(lines, described))
        for bad in k.DASHES:
            self.assertNotIn(bad, seen, "a dash reached the card copy: %r" % bad)
        self.assertIn(described, seen)

    def test_markup_in_a_bullet_is_escaped(self):
        rows = k.rows_html(["Trades <b> & decks"])
        self.assertIn("&lt;b&gt; &amp; decks", rows)

    def test_every_bullet_gets_a_row_and_a_colour(self):
        rows = k.rows_html(["one", "two", "three", "four", "five", "six"])
        self.assertEqual(rows.count('class="row"'), 6)
        # Six bullets with five colours means the sixth wraps to the first.
        self.assertEqual(rows.count("var(--cyan)"), 2)


if __name__ == "__main__":
    unittest.main()
