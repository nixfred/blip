"""Read pushes use synthetic IDs and mocked UI calls; never open Messages."""
import contextlib
import datetime
import importlib.machinery
import importlib.util
import io
import plistlib
from pathlib import Path
import struct
import subprocess
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
DND_LIST_NOW = read.dnd_list_now   # ActionProbes patches the module's copy

FOUNDATION_DISTANT_PAST = -63114076800.0   # NSDate.distantPast, as macOS 27 stores upiExpiryDate


def year_one_props(props: dict) -> bytes:
    """A chat.properties blob the way macOS 27 writes it: `upiExpiryDate` is
    Foundation's year 1, two days older than datetime.min, so plistlib refuses
    the whole dictionary (#132). Built by patching the one sentinel date."""
    blob = plistlib.dumps({**props, "upiExpiryDate": datetime.datetime(2001, 1, 1)}, fmt=plistlib.FMT_BINARY)
    marker = b"\x33" + bytes(8)                                  # a date of 0.0 s since 2001
    assert blob.count(marker) == 1
    return blob.replace(marker, b"\x33" + struct.pack(">d", FOUNDATION_DISTANT_PAST))


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

    def test_windowless_messages_names_a_locked_screen(self):
        with patch.object(read.subprocess, "run", return_value=CompletedProcess([], 0)), \
             patch.object(read, "osa", return_value=(0, "0")), \
             patch.object(read, "screen_locked", return_value=True):
            self.assertIn("screen is locked", read.select_chat("chat12345"))

    def test_accessibility_failure_names_the_lock_only_while_locked(self):
        denied = "osascript is not allowed assistive access"
        broken = "System Events got an error: Can't get window 1 of process \"Messages\"."
        with patch.object(read, "screen_locked", return_value=True):
            with patch.object(read, "osa", return_value=(1, broken)):
                self.assertIn("screen is locked", read.accessibility())
            with patch.object(read, "osa", return_value=(1, denied)):
                self.assertIn("Accessibility is not granted", read.accessibility())
        with patch.object(read, "screen_locked", return_value=False), \
             patch.object(read, "osa", return_value=(1, broken)):
            self.assertEqual(read.accessibility(), broken)

    RACE = ('System Events got an error: Can\'t get menu bar 1 of process "Messages". '
            'Invalid index. (-1719)')

    def test_a_launched_messages_is_waited_for_not_trusted(self):
        # The launch race (2026-11-09): `open -g -j` puts the process on the
        # list long before System Events can see its menu bar, and the old
        # success condition — process exists — let the very next probe answer
        # -1719. Every first tapback after Messages left lost that race.
        seq = iter([(1, self.RACE),    # the gate: menus not registered yet
                    (0, "false"),      # messages_running: not even a process
                    (1, self.RACE),    # loop: process up, menus still absent
                    (0, "Messages")])  # loop: driveable — success
        with patch.object(read, "osa", side_effect=lambda *a: next(seq)), \
             patch.object(read, "screen_locked", return_value=False), \
             patch.object(read.subprocess, "run", return_value=CompletedProcess([], 0)) as run:
            self.assertEqual(read.ensure_messages(), "")
        self.assertIn(["open", "-g", "-j", "-a", "Messages"],
                      [c[0][0] for c in run.call_args_list])

    def test_menus_that_never_arrive_are_not_a_success(self):
        def osa(script):
            return (1, self.RACE) if "menu bar 1" in script else (0, "true")
        with patch.object(read, "osa", side_effect=osa), \
             patch.object(read, "screen_locked", return_value=False), \
             patch.object(read.subprocess, "run", return_value=CompletedProcess([], 0)):
            why = read.ensure_messages()
        self.assertIn("cannot reach its menus", why)
        self.assertIn("-1719", why)   # the tool's own error travels with it

    def test_lock_and_denial_are_not_this_gate_and_never_wait(self):
        # Waiting only helps the kind waiting can fix: a lock screen hides
        # everything until a password, a denial repeats itself. Neither starts
        # Messages, neither sleeps, and the reason stays with the gate that
        # always named it — so exit 77 keeps its meaning and 69 stays
        # "Messages would not start", exactly as before this fix.
        with patch.object(read, "osa", return_value=(1, self.RACE)), \
             patch.object(read, "screen_locked", return_value=True), \
             patch.object(read.subprocess, "run") as run:
            self.assertEqual(read.ensure_messages(), "")
            self.assertIn("screen is locked", read.accessibility())
        self.assertEqual(run.call_args_list, [])
        with patch.object(read, "osa", return_value=(1, "osascript is not allowed assistive access")), \
             patch.object(read.subprocess, "run") as run:
            self.assertEqual(read.ensure_messages(), "")
            self.assertIn("Accessibility is not granted", read.accessibility())
        self.assertEqual(run.call_args_list, [])

    def test_already_drivable_messages_answers_one_probe(self):
        with patch.object(read, "osa", return_value=(0, "Messages")) as probe, \
             patch.object(read.subprocess, "run") as run:
            self.assertEqual(read.ensure_messages(), "")
        self.assertEqual(probe.call_count, 1)
        self.assertEqual(run.call_args_list, [])

    def test_screen_lock_is_read_from_the_console_session(self):
        locked = plistlib.dumps({"IOConsoleUsers": [
            {"kCGSSessionUserNameKey": "me", "kCGSSessionOnConsoleKey": True, "CGSSessionScreenIsLocked": True}]})
        unlocked = plistlib.dumps({"IOConsoleUsers": [
            {"kCGSSessionUserNameKey": "me", "kCGSSessionOnConsoleKey": True}]})
        cases = [(locked, 0, True), (unlocked, 0, False), (locked, 1, False),
                 (b"not a plist", 0, False), (b"", 0, False), (None, 0, False)]
        for payload, code, want in cases:
            with patch.object(read.subprocess, "run",
                              return_value=CompletedProcess([], code, stdout=payload)) as run:
                self.assertEqual(read.screen_locked(), want, (payload, code))
                self.assertEqual(run.call_args[0][0][:2], ["ioreg", "-n"])
        with patch.object(read.subprocess, "run", side_effect=OSError("no ioreg")):
            self.assertFalse(read.screen_locked())

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


