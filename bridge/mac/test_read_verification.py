#!/usr/bin/env python3
"""Read-push acknowledgement tests; no Messages, AppleScript or real database."""
import contextlib
import importlib.machinery
import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader(
    "imsg_read_verification", str(Path(__file__).with_name("imsg-read")))
spec = importlib.util.spec_from_loader(loader.name, loader)
read = importlib.util.module_from_spec(spec)
loader.exec_module(read)


class ReadVerificationTests(unittest.TestCase):
    def report(self, before, after, clicked=True):
        out, err = io.StringIO(), io.StringIO()
        code = 0
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                read.report(before, after, clicked, "Mark All as Read")
            except SystemExit as exc:
                code = exc.code
        return code, out.getvalue(), err.getvalue()

    def test_partial_progress_is_not_acknowledged(self):
        code, out, err = self.report(3, 1)
        self.assertEqual(code, 75)
        self.assertEqual(out, "")
        self.assertIn("1 still unread", err)

    def test_unavailable_verification_is_not_acknowledged(self):
        for before, after in ((3, None), (None, None), (None, 1)):
            with self.subTest(before=before, after=after):
                code, out, err = self.report(before, after)
                self.assertEqual(code, 75)
                self.assertEqual(out, "")
                self.assertTrue(err)

    def test_zero_after_click_is_acknowledged(self):
        for before in (3, None):
            with self.subTest(before=before):
                code, out, err = self.report(before, 0)
                self.assertEqual(code, 0)
                self.assertTrue(out)
                self.assertEqual(err, "")

    def test_absent_menu_is_success_only_if_database_confirms_read(self):
        self.assertEqual(self.report(1, 0, clicked=False)[0], 0)
        self.assertEqual(self.report(1, 1, clicked=False)[0], 75)

    def test_initial_zero_does_not_mask_a_later_unread(self):
        self.assertEqual(self.report(0, 1)[0], 75)
        self.assertEqual(self.report(0, 0)[0], 0)

    def test_settle_waits_through_partial_progress(self):
        with patch.object(read, "unread_on_mac", side_effect=[2, 1, 0]) as count, \
                patch.object(read.time, "sleep"):
            self.assertEqual(read.settle(3), 0)
        self.assertEqual(count.call_count, 3)

    def test_settle_allows_transient_database_failures(self):
        with patch.object(read, "unread_on_mac", side_effect=[None, 0]), \
                patch.object(read.time, "sleep"):
            self.assertEqual(read.settle(None), 0)

    def test_settle_is_bounded_and_scoped_to_the_requested_chat(self):
        with patch.object(read, "unread_on_mac", return_value=1) as count, \
                patch.object(read.time, "sleep"):
            self.assertEqual(read.settle(3, "+15551234567", tries=4), 1)
        self.assertEqual(count.call_count, 4)
        count.assert_called_with("+15551234567")

    def test_cli_mark_all_waits_for_complete_verification(self):
        out = io.StringIO()
        with patch.object(read.sys, "argv", ["imsg-read", "--all"]), \
                patch.object(read, "ensure_messages", return_value=""), \
                patch.object(read, "accessibility", return_value=""), \
                patch.object(read, "unread_on_mac", side_effect=[3, 2, 0]) as count, \
                patch.object(read, "click", return_value=(True, "")) as click, \
                patch.object(read.time, "sleep"), \
                contextlib.redirect_stdout(out):
            read.main()
        click.assert_called_once_with("Mark All as Read")
        self.assertEqual(count.call_count, 3)
        self.assertIn("0 unread", out.getvalue())


