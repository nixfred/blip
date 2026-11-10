#!/usr/bin/env python3
"""The serve channel's reachable surface.

`imsg serve` re-dispatches requests through the SAME parser the CLI uses, so
there is no second command table to drift. What it must NOT do is widen what
the confined ssh key can reach: the channel answers read-only queries and
nothing else."""
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


def load(tool: str):
    loader = SourceFileLoader(f"blip_{tool}", str(HERE / tool))
    spec = spec_from_loader(loader.name, loader)
    assert spec is not None
    mod = module_from_spec(spec)
    sys.modules[loader.name] = mod
    loader.exec_module(mod)
    return mod


imsg = load("imsg")


class ServeSurface(unittest.TestCase):
    def test_only_read_only_queries_are_reachable(self):
        self.assertEqual(
            imsg.SERVE_ALLOWED,
            {"recent", "from", "thread", "search", "contacts", "chats", "groups", "analyze", "read-state", "session"},
        )

    def test_streaming_and_blocking_commands_stay_one_shot(self):
        # attachment/avatar write binary and would park the channel behind a
        # 100 MB photo; watch blocks forever; serve would recurse.
        for cmd in ("attachment", "avatar", "watch", "serve"):
            self.assertNotIn(cmd, imsg.SERVE_ALLOWED, f"{cmd} must not be reachable on the channel")

    def test_serve_reuses_the_real_parser(self):
        # A second, hand-rolled command table would drift from the CLI and
        # become a second security surface.
        p = imsg.build_parser()
        ns = p.parse_args(["--json", "--rich", "thread", "--chat", "chat123", "40"])
        self.assertEqual(ns.cmd, "thread")
        self.assertEqual(ns.chat, "chat123")
        self.assertIn(ns.cmd, imsg.SERVE_ALLOWED)

    def test_serve_is_a_real_subcommand(self):
        ns = imsg.build_parser().parse_args(["serve"])
        self.assertEqual(ns.func, imsg.cmd_serve)


class ContactIndex(unittest.TestCase):
    """The suffix bucket must answer exactly as the old full scan did."""

    def test_a_match_always_shares_the_last_seven_digits(self):
        # This is what makes bucketing sound: _same_number only matches when
        # one national number is a SUFFIX of the other, with a floor of seven
        # digits — so the last seven always agree.
        n = imsg._LOCAL_NUMBER_DIGITS
        self.assertEqual(n, 7)
        pairs = [
            (("1", "2145550123"), ("1", "2145550123")),
            (("47", "12345678"), ("47", "12345678")),
            (("44", "7700900123"), ("44", "07700900123")),   # saved trunk zero
        ]
        for handle, card in pairs:
            if imsg._same_number(handle, card):
                stripped = card[1].removeprefix("0")
                self.assertTrue(
                    handle[1][-n:] in (card[1][-n:], stripped[-n:]),
                    f"{handle} vs {card} matched without sharing the last {n} digits",
                )

    def test_forgetting_contacts_clears_every_index(self):
        # The serve channel outlives an edit in Contacts.app, so it re-reads.
        imsg._NAME_CACHE["x"] = "stale"
        imsg._forget_contacts()
        self.assertEqual(imsg._NAME_CACHE, {})
        self.assertIsNone(imsg._NAME_INDEX)
        self.assertIsNone(imsg._PHONE_SUFFIX)
        self.assertEqual(imsg._EXACT_SEEN, set())


def chat_db() -> sqlite3.Connection:
    """The columns _group_cluster_map reads, in memory. No real chat.db."""
    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row
    con.executescript(
        """
        CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, guid TEXT,
                           display_name TEXT, style INTEGER, group_id TEXT, original_group_id TEXT);
        CREATE TABLE message (ROWID INTEGER PRIMARY KEY, date INTEGER, item_type INTEGER);
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
        CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
        CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
        CREATE TABLE chat_recoverable_message_join (message_id INTEGER);
        """
    )
    return con


def add_msg(con, chat_row: int, msg_row: int, date: int) -> None:
    con.execute("INSERT INTO message (ROWID, date, item_type) VALUES (?, ?, 0)", (msg_row, date))
    con.execute("INSERT INTO chat_message_join VALUES (?, ?)", (chat_row, msg_row))


