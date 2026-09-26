"""An attachment whose chat.db mime_type is empty gets its MIME from the UTI.

Every iPhone voice message is "Audio Message.caf", uti
com.apple.coreaudio-format, mime_type EMPTY. Blip gates opening on MIME, so it
saved those as .bin and never played them (2026-09-26).
"""
from __future__ import annotations

from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path
import sqlite3
import sys
import unittest

IMSG = Path(__file__).with_name("imsg")


def load_imsg():
    loader = SourceFileLoader("blip_imsg_mime", str(IMSG))
    spec = spec_from_loader(loader.name, loader)
    assert spec is not None
    mod = module_from_spec(spec)
    sys.modules[loader.name] = mod
    loader.exec_module(mod)
    return mod


class AttachmentMime(unittest.TestCase):
    def setUp(self) -> None:
        self.imsg = load_imsg()
        self.con = sqlite3.connect(":memory:")
        self.con.execute("CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, mime_type TEXT, uti TEXT)")

    def mime(self, mime_type, uti):
        self.con.execute("DELETE FROM attachment")
        self.con.execute("INSERT INTO attachment VALUES (1, ?, ?)", (mime_type, uti))
        return self.con.execute(
            f"SELECT {self.imsg.ATTACHMENT_MIME_SQL} FROM attachment a"
        ).fetchone()[0]

    def test_voice_message_with_empty_mime_is_caf(self) -> None:
        self.assertEqual(self.mime("", "com.apple.coreaudio-format"), "audio/x-caf")
        self.assertEqual(self.mime(None, "com.apple.coreaudio-format"), "audio/x-caf")

    def test_a_real_mime_type_always_wins(self) -> None:
        self.assertEqual(self.mime("image/gif", "com.apple.coreaudio-format"), "image/gif")

    def test_an_unknown_uti_stays_unknown(self) -> None:
        self.assertIsNone(self.mime("", "public.data"))
        self.assertIsNone(self.mime(None, None))

    def test_marks_placeholder_survives_the_fstring(self) -> None:
        src = IMSG.read_text()
        self.assertNotIn("IN ({marks})\"\"\",\n        rowids", src.replace("{{marks}}", "OK"))
        self.assertEqual(src.count("{ATTACHMENT_MIME_SQL}"), 3)


if __name__ == "__main__":
    unittest.main()
