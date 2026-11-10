#!/usr/bin/env python3
"""Synthetic custom reaction rows only. Never opens the user's Messages database."""
import sqlite3
import unittest
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path


def load_imsg():
    loader = SourceFileLoader("blip_reaction_kind_test", str(Path(__file__).with_name("imsg")))
    module = module_from_spec(spec_from_loader(loader.name, loader))
    loader.exec_module(module)
    return module


T0 = 800_000_000_000_000_000


class ReactionKind(unittest.TestCase):
    def setUp(self):
        self.imsg = load_imsg()
        self.con = sqlite3.connect(":memory:")
        self.con.row_factory = sqlite3.Row
        self.con.executescript("""
            CREATE TABLE message (
              ROWID INTEGER PRIMARY KEY, guid TEXT, date INTEGER, is_from_me INTEGER DEFAULT 0,
              handle_id INTEGER DEFAULT 1, text TEXT, attributedBody BLOB, item_type INTEGER DEFAULT 0,
              associated_message_type INTEGER DEFAULT 0, associated_message_guid TEXT,
              associated_message_emoji TEXT, date_read INTEGER DEFAULT 0,
              balloon_bundle_id TEXT, payload_data BLOB, thread_originator_guid TEXT,
              expressive_send_style_id TEXT, is_audio_message INTEGER DEFAULT 0);
            CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
            CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, transfer_name TEXT, mime_type TEXT,
              uti TEXT, total_bytes INTEGER, is_sticker INTEGER DEFAULT 0, sticker_user_info BLOB,
              attribution_info BLOB, emoji_image_short_description TEXT);
            CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
            CREATE TABLE chat_recoverable_message_join (message_id INTEGER);
            INSERT INTO handle VALUES (1, '+15551234567');
        """)

    def tearDown(self):
        self.con.close()

    def message(self, guid, kind=0, target=None, date=T0, emoji=None, mine=False):
        cur = self.con.execute("""INSERT INTO message
            (guid, date, associated_message_type, associated_message_guid, associated_message_emoji, is_from_me)
            VALUES (?, ?, ?, ?, ?, ?)""", (guid, date, kind, target, emoji, mine))
        return cur.lastrowid


    def enrich(self, ids):
        marks = ",".join("?" for _ in ids)
        rows = list(self.con.execute(f"""SELECT m.*, associated_message_type AS assoc_type,
          associated_message_guid AS assoc_guid, thread_originator_guid AS orig_guid,
          expressive_send_style_id AS style_id FROM {self.imsg.MESSAGE_SRC} m
          WHERE ROWID IN ({marks}) ORDER BY date, ROWID""", ids))
        return self.imsg.enrich(self.con, rows, False)

    def test_custom_classic_looking_emoji_retains_its_kind(self):
        p = self.message("P")
        self.message("E",2006,"p:0/P",emoji="👍",mine=True)
        custom = self.enrich([p])[1][p]["tapbacks"][0]
        self.assertEqual(custom["kind"],"emoji")
        self.assertEqual(custom["emoji"],"👍")


if __name__ == "__main__":
    unittest.main()
