#!/usr/bin/env python3
"""imsg-reply on a synthetic chat.db with a scripted Messages; never opens Messages."""
import contextlib
import io
import os
import sqlite3
import tempfile
import types
import unittest
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path
from unittest.mock import patch

_loader = SourceFileLoader("test_reply_tool", str(Path(__file__).with_name("imsg-reply")))
_spec = spec_from_loader(_loader.name, _loader)
tool = module_from_spec(_spec)
_loader.exec_module(tool)
rx = tool.rx

SCHEMA = """
CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, style INT);
CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, is_from_me INT, date INT,
  item_type INT DEFAULT 0, associated_message_type INT DEFAULT 0, balloon_bundle_id TEXT, payload_data BLOB,
  cache_has_attachments INT DEFAULT 0, thread_originator_guid TEXT, error INT DEFAULT 0);
CREATE TABLE chat_message_join (chat_id INT, message_id INT);
CREATE TABLE chat_recoverable_message_join (chat_id INT, message_id INT);
CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, mime_type TEXT, transfer_name TEXT, is_sticker INT DEFAULT 0);
CREATE TABLE message_attachment_join (message_id INT, attachment_id INT);
"""
BASE = 800_000_000 * 10**9
MINUTE = 60 * 10**9
imsg = types.SimpleNamespace(message_text=lambda r: r["text"], chat_cluster_ids=lambda con, chat: [chat])


class Db:
    def __init__(self):
        self.con = sqlite3.connect(":memory:")
        self.con.row_factory = sqlite3.Row
        self.con.executescript(SCHEMA)
        self.con.execute("INSERT INTO chat VALUES (1, '+15551234567', 45)")
        self.con.execute("INSERT INTO chat VALUES (2, 'group-1', 43)")
        self.con.execute("INSERT INTO chat VALUES (3, 'alias@example.com', 45)")
        self.n = 0

    def msg(self, guid, text="", me=1, date=BASE, chat=1, files=(), **extra):
        self.n += 1
        cols = {"ROWID": self.n, "guid": guid, "text": text, "is_from_me": me, "date": date,
                "cache_has_attachments": int(bool(files)), **extra}
        self.con.execute(f"INSERT INTO message ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", tuple(cols.values()))
        self.con.execute("INSERT INTO chat_message_join VALUES (?, ?)", (chat, self.n))
        for mime, name, sticker in files:
            cur = self.con.execute("INSERT INTO attachment (mime_type, transfer_name, is_sticker) VALUES (?, ?, ?)", (mime, name, sticker))
            self.con.execute("INSERT INTO message_attachment_join VALUES (?, ?)", (self.n, cur.lastrowid))
        return guid


PNG = ("image/png", "a.png", 0)