class ConversationActions(unittest.TestCase):
    """Pin, Unpin, Hide Alerts, Show Alerts: four Mac writes through Messages'
    Conversation menu. Every UI call is mocked; nothing opens Messages."""

    DM = "+15550100001"
    FLAGS = {"--pin": ("Pin", "chat_pinned", True, "pinned"),
             "--unpin": ("Unpin", "chat_pinned", False, "unpinned"),
             "--mute": ("Hide Alerts", "chat_muted", True, "muted"),
             "--unmute": ("Show Alerts", "chat_muted", False, "unmuted")}

    WANT = object()   # the probe reports exactly what the action asked for
    OPPOSITE = object()   # ... or the state the action is meant to change

    def run_action(self, flag, probe=WANT, unread=(0,), select_error="", clicks=((True, ""),),
                   front=("Previous app", "Messages"), handle=DM, start=OPPOSITE,
                   sidebar=(True, ""), refusal=""):
        """Run main() for one action. Returns (exit code, stdout, stderr, calls).
        `start` is what Hide/Show Alerts' pre-check reads (read.CHECK_FIRST)."""
        item, probe_name, want, _ = self.FLAGS[flag]
        calls = []
        checked = []
        fronts = list(front)
        clicks = list(clicks)
        unread = list(unread)

        def frontmost():
            calls.append("frontmost")
            return fronts.pop(0) if fronts else "Messages"

        def select(handle):
            calls.append(f"select:{handle}")
            return select_error

        def click(name):
            calls.append(f"click:{name}")
            return clicks.pop(0) if clicks else (True, "")

        def side(name):
            calls.append(f"sidebar:{name}")
            return sidebar

        def count(handle=None):
            calls.append("unread")
            return unread.pop(0) if len(unread) > 1 else unread[0]

        def restore(prev):
            calls.append(f"restore:{prev}")

        def refused():
            calls.append("refusal")
            return refusal

        def check(handle):
            if flag in read.CHECK_FIRST and not checked:
                checked.append(True)
                calls.append("precheck")
                return (not want) if start is self.OPPOSITE else start
            calls.append("verify")
            return want if probe is self.WANT else probe

        out, err = io.StringIO(), io.StringIO()
        code = 0
        with patch.object(read.sys, "argv", ["imsg-read", flag, handle]), \
             patch.object(read, "ensure_messages", return_value=""), \
             patch.object(read, "accessibility", return_value=""), \
             patch.object(read, "frontmost", side_effect=frontmost), \
             patch.object(read, "osa", return_value=(0, "")), \
             patch.object(read, "select_chat", side_effect=select), \
             patch.object(read, "click", side_effect=click), \
             patch.object(read, "sidebar_action", side_effect=side), \
             patch.object(read, "unread_on_mac", side_effect=count), \
             patch.object(read, "restore_front", side_effect=restore), \
             patch.object(read, "pin_refusal", side_effect=refused), \
             patch.object(read, probe_name, side_effect=check), \
             patch.object(read.time, "sleep"), \
             contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                read.main()
            except SystemExit as exc:
                code = exc.code
        return code, out.getvalue(), err.getvalue(), calls

    def test_front_app_is_captured_before_the_conversation_opens(self):
        """`open imessage:` can foreground Messages by itself; capturing after
        it restored Messages to Messages and left the user's app behind."""
        for flag, (item, _, _, word) in self.FLAGS.items():
            with self.subTest(flag=flag):
                code, out, _, calls = self.run_action(flag)
                self.assertEqual(code, 0)
                self.assertEqual(out.strip(), word)
                self.assertLess(calls.index("frontmost"), calls.index(f"select:{self.DM}"))
                self.assertLess(calls.index(f"select:{self.DM}"), calls.index(f"click:{item}"))
                self.assertIn(f"click:{item}", calls)
                self.assertEqual(calls[-1], "restore:Previous app")

    def test_dormant_menu_wakes_messages_and_still_restores_the_original_app(self):
        code, _, _, calls = self.run_action("--pin", clicks=((False, ""), (True, "")))
        self.assertEqual(code, 0)
        self.assertEqual(calls.count("click:Pin"), 2)
        self.assertEqual(calls[-1], "restore:Previous app")

    def test_selection_failure_never_clicks_and_restores_focus(self):
        code, _, err, calls = self.run_action("--mute", select_error="could not open the conversation")
        self.assertEqual(code, 64)
        self.assertIn("could not open", err)
        self.assertFalse([c for c in calls if c.startswith("click:")])
        self.assertEqual(calls[-1], "restore:Previous app")

    def test_menu_error_restores_focus(self):
        code, _, _, calls = self.run_action("--unmute", clicks=((False, "boom"),))
        self.assertEqual(code, 1)
        self.assertNotIn("verify", calls)
        self.assertEqual(calls[-1], "restore:Previous app")

    def test_verified_failed_and_unknown(self):
        for flag, (_, _, want, word) in self.FLAGS.items():
            with self.subTest(flag=flag, outcome="failed"):
                code, out, err, _ = self.run_action(flag, probe=not want)
                self.assertEqual(code, 75)
                self.assertEqual(out, "")
                self.assertIn(f"is not {word}", err)
            with self.subTest(flag=flag, outcome="unknown"):
                # Unknown is never success - not for the "off" actions either.
                code, out, err, _ = self.run_action(flag, probe=None)
                self.assertEqual(code, 75)
                self.assertEqual(out, "")
                self.assertIn("cannot confirm", err)

    def test_settle_flag_waits_through_a_transient_unknown(self):
        with patch.object(read.time, "sleep"):
            self.assertIs(read.settle_flag(iter([None, None, False]).__next__, False), False)
            self.assertIsNone(read.settle_flag(lambda: None, False, tries=3))
            self.assertIs(read.settle_flag(lambda: True, False, tries=3), True)

    def test_groups_are_refused_before_anything_opens(self):
        for group in ("chat12345", "a" * 32):
            with self.subTest(group=group):
                code, _, err, calls = self.run_action("--pin", handle=group)
                self.assertEqual(code, 64)
                self.assertIn("group", err)
                self.assertFalse([c for c in calls if c.startswith(("select:", "click:", "frontmost"))])

    def test_pin_or_mute_puts_back_an_unread_that_opening_it_read(self):
        """Selecting shows the DM and Messages reads what it shows. A pin is
        not a read: the unread goes back on while the chat is still selected,
        before focus returns."""
        for flag in self.FLAGS:
            with self.subTest(flag=flag):
                # before=1, after the action 0 (opening read it), then 1 again.
                code, out, err, calls = self.run_action(flag, unread=(1, 0, 1))
                self.assertEqual(code, 0)
                self.assertEqual(err, "")
                self.assertIn("click:Mark as Unread", calls)
                self.assertLess(calls.index("click:Mark as Unread"), calls.index("restore:Previous app"))

    def test_a_read_conversation_is_left_read(self):
        code, _, _, calls = self.run_action("--mute", unread=(0,))
        self.assertEqual(code, 0)
        self.assertNotIn("click:Mark as Unread", calls)

    def test_an_unread_that_survived_opening_is_not_touched(self):
        code, _, _, calls = self.run_action("--pin", unread=(2, 2))
        self.assertEqual(code, 0)
        self.assertNotIn("click:Mark as Unread", calls)

    def test_a_lost_unread_is_reported_not_hidden(self):
        code, out, err, calls = self.run_action("--pin", unread=(1, 0, 0),
                                                clicks=((True, ""), (True, "")))
        self.assertEqual(code, 0)          # the pin itself landed and was verified
        self.assertEqual(out.strip(), "pinned")
        self.assertIn("unread state", err)

    def test_unread_is_restored_even_when_the_action_fails(self):
        code, _, _, calls = self.run_action("--unpin", probe=True, unread=(1, 0, 1))
        self.assertEqual(code, 75)
        self.assertIn("click:Mark as Unread", calls)


    def test_hide_or_show_alerts_already_in_place_never_opens_messages(self):
        for flag in ("--mute", "--unmute"):
            with self.subTest(flag=flag):
                want = self.FLAGS[flag][2]
                code, out, _, calls = self.run_action(flag, start=want)
                self.assertEqual(code, 0)
                self.assertEqual(out.strip(), self.FLAGS[flag][3])
                self.assertEqual(calls, ["precheck"])

    def test_an_unknown_mute_state_never_clicks_a_toggle(self):
        """On macOS 27 Hide Alerts toggles: clicked while already muted it unmutes."""
        for flag in ("--mute", "--unmute"):
            with self.subTest(flag=flag):
                code, out, err, calls = self.run_action(flag, start=None)
                self.assertEqual(code, 75)
                self.assertEqual(out, "")
                self.assertIn("was not clicked", err)
                self.assertEqual(calls, ["precheck"])

    def test_macos_27_show_alerts_is_the_hide_alerts_toggle(self):
        """27 has no Show Alerts item; the muted chat's Hide Alerts turns them back on."""
        code, out, _, calls = self.run_action("--unmute", clicks=((False, ""), (False, ""), (True, "")))
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), "unmuted")
        clicks = [c for c in calls if c.startswith("click:")]
        self.assertEqual(clicks, ["click:Show Alerts", "click:Show Alerts", "click:Hide Alerts"])
        self.assertLess(calls.index("precheck"), calls.index(f"select:{self.DM}"))
        self.assertEqual(calls[-1], "restore:Previous app")

    def test_hide_alerts_has_no_fallback(self):
        code, _, err, calls = self.run_action("--mute", clicks=((False, ""), (False, "")))
        self.assertEqual(code, 1)
        self.assertIn("'Hide Alerts' was not available", err)
        self.assertEqual([c for c in calls if c.startswith("click:")], ["click:Hide Alerts"] * 2)

    def test_macos_27_pins_through_the_sidebar(self):
        """27's Conversation menu has no Pin or Unpin; the selected sidebar
        entry offers them as Accessibility actions (#132)."""
        for flag, item in (("--pin", "Pin"), ("--unpin", "Unpin")):
            with self.subTest(flag=flag):
                code, out, _, calls = self.run_action(flag, clicks=((False, ""), (False, "")))
                self.assertEqual(code, 0)
                self.assertEqual(out.strip(), self.FLAGS[flag][3])
                self.assertEqual([c for c in calls if c.startswith(("click:", "sidebar:"))],
                                 [f"click:{item}", f"click:{item}", f"sidebar:{item}"])
                self.assertLess(calls.index(f"select:{self.DM}"), calls.index(f"sidebar:{item}"))
                self.assertLess(calls.index(f"sidebar:{item}"), calls.index("verify"))
                self.assertEqual(calls[-1], "restore:Previous app")

    def test_pins_wait_longer_for_the_pin_list(self):
        """27's pin list trailed the sidebar action by 4.4 to 5.5 s."""
        seen = {}
        real = read.settle_flag

        def settle(fn, want, **kw):
            seen.update(kw)
            return real(fn, want, **kw)
        with patch.object(read, "settle_flag", side_effect=settle):
            self.run_action("--pin")
        self.assertGreaterEqual(seen["tries"] * seen["pause"], 10)
        seen.clear()
        with patch.object(read, "settle_flag", side_effect=settle):
            self.run_action("--mute")
        self.assertEqual(seen, {})

    def test_the_sidebar_is_never_used_when_the_menu_works(self):
        _, _, _, calls = self.run_action("--pin")
        self.assertNotIn("sidebar:Pin", calls)

    def test_mute_never_falls_back_to_the_sidebar(self):
        _, _, _, calls = self.run_action("--mute", clicks=((False, ""), (False, "")))
        self.assertFalse([c for c in calls if c.startswith("sidebar:")])

    def test_a_sidebar_that_offers_nothing_fails_and_says_why(self):
        code, out, err, calls = self.run_action(
            "--unpin", clicks=((False, ""), (False, "")),
            sidebar=(False, "Unpin is not in the Conversation menu or the sidebar (no Unpin)"))
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("not in the Conversation menu or the sidebar", err)
        self.assertNotIn("verify", calls)
        self.assertEqual(calls[-1], "restore:Previous app")

    def test_pins_are_not_checked_first(self):
        _, _, _, calls = self.run_action("--pin")
        self.assertNotIn("precheck", calls)


    CAP = "You can pin up to 9 conversations. To pin this conversation, unpin another one first."

    def test_a_pin_messages_refused_says_what_messages_said(self):
        """Live on the 27.2 gateway (2026-11-09): the sidebar action returned
        success, Messages put up its pin-limit alert, and the tool said only
        "clicked but not pinned" and left the alert open."""
        reason = f'Pin was clicked but Messages refused: "{self.CAP}" (the alert was dismissed)'
        code, out, err, calls = self.run_action("--pin", probe=False, refusal=reason)
        self.assertEqual(code, 75)
        self.assertEqual(out, "")
        self.assertIn(self.CAP, err)
        self.assertNotIn("is not pinned", err)
        self.assertEqual(calls[-2:], ["restore:Previous app", "refusal"])

    def test_a_pin_that_failed_without_an_alert_keeps_the_old_message(self):
        code, _, err, calls = self.run_action("--pin", probe=False, refusal="")
        self.assertEqual(code, 75)
        self.assertIn("was clicked but the conversation is not pinned", err)
        self.assertIn("refusal", calls)

    def test_the_window_is_only_read_after_a_pin_that_did_not_land(self):
        for flag, kw in (("--pin", {}), ("--unpin", {"probe": True}), ("--mute", {"probe": False}),
                         ("--unmute", {"probe": True})):
            with self.subTest(flag=flag):
                _, _, _, calls = self.run_action(flag, **kw)
                self.assertNotIn("refusal", calls)

    def test_an_unknown_pin_list_still_reads_the_alert(self):
        code, _, err, _ = self.run_action("--pin", probe=None,
                                          refusal=f'Pin was clicked but Messages refused: "{self.CAP}" (the alert was dismissed)')
        self.assertEqual(code, 75)
        self.assertIn(self.CAP, err)


