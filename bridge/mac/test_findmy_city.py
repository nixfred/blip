#!/usr/bin/env python3
"""Invented AX rows and Contacts only; never launches an app or reads a book."""
from datetime import datetime, timezone
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
from contextlib import closing, redirect_stdout

import findmy_city as city

NOW = datetime(2026, 11, 6, 12, 0, tzinfo=timezone.utc)
HANDLE = "+15550100001"
OTHER = "+15550100002"


def row(name="Alex Rivera", place="Boston, MA", age="Now"):
    return f"{name}\u00a0· 1 mi\u00a0· {place}\u00a0· {age}"


def card(first="Alex", last="Rivera", phone=HANDLE, emails=()):
    return {"name": f"{first} {last}", "first": first, "last": last, "org": "",
            "phones": [{"number": phone}] if phone else [],
            "emails": [{"address": address} for address in emails]}


class ParserTests(unittest.TestCase):
    def test_canadian_city_province_country_layout(self):
        self.assertEqual(city.parse_row(row(place="Exampleville QC Canada"), NOW)["city"], "Exampleville, QC")
        self.assertEqual(city.parse_row(row(place="Saint-Exemple NB Canada"), NOW)["city"], "Saint-Exemple, NB")
        for place in ("Address unavailable", "123 Main Street QC Canada", "Home QC Canada", "Exampleville ZZ Canada"):
            self.assertIsNone(city.parse_row(row(place=place), NOW))

    def test_city_and_explicit_utc_lifetime(self):
        self.assertEqual(city.parse_row(row(), NOW), {
            "city": "Boston, MA", "observedAt": "2026-11-06T12:00:00Z",
            "expiresAt": "2026-11-06T12:05:00Z"})
        self.assertEqual(city.parse_row(row(age="Live"), NOW)["city"], "Boston, MA")

    def test_rounded_ages_use_the_old_edge(self):
        self.assertEqual(city.parse_row(row(age="2 min. ago"), NOW)["observedAt"],
                         "2026-11-06T11:57:01Z")
        self.assertEqual(city.parse_row(row(age="4 min. ago"), NOW)["expiresAt"],
                         "2026-11-06T12:05:00Z")
        self.assertEqual(city.parse_row(row(age="30 sec. ago"), NOW)["observedAt"],
                         "2026-11-06T11:59:29Z")
        self.assertEqual(city.parse_row(row(age="1 hr. ago"), NOW)["observedAt"],
                         "2026-11-06T10:00:01Z")
        for age in ("Yesterday",
                    "in 2 min.", "-2 min. ago", "Now · extra", "Maintenant", "5 min ago"):
            with self.subTest(age=age):
                self.assertIsNone(city.parse_row(row(age=age), NOW))

    def test_known_ages_keep_observation_time_and_five_minute_snapshot_lease(self):
        for age, seconds in (("299 sec. ago", 300), ("7 min. ago", 479),
                             ("1 hr. ago", 7199), ("20 min. ago", 1259)):
            with self.subTest(age=age):
                parsed = city.parse_row(row(age=age), NOW)
                observed = datetime.fromisoformat(parsed["observedAt"].replace("Z", "+00:00"))
                self.assertEqual((NOW - observed).total_seconds(), seconds)
                self.assertEqual(parsed["expiresAt"], "2026-11-06T12:05:00Z")

    def test_location_older_than_a_day_is_hidden_and_near_boundary_expires_early(self):
        parsed = city.parse_row(row(age="23 hr. ago"), NOW)
        self.assertEqual(parsed["observedAt"], "2026-11-05T12:00:01Z")
        self.assertEqual(parsed["expiresAt"], "2026-11-06T12:00:01Z")
        for age in ("24 hr. ago", "25 hr. ago", "999 hr. ago"):
            with self.subTest(age=age):
                self.assertIsNone(city.parse_row(row(age=age), NOW))
        # A stale known row can request a refresh even after the display cap;
        # only the new snapshot can make it displayable again.
        self.assertTrue(city.needs_refresh(row(age="24 hr. ago"), NOW))

    def test_only_coarse_city_state_not_street_or_labels(self):
        for place in ("Home", "Work", "Home, MA", "123 Main Street, MA", "Main Street, MA",
                      "Boston", "Boston, Massachusetts", "Boston, ma", "Nearby", "12, MA",
                      "Boston\n, MA", "Boston\u202e, MA", "a" * 121 + ", MA"):
            with self.subTest(place=place):
                self.assertIsNone(city.parse_row(row(place=place), NOW))
        for place in ("St. Louis, MO", "Montréal, QC", "Winston-Salem, NC"):
            self.assertEqual(city.parse_row(row(place=place), NOW)["city"], place)

    def test_no_location_or_changed_layout_is_not_a_city(self):
        for value in (None, [], "Alex Rivera · No location found", "Alex Rivera · Location not shared",
                      "Boston, MA", row().replace("1 mi", "unknown distance"), "x" * 513):
            self.assertIsNone(city.parse_row(value, NOW))

    def test_handles_are_exact_without_country_suffix_guessing(self):
        self.assertEqual(city.normalize_handle("+1 (555) 010-0001"), HANDLE)
        self.assertEqual(city.normalize_handle("Person@Example.COM"), "person@example.com")
        for value in ("group-id", "chat123", "any;+;abcdef", "12345", "a@ b", "abc\n@example.com", None):
            with self.assertRaises(ValueError):
                city.normalize_handle(value)


