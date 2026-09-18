"""Read pushes use synthetic IDs and mocked UI calls; never open Messages."""
import importlib.machinery
import importlib.util
from pathlib import Path
import unittest
import os
import sqlite3
import tempfile
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse
from subprocess import CompletedProcess

loader = importlib.machinery.SourceFileLoader("imsg_read", str(Path(__file__).with_name("imsg-read")))
spec = importlib.util.spec_from_loader(loader.name, loader)
read = importlib.util.module_from_spec(spec)
loader.exec_module(read)


class ReadTests(unittest.TestCase):
    def test_group_and_direct_urls(self):
        for identifier, key in [("chat12345", "groupid"), ("a" * 32, "groupid"),
                                ("+15551234567", "address"), ("12345", "address"),
                                ("person+tag@example.com", "address")]:
            self.assertEqual(parse_qs(urlparse(read.chat_url(identifier)).query), {key: [identifier]})
            self.assertTrue(read.chat_url(identifier).startswith("imessage:open?"))

    def test_private_lock_refuses_symlinks(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(read.os.path, "expanduser", return_value=folder):
            with read.messages_ui_lock():
                self.assertEqual(os.stat(Path(folder) / "messages-ui.lock").st_mode & 0o777, 0o600)
            (Path(folder) / "messages-ui.lock").unlink()
            (Path(folder) / "messages-ui.lock").symlink_to(Path(folder) / "other")
            with self.assertRaises(OSError):
                with read.messages_ui_lock():
                    self.fail("symlink lock accepted")

    def test_no_url_parameter_injection(self):
        handle = "person&body=wrong@example.com"
        self.assertEqual(parse_qs(urlparse(read.chat_url(handle)).query), {"address": [handle]})
        for value in ["", "group name", "chat123?body=bad", "person\x00@example.com", "a" * 255]:
            with self.assertRaises(ValueError):
                read.chat_url(value)

    def run_chat(self, before=1, select_error="", click_error=""):
        with patch.object(read.sys, "argv", ["imsg-read", "--chat", "chat12345"]), \
             patch.object(read, "ensure_messages", return_value=""), \
             patch.object(read, "accessibility", return_value=""), \
             patch.object(read, "unread_on_mac", return_value=before), \
             patch.object(read, "frontmost", return_value="Previous app"), \
             patch.object(read, "select_chat", return_value=select_error) as select, \
             patch.object(read, "click", return_value=(not click_error, click_error)) as click, \
             patch.object(read, "settle", return_value=0) as settle, \
             patch.object(read, "restore_front") as restore:
            try:
                read.main()
            except SystemExit:
                pass
            return select, click, settle, restore

    def test_group_read_and_focus_restored(self):
        select, click, settle, restore = self.run_chat()
        select.assert_called_once_with("chat12345")
        click.assert_called_once_with("Mark as Read")
        settle.assert_called_once_with(1, "chat12345")
        restore.assert_called_once_with("Previous app")

    def test_open_failure_never_clicks_another_conversation(self):
        _, click, _, restore = self.run_chat(select_error="could not open")
        click.assert_not_called()
        restore.assert_called_once()

    def test_menu_failure_restores_focus(self):
        _, _, _, restore = self.run_chat(click_error="not available")
        restore.assert_called_once()

    def test_url_dispatch_without_a_window_is_not_selection_success(self):
        with patch.object(read.subprocess, "run", return_value=CompletedProcess([], 0)), \
             patch.object(read, "osa", return_value=(0, "0")):
            self.assertIn("no accessible window", read.select_chat("chat12345"))

    def test_failed_url_dispatch_does_not_query_or_click_a_window(self):
        with patch.object(read.subprocess, "run", return_value=CompletedProcess([], 1)), \
             patch.object(read, "osa") as osa:
            self.assertIn("could not open", read.select_chat("chat12345"))
            osa.assert_not_called()

    def test_already_read_never_opens_messages(self):
        select, click, settle, restore = self.run_chat(before=0)
        for call in (select, click, settle, restore):
            call.assert_not_called()



class ClusterScopedUnread(unittest.TestCase):
    """The push's referee must count the whole conversation, not one chat row.

    Messages splits one conversation across several chat rows: a re-keyed
    group keeps its retired row, and a merged 1:1 keeps a phone row beside an
    email row. Blip pushes ONE identifier. When the unread sits on an alias,
    a per-row count reports "nothing unread" and --chat exits 0 having done
    nothing at all.
    """

    SCHEMA = """
        CREATE TABLE chat (
          ROWID INTEGER PRIMARY KEY,
          chat_identifier TEXT,
          guid TEXT,
          display_name TEXT,
          style INTEGER,
          group_id TEXT,
          original_group_id TEXT,
          last_read_message_timestamp INTEGER DEFAULT 0
        );
        CREATE TABLE message (
          ROWID INTEGER PRIMARY KEY,
          date INTEGER,
          item_type INTEGER DEFAULT 0,
          is_from_me INTEGER DEFAULT 0,
          is_read INTEGER DEFAULT 0,
          associated_message_type INTEGER DEFAULT 0,
          group_title TEXT
        );
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
        CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
        CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
        CREATE TABLE chat_recoverable_message_join (message_id INTEGER);
    """

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.db = str(Path(self.folder.name) / "chat.db")
        con = sqlite3.connect(self.db)
        con.executescript(self.SCHEMA)
        con.commit()
        con.close()
        # imsg caches the message columns from whichever database it saw first.
        read.imsg_module()._COLS = None
        self.patch = patch.object(read, "DB_PATH", self.db)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def write(self, statements):
        con = sqlite3.connect(self.db)
        for sql, args in statements:
            con.execute(sql, args)
        con.commit()
        con.close()

    def unread_row(self, chat_row, msg_row, date):
        return [
            ("INSERT INTO message (ROWID, date, is_from_me, is_read) VALUES (?, ?, 0, 0)", (msg_row, date)),
            ("INSERT INTO chat_message_join VALUES (?, ?)", (chat_row, msg_row)),
        ]

    def test_merged_dm_counts_the_unread_on_its_other_handle(self):
        """Phone row + email row, one group_id. The unread is on the email row;
        Blip pushes the phone identifier."""
        rows = [
            ("INSERT INTO chat (ROWID, chat_identifier, guid, display_name, style, group_id) "
             "VALUES (1, '+15550100001', 'SMS;-;+15550100001', '', 45, 'MERGED-DM-1')", ()),
            ("INSERT INTO chat (ROWID, chat_identifier, guid, display_name, style, group_id) "
             "VALUES (2, 'pat@example.com', 'iMessage;-;pat@example.com', '', 45, 'MERGED-DM-1')", ()),
            ("INSERT INTO handle VALUES (1, '+15550100001')", ()),
            ("INSERT INTO handle VALUES (2, 'pat@example.com')", ()),
            ("INSERT INTO chat_handle_join VALUES (1, 1)", ()),
            ("INSERT INTO chat_handle_join VALUES (2, 2)", ()),
        ]
        self.write(rows + self.unread_row(2, 10, 700000000000000000))
        self.assertEqual(read.unread_on_mac("+15550100001"), 1)
        self.assertEqual(read.unread_on_mac("pat@example.com"), 1)

    def test_rekeyed_group_counts_the_unread_on_its_retired_row(self):
        """Same name, same members, new chat_identifier and new group_id. The
        unread is on the retired row; Blip pushes the live one."""
        live, retired = "4b3d072e07b14bf88b4b8fde00deebcf", "chat909594254947022019"
        rows = [
            ("INSERT INTO chat (ROWID, chat_identifier, guid, display_name, style, group_id) "
             "VALUES (1, ?, 'any;+;' || ?, 'Sportsball!', 43, 'LIVE-GROUP')", (live, live)),
            ("INSERT INTO chat (ROWID, chat_identifier, guid, display_name, style, group_id) "
             "VALUES (2, ?, 'any;+;' || ?, 'Sportsball!', 43, 'RETIRED-GROUP')", (retired, retired)),
            ("INSERT INTO handle VALUES (1, '+15550100001')", ()),
            ("INSERT INTO handle VALUES (2, '+15550100002')", ()),
            ("INSERT INTO chat_handle_join VALUES (1, 1)", ()),
            ("INSERT INTO chat_handle_join VALUES (1, 2)", ()),
            ("INSERT INTO chat_handle_join VALUES (2, 1)", ()),
            ("INSERT INTO chat_handle_join VALUES (2, 2)", ()),
        ]
        # The live row is the one with the newest message, as Messages has it.
        self.write(rows + [
            ("INSERT INTO message (ROWID, date, is_from_me, is_read) VALUES (5, 800000000000000000, 1, 1)", ()),
            ("INSERT INTO chat_message_join VALUES (1, 5)", ()),
        ] + self.unread_row(2, 11, 700000000000000000))
        self.assertEqual(read.unread_on_mac(live), 1)

    def test_an_unrelated_conversation_is_never_folded_in(self):
        """Two chats that share nothing stay two: the widened scope must not
        turn every push into a mark-all."""
        rows = [
            ("INSERT INTO chat (ROWID, chat_identifier, guid, display_name, style, group_id) "
             "VALUES (1, '+15550100001', 'iMessage;-;+15550100001', '', 45, 'DM-ONE')", ()),
            ("INSERT INTO chat (ROWID, chat_identifier, guid, display_name, style, group_id) "
             "VALUES (2, '+15550100002', 'iMessage;-;+15550100002', '', 45, 'DM-TWO')", ()),
            ("INSERT INTO handle VALUES (1, '+15550100001')", ()),
            ("INSERT INTO handle VALUES (2, '+15550100002')", ()),
            ("INSERT INTO chat_handle_join VALUES (1, 1)", ()),
            ("INSERT INTO chat_handle_join VALUES (2, 2)", ()),
        ]
        self.write(rows + self.unread_row(2, 12, 700000000000000000))
        self.assertEqual(read.unread_on_mac("+15550100001"), 0)
        self.assertEqual(read.unread_on_mac("+15550100002"), 1)

    def test_an_unreadable_cluster_still_counts_the_pushed_row(self):
        """imsg gone or a schema it cannot read: fall back to the identifier
        alone rather than losing the count entirely."""
        self.write(self.unread_row(1, 13, 700000000000000000) + [
            ("INSERT INTO chat (ROWID, chat_identifier, guid, display_name, style, group_id) "
             "VALUES (1, '+15550100001', 'iMessage;-;+15550100001', '', 45, NULL)", ()),
        ])
        with patch.object(read, "imsg_module", side_effect=OSError("no imsg here")):
            self.assertEqual(read.unread_on_mac("+15550100001"), 1)
            self.assertEqual(read.unread_on_mac("+15550100009"), 0)

if __name__ == "__main__":
    unittest.main()
