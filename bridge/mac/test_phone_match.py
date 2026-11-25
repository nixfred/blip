#!/usr/bin/env python3
"""Phone numbers match the way Contacts matches them: the exact last-ten key
first, then libphonenumber's rule — the Mac's region for a card saved without
a country code, equal calling codes, one national number a suffix of the
other. Names (name_for) and photos (_avatar_candidates) follow the one rule."""
from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path

HERE = Path(__file__).parent
JPEG = b"\xff\xd8\xff\xe0" + b"\0" * 32


def load(tool: str):
    loader = SourceFileLoader(f"blip_{tool}", str(HERE / tool))
    spec = spec_from_loader(loader.name, loader)
    assert spec is not None
    mod = module_from_spec(spec)
    sys.modules[loader.name] = mod
    loader.exec_module(mod)
    return mod


class FakeAddressBook:
    """One Contacts source under a temp dir, with the three tables the bridge reads."""

    def __init__(self, root: str, source: str = "SRC-A") -> None:
        folder = os.path.join(root, "Sources", source)
        os.makedirs(folder)
        self.path = os.path.join(folder, "AddressBook-v22.abcddb")
        self.con = sqlite3.connect(self.path)
        self.con.executescript(
            """
            CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT, ZLASTNAME TEXT,
              ZORGANIZATION TEXT, ZNICKNAME TEXT, ZTHUMBNAILIMAGEDATA BLOB, ZIMAGEDATA BLOB);
            CREATE TABLE ZABCDPHONENUMBER (ZOWNER INTEGER, ZFULLNUMBER TEXT);
            CREATE TABLE ZABCDEMAILADDRESS (ZOWNER INTEGER, ZADDRESS TEXT);
            """
        )
        self.next_pk = 1

    def card(self, first: str, last: str, *, phones=(), emails=(), photo: bytes | None = None) -> int:
        pk = self.next_pk
        self.next_pk += 1
        self.con.execute(
            "INSERT INTO ZABCDRECORD (Z_PK, ZFIRSTNAME, ZLASTNAME, ZTHUMBNAILIMAGEDATA) VALUES (?, ?, ?, ?)",
            (pk, first, last, photo),
        )
        for p in phones:
            self.con.execute("INSERT INTO ZABCDPHONENUMBER VALUES (?, ?)", (pk, p))
        for e in emails:
            self.con.execute("INSERT INTO ZABCDEMAILADDRESS VALUES (?, ?)", (pk, e))
        self.con.commit()
        return pk


class Base(unittest.TestCase):
    home = "47"   # the Mac's region as a calling code; None = unknown

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.book = FakeAddressBook(self.tmp.name)
        self.imsg = load("imsg")
        # Point the bridge at the fixture. No Accounts db means "no ranks, no
        # child delegates", the documented fallback; the region is set directly.
        self.imsg._AB_GLOB = os.path.join(self.tmp.name, "Sources", "*", "AddressBook-v22.abcddb")
        self.imsg._ACCOUNTS_DB = os.path.join(self.tmp.name, "no-such-Accounts4.sqlite")
        self.imsg._NAME_INDEX = None
        self.imsg._EXACT_SEEN = set()
        self.imsg._home_calling_code = lambda: self.home

    def tearDown(self) -> None:
        self.book.con.close()
        self.tmp.cleanup()


class CallingCodes(unittest.TestCase):
    def test_table_is_prefix_free_and_splits_unambiguously(self) -> None:
        cc = load("calling_codes.py")
        codes = sorted(cc.CALLING_CODES, key=len)
        self.assertFalse([(a, b) for a in codes for b in codes if a != b and b.startswith(a)])
        self.assertEqual(cc.split_calling_code("4712345678"), ("47", "12345678"))
        self.assertEqual(cc.split_calling_code("14155550100"), ("1", "4155550100"))
        self.assertEqual(cc.split_calling_code("447700900123"), ("44", "7700900123"))
        self.assertEqual(cc.split_calling_code("3546123456"), ("354", "6123456"))   # Iceland: 7-digit national numbers
        self.assertEqual(cc.REGION_TO_CALLING_CODE["NO"], 47)