class PinRefusal(unittest.TestCase):
    """pin_refusal() reads one line from the JXA helper; osascript is mocked."""

    def refusal(self, stdout=b"", code=0, pid=4242, timeout=False):
        done = subprocess.CompletedProcess([], code, stdout, b"")
        effect = subprocess.TimeoutExpired("osascript", 1) if timeout else None
        with patch.object(read, "messages_pid", return_value=pid), \
             patch.object(read.subprocess, "run", return_value=done, side_effect=effect) as run:
            got = read.pin_refusal()
        return got, run

    CAP = ConversationActions.CAP

    def test_a_dismissed_pin_limit_alert_is_quoted_and_said_to_be_dismissed(self):
        got, run = self.refusal(f"alert 1 {self.CAP}\n".encode())
        self.assertIn(self.CAP, got)
        self.assertIn("the alert was dismissed", got)
        self.assertEqual(run.call_args[0][0][-1], "4242")

    def test_an_alert_it_did_not_press_is_reported_as_left_open(self):
        got, _ = self.refusal(b"alert 0 Delete this conversation? This cannot be undone.\n")
        self.assertIn("Delete this conversation?", got)
        self.assertIn("left open on the Mac", got)

    def test_nothing_to_report_is_empty(self):
        for stdout, code in ((b"none\n", 0), (b"", 0), (b"alert 1 \n", 0), (b"alert 1 ok", 1)):
            with self.subTest(stdout=stdout, code=code):
                self.assertEqual(self.refusal(stdout, code=code)[0], "")

    def test_a_timeout_or_a_missing_messages_is_empty_and_never_runs_without_a_pid(self):
        self.assertEqual(self.refusal(timeout=True)[0], "")
        got, run = self.refusal(b"alert 1 x", pid=None)
        self.assertEqual(got, "")
        run.assert_not_called()

    def test_control_characters_in_the_alert_text_do_not_reach_stderr(self):
        got, _ = self.refusal("alert 1 limit\x1b[31m reached\r\x07".encode())
        self.assertNotIn("\x1b", got)
        self.assertNotIn("\x07", got)
        self.assertNotIn("\r", got)


