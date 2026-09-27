"""Tests for the release sweep (official announcements -> app release data)."""
import datetime as dt
import importlib.util
import json
import unittest

import release_sweep as rs

HAVE_IMAGING = bool(importlib.util.find_spec("numpy") and importlib.util.find_spec("PIL"))
TODAY = dt.date(2026, 9, 27)


class ParseTests(unittest.TestCase):
    def test_title_gives_product_type_and_set(self):
        self.assertEqual(rs.parse_title('Booster Pack "Eternal Ascent" Preorders Now Available!'),
                         ("Booster Pack", "Eternal Ascent"))
        self.assertEqual(rs.parse_title("Trial Deck &#8220;Eternal Ascent Red·Green&#8221; revealed"),
                         ("Trial Deck", "Eternal Ascent Red·Green"))
        self.assertEqual(rs.parse_title("Sleeve & Card Set “Vol. 2” announced")[0], "Sleeve & Card Set")

    def test_non_product_titles_are_ignored(self):
        for title in ("Palworld OFFICIAL CARD GAME officially hits 4.4 million pack sales worldwide!",
                      "Reprint Announcement Updates!", "Shop tournament results"):
            self.assertIsNone(rs.parse_title(title), title)

    def test_code_from_banner_file_name_or_text(self):
        self.assertEqual(rs.find_code("BP03-ordersheet-banner-template.png"), "BP03")
        self.assertEqual(rs.find_code("", "Trial Deck ETD04 details"), "TD04")
        self.assertEqual(rs.find_code("1920x1080-1.png", "no code here"), "")

    def test_release_date_prefers_a_signalled_date(self):
        self.assertEqual(rs.parse_date("PALWORLD\nOFFICIAL CARD GAME\nOn sale January 29, 2027"), "Jan 29, 2027")
        text = "Preorders opened September 11, 2026. Release date: Dec 18, 2026."
        self.assertEqual(rs.parse_date(text), "Dec 18, 2026")
        self.assertEqual(rs.parse_date("Announced Sept 4, 2026"), "Sep 4, 2026")
        self.assertEqual(rs.parse_date("late October"), "")
        self.assertEqual(rs.parse_date("February 30, 2027"), "")

    def test_colours_split_off_the_set_name(self):
        self.assertEqual(rs.split_colours("Eternal Ascent Red·Green"), ("Eternal Ascent", ["Red", "Green"]))
        self.assertEqual(rs.split_colours("Legends Awaken"), ("Legends Awaken", []))


class ProductsTests(unittest.TestCase):
    def test_a_booster_becomes_box_and_pack_like_the_app(self):
        rows = rs.products_for("Booster Pack", "Eternal Ascent", "BP03", "Jan 29, 2027",
                               "https://x.test/post", "REL_BANNER_BP03", TODAY)
        self.assertEqual([r["id"] for r in rows], ["box-bp03", "pack-bp03"])
        self.assertEqual(rows[0]["code"], "BP03")
        self.assertEqual(rows[1]["code"], "", "only the box carries the code, as in the app")
        self.assertTrue(all(r["pre"] and r["set"] == "Eternal Ascent" and r["banner"] == "REL_BANNER_BP03" for r in rows))

    def test_a_trial_deck_keeps_its_colours(self):
        [row] = rs.products_for("Trial Deck", "Eternal Ascent Red·Green", "TD03", "Dec 18, 2026", "https://x.test/p", "", TODAY)
        self.assertEqual(row["id"], "td-td03")
        self.assertEqual(row["name"], "Trial Deck, Red · Green")
        self.assertEqual(row["set"], "Eternal Ascent")

    def test_released_products_are_not_preorders(self):
        [box, _] = rs.products_for("Booster Pack", "Dawn of Palpagos", "BP01", "Jul 30, 2026", "https://x.test/p", "", TODAY)
        self.assertFalse(box["pre"])

    def test_no_code_falls_back_to_a_slug(self):
        [row] = rs.products_for("Card Set", "Vol. 2", "", "", "https://x.test/p", "", TODAY)
        self.assertEqual(row["id"], "vol-2-card-set")


class FakeSieve:
    def __init__(self, date="", code=""):
        self.result, self.calls = (date, code), []

    def release(self, link, set_name):
        self.calls.append(link)
        return self.result


def post(title, link, image="", content=""):
    return {"title": {"rendered": title}, "link": link, "content": {"rendered": content},
            "_embedded": {"wp:featuredmedia": [{"source_url": image}]} if image else {}}