class ClusterCacheFollowsWhatItDerivesFrom(unittest.TestCase):
    """A long-lived channel must not answer with a stale conversation cluster.
    (count, max ROWID) of the chat table missed every one of these."""

    PHONE, EMAIL = "+15550100001", "pat@example.com"

    def setUp(self) -> None:
        imsg._CLUSTER_CACHE = None
        self.con = chat_db()
        self.con.execute("INSERT INTO chat VALUES (1, ?, '', '', 45, 'G1', '')", (self.PHONE,))
        self.con.execute("INSERT INTO chat VALUES (2, ?, '', '', 45, 'G2', '')", (self.EMAIL,))
        add_msg(self.con, 1, 10, 100)
        add_msg(self.con, 2, 11, 200)

    def clusters(self) -> dict:
        return imsg._group_cluster_map(self.con)

    def test_a_group_id_update_reclusters(self):
        # The review's probe: two DMs, then Messages merges them by giving the
        # second the first's group_id. Row count and max ROWID do not move.
        self.assertEqual(self.clusters(), {})
        self.con.execute("UPDATE chat SET group_id = 'G1' WHERE ROWID = 2")
        self.assertEqual(self.clusters(), {self.PHONE: self.EMAIL, self.EMAIL: self.EMAIL})

    def test_a_new_message_moves_the_canonical_alias(self):
        self.con.execute("UPDATE chat SET group_id = 'G1' WHERE ROWID = 2")
        self.assertEqual(self.clusters()[self.PHONE], self.EMAIL)
        add_msg(self.con, 1, 12, 300)          # the phone row is the live one now
        self.assertEqual(self.clusters()[self.EMAIL], self.PHONE)

    def test_recently_deleted_moves_the_canonical_alias_back(self):
        self.con.execute("UPDATE chat SET group_id = 'G1' WHERE ROWID = 2")
        add_msg(self.con, 1, 12, 300)
        self.assertEqual(self.clusters()[self.EMAIL], self.PHONE)
        # Deleting that message adds no row anywhere a ROWID could see.
        self.con.execute("INSERT INTO chat_recoverable_message_join VALUES (12)")
        self.assertEqual(self.clusters()[self.PHONE], self.EMAIL)

    def test_membership_decides_a_group_cluster(self):
        for rid, cid in ((3, "chat100"), (4, "chat200")):
            self.con.execute("INSERT INTO chat VALUES (?, ?, '', 'Crew', 43, ?, '')", (rid, cid, cid))
        for hid, h in ((1, "+15550100002"), (2, "+15550100003")):
            self.con.execute("INSERT INTO handle VALUES (?, ?)", (hid, h))
        self.con.execute("INSERT INTO chat_handle_join VALUES (3, 1)")
        self.con.execute("INSERT INTO chat_handle_join VALUES (3, 2)")
        self.con.execute("INSERT INTO chat_handle_join VALUES (4, 1)")
        add_msg(self.con, 3, 20, 100)
        add_msg(self.con, 4, 21, 200)
        self.assertNotIn("chat100", self.clusters())
        # Same name, and now the same members: one conversation.
        self.con.execute("INSERT INTO chat_handle_join VALUES (4, 2)")
        self.assertEqual(self.clusters().get("chat100"), "chat200")

    def test_nothing_new_is_a_cache_hit(self):
        first = self.clusters()
        self.assertIs(self.clusters(), first)


class ContactsGenerationSeesTheWal(unittest.TestCase):
    """The Contacts index is rebuilt when anything it derives from moves —
    including a commit still sitting in the WAL, accounts and the region."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = self.tmp.name
        os.makedirs(os.path.join(root, "Sources", "A"))
        self.book = os.path.join(root, "Sources", "A", "AddressBook-v22.abcddb")
        self.saved = (imsg._AB_GLOB, imsg._ACCOUNTS_DB, imsg._GLOBAL_PREFS)
        imsg._AB_GLOB = os.path.join(root, "Sources", "*", "AddressBook-v22.abcddb")
        imsg._ACCOUNTS_DB = os.path.join(root, "Accounts4.sqlite")
        imsg._GLOBAL_PREFS = os.path.join(root, "prefs.plist")

    def tearDown(self) -> None:
        imsg._AB_GLOB, imsg._ACCOUNTS_DB, imsg._GLOBAL_PREFS = self.saved
        self.tmp.cleanup()

    def test_a_commit_not_yet_checkpointed_changes_the_generation(self):
        writer = sqlite3.connect(self.book)
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute("CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT)")
        writer.commit()
        writer.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        before = imsg._contacts_generation()
        writer.execute("INSERT INTO ZABCDRECORD (ZFIRSTNAME) VALUES ('Pat')")
        writer.commit()                      # in the WAL; the base file is untouched
        try:
            self.assertNotEqual(imsg._contacts_generation(), before)
        finally:
            writer.close()

    def test_accounts_and_region_are_dependencies(self):
        before = imsg._contacts_generation()
        with open(imsg._ACCOUNTS_DB, "wb") as fh:
            fh.write(b"x")
        after_accounts = imsg._contacts_generation()
        self.assertNotEqual(after_accounts, before)
        with open(imsg._GLOBAL_PREFS, "wb") as fh:
            fh.write(b"y")
        self.assertNotEqual(imsg._contacts_generation(), after_accounts)

    def test_forgetting_contacts_forgets_the_region(self):
        imsg._home_calling_code()
        self.assertGreaterEqual(imsg._home_calling_code.cache_info().currsize, 1)
        imsg._forget_contacts()
        self.assertEqual(imsg._home_calling_code.cache_info().currsize, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