class RegionDetection(unittest.TestCase):
    def test_region_comes_from_apple_locale(self) -> None:
        imsg = load("imsg")
        for locale, want in (("en_US@rg=nozzzz", "47"), ("nb_NO", "47"), ("en_US", "1"), ("en_GB", "44"), ("", None)):
            self.assertEqual(imsg._calling_code_for_locale(locale), want, locale)

    def test_the_reader_uses_the_prefs_file_and_survives_a_missing_one(self) -> None:
        import plistlib
        imsg = load("imsg")
        with tempfile.TemporaryDirectory() as tmp:
            imsg._GLOBAL_PREFS = os.path.join(tmp, "prefs.plist")
            with open(imsg._GLOBAL_PREFS, "wb") as f:
                plistlib.dump({"AppleLocale": "nb_NO"}, f)
            self.assertEqual(imsg._home_calling_code(), "47")
            imsg._home_calling_code.cache_clear()
            imsg._GLOBAL_PREFS = os.path.join(tmp, "missing.plist")
            self.assertIsNone(imsg._home_calling_code())


class Names(Base):
    def test_a_us_number_in_four_spellings_still_resolves(self) -> None:
        self.book.card("Alex", "Rivera", phones=["+1 (555) 555-0100"])
        for h in ("+15555550100", "5555550100", "(555) 555-0100", "555-555-0100"):
            self.assertEqual(self.imsg.name_for(h), "Alex Rivera", h)

    def test_a_card_without_country_code_takes_the_macs_region(self) -> None:
        self.book.card("Nora", "Berg", phones=["123 45 678"])
        self.assertEqual(self.imsg.name_for("+4712345678"), "Nora Berg")

    def test_a_card_saved_with_00_splits_like_plus(self) -> None:
        self.book.card("Nora", "Berg", phones=["0047 123 45 678"])
        self.assertEqual(self.imsg.name_for("+4712345678"), "Nora Berg")

    def test_the_exact_key_wins_over_the_region_rule(self) -> None:
        self.book.card("Ada", "Exact", phones=["+47 123 45 678"])
        self.book.card("Bea", "Suffix", phones=["123 45 678"])
        self.assertEqual(self.imsg.name_for("+4712345678"), "Ada Exact")

    def test_two_matching_cards_name_nobody(self) -> None:
        self.book.card("Ada", "One", phones=["123 45 678"])
        self.book.card("Bea", "Two", phones=["7 123 45 678"])
        self.assertIsNone(self.imsg.name_for("+4712345678"))

    def test_a_different_number_of_the_same_length_never_matches(self) -> None:
        # What Contacts itself answers: a suffix relation, not shared trailing digits.
        self.book.card("Nora", "Berg", phones=["123 45 678"])
        self.assertIsNone(self.imsg.name_for("+4713345678"))     # one digit off
        self.assertIsNone(self.imsg.name_for("+4712345670"))     # last digit off
        self.assertEqual(self.imsg.name_for("+4712345678"), "Nora Berg")

    def test_another_country_never_matches(self) -> None:
        self.book.card("Nora", "Berg", phones=["12345678"])
        self.assertIsNone(self.imsg.name_for("+3112345678"))      # the same eight digits, Dutch

    def test_email_handles_are_untouched(self) -> None:
        self.book.card("Sam", "Okafor", emails=["Sam@Example.com"])
        self.assertEqual(self.imsg.name_for("sam@example.com"), "Sam Okafor")
        self.assertIsNone(self.imsg.name_for("nobody@example.com"))


class TrunkZero(Base):
    home = "44"

    def test_a_uk_card_saved_with_its_zero_matches(self) -> None:
        self.book.card("Rob", "Taylor", phones=["07700 900123"])
        self.assertEqual(self.imsg.name_for("+447700900123"), "Rob Taylor")

    def test_an_italian_zero_is_part_of_the_number(self) -> None:
        self.imsg._home_calling_code = lambda: "39"
        self.book.card("Giulia", "Rossi", phones=["06 1234567"])
        self.assertEqual(self.imsg.name_for("+39061234567"), "Giulia Rossi")


