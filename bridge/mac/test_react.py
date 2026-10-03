#!/usr/bin/env python3
"""imsg-react on a synthetic chat.db with a scripted Messages; never opens Messages."""
import contextlib
import io
import json
import re
import sqlite3
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path
from unittest.mock import patch


def load(name):
    loader = SourceFileLoader(f"test_react_{name.replace('-', '_')}", str(Path(__file__).with_name(name)))
    spec = spec_from_loader(loader.name, loader)
    module = module_from_spec(spec)
    loader.exec_module(module)
    return module


react = load("imsg-react")
imsg = load("imsg")

ME = "+15550000001"        # this account's own handle (the self-thread)
FRIEND = "+15550000002"
MINUTE = 60_000_000_000
T0 = 800_000_000 * 1_000_000_000   # 2026-05-10, well in the past


def db():
    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row
    con.executescript("""
        CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, guid TEXT, display_name TEXT,
                           style INTEGER, group_id TEXT, original_group_id TEXT);
        CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
        CREATE TABLE message (
          ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, is_from_me INTEGER,
          handle_id INTEGER, date INTEGER, date_read INTEGER, item_type INTEGER DEFAULT 0,
          associated_message_type INTEGER DEFAULT 0, associated_message_guid TEXT,
          balloon_bundle_id TEXT, payload_data BLOB, cache_has_attachments INTEGER DEFAULT 0,
          thread_originator_guid TEXT);
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
        CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
        CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, transfer_name TEXT, mime_type TEXT,
                                 uti TEXT, total_bytes INTEGER);
        CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
        CREATE TABLE chat_recoverable_message_join (message_id INTEGER);
        INSERT INTO handle VALUES (1, '+15550000001'), (2, '+15550000002');
        INSERT INTO chat VALUES (1, '+15550000002', 'c1', NULL, 45, NULL, NULL),
                                (2, '+15550000001', 'c2', NULL, 45, NULL, NULL),
                                (3, 'chat900', 'c3', 'Group', 43, NULL, NULL);
        INSERT INTO chat_handle_join VALUES (1, 2), (2, 1), (3, 2);
    """)
    return con


def add(con, chat, guid, text, from_me, date, handle=2, **cols):
    row = {"guid": guid, "text": text, "is_from_me": int(from_me), "handle_id": 0 if from_me else handle,
           "date": date, **cols}
    cur = con.execute(f"INSERT INTO message ({', '.join(row)}) VALUES ({', '.join('?' * len(row))})",
                      list(row.values()))
    con.execute("INSERT INTO chat_message_join VALUES (?, ?)", (chat, cur.lastrowid))
    return guid


def tapback(con, chat, target, type_, from_me=True, handle=1, date=None):
    return add(con, chat, f"T{con.execute('SELECT COUNT(*) FROM message').fetchone()[0]}", None, from_me,
               date or react.apple_now(), handle=handle, associated_message_type=type_,
               associated_message_guid=f"p:0/{target}")


class FakeUI:
    """imsg-read's surface: lock-free, no Messages."""

    def __init__(self, select_error=""):
        self.select_error, self.selected, self.restored = select_error, [], []

    def ensure_messages(self):
        return ""

    def accessibility(self):
        return ""

    def frontmost(self):
        return "Previous app"

    def select_chat(self, chat):
        self.selected.append(chat)
        return self.select_error

    def restore_front(self, prev):
        self.restored.append(prev)


class FakeMessages:
    """The osascript side, scripted: each perform request takes the next
    answer; an answer carrying `lands` also writes that tapback row, the way
    Messages would (`lands_on` picks the GUID it lands on)."""

    def __init__(self, con, chat, target_guid, answers):
        self.con, self.chat, self.target, self.answers, self.requests = con, chat, target_guid, list(answers), []

    def __call__(self, request):
        self.requests.append(request)
        if request["mode"] == "page":
            return {"ok": True}
        answer = dict(self.answers.pop(0))
        lands = answer.pop("lands", None)
        on = answer.pop("lands_on", self.target)
        if lands:
            tapback(self.con, self.chat, on, lands, from_me=True)
        return answer

    @property
    def performs(self):
        return [r for r in self.requests if r["mode"] == "perform"]