class Targets(unittest.TestCase):
    def refused(self, db, guid, code):
        with self.assertRaises(rx.Stop) as ctx:
            tool.resolve(db.con, imsg, guid, [])
        self.assertEqual(ctx.exception.result["code"], code)

    def test_text_and_a_single_picture_are_targets(self):
        db = Db()
        db.msg("T", "hello")
        db.msg("P", "", files=[PNG], date=BASE + MINUTE)
        self.assertEqual(tool.resolve(db.con, imsg, "T", [])["text"], "hello")
        picture = tool.resolve(db.con, imsg, "P", [])
        self.assertEqual((picture["text"], picture["picture"], picture["ordinal"]), (tool.PICTURE_LABEL, True, 0))

    def test_what_is_unproven_is_refused(self):
        db = Db()
        db.msg("G", "hi", chat=2)
        db.msg("C", "caption", files=[PNG])
        db.msg("M", "", files=[PNG, ("image/jpeg", "b.jpg", 0)], date=BASE + MINUTE)
        db.msg("V", "", files=[("video/mp4", "a.mp4", 0)], date=BASE + 2 * MINUTE)
        db.msg("S", "", files=[("image/png", "s.png", 1)], date=BASE + 3 * MINUTE)
        db.msg("L", "see https://example.com", date=BASE + 4 * MINUTE)
        db.msg("A", "card", balloon_bundle_id="x.URLBalloonProvider", date=BASE + 5 * MINUTE)
        for guid in "GCMVSLA":
            self.refused(db, guid, "unsupported")
        self.refused(db, "nope", "no-such-message")

    def test_other_attachment_types_never_shift_picture_ordinal(self):
        for files in ([('video/mp4','v.mp4',0)], [('image/png','s.png',1)], [PNG,PNG]):
            db=Db(); db.msg("P",files=[PNG]); db.msg("OTHER",files=files,date=BASE+1)
            self.assertEqual(tool.resolve(db.con,imsg,"P",[])["ordinal"],0)

    def test_group_picture_is_refused(self):
        db=Db(); db.msg("P",files=[PNG],chat=2)
        self.refused(db,"P","unsupported")

    def test_two_pictures_in_a_minute_are_refused_not_guessed(self):
        db = Db()
        db.msg("P1", "", files=[PNG], date=BASE)
        db.msg("P2", "", files=[PNG], date=BASE + 10**9)
        self.refused(db, "P1", "ambiguous")
        self.refused(db, "P2", "ambiguous")

    def test_the_other_side_does_not_count_as_a_look_alike(self):
        db = Db()
        db.msg("P1", "", files=[PNG], date=BASE)
        db.msg("P2", "", files=[PNG], date=BASE + 10**9, me=0)
        self.assertTrue(tool.resolve(db.con, imsg, "P1", [])["picture"])

    def test_the_same_minute_on_a_later_day_is_counted_from_the_bottom(self):
        db = Db()
        db.msg("P1", "", files=[PNG], date=BASE)
        db.msg("P2", "", files=[PNG], date=BASE + 86400 * 2 * 10**9)
        self.assertEqual(tool.resolve(db.con, imsg, "P1", [])["ordinal"], 1)

    def test_a_self_thread_picture_aims_at_the_sent_row_and_knows_its_echo(self):
        db = Db()
        db.msg("ECHO", "", files=[PNG], me=0, date=BASE + 10**9)
        db.msg("SENT", "", files=[PNG], me=1, date=BASE)
        target = tool.resolve(db.con, imsg, "ECHO", ["+15551234567"])
        self.assertTrue(target["from_me"])
        self.assertEqual(set(target["guids"]), {"ECHO", "SENT"})


class Ui:
    def __init__(self, select=""):
        self.select = select
        self.restored = []

    def ensure_messages(self): return ""
    def accessibility(self): return ""
    def frontmost(self): return "Terminal"
    def select_chat(self, chat): return self.select
    def restore_front(self, prev): self.restored.append(prev)


class Script:
    """Messages as far as the tool can see it. `land` writes the reply row."""
    def __init__(self, db=None, composer=None, send=None, land=None):
        self.db, self.composer, self.answer, self.land = db, composer, send, land
        self.calls = []
        self.presses = 0

    def run(self, q):
        self.calls.append(q["mode"])
        if q["mode"] == "composer":
            return self.composer.pop(0) if self.composer else {"ok": True, "length": 0, "inReply": False}
        if q["mode"] == "send":
            self.sent = q
            if self.land:
                self.land()
            return self.answer or {"ok": True}
        return {"ok": True}

    def perform(self, target, action, deadline=None):
        self.presses += 1
        self.action = action
        return {"ok": True}


def target_of(db, guid):
    return tool.resolve(db.con, imsg, guid, [])