class MinimizedWindow(unittest.TestCase):
    """#164: a minimized (or missing) Messages window keeps Mark All as Read disabled
    however long Messages is active, so every push exited 75. Synthetic: nothing opens."""

    def mark_all(self, state, clicks=((False, ""), (True, "")), unminimize_ok=True):
        order, osa_scripts = [], []

        def osa(script):
            osa_scripts.append(script)
            if script == read.WINDOW_STATE:
                return 0, state
            order.append("restore-window" if script == read.UNMINIMIZE else
                         "reopen" if script == read.REOPEN else
                         "reminimize" if script == read.REMINIMIZE else "osa")
            return (0 if unminimize_ok or script not in (read.UNMINIMIZE, read.REOPEN) else 1), ""

        def click(name):
            order.append("click")
            return clicks[min(order.count("click") - 1, len(clicks) - 1)]

        out, err = io.StringIO(), io.StringIO()
        code = 0
        with patch.object(read.sys, "argv", ["imsg-read", "--all"]), \
                patch.object(read, "ensure_messages", return_value=""), \
                patch.object(read, "accessibility", return_value=""), \
                patch.object(read, "unread_on_mac", side_effect=[1, 0, 0]), \
                patch.object(read, "click", side_effect=click), \
                patch.object(read, "osa", side_effect=osa), \
                patch.object(read, "wake_messages", side_effect=lambda: order.append("wake") or "Previous app"), \
                patch.object(read, "restore_front", side_effect=lambda prev: order.append("front:" + prev)), \
                patch.object(read.time, "sleep"), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                read.main()
            except SystemExit as exc:
                code = exc.code
        return code, out.getvalue(), err.getvalue(), order

    def test_a_minimized_window_is_restored_before_the_wake_and_minimized_again_after(self):
        code, out, _, order = self.mark_all("minimized")
        self.assertEqual(order, ["click", "restore-window", "wake", "click", "front:Previous app", "reminimize"])
        self.assertIn("0 unread", out)

    def test_a_visible_window_is_left_alone(self):
        code, out, _, order = self.mark_all("visible")
        self.assertEqual(order, ["click", "wake", "click", "front:Previous app"])

    def test_no_window_asks_messages_to_reopen_and_leaves_what_it_opened(self):
        code, out, _, order = self.mark_all("no-window")
        self.assertEqual(order, ["click", "reopen", "wake", "click", "front:Previous app"])
        self.assertNotIn("reminimize", order)

    def test_an_unreadable_window_state_changes_nothing(self):
        _, _, _, order = self.mark_all("")
        self.assertEqual(order, ["click", "wake", "click", "front:Previous app"])

    def test_an_answer_that_is_not_a_known_state_changes_nothing(self):
        # A System Events error text, a localized word, or a failed lookup must never
        # be taken for a state: only the three exact answers count, and only on exit 0.
        for code, out in ((0, "mimimized"), (0, "Minimized"), (0, "error: -1728"), (1, "minimized"), (1, "no-window")):
            with self.subTest(code=code, out=out), patch.object(read, "osa", return_value=(code, out)):
                self.assertEqual(read.window_state(), "")
        for state in ("visible", "minimized", "no-window"):
            with self.subTest(state=state), patch.object(read, "osa", return_value=(0, state)):
                self.assertEqual(read.window_state(), state)

    def test_a_restore_that_fails_is_not_undone(self):
        _, _, _, order = self.mark_all("minimized", unminimize_ok=False)
        self.assertEqual(order, ["click", "restore-window", "wake", "click", "front:Previous app"])

    def test_the_window_goes_back_even_when_the_click_fails(self):
        code, _, err, order = self.mark_all("minimized", clicks=((False, ""), (False, "boom")))
        self.assertEqual(code, 1)
        self.assertIn("boom", err)
        self.assertEqual(order[-2:], ["front:Previous app", "reminimize"])

    def test_the_window_goes_back_even_when_the_click_raises(self):
        order = []

        def click(name):
            order.append("click")
            if order.count("click") == 2:
                raise TimeoutError("osascript timed out")
            return False, ""

        def osa(script):
            if script == read.WINDOW_STATE:
                return 0, "minimized"
            order.append("reminimize" if script == read.REMINIMIZE else "restore-window")
            return 0, ""
        with patch.object(read.sys, "argv", ["imsg-read", "--all"]), \
                patch.object(read, "ensure_messages", return_value=""), \
                patch.object(read, "accessibility", return_value=""), \
                patch.object(read, "unread_on_mac", return_value=1), \
                patch.object(read, "click", side_effect=click), \
                patch.object(read, "osa", side_effect=osa), \
                patch.object(read, "wake_messages", return_value="Previous app"), \
                patch.object(read, "restore_front"), \
                patch.object(read.time, "sleep"), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(TimeoutError):
                read.main()
        self.assertEqual(order[-1], "reminimize")

    def test_a_menu_that_already_validates_never_looks_at_the_window(self):
        code, out, _, order = self.mark_all("minimized", clicks=((True, ""),))
        self.assertEqual(order, ["click"])

    def test_status_names_the_window_as_the_reason(self):
        for state, words in (("minimized", "window is minimized"), ("no-window", "no window open"),
                             ("visible", "active app")):
            with self.subTest(state=state):
                out = io.StringIO()

                def osa(script):
                    return (0, state) if script == read.WINDOW_STATE else (0, "false")
                with patch.object(read.sys, "argv", ["imsg-read", "--status"]), \
                        patch.object(read, "ensure_messages", return_value=""), \
                        patch.object(read, "accessibility", return_value=""), \
                        patch.object(read, "unread_on_mac", return_value=2), \
                        patch.object(read, "osa", side_effect=osa), \
                        contextlib.redirect_stdout(out):
                    with self.assertRaises(SystemExit) as ctx:
                        read.main()
                self.assertEqual(ctx.exception.code, 0)
                self.assertIn("ready but dormant", out.getvalue())
                self.assertIn(words, out.getvalue())


if __name__ == "__main__":
    unittest.main()