class NoSelf:
    detect_self_handles = staticmethod(list)


OK = {"ok": True, "atBottom": True, "seen": 3, "frame": "10,20,100,30"}


class Resolve(unittest.TestCase):
    def setUp(self):
        self.con = db()

    def resolve(self, guid, self_handles=()):
        return react.resolve(self.con, imsg, guid, list(self_handles))

    def refused(self, guid):
        with self.assertRaises(react.Stop) as stop:
            self.resolve(guid)
        self.assertEqual(stop.exception.exit_code, react.EX_UNSUPPORTED)
        return stop.exception.why

    def test_refuses_what_it_cannot_find_on_screen(self):
        add(self.con, 3, "G", "in a group", False, T0)
        add(self.con, 1, "A", "a picture", False, T0, cache_has_attachments=1)
        add(self.con, 1, "C", "a card", False, T0, balloon_bundle_id="com.apple.messages.URLBalloonProvider")
        add(self.con, 1, "E", "", False, T0)
        add(self.con, 1, "L", "look https://example.com/x", False, T0)
        add(self.con, 1, "W", "see www.example.com", False, T0)
        row = tapback(self.con, 1, "E", 2000)
        self.assertIn("groups", self.refused("G"))
        self.assertIn("attachments", self.refused("A"))
        self.assertIn("cards", self.refused("C"))
        self.assertIn("no text", self.refused("E"))
        self.assertIn("link", self.refused("L"))
        self.assertIn("link", self.refused("W"))
        self.assertIn("not a message bubble", self.refused(row))
        self.assertIn("no message", self.refused("NOPE"))

    def test_identical_bubbles_below_are_counted(self):
        # Three "ok" from me in one minute, one in the next, one from them.
        for i, g in enumerate(["O1", "O2", "O3"]):
            add(self.con, 1, g, "ok", True, T0 + i * 1_000_000_000)
        add(self.con, 1, "THEIRS", "ok", False, T0 + 3_000_000_000)
        add(self.con, 1, "LATER", "ok", True, T0 + MINUTE)
        add(self.con, 1, "NEWEST", "bye", False, T0 + 2 * MINUTE)
        self.assertEqual([self.resolve(g)["ordinal"] for g in ["O1", "O2", "O3"]], [2, 1, 0])
        t = self.resolve("O1")
        self.assertEqual((t["text"], t["from_me"], t["chat"], t["self_thread"]), ("ok", True, FRIEND, False))
        self.assertEqual(t["newest"], {"text": "bye", "from_me": False, "hhmm": react.hhmm(T0 + 2 * MINUTE)})

    def test_a_later_day_twin_at_the_same_hhmm_is_counted(self):
        # The transcript labels bubbles with HH:MM only, so yesterday's "ok" at
        # 09:15 and today's "ok" at 09:15 look identical to the scan. Counting
        # stopped at the first new minute, the ordinal stayed 0, and the
        # newest-first scan reacted to TODAY's (review of #116, 2026-09-30).
        day = 24 * 60 * MINUTE
        add(self.con, 1, "YESTERDAY", "ok", True, T0)
        add(self.con, 1, "BETWEEN", "something else", True, T0 + MINUTE)
        add(self.con, 1, "TODAY", "ok", True, T0 + day)
        add(self.con, 1, "NOT_SAME_TIME", "ok", True, T0 + day + MINUTE)
        self.assertEqual(self.resolve("YESTERDAY")["ordinal"], 1)
        self.assertEqual(self.resolve("TODAY")["ordinal"], 0)

    def test_too_many_later_rows_refuses_instead_of_guessing(self):
        add(self.con, 1, "OLD", "ok", True, T0)
        for i in range(5):
            add(self.con, 1, f"L{i}", f"later {i}", True, T0 + (i + 1) * MINUTE)
        old = react.LATER_SCAN
        react.LATER_SCAN = 5
        try:
            with self.assertRaises(react.Stop) as stop:
                self.resolve("OLD")
            self.assertEqual((stop.exception.result["code"], stop.exception.exit_code), ("ambiguous", react.EX_TEMPFAIL))
            react.LATER_SCAN = 6
            self.assertEqual(self.resolve("OLD")["ordinal"], 0)
        finally:
            react.LATER_SCAN = old

    def test_deleted_look_alikes_are_not_counted(self):
        # Messages does not draw Recently Deleted rows; counting one below the
        # target would aim at the look-alike above it.
        for i, g in enumerate(["O1", "O2", "O3"]):
            add(self.con, 1, g, "ok", True, T0 + i * 1_000_000_000)
        rowid = self.con.execute("SELECT ROWID FROM message WHERE guid = 'O3'").fetchone()[0]
        self.con.execute("INSERT INTO chat_recoverable_message_join VALUES (?)", (rowid,))
        self.assertEqual([self.resolve(g)["ordinal"] for g in ["O1", "O2"]], [1, 0])

    def test_newest_skips_links_and_pictures(self):
        add(self.con, 1, "M", "hello", False, T0)
        add(self.con, 1, "P", "", False, T0 + MINUTE, cache_has_attachments=1)
        add(self.con, 1, "U", "https://example.com", True, T0 + 2 * MINUTE)
        self.assertEqual(self.resolve("M")["newest"]["text"], "hello")

    def test_newest_skips_tapback_rows(self):
        # A tapback row carries text of its own ("Loved “hello”"), but it is
        # drawn as a pill, not a bubble: the bottom check must not wait for it.
        add(self.con, 1, "M", "hello", False, T0)
        add(self.con, 1, "T", "Loved “hello”", True, T0 + MINUTE,
            associated_message_type=2000, associated_message_guid="p:0/M")
        self.assertEqual(self.resolve("M")["newest"]["text"], "hello")

    def test_self_thread_aims_at_the_sent_row_and_accepts_every_twin(self):
        # One message to yourself: the sent row plus two inbound echoes.
        add(self.con, 2, "ECHO1", "note", False, T0 + 400_000_000, handle=1)
        add(self.con, 2, "SENT", "note", True, T0)
        add(self.con, 2, "ECHO2", "note", False, T0 + 900_000_000, handle=1)
        add(self.con, 2, "OTHER", "note", False, T0 + 10_000_000_000, handle=1)   # a later, separate note
        t = self.resolve("ECHO2", [ME])
        self.assertTrue(t["self_thread"] and t["from_me"])
        self.assertEqual(t["guids"], ["ECHO2", "SENT", "ECHO1"])
        self.assertEqual(t["ordinal"], 0)


