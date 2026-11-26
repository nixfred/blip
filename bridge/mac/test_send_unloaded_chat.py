#!/usr/bin/env python3
"""A group older than Messages' loaded window fails `send ... to chat id` with
-1728 under every service prefix, though chat.db holds it in full (2026-11-26,
an older group, any;+;chat111111111111111111, 91 messages, last active in May).
imsg-send opens it through the groupid link, without raising Messages, and
retries the send once."""
from __future__ import annotations

import sqlite3
import subprocess
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).parent
loader = SourceFileLoader("blip_imsg_send_unloaded", str(HERE / "imsg-send"))
spec = spec_from_loader(loader.name, loader)
assert spec is not None
mod = module_from_spec(spec)
loader.exec_module(mod)

GUID = "any;+;chat111111111111111111"
GID = "11111111-2222-3333-4444-555555555555"
ERR = ("35:37: execution error: Messages got an error: "
       "Can’t get chat id \"any;+;chat111111111111111111\". (-1728)")


def make_db(path: str, group_id: str | None = GID) -> None:
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, group_id TEXT)")
    con.execute("INSERT INTO chat (guid, group_id) VALUES (?, ?)", (GUID, group_id))
    con.commit()
    con.close()


class UnloadedChatTests(unittest.TestCase):
    def test_error_shapes(self):
        self.assertTrue(mod.is_chat_not_loaded(ERR))
        self.assertFalse(mod.is_chat_not_loaded("execution error: Not authorized (-1743)"))
        self.assertFalse(mod.is_chat_not_loaded("Can't get participant (-1728)"))

    def test_group_id_lookup(self):
        with tempfile.TemporaryDirectory() as d:
            db = f"{d}/chat.db"
            make_db(db)
            with patch.object(mod, "CHAT_DB", db):
                self.assertEqual(mod._chat_group_id(GUID), GID)
                self.assertIsNone(mod._chat_group_id("any;+;chatNOPE"))
            make_db(db := f"{d}/b.db", group_id="x; do shell script")
            with patch.object(mod, "CHAT_DB", db):
                self.assertIsNone(mod._chat_group_id(GUID))

    def test_retry_once_after_load(self):
        calls = []

        def fake_run(script):
            calls.append(script)
            return (1, "", ERR) if len(calls) == 1 else (0, "", "")

        with patch.object(mod, "run_applescript", fake_run), \
             patch.object(mod, "load_chat", lambda g: True):
            self.assertEqual(mod.send_script("S", GUID), (0, "", ""))
        self.assertEqual(len(calls), 2)

    def test_no_retry_when_load_fails_or_other_error(self):
        calls = []

        def fake_run(script):
            calls.append(script)
            return 1, "", ERR

        with patch.object(mod, "run_applescript", fake_run), \
             patch.object(mod, "load_chat", lambda g: False):
            self.assertEqual(mod.send_script("S", GUID)[0], 1)
        self.assertEqual(len(calls), 1)

        calls.clear()
        with patch.object(mod, "run_applescript", lambda s: (1, "", "Not authorized (-1743)")), \
             patch.object(mod, "load_chat", lambda g: self.fail("must not open")):
            self.assertEqual(mod.send_script("S", GUID)[0], 1)
        with patch.object(mod, "run_applescript", lambda s: (1, "", ERR)), \
             patch.object(mod, "load_chat", lambda g: self.fail("DMs have no chat guid")):
            self.assertEqual(mod.send_script("S", None)[0], 1)

    def test_open_is_background_and_by_groupid(self):
        opened = []

        def run(args, **kw):
            opened.append(args)
            return subprocess.CompletedProcess(args, 0, stdout=b"", stderr=b"")

        with tempfile.TemporaryDirectory() as d:
            db = f"{d}/chat.db"
            make_db(db)
            with patch.object(mod, "CHAT_DB", db), \
                 patch.object(mod.subprocess, "run", run), \
                 patch.object(mod, "run_applescript", lambda s: (0, GUID, "")):
                self.assertTrue(mod.load_chat(GUID))
        self.assertEqual(opened[0], ["open", "-g", f"imessage:open?groupid={GID}"])


if __name__ == "__main__":
    unittest.main()