FAKE_ALERT = r"""
// An AX tree with one Messages window: app > window > [sheet > [texts, buttons]].
const S = JSON.parse(process.argv[2]);
const log = [];
const arr = a => ({ count: String(a.length), objectAtIndex: i => a[i] });  // JXA counts are strings
const mk = (role, extra) => Object.assign({ role, children: [] }, extra);
const sheet = mk('AXSheet', { children: [
  ...S.texts.map(t => mk('AXStaticText', { value: t })),
  ...S.buttons.map(b => mk('AXButton', { title: b })) ] });
const win = mk('AXWindow', { children: S.sheet ? [mk('AXGroup'), sheet] : [mk('AXGroup')] });
const app = mk('AXApplication', { children: [win] });
globalThis.ObjC = { import() {}, unwrap: x => x, castRefToObject: x => x };
globalThis.Ref = () => [];
globalThis.$ = Object.assign(s => s, {
  AXUIElementCreateApplication: () => app,
  AXUIElementCopyAttributeValue(el, name, ref) {
    const v = name === 'AXChildren' ? arr(el.children) : name === 'AXRole' ? el.role
      : name === 'AXValue' ? (el.value ?? null) : null;
    if (v === null) return -25205;
    ref[0] = v; return 0;
  },
  AXUIElementPerformAction(el, act) { log.push(act + ':' + el.title); return 0; },
});
"""