class SweepTests(unittest.TestCase):
    def test_only_new_announcements_are_processed(self):
        posts = [
            post('Booster Pack "Eternal Ascent" Preorders Now Available!', "https://site.test/news/post-10",
                 content="<p>On sale January 29, 2027</p>"),
            post("Reprint Announcement Updates!", "https://site.test/news/post-9"),
            post('Booster Pack "Legends Awaken" Preorders', "https://site.test/news/post-8"),
        ]
        sieve = FakeSieve()
        payload, images = rs.sweep(posts, {"https://site.test/news/post-8": ""}, force=False, sieve=sieve,
                                   get=lambda *a, **k: b"", today=TODAY)
        self.assertEqual(sieve.calls, ["https://site.test/news/post-10"], "seen posts cost no Sieve run")
        self.assertEqual([p["id"] for p in payload["products"]], ["box-eternal-ascent", "pack-eternal-ascent"])
        self.assertEqual(payload["products"][0]["date"], "Jan 29, 2027", "post text is the last fallback")
        self.assertEqual(payload["sets"], {"Eternal Ascent": {"logo": "", "release": "Jan 29, 2027"}})
        self.assertIn("https://site.test/news/post-10", payload["posts"])
        self.assertEqual(images, {})

    def test_sieve_date_and_code_win(self):
        posts = [post('Booster Pack "Eternal Ascent" Preorders', "https://site.test/news/p", content="Coming soon")]
        payload, _ = rs.sweep(posts, {}, force=False, sieve=FakeSieve("Jan 29, 2027", "BP03"),
                              get=lambda *a, **k: b"", today=TODAY)
        self.assertEqual(payload["products"][0]["id"], "box-bp03")
        self.assertEqual(payload["products"][0]["date"], "Jan 29, 2027")

    def test_force_reprocesses_seen_posts(self):
        posts = [post('Booster Pack "Eternal Ascent" Preorders', "https://site.test/news/p")]
        payload, _ = rs.sweep(posts, {"https://site.test/news/p": ""}, force=True, sieve=FakeSieve(),
                              get=lambda *a, **k: b"", today=TODAY)
        self.assertEqual(len(payload["products"]), 2)


class PublishTests(unittest.TestCase):
    def test_images_upload_first_and_their_paths_go_in_the_payload(self):
        calls = []

        def call(method, path, key, body, base):
            calls.append((method, path))
            if method == "PUT":
                return {"path": path.replace("/admin/", "/") + "?v=abc123"}
            self.assertEqual(body["img"], {"REL_LOGO_BP03": "/api/release-img/REL_LOGO_BP03?v=abc123"})
            return {"products": 2, "sets": 1}

        res = rs.publish({"products": [], "sets": {}, "posts": {}}, {"REL_LOGO_BP03": b"webp"}, "k", "https://b.test", call)
        self.assertEqual(calls, [("PUT", "/api/admin/release-img/REL_LOGO_BP03"), ("POST", "/api/admin/releases")])
        self.assertEqual(res["sets"], 1)


class MainTests(unittest.TestCase):
    def test_missing_admin_key_skips_cleanly(self):
        import os
        import tempfile
        from pathlib import Path
        from unittest import mock
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("BACKEND_ADMIN_KEY", None)
            gh = Path(tmp) / "gh.txt"
            self.assertEqual(rs.main(["--github-output", str(gh)]), 0)
            self.assertIn("status=skipped", gh.read_text(encoding="utf-8"))


@unittest.skipUnless(HAVE_IMAGING, "numpy and Pillow are needed for the logo cut-out")
class BannerLogoTests(unittest.TestCase):
    def banner(self, key_visual=False):
        from PIL import Image, ImageDraw
        im = Image.new("RGB", (1600, 900), (232, 223, 206))
        d = ImageDraw.Draw(im)
        if key_visual:
            for x in range(0, 1600, 40):
                d.rectangle([x, 0, x + 20, 900], fill=(30 + x % 200, 80, 160))
            return im
        d.rectangle([600, 60, 1000, 140], fill=(40, 30, 20))          # header
        d.line([200, 300, 1400, 300], fill=(60, 50, 40), width=3)     # divider
        d.ellipse([450, 380, 1150, 700], fill=(20, 40, 110), outline=(200, 150, 60), width=14)   # logo
        d.rectangle([520, 760, 1080, 800], fill=(30, 30, 30))         # date line
        return im

    def test_template_banner_yields_a_transparent_logo(self):
        import banner_logo
        logo = banner_logo.cut_logo(self.banner())
        self.assertIsNotNone(logo)
        self.assertEqual(logo.mode, "RGBA")
        self.assertEqual(logo.width, banner_logo.LOGO_WIDTH)
        ratio = logo.width / logo.height
        self.assertAlmostEqual(ratio, 700 / 320, delta=0.35, msg="the logo block, not the header or date line")
        self.assertEqual(logo.getpixel((2, 2))[3], 0, "corners are transparent")

    def test_key_visual_banner_yields_no_logo(self):
        import banner_logo
        self.assertIsNone(banner_logo.cut_logo(self.banner(key_visual=True)))


if __name__ == "__main__":
    unittest.main()
