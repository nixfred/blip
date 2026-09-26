#!/usr/bin/env python3
"""Regression: pins and merged DMs must follow the whole conversation cluster."""
from __future__ import annotations

from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
import sqlite3
import sys
import unittest
from pathlib import Path

IMSG = Path(__file__).with_name("imsg")


def load_imsg():
    loader = SourceFileLoader("blip_imsg", str(IMSG))
    spec = spec_from_loader(loader.name, loader)
    assert spec is not None
    mod = module_from_spec(spec)
    sys.modules[loader.name] = mod
    loader.exec_module(mod)
    return mod


def schema(con: sqlite3.Connection) -> None:
    con.executescript(
        """
        CREATE TABLE chat (
          ROWID INTEGER PRIMARY KEY,
          chat_identifier TEXT,
          guid TEXT,
          display_name TEXT,
          style INTEGER,
          group_id TEXT,
          original_group_id TEXT
        );
        CREATE TABLE message (
          ROWID INTEGER PRIMARY KEY,
          date INTEGER,
          item_type INTEGER
        );
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
        CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
        CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
        CREATE TABLE chat_recoverable_message_join (message_id INTEGER);
        """
    )


def add_msg(con, chat_row: int, msg_row: int, date: int) -> None:
    con.execute("INSERT INTO message (ROWID, date, item_type) VALUES (?, ?, 0)", (msg_row, date))
    con.execute("INSERT INTO chat_message_join VALUES (?, ?)", (chat_row, msg_row))