class PinAlertJs(unittest.TestCase):
    """The real PIN_ALERT_JS, run under bun or node against a fake AX tree."""

    CAP = ConversationActions.CAP

    def run_alert(self, texts, buttons, sheet=True):
        import json, shutil
        engine = shutil.which("bun") or shutil.which("node")
        if not engine:
            self.skipTest("no JavaScript runtime")
        state = {"texts": texts, "buttons": buttons, "sheet": sheet}
        js = FAKE_ALERT + read.PIN_ALERT_JS + (
            "\nconst result = run(['4242']);\nconsole.log(JSON.stringify({result, log}));\n")
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "alert.js"
            path.write_text(js)
            out = subprocess.run([engine, str(path), json.dumps(state)],
                                 capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode, 0, out.stderr)
        return json.loads(out.stdout)

    def test_the_pin_limit_sheet_is_read_and_its_only_button_pressed(self):
        got = self.run_alert(["Pinned Conversations", self.CAP], ["OK"])
        self.assertEqual(got["result"], "alert 1 Pinned Conversations " + self.CAP)
        self.assertEqual(got["log"], ["AXPress:OK"])

    def test_a_sheet_about_something_else_is_read_but_never_pressed(self):
        got = self.run_alert(["Delete Conversation", "This cannot be undone."], ["OK"])
        self.assertEqual(got["result"], "alert 0 Delete Conversation This cannot be undone.")
        self.assertEqual(got["log"], [])

    def test_a_sheet_with_a_choice_is_never_pressed_even_about_pins(self):
        got = self.run_alert(["Unpin another conversation?"], ["Unpin", "Cancel"])
        self.assertTrue(got["result"].startswith("alert 0 "))
        self.assertEqual(got["log"], [])

    def test_no_sheet_says_none(self):
        got = self.run_alert([], [], sheet=False)
        self.assertEqual(got["result"], "none")
        self.assertEqual(got["log"], [])


class SidebarAction(unittest.TestCase):
    """sidebar_action() reads one word from the JXA helper; osascript is mocked."""

    def run_js(self, stdout=b"", code=0, stderr=b"", pid=4242):
        done = subprocess.CompletedProcess([], code, stdout, stderr)
        with patch.object(read, "messages_pid", return_value=pid), \
             patch.object(read.subprocess, "run", return_value=done) as run:
            got = read.sidebar_action("Pin")
        return got, (run.call_args[0][0] if run.call_args else None)

    def test_item_and_the_messages_pid_ride_argv_after_the_script(self):
        _, argv = self.run_js(b"done\n")
        self.assertEqual(argv[:3], ["osascript", "-l", "JavaScript"])
        self.assertEqual(argv[-2:], ["Pin", "4242"])

    def test_no_single_messages_process_means_osascript_is_never_run(self):
        """Found on a real macOS 27.2 gateway (2026-11-08): the helper threw
        `objectAtIndex: index 0 beyond bounds for empty array` instead of saying
        Messages could not be found."""
        (ok, err), argv = self.run_js(b"done\n", pid=None)
        self.assertFalse(ok)
        self.assertIn("exactly one process", err)
        self.assertIsNone(argv)

    def test_messages_pid_wants_exactly_one_process_of_this_user(self):
        def pid_for(out, **kw):
            done = subprocess.CompletedProcess([], 0 if out else 1, out, b"")
            with patch.object(read.subprocess, "run", return_value=done, **kw) as run:
                return read.messages_pid(), run.call_args[0][0]
        got, argv = pid_for(b"66696\n")
        self.assertEqual(got, 66696)
        self.assertEqual(argv, ["/usr/bin/pgrep", "-x", "-U", str(read.os.getuid()), "Messages"])
        self.assertIsNone(pid_for(b"")[0])
        self.assertIsNone(pid_for(b"11 22\n")[0])
        self.assertIsNone(pid_for(b"not-a-pid\n")[0])
        with patch.object(read.subprocess, "run", side_effect=subprocess.TimeoutExpired("pgrep", 5)):
            self.assertIsNone(read.messages_pid())

    def test_the_js_never_asks_launchservices_and_compares_counts_as_numbers(self):
        """From an ssh session on macOS 27.2 NSRunningApplication and NSWorkspace
        list only background apps (no Finder, no Messages), and JXA hands every
        `count` back as a STRING, so `count === 0` can never be true."""
        # Code only: the comment that explains this names the banned APIs.
        js = "\n".join(line.split("//")[0] for line in read.SIDEBAR_JS.splitlines())
        for banned in ("NSRunningApplication", "NSWorkspace", "runningApplications"):
            self.assertNotIn(banned, js)
        self.assertIn("Number(argv[1])", js)
        self.assertNotIn("< arr.count", js)
        self.assertNotRegex(js, r"\.count\s*===")

    def test_done_and_already_are_success(self):
        self.assertEqual(self.run_js(b"done\n")[0], (True, ""))
        self.assertEqual(self.run_js(b"already\n")[0], (True, ""))

    def test_none_is_an_error_with_the_reason(self):
        (ok, err), _ = self.run_js(b"none 0 conversations are selected in the sidebar\n")
        self.assertFalse(ok)
        self.assertIn("0 conversations are selected", err)

    def test_ax_error_and_osascript_failure(self):
        self.assertEqual(self.run_js(b"error AXError -25205\n")[0], (False, "AXError -25205"))
        ok, err = self.run_js(code=1, stderr=b"execution error: boom")[0]
        self.assertFalse(ok)
        self.assertIn("boom", err)

    def test_only_the_sidebar_list_and_the_selected_entry_qualify(self):
        """A message bubble offers a bare "Pin" that pins the MESSAGE."""
        js = read.SIDEBAR_JS
        self.assertIn("'Conversations'", js)
        self.assertIn("'AXSelected') === true", js)
        self.assertIn("startsWith('Name:Pin ')", js)
        self.assertIn("endsWith(', Pinned')", js)


