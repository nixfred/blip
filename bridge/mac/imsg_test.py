#!/usr/bin/env python3
"""Projection tests for the Messages conversation list."""

import importlib.machinery
import importlib.util
import contextlib
import io
import json
import os
import sqlite3
import tempfile
import unittest
from types import SimpleNamespace


def load_imsg():
    path = os.path.join(os.path.dirname(__file__), "imsg")
    loader = importlib.machinery.SourceFileLoader("blip_imsg", path)
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


imsg = load_imsg()


class ShortNameTests(unittest.TestCase):
    def test_structured_short_names_preserve_multiword_names_and_safe_fallbacks(self):
        original = imsg.name_for
        saved = imsg._SHORT_NAMES
        try:
            imsg.name_for = lambda _: "Mary Jane Example"
            imsg._SHORT_NAMES = {"Mary Jane Example": {"Mary Jane"}}
            self.assertEqual(imsg.short_name_for("+15551234567"), "Mary Jane")
            imsg._SHORT_NAMES = {"Mary Jane Example": {"Mary Jane", "Mary"}}
            self.assertEqual(imsg.short_name_for("+15551234567"), "Mary Jane Example")
            imsg._SHORT_NAMES = {}
            self.assertEqual(imsg.short_name_for("+15551234567"), "Mary Jane Example")
        finally:
            imsg.name_for = original
            imsg._SHORT_NAMES = saved