class NorthAmerica(Base):
    home = "1"

    def test_a_seven_digit_local_card_is_refused_not_guessed(self) -> None:
        self.book.card("Casey", "Local", phones=["555-0100"])
        self.assertIsNone(self.imsg.name_for("+14155550100"))
        self.assertIsNone(self.imsg.name_for("+12125550100"))

    def test_a_ten_digit_card_resolves_as_before(self) -> None:
        self.book.card("Casey", "Full", phones=["415-555-0100"])
        self.assertEqual(self.imsg.name_for("+14155550100"), "Casey Full")


class NoRegion(Base):
    home = None

    def test_a_national_card_stays_a_number_and_plus_cards_still_work(self) -> None:
        self.book.card("Nora", "Berg", phones=["123 45 678"])
        self.book.card("Ada", "Plus", phones=["+47 198 77 665"])
        self.assertIsNone(self.imsg.name_for("+4712345678"))
        self.assertEqual(self.imsg.name_for("+4719877665"), "Ada Plus")


class Ambiguity(Base):
    def test_a_third_card_cannot_resurrect_an_ambiguous_number(self) -> None:
        # Alice and Bob cancel out; a third card used to bring the name back as "Carol".
        for first, last in (("Alice", "One"), ("Bob", "Two"), ("Carol", "Three")):
            self.book.card(first, last, phones=["+47 123 45 678"])
        self.assertIsNone(self.imsg.name_for("+4712345678"))

    def test_ambiguity_is_permanent_for_emails_too(self) -> None:
        for first, last in (("Alice", "One"), ("Bob", "Two"), ("Carol", "Three")):
            self.book.card(first, last, emails=["shared@example.com"])
        self.assertIsNone(self.imsg.name_for("shared@example.com"))


class OneCardSavedTwice(Base):
    home = "1"

    def test_spellings_that_differ_only_in_spacing_are_one_person(self) -> None:
        # The same person twice in ONE source, "Mom ❤️" and "Mom❤️" — a
        # duplicate card, not two people. They were a bare number with no photo.
        a = self.book.card("Mom ❤️", "", phones=["5550100200"])
        b = self.book.card("Mom❤️", "", phones=["+15550100200"], photo=JPEG)
        self.assertEqual(self.imsg.name_for("+15550100200"), "Mom ❤️")
        # Both records are photo candidates, oldest first; the first with a picture wins.
        self.assertEqual(self.imsg._avatar_candidates("+15550100200"), [(self.book.path, a), (self.book.path, b)])

    def test_case_and_compatibility_forms_are_one_person_too(self) -> None:
        self.book.card("ＡLEX", "rivera", phones=["+15550100201"])
        self.book.card("Alex", "Rivera", phones=["+15550100201"])
        self.assertEqual(self.imsg.name_for("+15550100201"), "ＡLEX rivera")

    def test_two_different_names_on_one_number_are_still_nobody(self) -> None:
        # A married name kept beside the old one is two cards Contacts shows separately.
        self.book.card("Dana", "Park", phones=["+15550100202"], photo=JPEG)
        self.book.card("Dana", "Reyes", phones=["+15550100202"], photo=JPEG)
        self.assertIsNone(self.imsg.name_for("+15550100202"))
        self.assertEqual(self.imsg._avatar_candidates("+15550100202"), [])

    def test_nameless_duplicates_stay_ambiguous(self) -> None:
        self.book.card("", "", phones=["+15550100202"], photo=JPEG)
        self.book.card("", "", phones=["+15550100202"], photo=JPEG)
        self.assertEqual(self.imsg._avatar_candidates("+15550100202"), [])

    def test_a_first_name_card_beside_the_full_card_is_one_person(self) -> None:
        # "Alex" saved in a hurry, "Alex Rivera" saved properly, one number: the
        # fuller name, in either card order, and both records are photo candidates.
        a = self.book.card("Alex", "", phones=["+15550100203"])
        b = self.book.card("Alex", "Rivera", phones=["(555) 010-0203"], photo=JPEG)
        self.book.card("Sam", "Lee", phones=["+15550100204"])
        self.book.card("Sam", "", phones=["+15550100204"])
        self.assertEqual(self.imsg.name_for("+15550100203"), "Alex Rivera")
        self.assertEqual(self.imsg.name_for("+15550100204"), "Sam Lee")
        self.assertEqual(self.imsg._avatar_candidates("+15550100203"), [(self.book.path, a), (self.book.path, b)])

    def test_leading_words_not_letters(self) -> None:
        # "Ann" does not lead "Anna Smith": two people, so nobody.
        self.book.card("Ann", "", phones=["+15550100205"])
        self.book.card("Anna", "Smith", phones=["+15550100205"])
        self.assertIsNone(self.imsg.name_for("+15550100205"))

    def test_two_full_names_after_a_short_one_are_still_nobody(self) -> None:
        # Alex leads both, but Alex Rivera and Alex Lee are two people, whichever came first.
        for first, last in (("Alex", ""), ("Alex", "Rivera"), ("Alex", "Lee")):
            self.book.card(first, last, phones=["+15550100206"], photo=JPEG)
        for first, last in (("Alex", "Rivera"), ("Alex", "Lee"), ("Alex", "")):
            self.book.card(first, last, phones=["+15550100207"])
        self.assertIsNone(self.imsg.name_for("+15550100206"))
        self.assertIsNone(self.imsg.name_for("+15550100207"))
        self.assertEqual(self.imsg._avatar_candidates("+15550100206"), [])