FAKE_SIDEBAR = r"""
// A Messages sidebar that, like the real one, builds only the rows near the
// viewport: `window` rows from `top`, paged 10 at a time.
const S = JSON.parse(process.argv[2]);
const log = [];
const rows = S.rows.map((d, i) => ({ desc: d, sel: i === S.selected,
  acts: d.endsWith(', Pinned') ? ['Name:Unpin'] : ['AXPress', 'Name:Pin ' + d.split(',')[0]] }));
let top = S.top;
const arr = a => ({ count: String(a.length), objectAtIndex: i => a[i] });  // JXA counts are strings
const list = { kind: 'list' };
const app = { kind: 'app', children: [{ kind: 'window', children: [list] }] };
function built() { return rows.slice(top, top + S.window); }
function value(el, name) {
  if (el.kind === 'app' || el.kind === 'window') return name === 'AXChildren' ? arr(el.children)
    : name === 'AXRole' ? (el.kind === 'window' ? 'AXWindow' : 'AXApplication') : null;
  if (el === list) return name === 'AXChildren' ? arr(built()) : name === 'AXDescription' ? 'Conversations' : null;
  return name === 'AXSelected' ? el.sel : name === 'AXDescription' ? el.desc : null;
}
globalThis.ObjC = { import() {}, unwrap: x => x, castRefToObject: x => x };
globalThis.Ref = () => [];
globalThis.delay = () => {};
globalThis.$ = Object.assign(s => s, {
  AXUIElementCreateApplication: () => app,
  AXUIElementCopyAttributeValue(el, name, ref) { const v = value(el, name); if (v === null) return -25205; ref[0] = v; return 0; },
  AXUIElementCopyActionNames(el, ref) { ref[0] = arr(el.acts || []); return 0; },
  AXUIElementPerformAction(el, act) {
    if (el === list) {
      log.push(act);
      const last = Math.max(0, rows.length - S.window);
      if (act === 'AXScrollDownByPage') top = Math.min(last, top + 10);
      if (act === 'AXScrollUpByPage') top = Math.max(0, top - 10);
    } else log.push('row:' + el.desc + ':' + act);
    return 0;
  },
});
"""


class SidebarScroll(unittest.TestCase):
    """The real SIDEBAR_JS, run under bun or node against a fake sidebar.
    On macOS 27 `open imessage:` selects a far-down chat without bringing its
    row into view (27.0.1 and 27.2, #132), so nothing built is selected."""

    ROWS = [f"Friend {i}, hello" for i in range(60)]

    def run_sidebar(self, want="Pin", selected=48, top=0, rows=None, window=12):
        import json, shutil
        engine = shutil.which("bun") or shutil.which("node")
        if not engine:
            self.skipTest("no JavaScript runtime")
        state = {"rows": rows or self.ROWS, "selected": selected, "top": top, "window": window}
        js = FAKE_SIDEBAR + read.SIDEBAR_JS + (
            "\nconst result = run([" + json.dumps(want) + ", '4242']);"
            "\nconsole.log(JSON.stringify({result, log, top}));\n")
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "sidebar.js"
            path.write_text(js)
            out = subprocess.run([engine, str(path), json.dumps(state)],
                                 capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode, 0, out.stderr)
        return json.loads(out.stdout)

    def test_a_far_down_chat_is_paged_into_view_pinned_and_the_list_returns_to_the_top(self):
        got = self.run_sidebar(selected=48)
        self.assertEqual(got["result"], "done")
        self.assertIn("row:Friend 48, hello:Name:Pin Friend 48", got["log"])
        self.assertIn("AXScrollDownByPage", got["log"])
        self.assertEqual(got["top"], 0)

    def test_a_built_selected_row_never_scrolls(self):
        got = self.run_sidebar(selected=3)
        self.assertEqual(got["result"], "done")
        self.assertFalse([a for a in got["log"] if a.startswith("AXScroll")])

    def test_a_list_left_scrolled_down_is_searched_from_the_top(self):
        got = self.run_sidebar(selected=2, top=40)
        self.assertEqual(got["result"], "done")
        self.assertIn("row:Friend 2, hello:Name:Pin Friend 2", got["log"])
        self.assertEqual(got["top"], 0)

    def test_nothing_selected_anywhere_ends_at_the_bottom_says_so_and_returns_to_the_top(self):
        got = self.run_sidebar(selected=-1)
        self.assertEqual(got["result"], "none 0 conversations are selected in the sidebar")
        self.assertFalse([a for a in got["log"] if a.startswith("row:")])
        self.assertEqual(got["top"], 0)

    def test_a_pinned_tile_found_after_paging_is_already_pinned(self):
        rows = list(self.ROWS)
        rows[30] = "Friend 30, Pinned"
        got = self.run_sidebar(selected=30, rows=rows)
        self.assertEqual(got["result"], "already")
        self.assertFalse([a for a in got["log"] if a.startswith("row:")])


