#!/usr/bin/env python3
"""blip-bridged applies the shim's path allowlist before starting a channel.

When the dedicated key is absent, _spawn() interpolates python and remote_bin
into a remote shell command. A hostile bridge.conf must not reach that
string. Same regexes as blip-shim; same exit 78 (EX_CONFIG)."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path

HERE = Path(__file__).parent


def load():
    loader = SourceFileLoader("blip_bridged", str(HERE / "blip-bridged"))
    spec = spec_from_loader(loader.name, loader)
    assert spec is not None
    mod = module_from_spec(spec)
    sys.modules[loader.name] = mod
    loader.exec_module(mod)
    return mod


bridged = load()


def conf(**overrides):
    base = {
        "host": "you@your-mac",
        "key": "/home/you/.ssh/blip_ed25519",
        "remote_bin": "$HOME/.blip/bin",
        "python": "python3",
    }
    base.update(overrides)
    return base


class ValidateConf(unittest.TestCase):
    def test_defaults_and_a_plain_host_are_accepted(self):
        bridged.validate_conf(conf())
        bridged.validate_conf(conf(host="mac.local", python="/usr/bin/python3",
                                  remote_bin="/Users/you/.blip/bin"))

    def test_empty_host_is_allowed_here_main_refuses_it_later(self):
        # read_conf() can run before host= is set; main() exits on empty host.
        bridged.validate_conf(conf(host=""))

    def test_a_hostile_python_is_refused(self):
        with self.assertRaises(SystemExit) as e:
            bridged.validate_conf(conf(python="python3; touch /tmp/pwned"))
        self.assertEqual(e.exception.code, "blip-bridged: refusing python/remote_bin/key — plain paths only")

    def test_a_hostile_remote_bin_is_refused(self):
        with self.assertRaises(SystemExit):
            bridged.validate_conf(conf(remote_bin="$HOME/.blip/bin; id"))
        with self.assertRaises(SystemExit):
            bridged.validate_conf(conf(remote_bin="$(id)"))

    def test_a_hostile_key_is_refused(self):
        with self.assertRaises(SystemExit):
            bridged.validate_conf(conf(key="/tmp/key; reboot"))

    def test_a_hostile_host_is_refused(self):
        with self.assertRaises(SystemExit) as e:
            bridged.validate_conf(conf(host="you@your-mac; id"))
        self.assertIn("refusing host", str(e.exception))

    def test_read_conf_validates_the_file_before_returning(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "bridge.conf")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("host=you@your-mac\npython=python3;id\n")
            os.environ["BLIP_BRIDGE_CONF"] = path
            try:
                with self.assertRaises(SystemExit):
                    bridged.read_conf()
            finally:
                os.environ.pop("BLIP_BRIDGE_CONF", None)


if __name__ == "__main__":
    unittest.main()