class ChatPreviewUsesJoinIndex(unittest.TestCase):
    """cmd_chats finds each conversation's newest visible message through the join
    index when chat_message_join carries message_date, and through the original
    expression ORDER BY when it does not. They must answer alike.

    Dates are distinct within a chat: which of two rows with the SAME nanosecond
    wins was never specified, and is not what is being held fixed here."""

    def build(self, rows, with_join_date):
        con = sqlite3.connect(":memory:")
        con.row_factory = sqlite3.Row
        con.executescript(f"""
            CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, guid TEXT, display_name TEXT,
              room_name TEXT, service_name TEXT, group_id TEXT, original_group_id TEXT, style INTEGER);
            CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
            CREATE TABLE message (ROWID INTEGER PRIMARY KEY, date INTEGER, text TEXT, attributedBody BLOB,
              is_from_me INTEGER, handle_id INTEGER, balloon_bundle_id TEXT, payload_data BLOB,
              item_type INTEGER DEFAULT 0, schedule_type INTEGER, schedule_state INTEGER);
            CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER{", message_date INTEGER" if with_join_date else ""});
            CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
            CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, transfer_name TEXT, mime_type TEXT, uti TEXT);
            CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
            CREATE TABLE chat_recoverable_message_join (message_id INTEGER);
            INSERT INTO handle VALUES (1, '+15550000001');
        """)
        chats = sorted({r[0] for r in rows})
        for cid in chats:
            con.execute("INSERT INTO chat VALUES (?,?,NULL,NULL,NULL,'iMessage',NULL,NULL,45)", (cid, "+1555000%04d" % cid))
        for mid, (cid, date, text, sched, deleted) in enumerate(rows, 1):
            con.execute("INSERT INTO message (ROWID,date,text,is_from_me,handle_id,schedule_type,schedule_state) VALUES (?,?,?,0,1,?,?)",
                        (mid, date, text, sched[0], sched[1]))
            if with_join_date:
                con.execute("INSERT INTO chat_message_join VALUES (?,?,?)", (cid, mid, date))
            else:
                con.execute("INSERT INTO chat_message_join VALUES (?,?)", (cid, mid))
            if deleted:
                con.execute("INSERT INTO chat_recoverable_message_join VALUES (?)", (mid,))
        return con

    CACHES = ("_COLS", "_CHAT_COLS", "_BASE_SELECT_CACHE", "_CLUSTER_CACHE", "_PINS_CACHE")

    def chats(self, con):
        # imsg memoises schema probes per process. Clear them on the way in (each database has its
        # own columns) AND on the way out: the older tests in this file assume an empty cache.
        for name in self.CACHES:
            setattr(imsg, name, None)
        pins, names = imsg.pinned_chat_identifiers, imsg.unified_names
        imsg.pinned_chat_identifiers, imsg.unified_names = (lambda: []), (lambda _h: {})
        try:
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                imsg.cmd_chats(con, SimpleNamespace(n=300, json=True, no_names=True))
            return json.loads(out.getvalue())
        finally:
            imsg.pinned_chat_identifiers, imsg.unified_names = pins, names
            for name in self.CACHES:
                setattr(imsg, name, None)

    def previews(self, rows, with_join_date=True):
        return {r["id"]: r.get("last_text") for r in self.chats(self.build(rows, with_join_date))}

    PLAIN, NULLS, WAITING, SENT = (0, 0), (None, None), (2, 2), (2, 3)

    def test_a_waiting_send_later_never_becomes_the_preview(self):
        rows = [(1, 100, "hello", self.PLAIN, 0), (1, 900, "scheduled for next week", self.WAITING, 0)]
        self.assertEqual(self.previews(rows), {"+15550000001": "hello"})

    def test_a_chat_with_only_waiting_rows_still_has_a_preview(self):
        rows = [(1, 500, "later", self.WAITING, 0), (1, 700, "much later", self.WAITING, 0)]
        for with_join_date in (True, False):
            self.assertEqual(self.previews(rows, with_join_date), {"+15550000001": "much later"})

    def test_a_null_schedule_is_not_pending(self):
        rows = [(1, 100, "old", self.NULLS, 0), (1, 200, "newest, schedule columns NULL", self.NULLS, 0)]
        for with_join_date in (True, False):
            self.assertEqual(self.previews(rows, with_join_date), {"+15550000001": "newest, schedule columns NULL"})

    def test_a_stray_null_schedule_no_longer_outranks_a_newer_ordinary_row(self):
        # The expression query sorted NULL before 0, so an OLDER row with NULL schedule columns beat a
        # newer ordinary one. Messages writes 0, never NULL; the join-index path gives the intended
        # answer (the newest visible message) and this pins it.
        rows = [(1, 100, "older, NULL schedule", self.NULLS, 0), (1, 200, "newer, ordinary", self.PLAIN, 0)]
        self.assertEqual(self.previews(rows), {"+15550000001": "newer, ordinary"})

    def test_a_sent_send_later_row_is_an_ordinary_message(self):
        rows = [(1, 100, "old", self.PLAIN, 0), (1, 200, "went out", self.SENT, 0)]
        self.assertEqual(self.previews(rows), {"+15550000001": "went out"})

    def test_random_conversations_agree_with_the_expression_query(self):
        import random
        rng = random.Random(20261110)
        for case in range(400):
            rows, used = [], {}
            for _ in range(rng.randint(1, 14)):
                cid = rng.randint(1, 4)
                date = rng.choice([d for d in range(1, 60) if d not in used.setdefault(cid, set())])
                used[cid].add(date)
                rows.append((cid, date, "m%d" % len(rows), rng.choice([self.PLAIN, self.PLAIN, self.WAITING, self.SENT]),
                             1 if rng.random() < 0.1 else 0))
            fast = self.chats(self.build(rows, True))
            slow = self.chats(self.build(rows, False))
            self.assertEqual(fast, slow, "case %d rows=%r" % (case, rows))