class ActionProbes(unittest.TestCase):
    """The verifiers read Messages' own records with synthetic fixtures."""

    SCHEMA = ClusterScopedUnread.SCHEMA.replace(
        "last_read_message_timestamp INTEGER DEFAULT 0",
        "last_read_message_timestamp INTEGER DEFAULT 0,\n          properties BLOB")

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        root = Path(self.folder.name)
        self.db = str(root / "chat.db")
        self.pins = root / "com.apple.messages.pinning.plist"
        con = sqlite3.connect(self.db)
        con.executescript(self.SCHEMA)
        # A merged DM: phone row and email row, one group_id.
        con.executescript("""
            INSERT INTO chat (ROWID, chat_identifier, guid, display_name, style, group_id)
              VALUES (1, '+15550100001', 'SMS;-;+15550100001', '', 45, 'MERGED-DM-1');
            INSERT INTO chat (ROWID, chat_identifier, guid, display_name, style, group_id)
              VALUES (2, 'pat@example.com', 'iMessage;-;pat@example.com', '', 45, 'MERGED-DM-1');
            INSERT INTO chat (ROWID, chat_identifier, guid, display_name, style, group_id)
              VALUES (3, '+15550100002', 'iMessage;-;+15550100002', '', 45, 'DM-TWO');
            INSERT INTO handle VALUES (1, '+15550100001');
            INSERT INTO handle VALUES (2, 'pat@example.com');
            INSERT INTO handle VALUES (3, '+15550100002');
            INSERT INTO chat_handle_join VALUES (1, 1);
            INSERT INTO chat_handle_join VALUES (2, 2);
            INSERT INTO chat_handle_join VALUES (3, 3);
        """)
        con.commit()
        con.close()
        self.dnd_file = root / "com.apple.MobileSMS.CKDNDList.plist"
        self.dnd = set()   # what cfprefsd answers; None = `defaults` failed
        mod = read.imsg_module()
        mod._COLS = None
        for target, name, value in ((read, "DB_PATH", self.db),
                                    (read, "dnd_list_now", lambda _mod: self.dnd),
                                    (mod, "DND_LIST_PATHS", (str(self.dnd_file),)),
                                    (mod, "PINNING_PLIST_PATHS", (str(self.pins),))):
            p = patch.object(target, name, value)
            p.start()
            self.addCleanup(p.stop)

    def write_pins(self, data):
        with open(self.pins, "wb") as fh:
            plistlib.dump(data, fh)

    def set_props(self, rowid, blob):
        con = sqlite3.connect(self.db)
        con.execute("UPDATE chat SET properties = ? WHERE ROWID = ?", (blob, rowid))
        con.commit()
        con.close()

    def test_unreadable_pin_list_is_unknown_not_unpinned(self):
        self.assertIsNone(read.chat_pinned("+15550100001"))      # no file at all
        self.pins.write_bytes(b"not a plist")
        self.assertIsNone(read.chat_pinned("+15550100001"))
        self.write_pins({"something": ["+15550100001"]})          # unknown layout
        self.assertIsNone(read.chat_pinned("+15550100001"))

    def test_pin_stored_under_the_other_handle_counts(self):
        self.write_pins({"pD": {"pP": ["pat@example.com"]}})
        self.assertIs(read.chat_pinned("+15550100001"), True)
        self.assertIs(read.chat_pinned("+15550100002"), False)

    def test_an_empty_pin_list_is_a_verified_unpin(self):
        self.write_pins({"pD": {"pP": [], "pZ": {"x": {"o": "+15550100001"}}}})
        self.assertIs(read.chat_pinned("+15550100001"), False)

    def test_unreadable_database_is_unknown_for_pins(self):
        self.write_pins({"pD": {"pP": ["+15550100002"]}})
        with patch.object(read, "DB_PATH", str(Path(self.folder.name) / "missing" / "chat.db")):
            self.assertIsNone(read.chat_pinned("+15550100001"))

    def test_mute_flag_on_either_row_mutes_the_conversation(self):
        self.assertIs(read.chat_muted("+15550100001"), False)    # never configured
        self.set_props(2, plistlib.dumps({"ignoreAlertsFlag": True}, fmt=plistlib.FMT_BINARY))
        self.assertIs(read.chat_muted("+15550100001"), True)
        self.assertIs(read.chat_muted("pat@example.com"), True)
        self.assertIs(read.chat_muted("+15550100002"), False)
        self.set_props(2, plistlib.dumps({"ignoreAlertsFlag": False}, fmt=plistlib.FMT_BINARY))
        self.assertIs(read.chat_muted("+15550100001"), False)

    def test_malformed_or_missing_mute_state_is_unknown(self):
        self.set_props(1, b"garbage")
        self.assertIsNone(read.chat_muted("+15550100001"))
        self.set_props(1, plistlib.dumps(["not", "a", "dict"]))
        self.assertIsNone(read.chat_muted("+15550100001"))
        self.assertIsNone(read.chat_muted("+15550199999"))      # not on this Mac
        with patch.object(read, "DB_PATH", str(Path(self.folder.name) / "missing" / "chat.db")):
            self.assertIsNone(read.chat_muted("+15550100002"))

    def test_a_year_one_date_does_not_hide_the_mute_flag(self):
        """#132: on macOS 27 `upiExpiryDate` is year 1, plistlib drops the whole
        dictionary, and Hide/Show Alerts could never be verified for that chat."""
        on = year_one_props({"ignoreAlertsFlag": True})
        with self.assertRaises(plistlib.InvalidFileException):    # the premise
            plistlib.loads(on)
        self.set_props(2, on)
        self.assertIs(read.chat_muted("+15550100001"), True)
        self.set_props(2, year_one_props({"ignoreAlertsFlag": False}))
        self.assertIs(read.chat_muted("+15550100001"), False)
        self.set_props(2, year_one_props({"hasViewedPotentialSpamChat": True}))   # never configured
        self.assertIs(read.chat_muted("+15550100001"), False)

    def test_the_chat_list_counts_a_muted_chat_whose_date_is_year_one(self):
        self.set_props(2, year_one_props({"ignoreAlertsFlag": True}))
        mod = read.imsg_module()
        con = read.open_db()
        try:
            clusters = mod._group_cluster_map(con)
            muted = mod.muted_conversations(con, clusters)
        finally:
            con.close()
        self.assertIn(clusters.get("+15550100001", "+15550100001"), muted)

    def test_chat_list_and_write_agree_on_a_muted_alias(self):
        """`imsg chats` reports muted over the same cluster the verifier checks."""
        self.set_props(2, plistlib.dumps({"ignoreAlertsFlag": True}))
        mod = read.imsg_module()
        con = read.open_db()
        try:
            clusters = mod._group_cluster_map(con)
            muted = mod.muted_conversations(con, clusters)
        finally:
            con.close()
        canon = clusters.get("+15550100001", "+15550100001")
        self.assertIn(canon, muted)
        self.assertNotIn("+15550100002", muted)


    DISTANT_FUTURE = 64092211200.0   # what Hide Alerts wrote on a macOS 27.0.1 Mac

    def macos27_list(self, entries):
        """The DND list the way macOS 27 keeps it (`defaults export`, 2026-10-28)."""
        return {"CKDNDListKey": entries, "CKDNDMigrationKey": 2, "CatalystDNDMigrationVersion": 2}

    def test_a_macos_27_mute_is_in_the_dnd_list_not_chat_properties(self):
        """#132: Hide Alerts on 27 left ignoreAlertsFlag absent and added the handle here."""
        mod = read.imsg_module()
        self.set_props(1, year_one_props({"wasDetectedAsSMSSpam": True}))
        self.dnd = mod.dnd_ids(self.macos27_list({"pat@example.com": self.DISTANT_FUTURE}))
        self.assertIs(read.chat_muted("+15550100001"), True)      # the merged DM's other handle
        self.assertIs(read.chat_muted("+15550100002"), False)
        self.dnd = mod.dnd_ids(self.macos27_list({}))             # Show Alerts removed it
        self.assertIs(read.chat_muted("+15550100001"), False)

    def test_an_unreadable_dnd_list_is_unknown_unless_the_flag_says_muted(self):
        self.dnd = None
        self.assertIsNone(read.chat_muted("+15550100001"))
        self.set_props(2, plistlib.dumps({"ignoreAlertsFlag": True}, fmt=plistlib.FMT_BINARY))
        self.assertIs(read.chat_muted("+15550100001"), True)

    def test_dnd_ids_reads_expiries(self):
        mod = read.imsg_module()
        now = datetime.datetime.now(datetime.timezone.utc)
        self.assertEqual(mod.dnd_ids(self.macos27_list({
            "+15550100001": self.DISTANT_FUTURE,
            "+15550100002": (now - datetime.timedelta(hours=1)).timestamp() - mod.APPLE_EPOCH,
            "pat@example.com": now.replace(tzinfo=None) + datetime.timedelta(hours=1),
        })), {"+15550100001", "pat@example.com"})
        self.assertEqual(mod.dnd_ids({}), set())                   # a domain never written
        for bad in ([], {"CKDNDListKey": []}, {"CKDNDListKey": {"+15550100001": "forever"}},
                    {"CKDNDListKey": {"+15550100001": True}}):
            with self.subTest(bad=bad):
                self.assertIsNone(mod.dnd_ids(bad))

    def test_the_verifier_asks_cfprefsd_not_the_lagging_file(self):
        mod = read.imsg_module()
        xml = plistlib.dumps(self.macos27_list({"+15550100001": self.DISTANT_FUTURE}))
        empty = plistlib.dumps({})
        cases = ((CompletedProcess([], 0, xml, b""), {"+15550100001"}),
                 (CompletedProcess([], 0, empty, b""), set()),
                 (CompletedProcess([], 1, b"", b"boom"), None),
                 (CompletedProcess([], 0, b"not a plist", b""), None))
        for result, want in cases:
            with self.subTest(want=want), patch.object(read.subprocess, "run", return_value=result) as run:
                self.assertEqual(DND_LIST_NOW(mod), want)
                self.assertEqual(run.call_args.args[0][:3], ["defaults", "export", "com.apple.MobileSMS.CKDNDList"])

    def test_the_chat_list_reads_the_dnd_list_file(self):
        mod = read.imsg_module()
        con = read.open_db()
        try:
            clusters = mod._group_cluster_map(con)
            self.assertEqual(mod.muted_conversations(con, clusters), set())   # no file: nobody
            with open(self.dnd_file, "wb") as fh:
                plistlib.dump(self.macos27_list({"pat@example.com": self.DISTANT_FUTURE}), fh,
                              fmt=plistlib.FMT_BINARY)
            muted = mod.muted_conversations(con, clusters)
            self.assertIn(clusters.get("+15550100001", "+15550100001"), muted)
            self.assertNotIn("+15550100002", muted)
            self.dnd_file.write_bytes(b"not a plist")                         # flags still count
            self.set_props(3, plistlib.dumps({"ignoreAlertsFlag": True}))
            self.assertEqual(mod.muted_conversations(con, clusters), {"+15550100002"})
        finally:
            con.close()


