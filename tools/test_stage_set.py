"""stage_set.py keeps cards the official list omits. No network."""
import unittest

import stage_set as S


def card(number, name="From the list"):
    return {"card_number": number, "card_name": name}


class MergeOmittedTests(unittest.TestCase):
    def test_ebp02_keeps_the_gold_soul_the_list_leaves_out(self):
        staged = S.merge_omitted("EBP02", [card("EBP02-001"), card("EBP02-100")])
        numbers = [c["card_number"] for c in staged]
        self.assertEqual(numbers, ["EBP02-001", "EBP02-100", "ESOUL-011"])
        soul = staged[-1]
        self.assertEqual(soul["card_name"], "Soul")
        self.assertEqual(soul["card_kind"], "Soul")
        self.assertEqual(soul["rare"], "SSS")
        self.assertEqual(soul["picture"], "EBP02/ESOUL-011.png")
        self.assertEqual(S.to_row(soul, "EBP02"), [
            "ESOUL-011", "Soul", "Soul", "", "SSS", "", "", "", "", "", "",
            "EBP02/ESOUL-011.png", "EBP02",
        ])

    def test_a_list_that_starts_returning_the_card_is_not_duplicated(self):
        official = card("ESOUL-011", "Soul")
        official["rare"] = "SSS"
        staged = S.merge_omitted("EBP02", [card("EBP02-001"), official])
        self.assertEqual([c["card_number"] for c in staged], ["EBP02-001", "ESOUL-011"])
        self.assertIs(staged[-1], official)

    def test_other_sets_are_left_alone(self):
        rows = [card("EBP01-001")]
        self.assertEqual(S.merge_omitted("EBP01", rows), rows)

    def test_the_note_says_the_card_was_added_by_hand(self):
        self.assertIn("added by hand", S.OMITTED_NOTE.lower())
        self.assertIn("official list omits", S.OMITTED_NOTE.lower())


class CompletenessTests(unittest.TestCase):
    def test_a_fetch_short_by_the_kept_rows_stays_incomplete(self):
        # 163 official rows, upstream total 164. Appending ESOUL-011 makes the staged
        # length equal the total. Completeness must still report 163 of 164.
        official = [card("EBP02-%03d" % i) for i in range(1, 164)]
        self.assertEqual(len(official), 163)
        staged = S.merge_omitted("EBP02", official)
        self.assertEqual(len(staged), 164)
        complete = S.fetch_is_complete(len(official), 164)
        self.assertFalse(complete)
        line = S.cards_of_total_line(len(official), 164, complete)
        warning = S.incomplete_warning(len(official), 164)
        self.assertIn("**163** of upstream total **164**", line)
        self.assertIn("complete: **False**", line)
        self.assertEqual(
            warning,
            "- !! INCOMPLETE: fetched 163 of upstream total 164. Re-run before shipping.",
        )
        self.assertNotIn("**164** of upstream total **164**", line)
        self.assertNotIn("fetched 164 of upstream total 164", warning)

    def test_a_full_official_fetch_stays_complete_when_the_soul_is_extra(self):
        official = [card("EBP02-%03d" % i) for i in range(1, 165)]
        self.assertEqual(len(official), 164)
        self.assertEqual(len(S.merge_omitted("EBP02", official)), 165)
        self.assertTrue(S.fetch_is_complete(len(official), 164))
        line = S.cards_of_total_line(164, 164, True)
        self.assertIn("**164** of upstream total **164**", line)
        self.assertIn("complete: **True**", line)

    def test_a_limited_sample_is_not_a_complete_fetch(self):
        self.assertFalse(S.fetch_is_complete(164, 164, limited=True))
        self.assertFalse(S.fetch_is_complete(10, None))


if __name__ == "__main__":
    unittest.main()
