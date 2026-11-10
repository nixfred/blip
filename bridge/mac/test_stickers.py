#!/usr/bin/env python3
"""Synthetic sticker rows only. Never opens the user's Messages database."""
import math
import io
import plistlib
import sqlite3
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


def load_imsg():
    loader = SourceFileLoader("blip_sticker_test", str(Path(__file__).with_name("imsg")))
    module = module_from_spec(spec_from_loader(loader.name, loader))
    loader.exec_module(module)
    return module


T0 = 800_000_000_000_000_000


class Stickers(unittest.TestCase):
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

    def attachment(self, mid, aid, sticker=True, name="sticker.png", mime="image/png", info=None):
        self.con.execute("INSERT INTO attachment VALUES (?, ?, ?, NULL, 128, ?, ?, NULL, NULL)",
                         (aid, name, mime, sticker, plistlib.dumps(info) if info is not None else None))
        self.con.execute("INSERT INTO message_attachment_join VALUES (?, ?)", (mid, aid))

    def enrich(self, ids):
        marks = ",".join("?" for _ in ids)
        rows = list(self.con.execute(f"""SELECT m.*, associated_message_type AS assoc_type,
          associated_message_guid AS assoc_guid, thread_originator_guid AS orig_guid,
          expressive_send_style_id AS style_id FROM {self.imsg.MESSAGE_SRC} m
          WHERE ROWID IN ({marks}) ORDER BY date, ROWID""", ids))
        return self.imsg.enrich(self.con, rows, False)

    def test_standalone_sticker_is_not_a_photo(self):
        a, b = self.message("S"), self.message("P")
        self.attachment(a, 1)
        self.attachment(b, 2, sticker=False)
        kept, extra = self.enrich([a, b])
        self.assertEqual(len(kept), 2)
        self.assertEqual(extra[a]["attachments"][0]["sticker"]["label"], "Sticker")
        self.assertNotIn("sticker", extra[b]["attachments"][0])

    def test_sticker_without_transfer_name_is_preserved(self):
        s = self.message("S")
        self.attachment(s, 1, name=None)
        self.assertEqual(self.enrich([s])[1][s]["attachments"][0]["name"], "Sticker")

    def test_ordinary_unfinished_and_link_payload_attachments_stay_hidden(self):
        m = self.message("M")
        self.attachment(m, 1, sticker=False, name=None)
        self.attachment(m, 2, sticker=False, name="x.pluginPayloadAttachment")
        self.assertNotIn("attachments", self.enrich([m])[1][m])

    def test_legacy_stickers_fold_additively_onto_parent_even_outside_window(self):
        parent = self.message("P")
        one = self.message("S1", 1000, "p:0/P", T0 + 1_000_000_000)
        two = self.message("S2", 1000, "p:0/P", T0 + 2_000_000_000)
        self.attachment(one, 1)
        self.attachment(two, 2)
        for window in ([parent], [parent, one, two]):
            kept, extra = self.enrich(window)
            self.assertEqual([r["ROWID"] for r in kept], [parent])
            self.assertEqual([s["attachment"]["id"] for s in extra[parent]["stickers"]], ["1", "2"])
            self.assertTrue(all(not s.get("reaction") for s in extra[parent]["stickers"]))
            self.assertEqual(extra[parent]["activity_ts"], self.imsg.fmt_ts(T0 + 2_000_000_000))

    def test_sticker_tapback_never_becomes_star_and_can_be_removed(self):
        parent = self.message("P")
        sticker = self.message("S", 2007, "p:0/P", T0 + 1_000_000_000)
        self.attachment(sticker, 1)
        kept, extra = self.enrich([parent, sticker])
        self.assertEqual(len(kept), 1)
        self.assertNotIn("tapbacks", extra[parent])
        self.assertEqual(len(extra[parent]["stickers"]), 1)
        self.assertIs(extra[parent]["stickers"][0]["reaction"], True)
        self.message("R", 3007, "p:0/P", T0 + 2_000_000_000)
        extra = self.enrich([parent, sticker])[1]
        self.assertNotIn("stickers", extra[parent])
        self.assertEqual(extra[parent]["activity_ts"], self.imsg.fmt_ts(T0 + 2_000_000_000))

    def test_emoji_replaces_sticker_slot_but_not_legacy_decorations(self):
        p = self.message("P")
        legacy = self.message("L", 1000, "p:0/P")
        modern = self.message("S", 2007, "p:0/P")
        self.attachment(legacy, 1)
        self.attachment(modern, 2)
        self.message("E", 2006, "p:0/P", T0 + 1_000_000_000, emoji="👍")
        extra = self.enrich([p])[1][p]
        self.assertEqual([s["guid"] for s in extra["stickers"]], ["L"])
        self.assertEqual(extra["tapbacks"][0]["kind"], "emoji")
        self.assertEqual(extra["tapbacks"][0]["emoji"], "👍")

    def test_body_parts_keep_separate_reaction_slots(self):
        p = self.message("P")
        s = self.message("S", 2007, "p:2/P")
        self.attachment(s, 1)
        self.message("E", 2001, "p:0/P", T0 + 1_000_000_000)
        extra = self.enrich([p])[1][p]
        self.assertEqual(extra["stickers"][0]["part"], 2)
        self.assertEqual(extra["tapbacks"][0]["emoji"], "👍")

    def test_same_timestamp_later_rowid_wins(self):
        p = self.message("P")
        s = self.message("S", 2007, "p:0/P")
        self.attachment(s, 1)
        self.message("R", 3007, "p:0/P")
        self.assertNotIn("stickers", self.enrich([p])[1][p])

    def test_orphan_sticker_stays_visible_until_removed(self):
        self.message("P")
        s = self.message("S", 2007, "p:0/P")
        self.attachment(s, 1)
        kept, extra = self.enrich([s])
        self.assertEqual([r["ROWID"] for r in kept], [s])
        self.assertIn("sticker", extra[s]["attachments"][0])
        self.message("R", 3007, "p:0/P", T0 + 1_000_000_000)
        self.assertEqual(self.enrich([s])[0], [])

    def test_legacy_orphan_is_retained(self):
        s = self.message("S", 1000, "p:0/missing")
        self.attachment(s, 1, sticker=False)  # association works on older schemas
        kept, extra = self.enrich([s])
        self.assertEqual(len(kept), 1)
        self.assertIn("sticker", extra[s]["attachments"][0])

    def test_missing_sticker_media_gets_an_explicit_placeholder(self):
        p = self.message("P")
        self.message("S", 2007, "p:0/P")
        overlay = self.enrich([p])[1][p]["stickers"][0]
        self.assertEqual(overlay["attachment"]["id"], "")
        self.assertEqual(overlay["attachment"]["sticker"]["label"], "Sticker")

    def test_orphan_missing_media_still_has_a_labeled_attachment(self):
        s = self.message("S", 2007, "p:0/missing")
        self.assertEqual(self.enrich([s])[1][s]["attachments"][0]["sticker"]["label"], "Sticker")

    def test_nested_sticker_survives_on_root_without_wrong_coordinates(self):
        p = self.message("P")
        one = self.message("S1", 1000, "p:0/P")
        two = self.message("S2", 1000, "p:0/S1", T0 + 1_000_000_000)
        geometry = {"sxs": "0.5", "sys": "0.5", "ssa": "1", "sro": "0"}
        self.attachment(one, 1, info=geometry)
        self.attachment(two, 2, info=geometry)
        kept, extra = self.enrich([p, one, two])
        self.assertEqual([r["ROWID"] for r in kept], [p])
        self.assertEqual(len(extra[p]["stickers"]), 2)
        nested = next(s for s in extra[p]["stickers"] if s["guid"] == "S2")
        self.assertNotIn("placement", nested)
        self.assertNotIn("placement", nested["attachment"]["sticker"])

    def test_cyclic_sticker_association_keeps_one_visible_row(self):
        one = self.message("S1", 1000, "p:0/S2")
        two = self.message("S2", 1000, "p:0/S1")
        self.attachment(one, 1)
        self.attachment(two, 2)
        kept, extra = self.enrich([one, two])
        self.assertTrue(kept)
        self.assertEqual(len(extra[kept[0]["ROWID"]]["attachments"]), 1)

    def test_deleted_sticker_does_not_reappear(self):
        p = self.message("P")
        s = self.message("S", 1000, "p:0/P")
        self.attachment(s, 1)
        self.con.execute("INSERT INTO chat_recoverable_message_join VALUES (?)", (s,))
        self.assertNotIn("stickers", self.enrich([p])[1][p])

    def test_schema_without_sticker_columns_still_reads_ordinary_images(self):
        self.con.execute("DROP TABLE attachment")
        self.con.execute("CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, transfer_name TEXT, mime_type TEXT, total_bytes INTEGER)")
        p = self.message("P")
        self.con.execute("INSERT INTO attachment VALUES (1, 'image.png', 'image/png', 10)")
        self.con.execute("INSERT INTO message_attachment_join VALUES (?, 1)", (p,))
        self.assertEqual(self.enrich([p])[1][p]["attachments"], [{"id": "1", "name": "image.png", "mime": "image/png", "bytes": 10}])

    def test_geometry_and_accessible_label_are_bounded_and_typed(self):
        info = {"sxs": "0.75", "sys": "0.1", "ssa": "1.2", "sro": "-0.4", "spw": "164",
                "pid": "extension:team:com.apple.messages.genmoji", "untrusted": "not forwarded"}
        r = {"is_sticker": 1, "mime": "image/heic", "sticker_user_info": plistlib.dumps(info),
             "emoji_description": "Smile\x00", "attribution_info": None}
        m = self.imsg.sticker_metadata(r)
        self.assertEqual(m["placement"], {"x": .75, "y": .1, "scale": 1.2, "rotation": -.4, "parentWidth": 164})
        self.assertEqual((m["label"], m["source"]), ("Smile", "genmoji"))
        self.assertNotIn("untrusted", m)
        for bad in ["nan", "inf", "1e999", -100, True]:
            r["sticker_user_info"] = plistlib.dumps({**info, "sxs": bad})
            self.assertNotIn("placement", self.imsg.sticker_metadata(r))

    def test_valid_plist_over_cap_is_rejected(self):
        blob = plistlib.dumps({"value": "x" * 65536})
        self.assertGreater(len(blob), 65536)
        self.assertEqual(self.imsg._small_plist_dict(blob), {})

    def test_bad_plists_never_take_down_thread(self):
        for bad in [None, b"garbage", b"<?xml version='1.0'?><plist><dict>",
                    b"<?xml version='1.0'?><plist>&unknown;</plist>", b"x" * 65537, plistlib.dumps([1, 2])]:
            self.assertEqual(self.imsg._small_plist_dict(bad), {})
            self.assertEqual(self.imsg.sticker_metadata({"is_sticker": 1, "sticker_user_info": bad})["source"], "unknown")

    def test_png_conversion_flag_is_exclusive_with_jpeg(self):
        args = self.imsg.build_parser().parse_args(["attachment", "42", "--png"])
        self.assertTrue(args.png)
        self.assertFalse(args.jpeg)

    def test_attachment_png_conversion_preserves_stream_and_cleans_temp(self):
        m = self.message("S")
        self.attachment(m, 1, name=None, mime="image/heic")
        self.con.execute("ALTER TABLE attachment ADD COLUMN filename TEXT")
        with tempfile.TemporaryDirectory(prefix="blip-sticker-test-") as directory:
            source = Path(directory) / "source.heic"
            source.write_bytes(b"synthetic heic input")
            self.con.execute("UPDATE attachment SET filename=? WHERE ROWID=1", (str(source),))
            output, temporary = io.BytesIO(), []

            def convert(argv, **kwargs):
                self.assertEqual(argv[:4], ["sips", "-s", "format", "png"])
                temporary.append(argv[-1])
                Path(argv[-1]).write_bytes(b"\x89PNG\r\n\x1a\nsynthetic output")
                return SimpleNamespace(returncode=0, stderr=b"")

            with patch.object(self.imsg, "ATTACHMENTS_ROOT", directory), \
                 patch("subprocess.run", side_effect=convert), \
                 patch.object(self.imsg.sys, "stdout", SimpleNamespace(buffer=output)):
                self.imsg.cmd_attachment(self.con, SimpleNamespace(id="1", png=True, jpeg=False, max_dim=0))
            self.assertEqual(output.getvalue(), b"\x89PNG\r\n\x1a\nsynthetic output")
            self.assertTrue(temporary)
            self.assertFalse(Path(temporary[0]).exists())


if __name__ == "__main__":
    unittest.main()