class IdentityTests(unittest.TestCase):
    def select(self, rows=None, cards=None, handle=HANDLE):
        return city.select_city(handle, rows if rows is not None else [row()],
                                cards if cards is not None else [card()], NOW)

    def test_unique_full_person_name(self):
        self.assertEqual(self.select()["city"], "Boston, MA")
        self.assertIsNone(self.select(handle=OTHER))
        self.assertIsNone(self.select(rows=[row("Alex")]))
        self.assertIsNone(self.select(rows=[row("Alex Rivera Jr.")]))

    def test_duplicate_homonyms_elsewhere_in_address_book_are_rejected(self):
        self.assertIsNone(self.select(cards=[card(), card(phone=OTHER)]))
        self.assertIsNone(self.select(cards=[card(), card(phone=None, emails=["other@example.com"])]))
        self.assertIsNone(self.select(cards=[card(), card(phone=None)]))
        self.assertIsNone(self.select(cards=[card(), card(first="Taylor", last="Chen")]))
        # Identical mirrored cards are one identity, without last-ten dedupe.
        self.assertIsNotNone(self.select(cards=[card(), card()]))
        self.assertIsNone(self.select(cards=[card(), card(phone="+445550100001")]))

    def test_mirrored_cards_can_add_fields_but_must_all_bind_requested_handle(self):
        rich = card(emails=["alex@example.test"])
        rich["phones"].append({"number": OTHER})
        self.assertIsNotNone(self.select(cards=[card(), rich]))
        self.assertIsNotNone(self.select(cards=[rich, card()]))
        # A same-name card without the shared handle still leaves identity
        # unresolved, however many agreeing mirrors exist.
        self.assertIsNone(self.select(cards=[card(), rich, card(phone=OTHER)]))
        self.assertIsNone(self.select(cards=[card(), rich, card(phone=None)]))
        self.assertIsNone(self.select(cards=[card(), rich, card(phone="+445550100001")]))

    def test_exact_single_field_personal_names_without_shortening_full_names(self):
        for person in (card(first="Alex", last=""), card(first="", last="Rivera")):
            name = person["name"].strip()
            self.assertIsNotNone(self.select(rows=[row(name)], cards=[person]))
            other = dict(person, phones=[{"number": OTHER}])
            self.assertIsNone(self.select(rows=[row(name)], cards=[person, other]))
        self.assertIsNone(self.select(rows=[row("Alex")], cards=[card()]))

    def test_nickname_company_and_partial_names_do_not_qualify(self):
        for change in ({"first": "", "last": "", "nick": "Alex Rivera"},
                       {"first": "", "last": "", "org": "Alex Rivera"},
                       {"last": ""}):
            self.assertIsNone(self.select(cards=[dict(card(), **change)]))
        self.assertIsNone(self.select(cards=[card(), dict(card(phone=OTHER), first="", last="",
                                                       org="Alex Rivera")]))

    def test_findmy_row_uniqueness_includes_stale_and_unavailable_rows(self):
        for duplicate in (row(), row(age="20 min. ago"), "Alex Rivera · No location found"):
            self.assertIsNone(self.select(rows=[row(), duplicate]))

    def test_exact_phone_or_email_row_needs_no_name_guess(self):
        self.assertIsNotNone(self.select(rows=[row(HANDLE)], cards=[]))
        self.assertIsNotNone(self.select(rows=[row("PERSON@Example.COM")], cards=[],
                                        handle="person@example.com"))
        self.assertIsNone(self.select(rows=[row("+445550100001")], cards=[]))
        self.assertIsNone(self.select(rows=[row(HANDLE), row(HANDLE)], cards=[]))

    def test_bounds_and_unsafe_name_do_not_match(self):
        self.assertIsNone(self.select(rows=[row()] * (city.MAX_ROWS + 1)))
        self.assertIsNone(self.select(cards=[card()] * (city.MAX_CONTACTS + 1)))
        self.assertIsNone(self.select(rows=[row("Alex\u202e Rivera")]))


