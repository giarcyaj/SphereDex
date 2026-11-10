"""The 2.4.8 publication runbook must keep the deployed-worker evidence and the store gate.

It must not treat the worker `released` field as fresh proof that both production stores
are on 2.4.8. The banner that ships is the LIVE IN THE APP file.
"""

import hashlib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUNBOOK = ROOT / "docs" / "release-2.4.8-publication.md"

HIGHLIGHTS = (
    "Print your collection, share wants and spares, and track cards out for grading",
    "Closest winning decks, built decks that hold their copies, and a place for each card",
    "A Daily Pal guess, a wishlist budget, and live and sold value on every set",
)
LIVE_SHA = "997f7832c868e7eb8c0dfc65fec78425015ff1d0a7eb0e4b5fd598af0becf332"
PREVIEW_SHA = "c6a1578beb7a01599692f2f2fd21cf3c2b388c76eaeca3d9c139d75a4f0ceb7f"
SHIPPED = (
    ROOT / "docs" / "app" / "img" / "UPDATE_2_4_8.webp",
    ROOT / "app" / "src" / "main" / "assets" / "img" / "UPDATE_2_4_8.webp",
    ROOT / "ios" / "SphereDex" / "SphereDex" / "Resources" / "img" / "UPDATE_2_4_8.webp",
)


class Release248PublicationRunbook(unittest.TestCase):
    def setUp(self):
        self.text = RUNBOOK.read_text(encoding="utf-8")

    def test_cites_deployed_snapshot_not_a_git_commit(self):
        self.assertIn("64a3d01c19dfd8c166a4f0b971813d3fda2e395b81dc650c39c431d088cb9d25", self.text)
        self.assertIn("8a7e9d9ebc3a4dd6baddfa57061d932e", self.text)
        for span in ("9373–9377", "9387–9389", "11223–11229", "11271–11286", "11287–11288",
                     "7512–7518", "7457–7501", "11549–11551", "11481–11485", "7527–7535"):
            self.assertIn(span, self.text, span)
        self.assertIn("not a GitHub tree", self.text)
        self.assertIn("not proof the trigger is installed", self.text)

    def test_push_uses_bundled_first_note_and_ignores_env_overrides(self):
        self.assertIn("RELEASE_NOTES[now]", self.text)
        self.assertIn("does not read `APP_LATEST_NOTES` or `APP_LATEST_ART`", self.text)
        self.assertIn("only the first note", self.text)
        self.assertIn("Your collection value beneath every set", self.text)

    def test_released_is_not_both_store_proof(self):
        self.assertIn(
            "`released` is not, by itself, proof that both production stores are freshly verified on 2.4.8.",
            self.text)
        self.assertIn("If one side is missing it returns the other side.", self.text)
        self.assertIn("A lower fetched version does not replace a higher stored version", self.text)
        self.assertIn("current production App Store listing and the current production Play listing", self.text)
        self.assertNotIn("released alone proves", self.text)

    def test_shipped_banner_is_the_live_file(self):
        self.assertIn("LIVE IN THE APP", self.text)
        self.assertIn("UPDATE PREVIEW", self.text)
        self.assertIn(LIVE_SHA, self.text)
        self.assertIn(PREVIEW_SHA, self.text)
        self.assertIn("https://spheredex.app/app/img/UPDATE_2_4_8.webp", self.text)
        self.assertIn('`RELEASE_ART["2.4.8"]` is `img/UPDATE_2_4_8.webp`', self.text)
        self.assertNotIn("Do not publish the preview file as the live banner.", self.text)
        self.assertNotIn("release-notes/held/UPDATE_2_4_8.webp", self.text)
        self.assertFalse((ROOT / "release-notes" / "held" / "UPDATE_2_4_8.webp").exists())
        digests = []
        for path in SHIPPED:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            digests.append(digest)
            self.assertEqual(digest, LIVE_SHA, str(path))
            self.assertNotEqual(digest, PREVIEW_SHA, str(path))
        self.assertEqual(len(set(digests)), 1)

    def test_notes_fix_is_the_three_app_lines_and_is_not_applied_here(self):
        for line in HIGHLIGHTS:
            self.assertIn(line, self.text)
        self.assertIn("not in this repository", self.text)
        self.assertIn("Nothing below has been deployed.", self.text)
        self.assertIn('Do not add a second `2.4.8` key.', self.text)
        self.assertIn("Do not change the `2.4.7` art or notes.", self.text)
        self.assertIn("Do not edit cron", self.text)


if __name__ == "__main__":
    unittest.main()