class Rows(unittest.TestCase):
    def setUp(self):
        self.con = db()
        add(self.con, 2, "SENT", "note", True, T0)

    def test_self_handle_echo_is_mine_and_others_are_not(self):
        tapback(self.con, 2, "SENT", 2001, from_me=False, handle=1, date=T0 + 1)   # the self-thread echo
        tapback(self.con, 2, "SENT", 2003, from_me=False, handle=2, date=T0 + 2)   # someone else
        tapback(self.con, 2, "XSENT", 2004, date=T0 + 3)                            # a GUID ending the same way
        self.assertEqual([r["type"] for r in react.my_rows(self.con, ["SENT"], [ME])], [2001])
        self.assertEqual(react.my_rows(self.con, ["SENT"], []), [])

    def test_latest_row_wins(self):
        self.assertIsNone(react.current_kind([]))
        self.assertEqual(react.current_kind([{"type": 2000}, {"type": 2003}]), 3)
        self.assertIsNone(react.current_kind([{"type": 2000}, {"type": 3000}]))

    def test_plan_never_toggles_the_wrong_way(self):
        self.assertEqual(react.plan(None, 0, False), 2000)
        self.assertIsNone(react.plan(0, 0, False))           # already there
        self.assertEqual(react.plan(3, 0, False), 2000)      # replaces another kind
        self.assertEqual(react.plan(0, 0, True), 3000)
        self.assertIsNone(react.plan(None, 0, True))         # nothing to remove
        self.assertIsNone(react.plan(3, 0, True))            # a different kind is not removed

    def test_strip_assoc_matches_the_read_path(self):
        for g in ["p:0/ABC", "p:12/ABC", "bp:ABC", "ABC", "", None]:
            self.assertEqual(react.strip_assoc(g), imsg._strip_assoc(g))