class GuiSessionTests(unittest.TestCase):
    """`imsg session` reports whether anyone is logged in at the Mac's screen, because a send
    cannot start Messages without one (-10810) while reads keep working."""

    def alive(self, **run):
        from unittest.mock import patch
        with patch.object(imsg.subprocess, "run", **run) as mocked:
            return imsg.gui_session_alive(), mocked

    def test_the_gui_domain_exists_while_someone_is_logged_in(self):
        from types import SimpleNamespace as NS
        alive, run = self.alive(return_value=NS(returncode=0))
        self.assertIs(alive, True)
        argv = run.call_args.args[0]
        self.assertEqual(argv[:2], ["/bin/launchctl", "print"])
        self.assertEqual(argv[2], "gui/%d" % os.getuid())       # this user's own domain, nobody else's
        self.assertEqual(run.call_args.kwargs["timeout"], 5)
        self.assertIs(run.call_args.kwargs["stdout"], imsg.subprocess.DEVNULL)   # `print` is huge; none of it is read

    def test_no_gui_domain_means_nobody_is_logged_in(self):
        from types import SimpleNamespace as NS
        for rc in (112, 113, 1):                                # "Could not find domain", "does not support"
            self.assertIs(self.alive(return_value=NS(returncode=rc))[0], False)

    def test_a_probe_that_cannot_run_or_hangs_is_unknown_not_signed_out(self):
        import subprocess
        self.assertIsNone(self.alive(side_effect=FileNotFoundError())[0])
        self.assertIsNone(self.alive(side_effect=subprocess.TimeoutExpired("launchctl", 5))[0])

    def test_the_command_prints_one_versioned_json_line(self):
        from unittest.mock import patch
        for value in (True, False, None):
            out = io.StringIO()
            with patch.object(imsg, "gui_session_alive", return_value=value), contextlib.redirect_stdout(out):
                imsg.cmd_session(None, SimpleNamespace())
            self.assertEqual(json.loads(out.getvalue()), {"version": 1, "gui": value})
            self.assertEqual(out.getvalue().count("\n"), 1)

    def test_session_is_a_real_read_only_subcommand_on_the_serve_channel(self):
        ns = imsg.build_parser().parse_args(["--json", "session"])
        self.assertEqual(ns.func, imsg.cmd_session)
        self.assertIn("session", imsg.SERVE_ALLOWED)