def node(role="AXGroup", ident="", desc="", children=(), selected=False):
    return {"AXRole": role, "AXIdentifier": ident, "AXDescription": desc,
            "children": list(children), "selected": selected}


def container(*, people=True, heading="People", rows=None):
    return node(ident="CardContainerView", children=[
        node("AXHeading", desc=heading),
        node("AXRadioButton", desc="People", selected=people),
        *[node("AXButton", ident="ListEntityRow", desc=value)
          for value in (rows if rows is not None else [row()])],
        # A map label with the same city must never become a row.
        node("AXButton", ident="MapPlace", desc=row("Wrong Person"))])


def comma_row(name="Alex Rivera", distance="1 mi", place="Boston, MA", age="Now"):
    """The macOS 27.2 People row: commas for the first three fields."""
    return f"{name}, {distance}, {place}\u00a0· {age}"


def container_272(*, rows=None, people=True):
    """macOS 27.2: rows are static text with a repeated identifier, no buttons."""
    return node(ident="CardContainerView", children=[
        node("AXHeading", desc="People"),
        node("AXRadioButton", desc="People", selected=people),
        *[node("AXStaticText", ident="ListEntityRow-ListEntityRow-ListEntityRow", desc=value)
          for value in (rows if rows is not None else [comma_row()])],
        node("AXStaticText", ident="MapPlace", desc=comma_row("Wrong Person"))])


class FakeAX(city.AccessibilityReader):
    def __init__(self, containers=None):
        self.clock, self.deadline, self.nodes = lambda: 0, 10, 0
        self.released = []
        self.application = node(children=[node("AXWindow", children=containers or [container()])])
        self.ax = SimpleNamespace(AXIsProcessTrusted=lambda: True,
                                  AXUIElementCreateApplication=lambda pid: self.application)
        self.cf = SimpleNamespace(CFRelease=self.released.append)

    def children(self, element, attribute="AXChildren"):
        yield from element["children"]

    def text(self, element, attribute):
        return element.get(attribute, "")

    def selected(self, element):
        return element["selected"]


class AXTests(unittest.TestCase):
    def test_verified_people_structure_only(self):
        reader = FakeAX()
        self.assertEqual(reader.snapshot(123), [row()])
        self.assertEqual(reader.released, [reader.application])

    def test_wrong_tab_or_missing_heading_or_multiple_containers_fails_closed(self):
        for containers in ([container(people=False)], [container(heading="Devices")],
                           [container(), container()]):
            reader = FakeAX(containers)
            with self.assertRaises(city.Unavailable):
                reader.snapshot(123)
            self.assertEqual(reader.released, [reader.application])

    def test_traversal_limits_and_deadline(self):
        deep = node()
        for _ in range(city.MAX_DEPTH + 1):
            deep = node(children=[deep])
        for tree in (deep, node(children=[node()] * city.MAX_NODES)):
            reader = FakeAX()
            with self.assertRaises(city.Unavailable):
                list(reader.walk(tree))
        reader = FakeAX()
        reader.deadline = 0
        with self.assertRaises(city.Unavailable):
            list(reader.walk(node()))

    def test_cf_copy_results_and_attribute_keys_released_on_failure(self):
        reader = city.AccessibilityReader.__new__(city.AccessibilityReader)
        reader.clock, reader.deadline = lambda: 0, 1
        releases = []
        reader.cf = SimpleNamespace(CFStringCreateWithCString=lambda *args: 11,
                                    CFRelease=lambda value: releases.append(value.value if hasattr(value, "value") else value))
        def copy(element, key, target):
            target._obj.value = 22
            return -25204  # Cannot complete, not an unsupported attribute.
        reader.ax = SimpleNamespace(AXUIElementSetMessagingTimeout=lambda *args: 0,
                                    AXUIElementCopyAttributeValue=copy)
        with self.assertRaises(city.Unavailable):
            with reader.attribute(1, "AXRole"):
                self.fail("transport errors must not yield partial values")
        self.assertEqual(releases, [22, 11])