class AmbiguousExactNeverFallsThrough(Base):
    def test_an_ambiguous_exact_card_blocks_the_suffix_match(self) -> None:
        # Alice and Bob share the exact number; Carol's local-format card would
        # suffix-match. The answer is "ambiguous", never Carol (Astra C#2).
        self.book.card("Alice", "One", phones=["+47 123 45 678"])
        self.book.card("Bob", "Two", phones=["+47 123 45 678"])
        other = FakeAddressBook(self.tmp.name, "SRC-B")
        try:
            carol = other.card("Carol", "Three", phones=["123 45 678"], photo=JPEG)
            self.assertIsNone(self.imsg.name_for("+4712345678"))
            self.assertEqual(self.imsg._avatar_candidates("+4712345678"), [])
        finally:
            other.con.close()


class ExactBeatsSuffixAcrossSources(Base):
    def test_an_exact_card_in_a_later_source_beats_a_nearer_suffix_card(self) -> None:
        # Source A (first in rank order) only has a suffix card with a photo; source B
        # has the exact card. The conversation is NAMED after the exact card, so its
        # photo must come from there too — never a different person's face.
        self.book.card("Bea", "Suffix", phones=["123 45 678"], photo=JPEG)
        other = FakeAddressBook(self.tmp.name, "SRC-B")
        try:
            exact = other.card("Ada", "Exact", phones=["+47 123 45 678"], photo=JPEG)
            self.assertEqual(self.imsg._avatar_candidates("+4712345678"), [(other.path, exact)])
        finally:
            other.con.close()


class Photos(Base):
    def test_the_region_rule_picks_the_card_when_nothing_is_exact(self) -> None:
        pk = self.book.card("Nora", "Berg", phones=["123 45 678"], photo=JPEG)
        self.assertEqual(self.imsg._avatar_candidates("+4712345678"), [(self.book.path, pk)])

    def test_the_exact_card_is_preferred(self) -> None:
        exact = self.book.card("Ada", "Exact", phones=["+4712345678"])
        self.book.card("Bea", "Suffix", phones=["123 45 678"], photo=JPEG)
        self.assertEqual(self.imsg._avatar_candidates("+4712345678"), [(self.book.path, exact)])

    def test_an_ambiguous_source_yields_no_candidate(self) -> None:
        self.book.card("Ada", "One", phones=["123 45 678"], photo=JPEG)
        self.book.card("Bea", "Two", phones=["7 123 45 678"], photo=JPEG)
        self.assertEqual(self.imsg._avatar_candidates("+4712345678"), [])


if __name__ == "__main__":
    unittest.main()