class React(unittest.TestCase):
    def setUp(self):
        self.con = db()
        add(self.con, 1, "M", "see you", False, T0)
        self.target = react.resolve(self.con, imsg, "M", [])
        self.ui = FakeUI()
        self.sleep = patch.object(react.time, "sleep")
        self.sleep.start()
        self.addCleanup(self.sleep.stop)
        self.wait = patch.object(react, "ROW_WAIT", 0.05)
        self.wait.start()
        self.addCleanup(self.wait.stop)
        env = patch.dict(react.os.environ, {"SSH_CONNECTION": ""})   # as if at the Mac
        env.start()
        self.addCleanup(env.stop)

    def run_react(self, answers, kind=0, remove=False):
        messages = FakeMessages(self.con, 1, "M", answers)
        try:
            return react.react(self.con, self.target, kind, remove, [], self.ui, run=messages), messages
        except react.Stop as stop:
            return stop, messages

    def test_add_is_verified_by_the_row(self):
        result, messages = self.run_react([{**OK, "lands": 2000}])
        self.assertEqual((result["result"], result["type"]), ("added", 2000))
        self.assertEqual(len(messages.performs), 1)
        self.assertEqual(messages.performs[0]["action"], "Heart")
        self.assertEqual(self.ui.selected, [FRIEND])
        self.assertEqual(self.ui.restored, ["Previous app"])

    def test_nothing_to_do_never_touches_messages(self):
        tapback(self.con, 1, "M", 2000, date=T0 + 1)
        result, messages = self.run_react([])
        self.assertEqual(result, {"ok": True, "result": "unchanged"})
        self.assertEqual((messages.requests, self.ui.selected), ([], []))

    def test_not_offered_is_reported_once_and_left_alone(self):
        stop, messages = self.run_react([{"ok": False, "error": "not-offered", "offered": ["Coeur"]}])
        self.assertEqual((stop.exit_code, stop.result["code"]), (react.EX_NOT_OFFERED, "not-offered"))
        self.assertEqual(stop.result["offered"], ["Coeur"])
        self.assertEqual(len(messages.performs), 1)
        self.assertEqual(self.ui.restored, ["Previous app"])

    def test_no_row_is_reported_and_never_pressed_again(self):
        # A second press could land after a late first row and toggle it back.
        stop, messages = self.run_react([OK])
        self.assertEqual((stop.exit_code, stop.result["code"]), (react.EX_TEMPFAIL, "no-row"))
        self.assertEqual(len(messages.performs), 1)

    def test_a_tapback_on_another_message_is_named(self):
        add(self.con, 1, "N", "other", False, T0 + 1)
        stop, messages = self.run_react([{**OK, "lands": 2000, "lands_on": "N"}])
        self.assertEqual((stop.exit_code, stop.result["code"], stop.result["guid"]), (react.EX_TEMPFAIL, "stray", "N"))
        self.assertEqual(len(messages.performs), 1)
        self.assertEqual(self.ui.restored, ["Previous app"])

    def test_only_this_accounts_rows_in_this_conversation_are_strays(self):
        add(self.con, 1, "N", "other", False, T0 + 1)
        add(self.con, 2, "S", "note to self", True, T0 + 1)
        later = react.apple_now() + MINUTE   # after the run starts, so only the guards keep them out
        tapback(self.con, 1, "N", 2001, from_me=False, handle=2, date=later)   # the friend's own tapback
        tapback(self.con, 2, "S", 2001, date=later)                             # mine, in another conversation
        stop, _ = self.run_react([OK])
        self.assertEqual(stop.result["code"], "no-row")

    def run_late(self, answer, on):
        """`answer`, with the row landing on `on` only once chat.db is waited
        on, a moment after osascript gave up, as it would on the Mac."""
        pending = [on]
        def sleep(_):
            if pending:
                tapback(self.con, 1, pending.pop(), 2000, from_me=True)
        with patch.object(react.time, "sleep", side_effect=sleep):
            return self.run_react([answer])

    def test_a_late_stray_after_a_press_is_named_not_no_row(self):
        add(self.con, 1, "N", "other", False, T0 + 1)
        stop, _ = self.run_late(OK, "N")
        self.assertEqual((stop.result["code"], stop.result["guid"]), ("stray", "N"))

    def test_a_stray_is_named_even_when_the_target_got_its_row(self):
        add(self.con, 1, "N", "other", False, T0 + 1)
        tapback(self.con, 1, "N", 2001, date=react.apple_now() + MINUTE)
        stop, _ = self.run_react([{**OK, "lands": 2000}])
        self.assertEqual((stop.result["code"], stop.result["guid"]), ("stray", "N"))

    def test_an_osascript_failure_may_have_pressed_so_chat_db_decides(self):
        result, _ = self.run_late({"ok": False, "error": "perform-failed"}, "M")
        self.assertEqual((result["result"], result["type"]), ("added", 2000))

    def test_an_osascript_failure_that_landed_elsewhere_is_a_stray(self):
        add(self.con, 1, "N", "other", False, T0 + 1)
        stop, _ = self.run_late({"ok": False, "error": "timeout"}, "N")
        self.assertEqual((stop.result["code"], stop.result["guid"]), ("stray", "N"))

    def test_an_osascript_failure_with_no_row_is_that_failure(self):
        stop, _ = self.run_react([{"ok": False, "error": "perform-failed"}])
        self.assertEqual((stop.exit_code, stop.result["code"]), (react.EX_TEMPFAIL, "perform-failed"))

    def test_an_answer_that_pressed_nothing_does_not_wait(self):
        for error in ["moved", "ambiguous", "not-offered"]:
            with patch.object(react, "answer") as waited:
                stop, _ = self.run_react([{"ok": False, "error": error}])
            self.assertEqual(stop.result["code"], error)
            waited.assert_not_called()

    def test_a_bubble_that_keeps_moving_is_never_pressed(self):
        moving = {"ok": False, "error": "unsettled", "frame": "10,20,100,30"}
        with patch.object(react, "answer") as waited:
            stop, messages = self.run_react([dict(moving) for _ in range(react.MAX_SETTLES + 1)])
        self.assertEqual((stop.exit_code, stop.result["code"]), (react.EX_TEMPFAIL, "unsettled"))
        self.assertEqual(len(messages.performs), react.MAX_SETTLES + 1)
        waited.assert_not_called()

    def test_no_consent_touches_nothing(self):
        messages = FakeMessages(self.con, 1, "M", [])
        with patch.object(react, "system_events_consent", return_value="not yet"), \
             self.assertRaises(react.Stop) as caught:
            react.react(self.con, self.target, 0, False, [], self.ui, run=messages)
        self.assertEqual((caught.exception.exit_code, caught.exception.result["code"]), (react.EX_NOPERM, "consent"))
        self.assertEqual((messages.requests, self.ui.selected, self.ui.restored), ([], [], []))

    def test_the_wrong_row_type_is_not_success(self):
        stop, _ = self.run_react([{**OK, "lands": 2003}])
        self.assertEqual((stop.result["code"], stop.result["type"]), ("unexpected", 2003))

    def test_failed_selection_performs_nothing(self):
        self.ui.select_error = "could not open"
        stop, messages = self.run_react([])
        self.assertEqual(stop.exit_code, react.EX_UNAVAILABLE)
        self.assertEqual(messages.requests, [])
        self.assertEqual(self.ui.restored, ["Previous app"])

    def test_add_then_remove_leaves_the_message_as_it_was(self):
        def shown():
            rows = self.con.execute(
                """SELECT m.ROWID, m.guid, m.associated_message_type AS assoc_type, m.balloon_bundle_id,
                          m.payload_data, m.thread_originator_guid AS orig_guid, m.is_from_me, m.date_read,
                          NULL AS style_id, 0 AS is_audio_message
                     FROM message m""").fetchall()
            kept, extras = imsg.enrich(self.con, rows, with_names=False)
            return [extras[r["ROWID"]].get("tapbacks", []) for r in kept]

        before = shown()
        added, _ = self.run_react([{**OK, "lands": 2004}], kind=4)
        self.assertEqual(added["result"], "added")
        self.assertEqual(shown(), [[{"emoji": imsg.TAPBACK_EMOJI[4], "from_me": True, "by": None}]])
        removed, _ = self.run_react([{**OK, "lands": 3004}], kind=4, remove=True)
        self.assertEqual(removed["result"], "removed")
        self.assertEqual(shown(), before)
        self.assertIsNone(react.current_kind(react.my_rows(self.con, ["M"], [])))


