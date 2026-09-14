#!/usr/bin/env python3
"""Regression: the optional read-push probe must never ask for consent uninvited.

check_markread() talks to System Events, which pops an Automation prompt of its
own. On macOS 26 a grant the user never asked for could not be switched back off
in System Settings (#36), so the probe is opt-in: nothing fires it without
--markread, and a probe that never ran must not print a "fix" for itself.
"""
from __future__ import annotations

import io
import json
import sys
import unittest
from contextlib import redirect_stdout
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path

CHECK = Path(__file__).with_name("blip-check")


def load_check():
    loader = SourceFileLoader("blip_check", str(CHECK))
    spec = spec_from_loader(loader.name, loader)
    assert spec is not None
    mod = module_from_spec(spec)
    sys.modules[loader.name] = mod
    loader.exec_module(mod)
    return mod


class OptInMarkread(unittest.TestCase):
    def setUp(self) -> None:
        self.mod = load_check()
        self.markread_calls = 0
        # The three required probes pass, so main() reaches the optional one and
        # exits 0; none of them may touch a real Mac from the test runner.
        self.mod.check_chatdb = lambda: (True, "stub")
        self.mod.check_automation = lambda: (True, "stub")
        self.mod.check_contacts = lambda: (True, "stub")

        def counted() -> tuple[bool, str]:
            self.markread_calls += 1
            return False, "Accessibility not granted"

        self.mod.check_markread = counted
        self.mutation_calls = 0
        def mutations():
            self.mutation_calls += 1
            return {"message_delete": (False, "missing"), "contact_save": (True, "ready")}
        self.mod.check_mutations = mutations

    def test_action_checks_are_explicit_and_missing_permissions_fail_when_requested(self):
        _, code = self.run_main(["--json"])
        self.assertEqual(self.mutation_calls, 0)
        self.assertEqual(code, 0)
        out, code = self.run_main(["--json", "--mutations"])
        self.assertEqual(self.mutation_calls, 1)
        self.assertEqual(self.markread_calls, 0)
        self.assertEqual(code, 1)
        self.assertIn("Accessibility", json.loads(out)["message_delete"]["fix"])

    def run_main(self, argv: list[str]) -> tuple[str, int]:
        self.mod.sys.argv = ["blip-check", *argv]
        buf = io.StringIO()
        with redirect_stdout(buf):
            with self.assertRaises(SystemExit) as caught:
                self.mod.main()
        code = caught.exception.code
        return buf.getvalue(), 0 if code is None else int(code)

    def test_default_run_never_touches_system_events(self) -> None:
        out, code = self.run_main(["--json"])
        self.assertEqual(self.markread_calls, 0, "the probe fired without --markread")
        data = json.loads(out)
        self.assertIn("markread", data, "the key must survive for existing consumers")
        self.assertFalse(data["markread"]["ok"])
        self.assertIn("--markread", data["markread"]["detail"])
        # A probe that never ran is not a problem to fix.
        self.assertEqual(data["markread"]["fix"], "")
        self.assertEqual(code, 0, "the optional probe must not decide the exit code")

    def test_opt_in_runs_it_and_reports_a_fix(self) -> None:
        out, code = self.run_main(["--json", "--markread"])
        self.assertEqual(self.markread_calls, 1)
        data = json.loads(out)
        self.assertFalse(data["markread"]["ok"])
        self.assertIn("Accessibility", data["markread"]["fix"])
        self.assertEqual(code, 0, "a failed OPTIONAL probe still exits 0")

    def test_human_output_hides_the_fix_line_when_not_asked(self) -> None:
        out, _ = self.run_main([])
        self.assertEqual(self.markread_calls, 0)
        self.assertIn("markread", out)
        self.assertNotIn("fix:", out, "no fix line for a probe nobody ran")

    def test_human_output_shows_the_fix_line_when_asked(self) -> None:
        out, _ = self.run_main(["--markread"])
        self.assertEqual(self.markread_calls, 1)
        self.assertIn("fix:", out)


if __name__ == "__main__":
    unittest.main()