class Run(unittest.TestCase):
    def setUp(self):
        p = patch.object(rx, "system_events_consent", return_value="")
        p.start()
        self.addCleanup(p.stop)
        now = patch.object(rx, "apple_now", return_value=BASE)
        now.start()
        self.addCleanup(now.stop)

    def go(self, db, script, ui=None, guid="T", text="the reply"):
        return tool.reply(db.con, imsg, target_of(db, guid), text, ui or Ui(), run=script.run,
                          perform=script.perform, pause=lambda _: None)

    def land(self, db, orig, text="the reply", chat=1, error=0):
        return lambda: db.msg("R", text, date=BASE + 5 * 10**9, chat=chat, thread_originator_guid=orig, error=error)

    def test_prefix_neighbour_does_not_crash_shared_reaction_resolution(self):
        db = Db()
        db.msg("T", "ok")
        db.msg("N", "ok, see you then", date=BASE+1)
        self.assertEqual(target_of(db, "T")["text"], "ok")

    def test_sent_when_chat_db_names_the_target(self):
        db = Db(); db.msg("T", "hello")
        ui = Ui()
        s = Script(land=self.land(db, "T"))
        self.assertEqual(self.go(db, s, ui)["result"], "sent")
        self.assertEqual((s.presses, s.action), (1, "Reply…"))
        self.assertEqual(s.sent["body"], "the reply")
        self.assertEqual(s.calls[-1], "close")
        self.assertEqual(ui.restored, ["Terminal"])

    def test_a_reply_under_another_address_of_the_same_person_still_counts(self):
        db = Db(); db.msg("T", "hello")
        self.assertEqual(self.go(db, Script(land=self.land(db, "T", chat=3)))["result"], "sent")

    def test_a_reply_to_a_reply_names_the_start_of_the_thread(self):
        db = Db(); db.msg("ROOT", "first"); db.msg("T", "hello", date=BASE + MINUTE, thread_originator_guid="ROOT")
        self.assertEqual(self.go(db, Script(land=self.land(db, "ROOT")))["result"], "sent")

    def test_a_draft_stops_the_run_before_anything_is_pressed(self):
        db = Db(); db.msg("T", "hello")
        s = Script(composer=[{"ok": True, "length": 5, "inReply": False}])
        with self.assertRaises(rx.Stop) as ctx:
            self.go(db, s)
        self.assertEqual(ctx.exception.result["code"], "draft")
        self.assertEqual(ctx.exception.exit_code, tool.EX_TEMPFAIL)
        self.assertEqual(s.presses, 0)
        self.assertNotIn("send", s.calls)

    def test_a_reply_view_left_open_is_closed_first(self):
        db = Db(); db.msg("T", "hello")
        s = Script(composer=[{"ok": True, "length": 0, "inReply": True}, {"ok": True, "length": 0, "inReply": False}],
                   land=self.land(db, "T"))
        self.assertEqual(self.go(db, s)["result"], "sent")
        self.assertEqual(s.calls[:3], ["composer", "close", "composer"])

    def test_a_locked_mac_is_said_plainly_and_nothing_is_pressed(self):
        db = Db(); db.msg("T", "hello")
        s = Script()
        with self.assertRaises(rx.Stop) as ctx:
            self.go(db, s, Ui(select="the Mac's screen is locked"))
        self.assertIn("locked", ctx.exception.why)
        self.assertEqual(ctx.exception.exit_code, tool.EX_TEMPFAIL)
        self.assertEqual(s.presses, 0)

    def test_nothing_sent_is_a_retryable_failure_and_the_view_closes(self):
        for code in tool.NOT_SENT:
            db = Db(); db.msg("T", "hello")
            s = Script(send={"ok": False, "error": code})
            with self.assertRaises(rx.Stop) as ctx:
                self.go(db, s)
            self.assertEqual((ctx.exception.result["code"], ctx.exception.exit_code), (code, tool.EX_TEMPFAIL))
            self.assertEqual(s.calls[-1], "close")

    def test_slow_field_clear_confirms_instead_of_inviting_resend(self):
        db = Db(); db.msg("T", "hello")
        for error in ("not-sent", "unconfirmed"):
            s = Script(send={"ok":False,"error":error}, land=self.land(db,"T"))
            self.assertEqual(self.go(db,s)["result"], "sent")

    def test_confirmation_errors_are_always_uncertain(self):
        for error in (sqlite3.OperationalError("unavailable"), OSError("unavailable")):
            db = Db(); db.msg("T", "hello")
            with patch.object(tool, "find_reply", side_effect=error):
                with self.assertRaises(rx.Stop) as ctx: self.go(db, Script())
            self.assertEqual(ctx.exception.exit_code, 76)

    def test_old_or_incoming_rows_cannot_confirm(self):
        for me, date in ((0, BASE+1), (1, BASE-1)):
            db = Db(); db.msg("T", "hello")
            db.msg("R", "the reply", me=me,date=date,thread_originator_guid="T")
            self.assertIsNone(tool.find_reply(db.con,imsg,{"T"},"the reply",BASE))

    def test_no_row_after_return_is_unconfirmed_and_never_says_resend(self):
        db = Db(); db.msg("T", "hello")
        s = Script()
        with patch.object(tool, "CONFIRM_SECONDS", 0.5), self.assertRaises(rx.Stop) as ctx:
            tool.reply(db.con, imsg, target_of(db, "T"), "the reply", Ui(), run=s.run, perform=s.perform,
                       pause=lambda _: None)
        self.assertEqual((ctx.exception.result["code"], ctx.exception.exit_code), ("unconfirmed", tool.EX_UNCONFIRMED))

    def test_a_script_that_dies_during_send_is_checked_never_retried(self):
        db = Db(); db.msg("T", "hello")
        s = Script(send={"ok": False, "error": "timeout"}, land=self.land(db, "T"))
        self.assertEqual(self.go(db, s)["result"], "sent")
        self.assertEqual(s.calls.count("send"), 1)

    def test_a_row_with_the_wrong_thread_or_text_does_not_confirm(self):
        db = Db(); db.msg("T", "hello"); db.msg("OTHER", "other", date=BASE + MINUTE)
        s = Script(land=self.land(db, "OTHER"))
        with patch.object(tool, "CONFIRM_SECONDS", 0.5), self.assertRaises(rx.Stop) as ctx:
            tool.reply(db.con, imsg, target_of(db, "T"), "the reply", Ui(), run=s.run, perform=s.perform, pause=lambda _: None)
        self.assertEqual(ctx.exception.result["code"], "unconfirmed")

    def test_a_delivery_error_is_reported_without_inviting_a_resend(self):
        db = Db(); db.msg("T", "hello")
        with self.assertRaises(rx.Stop) as ctx:
            self.go(db, Script(land=self.land(db, "T", error=22)))
        self.assertEqual((ctx.exception.result["code"], ctx.exception.exit_code), ("failed", tool.EX_UNCONFIRMED))

    def test_a_bubble_not_found_says_nothing_was_sent(self):
        db = Db(); db.msg("T", "hello")
        s = Script()
        s.perform = lambda target, action, deadline=None: {"ok": False, "error": "not-rendered"}
        with self.assertRaises(rx.Stop) as ctx:
            self.go(db, s)
        self.assertIn("nothing was sent", ctx.exception.why)
        self.assertNotIn("send", s.calls)