class Consent(unittest.TestCase):
    """Over ssh, act only on a recorded Automation → System Events grant (#36)."""
    def setUp(self):
        env = patch.dict(react.os.environ, {"SSH_CONNECTION": "100.64.0.2 50000 100.64.0.1 22"})
        env.start()
        self.addCleanup(env.stop)

    def tcc(self, rows=(), schema="access"):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "TCC.db"
        con = sqlite3.connect(path)
        con.execute(f"CREATE TABLE {schema} (service TEXT, client TEXT, client_type INTEGER, auth_value INTEGER,"
                    " indirect_object_identifier TEXT)")
        con.executemany(f"INSERT INTO {schema} VALUES (?, ?, 1, ?, ?)", rows)
        con.commit()
        con.close()
        return str(path)

    def grant(self, value, client=react.SSH_CLIENT, target="com.apple.systemevents"):
        return ("kTCCServiceAppleEvents", client, value, target)

    def test_at_the_mac_nothing_is_checked(self):
        with patch.dict(react.os.environ, {"SSH_CONNECTION": ""}):
            self.assertEqual(react.system_events_consent("/nonexistent/TCC.db"), "")

    def test_a_recorded_grant_lets_it_through(self):
        self.assertEqual(react.system_events_consent(self.tcc([self.grant(2)])), "")

    def test_no_grant_yet_is_refused_with_the_way_to_give_it(self):
        path = self.tcc([self.grant(2, client="/usr/bin/osascript"), self.grant(2, target="com.apple.MobileSMS")])
        self.assertIn("blip-check --markread over ssh", react.system_events_consent(path))

    def test_a_denial_points_at_the_reset(self):
        self.assertIn("tccutil reset AppleEvents", react.system_events_consent(self.tcc([self.grant(0)])))

    def test_unreadable_or_unfamiliar_is_no(self):
        self.assertIn("cannot confirm", react.system_events_consent("/nonexistent/TCC.db"))
        self.assertIn("cannot confirm", react.system_events_consent(self.tcc(schema="other")))