class Layout272Tests(unittest.TestCase):
    def test_comma_row_reads_like_the_dotted_one(self):
        self.assertEqual(city.legacy_row(comma_row()), row())
        self.assertEqual(city.parse_row(city.legacy_row(comma_row()), NOW)["city"], "Boston, MA")
        self.assertEqual(city.row_identity(city.legacy_row(comma_row())), "Alex Rivera")
        self.assertEqual(city.parse_row(city.legacy_row(comma_row(distance="1,200 mi", age="5 min. ago")), NOW)["city"],
                         "Boston, MA")

    def test_a_comma_in_the_name_does_not_move_the_split(self):
        fixed = city.legacy_row(comma_row(name="Rivera, Alex Jr."))
        self.assertEqual(city.row_identity(fixed), "Rivera, Alex Jr.")
        self.assertEqual(city.parse_row(fixed, NOW)["city"], "Boston, MA")

    def test_the_privacy_rules_still_apply_through_the_comma_layout(self):
        for place in ("Home", "123 Main Street, MA", "Boston", "Home, MA"):
            with self.subTest(place=place):
                self.assertIsNone(city.parse_row(city.legacy_row(comma_row(place=place)), NOW))
        self.assertIsNone(city.parse_row(city.legacy_row(comma_row(age="Paused")), NOW))

    def test_other_rows_are_left_exactly_as_they_were(self):
        for value in (row(), "Alex Rivera · No location found", "Alex Rivera, nearby, Boston, MA · Now",
                      "Alex Rivera, 1 mi, Boston, MA", "Alex Rivera, 1 mi, Boston, MA · Now · extra",
                      None, 7, "x" * 513 + " · Now"):
            with self.subTest(value=value):
                self.assertEqual(city.legacy_row(value), value)

    def test_static_text_rows_are_read_and_rewritten(self):
        reader = FakeAX([container_272(rows=[comma_row(), comma_row("Sam Lee", place="Home")])])
        self.assertEqual(reader.snapshot(123), [row(), city.legacy_row(comma_row("Sam Lee", place="Home"))])

    def test_row_buttons_win_over_static_text_so_old_layouts_never_double_count(self):
        mixed = container()
        mixed["children"].append(node("AXStaticText", ident="ListEntityRow-ListEntityRow", desc=comma_row("Extra")))
        self.assertEqual(FakeAX([mixed]).snapshot(123), [row()])

    def test_the_people_gate_still_decides_in_the_272_layout(self):
        with self.assertRaises(city.Unavailable):
            FakeAX([container_272(people=False)]).snapshot(123)

    def test_static_text_rows_count_toward_the_row_limit(self):
        with self.assertRaises(city.Unavailable):
            FakeAX([container_272(rows=[comma_row(f"P{i}") for i in range(city.MAX_ROWS + 1)])]).snapshot(123)


