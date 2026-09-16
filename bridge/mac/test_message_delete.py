import importlib.machinery
import importlib.util
from pathlib import Path
import sqlite3
import unittest
from unittest.mock import patch
from types import SimpleNamespace

loader = importlib.machinery.SourceFileLoader("delete_bridge", str(Path(__file__).with_name("imsg-delete")))
spec = importlib.util.spec_from_loader(loader.name, loader)
bridge = importlib.util.module_from_spec(spec)
loader.exec_module(bridge)


class MessageDeleteTests(unittest.TestCase):
    def setUp(self):
        self.con = sqlite3.connect(":memory:")
        self.con.row_factory = sqlite3.Row
        self.con.executescript("""
        CREATE TABLE message(guid TEXT,text TEXT,attributedBody BLOB,is_from_me INTEGER,item_type INTEGER,associated_message_type INTEGER);
        CREATE TABLE chat(chat_identifier TEXT,room_name TEXT);
        CREATE TABLE chat_message_join(message_id INTEGER,chat_id INTEGER);
        CREATE TABLE chat_recoverable_message_join(message_id INTEGER);
        CREATE TABLE message_attachment_join(message_id INTEGER,attachment_id INTEGER);
        INSERT INTO message VALUES('11111111-2222-4333-8444-555555555555','Synthetic message',NULL,0,0,0);
        INSERT INTO message VALUES('22222222-2222-4333-8444-555555555555','Synthetic message',NULL,1,0,0);
        INSERT INTO chat VALUES('chat12345','room12345');
        INSERT INTO chat_message_join VALUES(1,1),(2,1);
        """)
        self.request = {"id": "1", "guid": "11111111-2222-4333-8444-555555555555", "chat": "chat12345", "confirmed": True}
        self.calls = []

    def tearDown(self):
        self.con.close()

    def remove(self, request=None, native=None):
        return bridge.remove_message(request or self.request, self.con, native or self.native, lambda r: r["text"], lambda _: None)

    def native(self, value):
        self.calls.append(value)
        return {"ok": True}

    def test_requires_exact_identity_and_explicit_confirmation(self):
        for change in [{"id": 1}, {"id": "0"}, {"id": str(2**63)}, {"guid": "bad"}, {"chat": "x\n"}, {"confirmed": False}]:
            with self.assertRaises(ValueError):
                self.remove({**self.request, **change})
        self.assertEqual(self.calls, [])

    def test_wrong_chat_or_guid_never_reaches_native_action(self):
        for change in [{"chat": "different"}, {"guid": "33333333-2222-4333-8444-555555555555"}]:
            self.assertEqual(self.remove({**self.request, **change})["code"], "not-found")
        self.assertEqual(self.calls, [])

    def test_success_requires_the_exact_message_to_leave_live_history(self):
        self.assertEqual(self.remove()["code"], "unverified")
        self.assertEqual(self.calls, [{"guid": self.request["guid"], "text": "Synthetic message", "attachments": 0}])

    def test_deleting_one_duplicate_does_not_accept_removing_the_other(self):
        def wrong(_):
            self.con.execute("INSERT INTO chat_recoverable_message_join VALUES(2)")
            return {"ok": True}
        self.assertEqual(self.remove(native=wrong)["code"], "unverified")

    def test_verified_removal_and_repeat_are_safe(self):
        def right(_):
            self.con.execute("INSERT INTO chat_recoverable_message_join VALUES(1)")
            return {"ok": True}
        result = self.remove(native=right)
        self.assertEqual(result, {"ok": True, "deleted": True, **{k: self.request[k] for k in ("id", "guid", "chat")}})
        self.assertIsNotNone(bridge.lookup(self.con, {**self.request, "id": "2", "guid": "22222222-2222-4333-8444-555555555555"}))
        self.assertEqual(self.remove()["code"], "not-found")

    def test_native_failure_and_non_message_rows_are_refused(self):
        self.assertEqual(self.remove(native=lambda _: {"ok": False, "code": "selection"})["code"], "selection")
        self.con.execute("UPDATE message SET item_type=1 WHERE rowid=1")
        self.assertEqual(self.remove()["code"], "unsupported")
        self.assertEqual(self.calls, [])

    def test_lost_native_acknowledgement_still_checks_exact_database_result(self):
        def acted(_):
            self.con.execute("INSERT INTO chat_recoverable_message_join VALUES(1)")
            return {"ok": False, "code": "unverified"}
        self.assertTrue(self.remove(native=acted)["ok"])

    def test_original_room_identity_and_attachment_only_message(self):
        self.con.execute("UPDATE message SET text='' WHERE rowid=1")
        self.con.execute("INSERT INTO message_attachment_join VALUES(1,10)")
        self.remove({**self.request, "chat": "room12345"})
        self.assertEqual(self.calls[0]["text"], "")
        self.assertEqual(self.calls[0]["attachments"], 1)

    def test_native_unicode_payload_uses_utf8_within_the_receiver_bound(self):
        for text in ["漢" * 32768, "😀" * 24576]:
            with patch.object(bridge.subprocess, "run") as run:
                run.return_value = SimpleNamespace(returncode=0, stdout=b'{"ok":true}')
                self.assertTrue(bridge.native_delete({"guid": self.request["guid"], "text": text, "attachments": 0}, Path("/synthetic"))["ok"])
                self.assertLess(len(run.call_args.kwargs["input"]), 128*1024)

    def test_json_expansion_past_receiver_bound_never_reaches_native_action(self):
        with patch.object(bridge.subprocess, "run") as run:
            result = bridge.native_delete({"guid": self.request["guid"], "text": "\x00" * (96*1024), "attachments": 0}, Path("/synthetic"))
            self.assertEqual(result, {"ok": False, "code": "unsupported"})
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