class Paging(unittest.TestCase):
    TARGET = {"text": "x", "from_me": True, "hhmm": "10:00", "ordinal": 0,
              "newest": {"text": "y", "from_me": False, "hhmm": "10:05"}}

    def perform(self, answers, pages=None):
        requests = []
        pages = list(pages or [])

        def run(request):
            requests.append(request)
            if request["mode"] == "page":
                return pages.pop(0) if pages else {"ok": True}
            return answers.pop(0)

        with patch.object(react.time, "sleep"):
            result = react.perform(self.TARGET, "Heart", run=run)
        return result, [r.get("direction") for r in requests if r["mode"] == "page"]

    def test_found_at_once_pages_nothing(self):
        self.assertEqual(self.perform([OK]), (OK, []))

    def test_pages_down_to_the_bottom_then_up(self):
        missing, bottom = {"ok": False, "error": "not-rendered"}, {"ok": False, "error": "not-rendered", "atBottom": True}
        result, pages = self.perform([missing, bottom, bottom, bottom, OK])
        self.assertEqual((result, pages), (OK, ["down", "up", "up"]))

    def test_never_pages_up_without_having_seen_the_bottom(self):
        missing = {"ok": False, "error": "not-rendered"}
        result, pages = self.perform([dict(missing) for _ in range(5)])
        self.assertEqual(result["error"], "not-rendered")
        self.assertEqual(pages, ["down"] * react.MAX_PAGES_DOWN)

    def test_no_page_below_counts_as_the_bottom(self):
        missing = {"ok": False, "error": "not-rendered"}
        result, pages = self.perform([dict(missing)] * 3 + [OK], pages=[{"ok": True, "atBottom": True}])
        self.assertEqual((result, pages), (OK, ["down", "up"]))

    def test_gives_up_after_the_last_page_up(self):
        bottom = {"ok": False, "error": "not-rendered", "atBottom": True}
        result, pages = self.perform([dict(bottom) for _ in range(react.MAX_PAGES_UP + 2)])
        self.assertEqual(result["error"], "not-rendered")
        self.assertEqual(pages, ["up"] * react.MAX_PAGES_UP)

    def test_the_search_stops_at_the_deadline(self):
        missing = {"ok": False, "error": "not-rendered"}
        requests = []

        def run(request):
            requests.append(request)
            return dict(missing)

        with patch.object(react.time, "sleep"):
            result = react.perform(self.TARGET, "Heart", run=run, deadline=react.time.monotonic())
        self.assertEqual((result["error"], len(requests)), ("not-rendered", 1))
        self.assertIn("not found", result["detail"])

    def test_presses_only_where_the_last_pass_left_it(self):
        # Each pass that saw the bubble somewhere new scrolled it; the next
        # must find it at that frame before anything is pressed.
        requests = []
        answers = [{"ok": False, "error": "unsettled", "frame": "0,500,100,30"},
                   {"ok": False, "error": "unsettled", "frame": "0,300,100,30"}, OK]

        def run(request):
            requests.append(request)
            return answers.pop(0)

        with patch.object(react.time, "sleep"):
            self.assertEqual(react.perform(self.TARGET, "Heart", run=run), OK)
        self.assertEqual([r["frame"] for r in requests], ["", "0,500,100,30", "0,300,100,30"])

    def test_other_errors_end_the_search(self):
        self.assertEqual(self.perform([{"ok": False, "error": "ambiguous"}])[0]["error"], "ambiguous")