class ChatProjectionTests(unittest.TestCase):
    def test_chat_json_deduplicates_parallel_service_rows(self):
        con = sqlite3.connect(":memory:")
        con.row_factory = sqlite3.Row
        con.executescript("""
            CREATE TABLE chat (
              ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, guid TEXT, display_name TEXT,
              room_name TEXT, service_name TEXT, group_id TEXT, original_group_id TEXT,
              style INTEGER
            );
            CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
            CREATE TABLE message (
              ROWID INTEGER PRIMARY KEY, date INTEGER, text TEXT,
              attributedBody BLOB, is_from_me INTEGER, handle_id INTEGER,
              balloon_bundle_id TEXT, payload_data BLOB, item_type INTEGER DEFAULT 0
            );
            CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
            CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
            CREATE TABLE attachment (
              ROWID INTEGER PRIMARY KEY, transfer_name TEXT, mime_type TEXT, uti TEXT
            );
            CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
            CREATE TABLE chat_recoverable_message_join (message_id INTEGER);
            INSERT INTO chat VALUES (1, '+15551234567', NULL, NULL, NULL, 'SMS', NULL, NULL, 45);
            INSERT INTO chat VALUES (2, '+15551234567', NULL, NULL, NULL, 'iMessage', NULL, NULL, 45);
            INSERT INTO handle VALUES (1, '+15551234567');
            INSERT INTO message (ROWID, date, text, attributedBody, is_from_me, handle_id) VALUES (10, 100, 'old', NULL, 0, 1);
            INSERT INTO message (ROWID, date, text, attributedBody, is_from_me, handle_id) VALUES (11, 200, 'new', NULL, 0, 1);
            INSERT INTO chat_message_join VALUES (1, 10);
            INSERT INTO chat_message_join VALUES (2, 11);
        """)
        original = imsg.pinned_chat_identifiers
        imsg.pinned_chat_identifiers = lambda: [{"+15551234567"}]
        try:
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                imsg.cmd_chats(con, SimpleNamespace(n=300, json=True, no_names=True))
            rows = json.loads(output.getvalue())
        finally:
            imsg.pinned_chat_identifiers = original
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["last_text"], "new")
        self.assertEqual(rows[0]["pin_order"], 0)

    def test_chat_json_labels_an_attachment_without_leaking_placeholder_text(self):
        con = sqlite3.connect(":memory:")
        con.row_factory = sqlite3.Row
        con.executescript("""
            CREATE TABLE chat (
              ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, guid TEXT, display_name TEXT,
              room_name TEXT, service_name TEXT, group_id TEXT, original_group_id TEXT,
              style INTEGER
            );
            CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
            CREATE TABLE message (
              ROWID INTEGER PRIMARY KEY, date INTEGER, text TEXT,
              attributedBody BLOB, is_from_me INTEGER, handle_id INTEGER,
              balloon_bundle_id TEXT, payload_data BLOB, item_type INTEGER DEFAULT 0
            );
            CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
            CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
            CREATE TABLE attachment (
              ROWID INTEGER PRIMARY KEY, transfer_name TEXT, mime_type TEXT, uti TEXT
            );
            CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
            CREATE TABLE chat_recoverable_message_join (message_id INTEGER);
            INSERT INTO chat VALUES (1, 'chat999', NULL, NULL, 'chat999', 'iMessage', NULL, NULL, 43);
            INSERT INTO handle VALUES (1, '+15551234567');
            INSERT INTO message (ROWID, date, text, attributedBody, is_from_me, handle_id) VALUES (10, 100, '￼', NULL, 0, 1);
            INSERT INTO chat_message_join VALUES (1, 10);
            INSERT INTO attachment VALUES (20, 'photo.HEIC', 'image/heic', NULL);
            INSERT INTO message_attachment_join VALUES (10, 20);
        """)
        original_pins = imsg.pinned_chat_identifiers
        original_names = imsg.unified_names
        imsg.pinned_chat_identifiers = lambda: []
        imsg.unified_names = lambda _handles: {}
        try:
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                imsg.cmd_chats(con, SimpleNamespace(n=300, json=True, no_names=True))
            rows = json.loads(output.getvalue())
        finally:
            imsg.pinned_chat_identifiers = original_pins
            imsg.unified_names = original_names
        self.assertIsNone(rows[0]["name"])
        self.assertEqual(rows[0]["last_attachment"]["mime"], "image/heic")

    def test_named_group_migrations_coalesce_only_with_the_same_participants(self):
        con = sqlite3.connect(":memory:")
        con.row_factory = sqlite3.Row
        con.executescript("""
            CREATE TABLE chat (
              ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, guid TEXT, display_name TEXT,
              room_name TEXT, service_name TEXT, group_id TEXT, original_group_id TEXT,
              style INTEGER
            );
            CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
            CREATE TABLE message (
              ROWID INTEGER PRIMARY KEY, date INTEGER, text TEXT,
              attributedBody BLOB, is_from_me INTEGER, handle_id INTEGER,
              balloon_bundle_id TEXT, payload_data BLOB, item_type INTEGER DEFAULT 0
            );
            CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
            CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
            CREATE TABLE attachment (
              ROWID INTEGER PRIMARY KEY, transfer_name TEXT, mime_type TEXT, uti TEXT
            );
            CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
            CREATE TABLE chat_recoverable_message_join (message_id INTEGER);
            INSERT INTO chat VALUES (1, 'old-group', NULL, 'Project Team', NULL, 'iMessage', 'old', NULL, 43);
            INSERT INTO chat VALUES (2, 'new-group', NULL, 'Project Team', NULL, 'iMessage', 'new', 'old', 43);
            INSERT INTO chat VALUES (3, 'other-group', NULL, 'Project Team', NULL, 'iMessage', 'other', NULL, 43);
            INSERT INTO handle VALUES (1, '+15550000001');
            INSERT INTO handle VALUES (2, '+15550000002');
            INSERT INTO handle VALUES (3, '+15550000003');
            INSERT INTO message (ROWID, date, text, attributedBody, is_from_me, handle_id) VALUES (10, 100, 'old', NULL, 0, 1);
            INSERT INTO message (ROWID, date, text, attributedBody, is_from_me, handle_id) VALUES (11, 200, 'new', NULL, 0, 1);
            INSERT INTO message (ROWID, date, text, attributedBody, is_from_me, handle_id) VALUES (12, 150, 'different people', NULL, 0, 3);
            INSERT INTO chat_message_join VALUES (1, 10);
            INSERT INTO chat_message_join VALUES (2, 11);
            INSERT INTO chat_message_join VALUES (3, 12);
            INSERT INTO chat_handle_join VALUES (1, 1);
            INSERT INTO chat_handle_join VALUES (1, 2);
            INSERT INTO chat_handle_join VALUES (2, 1);
            INSERT INTO chat_handle_join VALUES (2, 2);
            INSERT INTO chat_handle_join VALUES (3, 1);
            INSERT INTO chat_handle_join VALUES (3, 3);
        """)
        original_pins = imsg.pinned_chat_identifiers
        original_names = imsg.unified_names
        imsg.pinned_chat_identifiers = lambda: [{"old-group"}]
        imsg.unified_names = lambda _handles: {}
        try:
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                imsg.cmd_chats(con, SimpleNamespace(n=300, json=True, no_names=True))
            rows = json.loads(output.getvalue())
        finally:
            imsg.pinned_chat_identifiers = original_pins
            imsg.unified_names = original_names
        self.assertEqual(len(rows), 2)
        merged = next(row for row in rows if row["id"] == "new-group")
        self.assertEqual(merged["aliases"], ["old-group"])
        self.assertEqual(merged["messages"], 2)
        self.assertEqual(merged["pin_order"], 0)
        self.assertIn("other-group", [row["id"] for row in rows])


