#!/usr/bin/env python3
"""Messages AppleEvents share one Automation budget.

An unanswered prompt is recorded as a denial after about two minutes, so a
shorter kill turns the Allow click into a failed send and a traceback.
"""
from __future__ import annotations

import subprocess
import unittest
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).parent
loader = SourceFileLoader("blip_imsg_send", str(HERE / "imsg-send"))
spec = spec_from_loader(loader.name, loader)
assert spec is not None
mod = module_from_spec(spec)
loader.exec_module(mod)

SENTENCE = (
    "Messages did not answer. On the Mac, allow Automation for the process "
    "that runs Blip, then send again."
)


class OsascriptBudgetTests(unittest.TestCase):
    def test_service_list_waits_and_parses(self):
        seen = {}

        def run(args, **kwargs):
            seen["timeout"] = kwargs.get("timeout")
            return subprocess.CompletedProcess(args, 0, stdout="iMessage|iMessage\n", stderr="")

        with patch.object(mod.subprocess, "run", run):
            services = mod.list_services()
        self.assertGreaterEqual(seen["timeout"], 150)
        self.assertEqual(services, [{"id": "iMessage", "type": "iMessage"}])

    def test_service_list_timeout_is_one_sentence(self):
        def run(args, **kwargs):
            raise subprocess.TimeoutExpired(args, kwargs.get("timeout") or 0)

        with patch.object(mod.subprocess, "run", run):
            with self.assertRaises(SystemExit) as raised:
                mod.list_services()
        self.assertEqual(raised.exception.code, SENTENCE)

    def test_send_script_uses_the_same_budget(self):
        def run(args, **kwargs):
            self.assertGreaterEqual(kwargs.get("timeout") or 0, 150)
            self.assertEqual(args, ["osascript", "-"])
            self.assertEqual(kwargs.get("input"), 'return "ok"')
            raise subprocess.TimeoutExpired(args, kwargs.get("timeout") or 0)

        with patch.object(mod.subprocess, "run", run):
            with self.assertRaises(SystemExit) as raised:
                mod.run_applescript('return "ok"')
        self.assertEqual(raised.exception.code, SENTENCE)


if __name__ == "__main__":
    unittest.main()