class Text(unittest.TestCase):
    def read(self, raw):
        return tool.read_text(types.SimpleNamespace(buffer=io.BytesIO(raw)))

    def test_limits(self):
        self.assertEqual(self.read("  two\nlines 👍\n".encode()), "two\nlines 👍")
        for bad in (b"", b"  \n", b"\xff\xfe", b"x" * (tool.MAX_BYTES + 1), b"x" * (tool.MAX_CHARS + 1)):
            with self.assertRaises(rx.Stop):
                self.read(bad)

    def test_the_log_never_holds_a_guid_or_text(self):
        with tempfile.TemporaryDirectory() as d, patch.object(tool, "LOG", os.path.join(d, "reply.log")):
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                tool.emit({"ok": True, "result": "sent", "seconds": 1.2})
                tool.emit(rx.Stop("draft", 75, "a draft"))
            log = Path(tool.LOG).read_text()
        self.assertIn("sent exit=0 1.2s", log)
        self.assertIn("draft exit=75", log)
        self.assertNotIn("a draft", log)

    def test_dry_run_never_touches_the_ui(self):
        db=Db(); db.msg("T","hello")
        fake_imsg=types.SimpleNamespace(DB_PATH="synthetic",message_text=imsg.message_text,chat_cluster_ids=imsg.chat_cluster_ids)
        def sibling(name):
            if name == "imsg": return fake_imsg
            if name == "imsg-send": return types.SimpleNamespace(detect_self_handles=lambda: [])
            raise AssertionError("dry run touched UI")
        with patch.object(rx,"sibling",side_effect=sibling), patch.object(tool.sqlite3,"connect",return_value=db.con), patch.object(tool.sys,"stdin",types.SimpleNamespace(buffer=io.BytesIO(b"synthetic reply"))), patch.object(tool,"emit",side_effect=lambda r: 0 if not isinstance(r,rx.Stop) else r.exit_code):
            self.assertEqual(tool.main(["--guid","T","--text-stdin"]),0)

    def test_invalid_guid_is_refused_before_any_lookup(self):
        with patch.object(rx,"sibling",side_effect=AssertionError("must not load bridge")), patch.object(tool,"emit",side_effect=lambda r:r.exit_code):
            self.assertEqual(tool.main(["--guid","bad;guid","--text-stdin"]),tool.EX_USAGE)

    def test_no_guid_no_tool(self):
        with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(tool.main(["--text-stdin"]), tool.EX_USAGE)


if __name__ == "__main__":
    unittest.main()