class AttachmentStoreTests(unittest.TestCase):
    """`imsg attachment` serves a file only from the directories message media
    lives in. Stickers are the third one: Messages keeps them in StickerCache,
    not Attachments, and the old two-root check refused every sticker sent."""

    def test_stickers_are_served_and_everything_outside_the_store_is_not(self):
        saved = (imsg.ATTACHMENTS_ROOT, imsg.STICKER_ROOT, imsg.SENT_ROOT)
        with tempfile.TemporaryDirectory() as tmp:
            roots = {n: os.path.join(tmp, "Messages", n) for n in ("Attachments", "StickerCache")}
            roots["sent"] = os.path.join(tmp, ".blip", "sent")
            outside = os.path.join(tmp, "Messages", "chat.db")
            for d in roots.values():
                os.makedirs(d)
                open(os.path.join(d, "file.png"), "w").close()
            open(outside, "w").close()
            # a sibling directory that shares StickerCache's name as a prefix
            os.makedirs(roots["StickerCache"] + "-evil")
            open(os.path.join(roots["StickerCache"] + "-evil", "file.png"), "w").close()
            # a link planted inside the sticker store, pointing out of it
            os.symlink(outside, os.path.join(roots["StickerCache"], "link.png"))
            try:
                imsg.ATTACHMENTS_ROOT, imsg.STICKER_ROOT, imsg.SENT_ROOT = (
                    roots["Attachments"], roots["StickerCache"], roots["sent"])
                for d in roots.values():
                    self.assertTrue(imsg._in_message_store(os.path.join(d, "file.png")), d)
                self.assertFalse(imsg._in_message_store(outside))
                self.assertFalse(imsg._in_message_store(os.path.join(roots["StickerCache"] + "-evil", "file.png")))
                self.assertFalse(imsg._in_message_store(os.path.join(roots["StickerCache"], "link.png")))
                self.assertFalse(imsg._in_message_store(os.path.join(roots["StickerCache"], "..", "chat.db")))
            finally:
                imsg.ATTACHMENTS_ROOT, imsg.STICKER_ROOT, imsg.SENT_ROOT = saved


if __name__ == "__main__":
    unittest.main()