class Boundaries(unittest.TestCase):
    def test_message_text_never_rides_argv(self):
        seen = {}

        def fake_run(args, input=None, **kw):
            seen["args"], seen["input"] = args, input
            return type("P", (), {"returncode": 0, "stdout": b'{"ok": true}', "stderr": b""})()

        with patch.object(react.subprocess, "run", fake_run):
            self.assertEqual(react.jxa({"text": "secret words"}), {"ok": True})
        self.assertNotIn("secret words", " ".join(seen["args"]))
        self.assertIn("secret words", seen["input"].decode())

    def test_a_pass_that_scrolls_never_presses(self):
        # AX paths name places in the tree and a scroll renumbers the rows: a
        # press in the pass that scrolled can land on the neighbour.
        run = react.JXA[react.JXA.index("function run()"):]
        self.assertEqual(run.count("AXScrollToVisible"), 1)
        start = run.index("if (q.frame !== g.key) {")
        branch = run[start:run.index("\n  }\n", start)]
        self.assertIn("AXScrollToVisible", branch)
        self.assertIn('out.error = "unsettled"; return', branch)
        self.assertLess(start, run.index("out.ok = true"))

    def test_osascript_failure_is_an_error_not_a_crash(self):
        def fake_run(args, input=None, **kw):
            return type("P", (), {"returncode": 1, "stdout": b"", "stderr": b"execution error"})()

        with patch.object(react.subprocess, "run", fake_run):
            self.assertEqual(react.jxa({})["error"], "osascript")

    def test_usage_errors_exit_64(self):
        with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(react.main(["love"]), react.EX_USAGE)
            self.assertEqual(react.main(["--guid", "A", "wave"]), react.EX_USAGE)
            self.assertEqual(react.main(["--guid", "A B;rm", "love"]), react.EX_USAGE)

    def test_dry_run_says_what_it_would_do(self):
        con = db()
        add(con, 1, "M", "see you", False, T0)
        out = io.StringIO()
        with patch.object(react.sqlite3, "connect", return_value=con), \
             patch.object(react, "sibling", side_effect=lambda n: imsg if n == "imsg" else NoSelf), \
             contextlib.redirect_stdout(out):
            self.assertEqual(react.main(["--guid", "M", "like"]), 0)
        self.assertEqual(json.loads(out.getvalue()),
                         {"ok": True, "result": "dry-run", "would": "add", "action": "Thumbs up"})

    def test_a_bug_is_named_and_never_exit_1(self):
        # Exit 1 means "not-offered" (Messages renamed the action): a crash must not say that.
        out, err = io.StringIO(), io.StringIO()
        with patch.object(react.sqlite3, "connect", return_value=db()), \
             patch.object(react, "sibling", side_effect=lambda n: imsg if n == "imsg" else NoSelf), \
             patch.object(react, "resolve", side_effect=KeyError("chat_identifier")), \
             contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assertEqual(react.main(["--guid", "M", "like"]), react.EX_SOFTWARE)
        self.assertEqual(json.loads(out.getvalue())["code"], "error")
        self.assertIn("KeyError", err.getvalue())

    def test_the_six_classic_kinds(self):
        self.assertEqual(sorted(k for _, k in react.TAPBACKS.values()), [0, 1, 2, 3, 4, 5])
        self.assertEqual(len(set(react.ACTIONS)), 6)


class Siblings(unittest.TestCase):
    """The tests above hand react() a stand-in for imsg-read. This pins the
    real tools to what imsg-react calls on them, so a sibling that renames or
    drops one (the Messages lock above all) fails here, not on the Mac."""

    def test_every_sibling_name_imsg_react_uses_exists(self):
        src = Path(__file__).with_name("imsg-react").read_text()
        uses = {("imsg", n) for n in re.findall(r"\bimsg\.([A-Za-z_]+)", src)}
        uses |= {("imsg-read", n) for n in re.findall(r"\bui\.([A-Za-z_]+)", src)}
        uses |= set(re.findall(r'sibling\("([a-z-]+)"\)\.([A-Za-z_]+)', src))
        self.assertIn(("imsg-read", "messages_ui_lock"), uses)
        self.assertIn(("imsg-send", "detect_self_handles"), uses)
        tools = {name: load(name) for name in {tool for tool, _ in uses}}
        missing = sorted(f"{tool}.{n}" for tool, n in uses if not hasattr(tools[tool], n))
        self.assertEqual(missing, [])


if __name__ == "__main__":
    unittest.main()
