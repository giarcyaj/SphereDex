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


if __name__ == "__main__":
    unittest.main()