class PlistDateTolerance(unittest.TestCase):
    """_clamp_bplist_dates rewrites only dates datetime cannot hold, and only
    in a well-formed binary plist; everything else is left to plistlib."""

    def setUp(self):
        self.imsg = read.imsg_module()

    def test_out_of_range_dates_are_clamped_and_the_rest_survives(self):
        for secs in (FOUNDATION_DISTANT_PAST, float("-inf"), float("nan"), 1e12, float("inf")):
            blob = plistlib.dumps({"keep": "me", "n": 7, "d": datetime.datetime(2001, 1, 1)},
                                  fmt=plistlib.FMT_BINARY)
            blob = blob.replace(b"\x33" + bytes(8), b"\x33" + struct.pack(">d", secs))
            with self.assertRaises((plistlib.InvalidFileException, ValueError)):
                plistlib.loads(blob)
            got = self.imsg._loads_chat_properties(blob)
            self.assertEqual((got["keep"], got["n"]), ("me", 7), secs)
            self.assertIsInstance(got["d"], datetime.datetime)

    def test_ordinary_plists_and_non_plists_are_not_touched(self):
        normal = plistlib.dumps({"ignoreAlertsFlag": True}, fmt=plistlib.FMT_BINARY)
        self.assertIsNone(self.imsg._clamp_bplist_dates(normal))                 # nothing to fix
        with_date = plistlib.dumps({"d": datetime.datetime(2026, 10, 4)}, fmt=plistlib.FMT_BINARY)
        self.assertIsNone(self.imsg._clamp_bplist_dates(with_date))              # in-range date
        for junk in (b"", b"garbage", b"bplist00", b"bplist00" + bytes(40), normal[:-5], normal[:20],
                     plistlib.dumps({"a": 1}, fmt=plistlib.FMT_XML)):
            self.assertIsNone(self.imsg._clamp_bplist_dates(junk), junk[:12])
            if junk != plistlib.dumps({"a": 1}, fmt=plistlib.FMT_XML):
                with self.assertRaises((plistlib.InvalidFileException, ValueError, TypeError)):
                    self.imsg._loads_chat_properties(junk)

    def test_a_corrupt_offset_table_cannot_loop_or_crash(self):
        blob = bytearray(plistlib.dumps({"d": datetime.datetime(2001, 1, 1)}, fmt=plistlib.FMT_BINARY))
        blob[-32:] = struct.pack(">6xBBQQQ", 8, 1, 2 ** 60, 0, 8)                # absurd object count
        self.assertIsNone(self.imsg._clamp_bplist_dates(bytes(blob)))
        blob[-32:] = struct.pack(">6xBBQQQ", 3, 1, 1, 0, 8)                      # impossible offset size
        self.assertIsNone(self.imsg._clamp_bplist_dates(bytes(blob)))


if __name__ == "__main__":
    unittest.main()