class BoundaryTests(unittest.TestCase):
    def test_stale_known_city_refreshes_once_and_revalidates_identity(self):
        for age in ("7 min. ago", "1 hr. ago", "299 sec. ago"):
            with self.subTest(age=age):
                refresher = mock.Mock(return_value=[row()])
                loader = mock.Mock(return_value=[card()])
                result = city.shared_city(HANDLE, None, enabled=True,
                    row_reader=lambda **kwargs: [row(age=age)], card_loader=loader,
                    refresher=refresher, now=NOW)
                self.assertEqual(result["city"], "Boston, MA")
                refresher.assert_called_once_with(enabled=True, handle=HANDLE)
                self.assertEqual(loader.call_count, 2)
        # An unchanged last-known observation retains its old timestamp; the
        # caller displays its age instead of inventing a fresh location.
        for age in ("7 min. ago", "1 hr. ago"):
            result = city.shared_city(HANDLE, None, enabled=True,
                row_reader=lambda **kwargs: [row(age=age)],
                card_loader=lambda module: [card()],
                refresher=lambda **kwargs: [row(age=age)], now=NOW)
            expected = city.parse_row(row(age=age), NOW)
            self.assertEqual(result["city"], expected["city"])
            self.assertEqual(result["observedAt"], expected["observedAt"])
            self.assertEqual(result["expiresAt"], expected["expiresAt"])
        self.assertIsNone(city.shared_city(HANDLE, None, enabled=True,
            row_reader=lambda **kwargs: [row(age="7 min. ago")],
            card_loader=lambda module: [card()],
            refresher=lambda **kwargs: ["Alex Rivera · No location found"], now=NOW)["city"])
        self.assertIsNone(city.shared_city(HANDLE, None, enabled=True,
            row_reader=lambda **kwargs: [row(age="1 hr. ago")],
            card_loader=lambda module: [card()],
            refresher=lambda **kwargs: [row("Other Person")], now=NOW)["city"])
        loader = mock.Mock(side_effect=[[card()], [card(), card(phone=OTHER)]])
        self.assertIsNone(city.shared_city(HANDLE, None, enabled=True,
            row_reader=lambda **kwargs: [row(age="7 min. ago")], card_loader=loader,
            refresher=lambda **kwargs: [row()], now=NOW)["city"])

    def test_fresh_unknown_and_unsupported_rows_do_not_activate_findmy(self):
        for value in (row(), row(age="Live"), row(age="2 min. ago"),
                      row(age="Yesterday"), row(age="5 min ago"),
                      row(age="Unknown"), row(place="Home", age="Paused"),
                      row(place="Address unavailable", age="7 min. ago"),
                      "Alex Rivera · No location found"):
            with self.subTest(value=value):
                refresh = mock.Mock()
                city.shared_city(HANDLE, None, enabled=True,
                    row_reader=lambda **kwargs: [value], card_loader=lambda module: [card()],
                    refresher=refresh, now=NOW)
                refresh.assert_not_called()

    def test_paused_never_refreshes_and_reports_location_unavailable(self):
        for value in (row(age="Paused"), row(HANDLE, age="Paused")):
            refresher = mock.Mock()
            result = city.shared_city(HANDLE, None, enabled=True,
                row_reader=lambda **kwargs: [value], card_loader=lambda module: [card()],
                refresher=refresher, now=NOW)
            self.assertIsNone(result["city"])
            self.assertEqual(result["reason"], "location-unavailable")
            refresher.assert_not_called()
        self.assertFalse(city.needs_refresh(row(age="Paused"), NOW))

    def test_stale_lookups_share_persistent_cooldown_and_keep_passive_age(self):
        clock = mock.Mock(return_value=1000)
        runner = mock.Mock(side_effect=lambda argv, **kwargs: SimpleNamespace(
            returncode=0, stdout='{"previousPid":10,"findmyPid":20}' if argv[-1] == "start" else '{}'))
        with tempfile.TemporaryDirectory() as directory:
            def lookup(handle=HANDLE, age="7 min. ago", cards=None):
                # Recreate the adapter on each request, as separate bridge calls do.
                def refresh(**kwargs):
                    return city.foreground_rows(**kwargs, runner=runner, sleeper=lambda seconds: None,
                        row_reader=lambda **kw: [row(handle, age=age)], reader_factory=FakeAX,
                        lock_directory=directory, clock=clock)
                return city.shared_city(handle, None, enabled=True,
                    row_reader=lambda **kw: [row(handle, age=age)],
                    card_loader=lambda module: cards or [], refresher=refresh, now=NOW)
            first = lookup()
            self.assertEqual(runner.call_count, 2)
            clock.return_value = 1060
            self.assertEqual(lookup(), first)
            self.assertEqual(runner.call_count, 2)
            # A second handle has its own cooldown, shared by normalized identities.
            lookup(OTHER)
            self.assertEqual(runner.call_count, 4)
            lookup("+1 (555) 010-0001")
            self.assertEqual(runner.call_count, 4)
            clock.return_value = 999  # Wall-clock rollback must not bypass it.
            lookup()
            self.assertEqual(runner.call_count, 4)
            clock.return_value = 1899
            lookup()
            self.assertEqual(runner.call_count, 4)
            clock.return_value = 1900
            lookup()
            self.assertEqual(runner.call_count, 6)
            # Cooldown does not retain rows, bypass identity checks or extend age limits.
            self.assertIsNone(lookup(age="24 hr. ago")["city"])
            result = city.shared_city(HANDLE, None, enabled=True,
                row_reader=lambda **kw: [row()], card_loader=lambda module: [card(phone=OTHER)], now=NOW)
            self.assertEqual(result["reason"], "no-match")
            state = Path(directory, "findmy-refresh.json")
            raw = state.read_text()
            self.assertNotIn(HANDLE, raw)
            self.assertNotIn("Boston", raw)
            self.assertNotIn("Rivera", raw)
            self.assertEqual(state.stat().st_mode & 0o777, 0o600)

    def test_cooldown_is_shared_by_independent_bridge_processes(self):
        script = """
import sys
import findmy_city as city
with city.refresh_lock(sys.argv[1]):
    print(city.claim_refresh(sys.argv[2], sys.argv[1], lambda: float(sys.argv[3])))
"""
        with tempfile.TemporaryDirectory() as directory:
            def claim(stamp):
                return subprocess.run([sys.executable, "-c", script, directory, HANDLE, str(stamp)],
                    cwd=Path(__file__).parent, capture_output=True, text=True, check=True).stdout.strip()
            self.assertEqual(claim(1000), "True")
            self.assertEqual(claim(1060), "False")
            self.assertEqual(claim(1900), "True")

    def test_failed_focus_attempt_is_throttled_and_lock_contention_never_focuses(self):
        runner = mock.Mock(side_effect=subprocess.TimeoutExpired("fake", 2))
        with tempfile.TemporaryDirectory() as directory:
            kwargs = dict(enabled=True, handle=HANDLE, runner=runner, reader_factory=FakeAX,
                          lock_directory=directory, clock=lambda: 1000)
            with self.assertRaises(subprocess.TimeoutExpired):
                city.foreground_rows(**kwargs)
            self.assertIsNone(city.foreground_rows(**kwargs))
            runner.assert_called_once()
            with city.refresh_lock(directory):
                with self.assertRaises(BlockingIOError):
                    city.foreground_rows(**kwargs)
            runner.assert_called_once()

    def test_cooldown_state_rejects_unsafe_corrupt_and_oversized_files(self):
        for kind in ("symlink", "hardlink", "public", "corrupt", "oversized", "invalid-stamp"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                path = Path(directory, "findmy-refresh.json")
                target = Path(directory, "target")
                target.write_text("untouched")
                if kind == "symlink":
                    path.symlink_to(target)
                elif kind == "hardlink":
                    os.link(target, path)  # Path.hardlink_to needs Python 3.10; the Mac runs 3.9
                else:
                    path.write_text({"corrupt": "{", "oversized": "x" * (city.MAX_REFRESH_STATE_BYTES + 1),
                                     "invalid-stamp": '{"' + "a" * 64 + '":NaN}'}.get(kind, "{}"))
                    path.chmod(0o644 if kind == "public" else 0o600)
                runner = mock.Mock()
                with self.assertRaises(Exception):
                    city.foreground_rows(enabled=True, handle=HANDLE, runner=runner,
                        reader_factory=FakeAX, lock_directory=directory, clock=lambda: 1000)
                runner.assert_not_called()
                self.assertEqual(target.read_text(), "untouched")

    def test_cooldown_state_is_bounded_and_prunes_expired_handles(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "findmy-refresh.json")
            entries = {format(i, "064x"): 1000 for i in range(city.MAX_REFRESH_HANDLES)}
            path.write_text(json.dumps(entries))
            path.chmod(0o600)
            with city.refresh_lock(directory):
                self.assertFalse(city.claim_refresh(HANDLE, directory, lambda: 1001))
                self.assertTrue(city.claim_refresh(HANDLE, directory, lambda: 1900))
            self.assertEqual(len(json.loads(path.read_text())), 1)

    def test_foreground_restoration_runs_on_success_and_snapshot_failure(self):
        for failed in (False, True):
            runner = mock.Mock(side_effect=[
                SimpleNamespace(returncode=0, stdout='{"previousPid":10,"findmyPid":20}'),
                SimpleNamespace(returncode=0, stdout='{}')])
            rows = mock.Mock(side_effect=city.Unavailable()) if failed else mock.Mock(return_value=[row()])
            with tempfile.TemporaryDirectory() as directory:
                kwargs = dict(enabled=True, handle=HANDLE, row_reader=rows, runner=runner, sleeper=mock.Mock(),
                              lock_directory=directory, reader_factory=FakeAX)
                if failed:
                    with self.assertRaises(city.Unavailable):
                        city.foreground_rows(**kwargs)
                else:
                    self.assertEqual(city.foreground_rows(**kwargs), [row()])
            self.assertEqual(runner.call_args_list[-1].args[0][-3:], ["restore", "10", "20"])

    def test_foreground_untrusted_and_disabled_never_activate(self):
        runner = mock.Mock()
        factory = mock.Mock()
        self.assertEqual(city.foreground_rows(enabled=False, handle=HANDLE, runner=runner, reader_factory=factory), [])
        factory.assert_not_called()
        reader = FakeAX()
        reader.ax.AXIsProcessTrusted = lambda: False
        self.assertEqual(city.foreground_rows(enabled=True, handle=HANDLE, runner=runner,
                                              reader_factory=lambda: reader), [])
        runner.assert_not_called()

    @unittest.skipUnless(shutil.which("bun"), "Bun executes the shipped AppKit control script with fake APIs")
    def test_shipped_focus_script_preserves_a_new_user_focus_choice(self):
        harness = '''
var ObjC = {import:function(){}};
var calls=[], front={processIdentifier:10};
var original={activateWithOptions:function(){calls.push('restore');return true}};
var target={processIdentifier:20,activateWithOptions:function(){calls.push('activate');front=target;return true}};
var $={NSApplicationActivateIgnoringOtherApps:2,
 NSWorkspace:{sharedWorkspace:{get frontmostApplication(){return front}}},
 NSRunningApplication:{runningApplicationsWithBundleIdentifier:function(){return {count:1,objectAtIndex:function(){return target}}},
 runningApplicationWithProcessIdentifier:function(pid){if(pid!==10)throw Error('wrong pid');return original}}};
''' + city._FOCUS_SCRIPT + '''
var state=JSON.parse(run(['start']));
if(state.previousPid!==10 || state.findmyPid!==20)throw Error('wrong capture');
run(['restore','10','20']);
if(calls.join(',')!=='activate,restore')throw Error('restore missing');
calls=[];front={processIdentifier:30};
run(['restore','10','20']);
if(calls.length)throw Error('overrode user choice');
console.log('PASS');
'''
        result = subprocess.run([shutil.which("bun"), "-e", harness], capture_output=True,
                                text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "PASS")

    def test_people_gate_is_rechecked_after_rows(self):
        reader = FakeAX()
        calls = 0
        def selected(element):
            nonlocal calls
            calls += 1
            return calls == 1
        reader.selected = selected
        with self.assertRaises(city.Unavailable):
            reader.snapshot(123)

    def test_disabled_never_constructs_reader_or_launches_app(self):
        factory, runner = mock.Mock(), mock.Mock()
        self.assertEqual(city.read_rows(enabled=False, reader_factory=factory, runner=runner), [])
        factory.assert_not_called()
        runner.assert_not_called()

    def test_untrusted_preflight_does_not_prompt_or_launch(self):
        reader = FakeAX()
        reader.ax.AXIsProcessTrusted = lambda: False
        runner = mock.Mock()
        self.assertEqual(city.read_rows(enabled=True, reader_factory=lambda: reader, runner=runner), [])
        runner.assert_not_called()

    def test_running_app_is_never_activated_or_switched(self):
        reader = FakeAX()
        runner = mock.Mock(return_value=SimpleNamespace(returncode=0, stdout=b"123\n"))
        self.assertEqual(city.read_rows(enabled=True, reader_factory=lambda: reader, runner=runner), [row()])
        self.assertEqual(runner.call_args.args[0], ["/usr/bin/pgrep", "-x", "FindMy"])
        self.assertEqual(runner.call_count, 1)

    def test_new_launch_is_explicitly_background_only(self):
        reader = FakeAX()
        runner = mock.Mock(side_effect=[SimpleNamespace(returncode=1, stdout=b""),
                                       SimpleNamespace(returncode=0),
                                       SimpleNamespace(returncode=0, stdout=b"123\n")])
        self.assertEqual(city.read_rows(enabled=True, reader_factory=lambda: reader, runner=runner), [row()])
        self.assertEqual(runner.call_args_list[1].args[0], ["/usr/bin/open", "-g", "-a", "FindMy"])

    def test_no_private_error_or_identity_fields_cross_boundary(self):
        output = city.shared_city(HANDLE, None, enabled=True, row_reader=lambda **kw: [row()],
                                  card_loader=lambda module: [card()], now=NOW)
        self.assertEqual(set(output), {"ok", "handle", "city", "observedAt", "expiresAt", "reason"})
        self.assertEqual(output["reason"], "available")
        self.assertNotIn("Rivera", json.dumps(output))
        for kwargs in ({"row_reader": mock.Mock(side_effect=RuntimeError("private AX text"))},
                       {"row_reader": lambda **kw: [row()],
                        "card_loader": mock.Mock(side_effect=RuntimeError("private path"))}):
            self.assertEqual(city.shared_city(HANDLE, None, enabled=True, **kwargs),
                             {"ok": True, "handle": HANDLE, "city": None,
                              "reason": "source-unavailable"})

    def test_diagnostic_reasons_are_bounded_and_revalidate_after_refresh(self):
        cases = [
            ([], "source-unavailable"),
            (None, "source-unavailable"),
            ([row("Other Person")], "no-match"),
            (["Alex Rivera · No location found"], "location-unavailable"),
            (["Alex Rivera · 1 mi · No location found"], "location-unavailable"),
            ([row(place="Address unavailable")], "unsupported-location"),
            ([row(place="Home")], "unsupported-location"),
            ([row(age="Unknown")], "unsupported-location"),
            ([row(age="24 hr. ago")], "observation-too-old"),
            ([row()], "available"),
        ]
        for rows, reason in cases:
            with self.subTest(reason=reason, rows=rows):
                result = city.shared_city(HANDLE, None, enabled=True,
                    row_reader=lambda **kwargs: rows, card_loader=lambda module: [card()],
                    refresher=lambda **kwargs: rows, now=NOW)
                self.assertEqual(result["reason"], reason)
                self.assertEqual(result["city"] is not None, reason == "available")
                self.assertNotIn("Rivera", json.dumps(result))
        reader = mock.Mock()
        result = city.shared_city(HANDLE, None, enabled=False, row_reader=reader)
        self.assertEqual(result, {"ok": True, "handle": HANDLE, "city": None, "reason": "disabled"})
        reader.assert_not_called()
        for rows, reason in (([], "source-unavailable"), ([row("Other Person")], "no-match"),
                             (["Alex Rivera · No location found"], "location-unavailable")):
            result = city.shared_city(HANDLE, None, enabled=True,
                row_reader=lambda **kwargs: [row(age="7 min. ago")], card_loader=lambda module: [card()],
                refresher=lambda **kwargs: rows, now=NOW)
            self.assertEqual(result["reason"], reason)
            self.assertIsNone(result["city"])

    def test_direct_handle_does_not_read_contacts_and_disabled_reads_nothing(self):
        loader = mock.Mock()
        output = city.shared_city(HANDLE, None, enabled=True,
                                  row_reader=lambda **kw: [row(HANDLE)], card_loader=loader, now=NOW)
        self.assertEqual(output["city"], "Boston, MA")
        loader.assert_not_called()
        reader = mock.Mock()
        self.assertIsNone(city.shared_city(HANDLE, None, enabled=False, row_reader=reader)["city"])
        reader.assert_not_called()

    def test_contacts_load_is_read_only_and_any_unreadable_source_invalidates(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "contacts.sqlite"
            with closing(sqlite3.connect(database)) as connection:
                connection.execute("CREATE TABLE ZABCDRECORD (name TEXT)")
                connection.execute("INSERT INTO ZABCDRECORD VALUES ('invented')")
                connection.commit()
            contacts = SimpleNamespace(bounded_source_dbs=lambda: [str(database)],
                                       open_db=lambda path: sqlite3.connect(f"file:{path}?mode=ro", uri=True),
                                       fetch_contacts=lambda connection: [card()])
            self.assertEqual(city.load_cards(contacts), [card()])
            contacts.bounded_source_dbs = lambda: [str(database), str(database) + ".missing"]
            with self.assertRaises(sqlite3.OperationalError):
                city.load_cards(contacts)

    def test_contacts_subcommand_bounded_input_and_generic_failure(self):
        loader = importlib.machinery.SourceFileLoader("city_contacts", str(Path(__file__).with_name("contacts")))
        spec = importlib.util.spec_from_loader(loader.name, loader)
        contacts = importlib.util.module_from_spec(spec)
        with mock.patch.dict(sys.modules, {loader.name: contacts}):
            loader.exec_module(contacts)
            for payload in (b"{invalid", b"[]", b"x" * 1025,
                            b'{"handle":"group-id"}', b'{"handle":"+15550100001","extra":true}'):
                output = io.StringIO()
                with mock.patch.object(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(payload))), redirect_stdout(output):
                    with self.assertRaises(SystemExit):
                        contacts.cmd_shared_city(None)
                self.assertEqual(json.loads(output.getvalue()), {"ok": False, "error": "Shared city unavailable"})
            output = io.StringIO()
            response = {"ok": True, "handle": HANDLE, "city": None, "reason": "location-unavailable"}
            with mock.patch.object(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(json.dumps({"handle": HANDLE}).encode()))), \
                    mock.patch.object(city, "shared_city", return_value=response) as shared, redirect_stdout(output):
                contacts.cmd_shared_city(None)
            self.assertEqual(json.loads(output.getvalue()), response)
            shared.assert_called_once_with(HANDLE, contacts, enabled=True)


if __name__ == "__main__":
    unittest.main()