class ClusterPins(unittest.TestCase):
    def setUp(self) -> None:
        self.imsg = load_imsg()
        self.con = sqlite3.connect(":memory:")
        self.con.row_factory = sqlite3.Row
        schema(self.con)

    def test_same_chat_id_treats_dashed_and_plain_uuid_as_equal(self) -> None:
        dashed = "AB50F3F5-B1B1-42E8-8FC4-39E194755E41"
        plain = "ab50f3f5b1b142e88fc439e194755e41"
        self.assertTrue(self.imsg._same_chat_id(dashed, plain))
        self.assertFalse(self.imsg._same_chat_id(dashed, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))

    def test_group_pin_resolves_through_chat_lookup(self) -> None:
        # LMT, 2026-09-26: the pin's ids (pP entry and pZ.o) matched no chat
        # row's group_id or original_group_id; Messages maps them to the live
        # chat in chat_lookup (domain iMessageGroupID). Without it LMT fell
        # out of Favorites while the phone still showed it pinned.
        live = "ce5a593a78af408282d61461ade89135"
        self.con.execute(
            "INSERT INTO chat VALUES (1, ?, 'any;+;' || ?, 'LMT', 43, "
            "'53466BFF-732F-4270-836E-B5B18DB1CD10', 'E203FF66-DC0F-4B7C-BB99-C8CBB1EABF44')",
            (live, live),
        )
        self.con.executescript(
            "CREATE TABLE chat_lookup (identifier TEXT, domain TEXT, chat INTEGER, priority INTEGER);"
            "INSERT INTO chat_lookup VALUES ('76377A76-A8B0-49BE-B7CC-EC9A287E948F', 'iMessageGroupID', 1, 0);"
            "INSERT INTO chat_lookup VALUES ('+15550100009', 'iMessageHandle', 1, 0);"
        )
        pins = [{"thomasonix@example.com"},
                {"76377A76-A8B0-49BE-B7CC-EC9A287E948F", "ADDDE374-5030-4C87-99F3-E356F950117F"}]
        cands = [live, f"any;+;{live}", "53466BFF-732F-4270-836E-B5B18DB1CD10"]
        self.assertIsNone(self.imsg.pin_order_for(pins, *cands))  # the bug
        expanded = self.imsg.expand_pins_via_lookup(self.con, pins)
        self.assertEqual(self.imsg.pin_order_for(expanded, *cands), 1)
        self.assertEqual(expanded[0], pins[0])  # a DM pin is untouched
        # an older macOS without chat_lookup leaves the pins as they were
        bare = sqlite3.connect(":memory:")
        self.assertEqual(self.imsg.expand_pins_via_lookup(bare, pins), pins)

    def test_rekeyed_group_pin_on_retired_row_attaches_to_live_id(self) -> None:
        live = "4b3d072e07b14bf88b4b8fde00deebcf"
        old = "chat909594254947022019"
        pin = "84177BB6AEADC8C5ED2A2B2CC89B1D8F47247C23"
        members = ["+15550100001", "+15550100002"]
        self.con.execute(
            "INSERT INTO chat VALUES (1, ?, 'any;+;' || ?, 'Sportsball!', 43, "
            "'AB50F3F5-B1B1-42E8-8FC4-39E194755E41', 'AB50F3F5-B1B1-42E8-8FC4-39E194755E41')",
            (live, live),
        )
        self.con.execute(
            "INSERT INTO chat VALUES (2, ?, 'any;+;' || ?, 'Sportsball!', 43, ?, "
            "'A1322320-8A1A-4F3D-885C-47DD657F556A')",
            (old, old, pin),
        )
        for i, h in enumerate(members, start=1):
            self.con.execute("INSERT INTO handle VALUES (?, ?)", (i, h))
            self.con.execute("INSERT INTO chat_handle_join VALUES (1, ?)", (i,))
            self.con.execute("INSERT INTO chat_handle_join VALUES (2, ?)", (i,))
        add_msg(self.con, 1, 10, 300)
        add_msg(self.con, 2, 11, 100)

        clusters = self.imsg._group_cluster_map(self.con)
        self.assertEqual(clusters[old], live)
        self.assertEqual(clusters[live], live)

        cands = self.imsg._cluster_pin_candidates(self.con, clusters)
        pins = [{pin}]
        self.assertEqual(self.imsg.pin_order_for(pins, *cands[live]), 0)
        # matching only the live row still misses it — that was the bug
        self.assertIsNone(self.imsg.pin_order_for(
            pins, live, f"any;+;{live}",
            "AB50F3F5-B1B1-42E8-8FC4-39E194755E41",
            "AB50F3F5-B1B1-42E8-8FC4-39E194755E41",
        ))

    def test_merged_dm_phone_and_email_share_one_conversation(self) -> None:
        phone = "+15550100001"
        email = "pat@example.com"
        gid = "531E435C-B41F-4494-B08A-9B4F935A52DB"
        self.con.execute(
            "INSERT INTO chat VALUES (1, ?, 'any;-;' || ?, '', 45, ?, 'AAAA')",
            (email, email, gid),
        )
        self.con.execute(
            "INSERT INTO chat VALUES (2, ?, 'any;-;' || ?, '', 45, ?, 'BBBB')",
            (phone, phone, gid),
        )
        add_msg(self.con, 1, 10, 300)   # email is newer → canonical
        add_msg(self.con, 2, 11, 100)

        clusters = self.imsg._group_cluster_map(self.con)
        self.assertEqual(clusters[phone], email)
        self.assertEqual(clusters[email], email)

        cands = self.imsg._cluster_pin_candidates(self.con, clusters)
        pins = [{phone}]
        self.assertEqual(self.imsg.pin_order_for(pins, *cands[email]), 0)

    def test_unrelated_dms_are_not_clustered(self) -> None:
        self.con.execute(
            "INSERT INTO chat VALUES (1, '+15550100001', 'any;-;+15550100001', '', 45, 'GID-A', 'A')"
        )
        self.con.execute(
            "INSERT INTO chat VALUES (2, '+15550100002', 'any;-;+15550100002', '', 45, 'GID-B', 'B')"
        )
        add_msg(self.con, 1, 10, 300)
        add_msg(self.con, 2, 11, 200)
        self.assertEqual(self.imsg._group_cluster_map(self.con), {})


if __name__ == "__main__":
    unittest.main()
