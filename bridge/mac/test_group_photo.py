#!/usr/bin/env python3
"""Regression: group photos live on item_type=3 rows that MESSAGE_SRC hides."""
from __future__ import annotations

from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
import plistlib
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
          display_name TEXT,
          style INTEGER,
          group_id TEXT,
          original_group_id TEXT,
          properties BLOB
        );
        CREATE TABLE message (
          ROWID INTEGER PRIMARY KEY,
          date INTEGER,
          item_type INTEGER
        );
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
        CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
        CREATE TABLE attachment (
          ROWID INTEGER PRIMARY KEY,
          filename TEXT,
          transfer_name TEXT,
          guid TEXT,
          original_guid TEXT
        );
        CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
        CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
        CREATE TABLE chat_recoverable_message_join (message_id INTEGER);
        """
    )


class GroupPhotoPath(unittest.TestCase):
    def setUp(self) -> None:
        self.imsg = load_imsg()
        self.con = sqlite3.connect(":memory:")
        self.con.row_factory = sqlite3.Row
        schema(self.con)

    def test_finds_photo_on_announcement_row(self) -> None:
        cid = "chat640665907856941413"
        path = "~/Library/Messages/Attachments/xx/GroupPhotoImage"
        self.con.execute(
            "INSERT INTO chat (ROWID, chat_identifier, display_name, style) VALUES (1, ?, 'Sportsball!', 43)",
            (cid,),
        )
        self.con.execute("INSERT INTO message (ROWID, date, item_type) VALUES (10, 100, 3)")
        self.con.execute("INSERT INTO chat_message_join VALUES (1, 10)")
        self.con.execute(
            "INSERT INTO attachment (ROWID, filename, transfer_name) VALUES (20, ?, 'GroupPhotoImage')",
            (path,),
        )
        self.con.execute("INSERT INTO message_attachment_join VALUES (10, 20)")
        got = self.imsg._group_photo_path(self.con, cid)
        self.assertTrue(got.endswith("GroupPhotoImage"))

    def test_group_photo_guid_when_filename_on_join_is_null(self) -> None:
        cid = "053856bb0d9a40e392db59eace1c56d1"
        path = "~/Library/Messages/Attachments/yy/GroupPhotoImage"
        guid = "AAAA-PHOTO-GUID"
        props = plistlib.dumps({"groupPhotoGuid": guid}, fmt=plistlib.FMT_BINARY)
        self.con.execute(
            "INSERT INTO chat (ROWID, chat_identifier, display_name, style, properties) VALUES (1, ?, 'Named', 43, ?)",
            (cid, props),
        )
        self.con.execute("INSERT INTO message (ROWID, date, item_type) VALUES (10, 100, 3)")
        self.con.execute("INSERT INTO chat_message_join VALUES (1, 10)")
        self.con.execute(
            "INSERT INTO attachment (ROWID, filename, transfer_name, guid) VALUES (20, NULL, 'GroupPhotoImage', ?)",
            (guid,),
        )
        self.con.execute("INSERT INTO message_attachment_join VALUES (10, 20)")
        self.con.execute(
            "INSERT INTO attachment (ROWID, filename, guid) VALUES (21, ?, ?)",
            (path, guid),
        )
        got = self.imsg._group_photo_path(self.con, cid)
        self.assertTrue(got.endswith("GroupPhotoImage"))


if __name__ == "__main__":
    unittest.main()
