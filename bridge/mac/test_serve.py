#!/usr/bin/env python3
"""The serve channel's reachable surface.

`imsg serve` re-dispatches requests through the SAME parser the CLI uses, so
there is no second command table to drift. What it must NOT do is widen what
the confined ssh key can reach: the channel answers read-only queries and
nothing else."""
from __future__ import annotations

import sys
import unittest
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path

HERE = Path(__file__).parent


def load(tool: str):
    loader = SourceFileLoader(f"blip_{tool}", str(HERE / tool))
    spec = spec_from_loader(loader.name, loader)
    assert spec is not None
    mod = module_from_spec(spec)
    sys.modules[loader.name] = mod
    loader.exec_module(mod)
    return mod


imsg = load("imsg")


class ServeSurface(unittest.TestCase):
    def test_only_read_only_queries_are_reachable(self):
        self.assertEqual(
            imsg.SERVE_ALLOWED,
            {"recent", "from", "thread", "search", "contacts", "chats", "groups", "analyze"},
        )

    def test_streaming_and_blocking_commands_stay_one_shot(self):
        # attachment/avatar write binary and would park the channel behind a
        # 100 MB photo; watch blocks forever; serve would recurse.
        for cmd in ("attachment", "avatar", "watch", "serve"):
            self.assertNotIn(cmd, imsg.SERVE_ALLOWED, f"{cmd} must not be reachable on the channel")

    def test_serve_reuses_the_real_parser(self):
        # A second, hand-rolled command table would drift from the CLI and
        # become a second security surface.
        p = imsg.build_parser()
        ns = p.parse_args(["--json", "--rich", "thread", "--chat", "chat123", "40"])
        self.assertEqual(ns.cmd, "thread")
        self.assertEqual(ns.chat, "chat123")
        self.assertIn(ns.cmd, imsg.SERVE_ALLOWED)

    def test_serve_is_a_real_subcommand(self):
        ns = imsg.build_parser().parse_args(["serve"])
        self.assertEqual(ns.func, imsg.cmd_serve)


if __name__ == "__main__":
    unittest.main(verbosity=2)
