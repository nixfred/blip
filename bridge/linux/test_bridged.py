#!/usr/bin/env python3
"""blip-bridged: socket trust, deadlines, and filter parity with the shim.

No network, no Mac. The ssh child is a stand-in with real pipes that the test
plays the Mac's side of (silent, half-open, or answering), the socket tests
use temporary directories, and the parity test runs the real shim against a
fake ssh that only records what it would have sent."""
from __future__ import annotations

import json
import os
import shlex
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
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
UID = os.getuid()


def conf(**overrides) -> dict:
    base = {"host": "you@your-mac", "key": "/nonexistent/blip_ed25519",
            "remote_bin": "$HOME/.blip/bin", "python": "python3",
            "hide_spam": "", "hide_unknown": ""}
    base.update(overrides)
    return base


# ------------------------------------------------------------ the fake Mac

class FakeProc:
    """The ssh child, minus ssh: two real pipes. `mode` is what the Mac does:
    "silent" never speaks, "stall" says ready and then nothing, "serve"
    answers every request line with a frame echoing the request."""

    def __init__(self, mode: str) -> None:
        self.mode = mode
        to_child_r, to_child_w = os.pipe()
        from_child_r, from_child_w = os.pipe()
        self.stdin = os.fdopen(to_child_w, "wb", buffering=0)
        self.stdout = os.fdopen(from_child_r, "rb", buffering=0)
        self._peer_in = os.fdopen(to_child_r, "rb", buffering=0)
        self._peer_out = os.fdopen(from_child_w, "wb", buffering=0)
        self.killed = False
        self.reaped = False
        self.requests: list[dict] = []
        if mode in ("stall", "serve"):
            self._peer_out.write(b"ready\n")
        if mode == "serve":
            threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self) -> None:
        try:
            for line in self._peer_in:
                req = json.loads(line)
                self.requests.append(req)
                body = json.dumps(req).encode()
                self._peer_out.write(json.dumps({"status": 0, "len": len(body)}).encode() + b"\n" + body)
        except (OSError, ValueError):
            pass

    def poll(self):
        return -9 if self.killed else None

    def kill(self) -> None:
        self.killed = True
        for f in (self._peer_in, self._peer_out):
            try:
                f.close()
            except OSError:
                pass

    def wait(self, timeout=None):
        self.reaped = True
        return -9


class Spawner:
    """popen= for Channel: hands out FakeProcs in the given modes, in order."""

    def __init__(self, *modes: str) -> None:
        self.modes = list(modes)
        self.procs: list[FakeProc] = []
        self.commands: list[list[str]] = []

    def __call__(self, cmd, **_kw):
        self.commands.append(cmd)
        proc = FakeProc(self.modes.pop(0) if self.modes else "serve")
        self.procs.append(proc)
        return proc


def payload(argv=("--json", "recent", "5")) -> bytes:
    return json.dumps({"argv": list(argv)}).encode() + b"\n"


# ------------------------------------------------------------ deadlines

class Deadlines(unittest.TestCase):
    def test_a_silent_peer_at_spawn_is_killed_and_reaped(self):
        spawn = Spawner("silent")
        ch = bridged.Channel(popen=spawn, spawn_timeout=0.2)
        t0 = time.monotonic()
        with self.assertRaises(bridged.ChannelTimeout):
            ch.request(payload(), conf(), time.monotonic() + 5)
        self.assertLess(time.monotonic() - t0, 2)
        self.assertTrue(spawn.procs[0].killed)
        self.assertTrue(spawn.procs[0].reaped)
        self.assertIsNone(ch.proc)

    def test_a_peer_that_goes_quiet_mid_request_costs_one_deadline(self):
        # ready, then a half-open link: the reply never comes. Before, the
        # header read blocked forever and held the slot.
        spawn = Spawner("stall")
        ch = bridged.Channel(popen=spawn)
        t0 = time.monotonic()
        with self.assertRaises(bridged.ChannelTimeout):
            ch.request(payload(), conf(), time.monotonic() + 0.3)
        self.assertLess(time.monotonic() - t0, 2)
        self.assertTrue(spawn.procs[0].killed and spawn.procs[0].reaped)
        self.assertIsNone(ch.proc)

    def test_the_next_request_reconnects(self):
        spawn = Spawner("stall", "serve")
        ch = bridged.Channel(popen=spawn)
        with self.assertRaises(bridged.ChannelTimeout):
            ch.request(payload(), conf(), time.monotonic() + 0.2)
        reply = ch.request(payload(), conf(), time.monotonic() + 5)
        head, body = reply.split(b"\n", 1)
        self.assertEqual(json.loads(head)["status"], 0)
        self.assertEqual(json.loads(body)["argv"], ["--json", "recent", "5"])
        self.assertEqual(len(spawn.procs), 2)
        self.assertTrue(spawn.procs[0].killed)
        self.assertFalse(spawn.procs[1].killed)
        # and the live channel is reused, not respawned
        ch.request(payload(), conf(), time.monotonic() + 5)
        self.assertEqual(len(spawn.procs), 2)

    def test_a_peer_that_hangs_up_is_an_error_not_a_hang(self):
        spawn = Spawner("stall")
        ch = bridged.Channel(popen=spawn)
        ch._spawn(conf(), time.monotonic() + 5)
        spawn.procs[0]._peer_out.close()
        with self.assertRaises(bridged.ChannelError):
            ch.request(payload(), conf(), time.monotonic() + 5)
        self.assertIsNone(ch.proc)

    def test_an_implausible_header_kills_the_channel(self):
        spawn = Spawner("stall")
        ch = bridged.Channel(popen=spawn)
        ch._spawn(conf(), time.monotonic() + 5)
        spawn.procs[0]._peer_out.write(b'{"status":0,"len":"lots"}\n')
        with self.assertRaises(bridged.ChannelError):
            ch.request(payload(), conf(), time.monotonic() + 5)
        self.assertTrue(spawn.procs[0].killed)

    def test_an_edited_bridge_conf_respawns_the_channel(self):
        spawn = Spawner("serve", "serve")
        ch = bridged.Channel(popen=spawn)
        ch.request(payload(), conf(), time.monotonic() + 5)
        ch.request(payload(), conf(host="other@your-mac"), time.monotonic() + 5)
        self.assertEqual(len(spawn.procs), 2)
        self.assertTrue(spawn.procs[0].killed)
        self.assertIn("other@your-mac", spawn.commands[1])

    def test_the_serve_channel_carries_keepalives_and_a_connect_timeout(self):
        cmd = bridged.ssh_command(conf())
        self.assertIn("ServerAliveInterval=10", cmd)
        self.assertIn("ServerAliveCountMax=2", cmd)
        self.assertIn(f"ConnectTimeout={bridged.CONNECT_TIMEOUT}", cmd)
        self.assertEqual(cmd[-2:], ["you@your-mac",
                                    "PATH=/opt/homebrew/bin:/usr/local/bin:$PATH python3 $HOME/.blip/bin/imsg serve"])

    def test_the_dedicated_key_channel_refuses_agent_keys(self):
        # An agent-held key outranks -i, would get a shell instead of
        # blip-dispatch, and `imsg serve` would run unconfined.
        with tempfile.NamedTemporaryFile() as key:
            cmd = bridged.ssh_command(conf(key=key.name))
        self.assertIn("IdentityAgent=none", cmd)
        self.assertEqual(cmd[-1], "imsg serve")


class PoolLimits(unittest.TestCase):
    def pool(self, *modes, max_queued=0):
        spawn = Spawner(*modes)
        return bridged.Pool(size=2, max_queued=max_queued,
                            channel=lambda: bridged.Channel(popen=spawn)), spawn

    def stuck_pair(self, pool, hold: float):
        threads = [threading.Thread(target=bridged.answer,
                                    args=(b'{"argv":["--json","recent","5"]}', pool, lambda: conf(), hold))
                   for _ in range(2)]
        for t in threads:
            t.start()
        deadline = time.monotonic() + 2
        while pool.free and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(pool.free, [])
        return threads

    def test_two_stuck_requests_turn_the_third_away_at_once(self):
        pool, _ = self.pool("stall", "stall", "serve", "serve")
        threads = self.stuck_pair(pool, 0.5)
        t0 = time.monotonic()
        reply = bridged.answer(b'{"argv":["--json","recent","5"]}', pool, lambda: conf(), 5)
        self.assertLess(time.monotonic() - t0, 0.3)
        self.assertTrue(json.loads(reply.split(b"\n", 1)[0])["fallback"])
        for t in threads:
            t.join(3)
        # the stalls were killed and their slots came back
        self.assertEqual(len(pool.free), 2)
        reply = bridged.answer(b'{"argv":["--json","recent","5"]}', pool, lambda: conf(), 5)
        self.assertEqual(json.loads(reply.split(b"\n", 1)[0]), {"status": 0, "len": len(reply.split(b"\n", 1)[1])})

    def test_a_queued_client_waits_one_deadline_not_forever(self):
        pool, _ = self.pool("stall", "stall", max_queued=1)
        threads = self.stuck_pair(pool, 2)
        t0 = time.monotonic()
        reply = bridged.answer(b'{"argv":["--json","recent","5"]}', pool, lambda: conf(), 0.3)
        self.assertLess(time.monotonic() - t0, 1.5)
        self.assertTrue(json.loads(reply.split(b"\n", 1)[0])["fallback"])
        for t in threads:
            t.join(4)

    def test_a_fallback_frame_is_never_command_output(self):
        frame = bridged.fallback_frame("every channel is busy")
        head, body = frame.split(b"\n", 1)
        meta = json.loads(head)
        self.assertEqual(meta, {"fallback": True, "status": 75, "len": len(body)})


# ------------------------------------------------------------ filter parity

class FilterParity(unittest.TestCase):
    """The fast path must send imsg exactly the argv the shim sends."""

    VARIANTS = [
        "", "hide_spam=on\n", "hide_unknown=on\n", "hide_spam=on\nhide_unknown=on\n",
        "hide_spam = ON # x\n", "hide_spam='yes'\n", 'hide_unknown="1"\n', "hide_spam=true\n",
        "hide_spam=on\nhide_spam=off\n", "hide_spam=maybe\n", "# hide_spam=on\n", "hide_spam=\n",
    ]

    def shim_argv(self, tmp: str, conf_text: str, args: list[str]) -> list[str]:
        """What the real shim would run on the Mac, read back from a fake ssh."""
        shutil.copy(HERE / "blip-shim", os.path.join(tmp, "imsg"))
        os.chmod(os.path.join(tmp, "imsg"), 0o755)
        log = os.path.join(tmp, "ssh.log")
        with open(os.path.join(tmp, "ssh"), "w") as fh:
            fh.write(f'#!/bin/sh\nfor a in "$@"; do last="$a"; done\nprintf "%s" "$last" > "{log}"\n')
        os.chmod(os.path.join(tmp, "ssh"), 0o755)
        with open(os.path.join(tmp, "bridge.conf"), "w") as fh:
            fh.write(f"host=you@your-mac\nkey={tmp}/no-key\n{conf_text}")
        env = {"PATH": f"{tmp}:/usr/bin:/bin", "HOME": tmp,
               "BLIP_BRIDGE_CONF": os.path.join(tmp, "bridge.conf")}
        subprocess.run([os.path.join(tmp, "imsg"), *args], env=env, check=True)
        with open(log) as fh:
            words = shlex.split(fh.read())
        return words[words.index("$HOME/.blip/bin/imsg") + 1:]

    def test_each_bridge_conf_filters_the_fast_path_as_the_shim_does(self):
        args = ["--json", "chats", "300"]
        for text in self.VARIANTS:
            with self.subTest(conf=text), tempfile.TemporaryDirectory() as tmp:
                slow = self.shim_argv(tmp, text, args)
                env = {"HOME": tmp, "BLIP_BRIDGE_CONF": os.path.join(tmp, "bridge.conf")}
                req = bridged.build_request(json.dumps({"argv": args}).encode(), bridged.read_conf(env))
                self.assertEqual(json.loads(req)["argv"], slow)

    def test_a_filter_turned_on_reaches_the_next_request(self):
        # The shim reads bridge.conf on every call; so does the daemon.
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "bridge.conf")
            env = {"HOME": tmp, "BLIP_BRIDGE_CONF": path}
            with open(path, "w") as fh:
                fh.write("host=you@your-mac\n")
            spawn = Spawner("serve")
            pool = bridged.Pool(size=1, channel=lambda: bridged.Channel(popen=spawn))
            src = lambda: bridged.read_conf(env)
            bridged.answer(b'{"argv":["--json","chats","300"]}', pool, src)
            with open(path, "a") as fh:
                fh.write("hide_spam=on\nhide_unknown=on\n")
            bridged.answer(b'{"argv":["--json","chats","300"]}', pool, src)
            self.assertEqual([r["argv"] for r in spawn.procs[0].requests], [
                ["--json", "chats", "300"],
                ["--hide-spam", "--hide-unknown", "--json", "chats", "300"],
            ])

    def test_stdin_stays_out_of_argv(self):
        req = json.loads(bridged.build_request(
            b'{"argv":["--json","search","--stdin"],"stdin":"secret words"}', conf(hide_spam="on")))
        self.assertEqual(req["stdin"], "secret words")
        self.assertNotIn("secret words", " ".join(req["argv"]))

    def test_a_malformed_request_falls_back(self):
        for line in (b"not json", b'{"argv":"--json"}', b'{"argv":[1]}', b'{"argv":[],"stdin":3}', b"[]"):
            reply = bridged.answer(line, bridged.Pool(size=1), lambda: conf())
            self.assertTrue(json.loads(reply.split(b"\n", 1)[0])["fallback"], line)

    def test_the_mac_host_override_matches_the_shim(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = {"HOME": tmp, "BLIP_BRIDGE_CONF": os.path.join(tmp, "none"), "BLIP_MAC_HOST": "you@other-mac"}
            self.assertEqual(bridged.read_conf(env)["host"], "you@other-mac")


# ------------------------------------------------------------ socket trust

class SocketTrust(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        os.chmod(self.tmp, 0o700)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def env(self, base=None):
        return {"XDG_RUNTIME_DIR": base or self.tmp}

    def test_a_private_runtime_dir_is_used_and_blip_is_made_0700(self):
        d = bridged.runtime_dir(self.env())
        self.assertEqual(d, os.path.join(self.tmp, "blip"))
        self.assertEqual(stat.S_IMODE(os.lstat(d).st_mode), 0o700)

    def test_a_shared_base_is_refused(self):
        os.chmod(self.tmp, 0o755)
        with self.assertRaises(bridged.UntrustedRuntime):
            bridged.runtime_dir(self.env())

    def test_an_existing_open_blip_dir_is_refused_not_adopted(self):
        os.mkdir(os.path.join(self.tmp, "blip"))
        os.chmod(os.path.join(self.tmp, "blip"), 0o777)
        with self.assertRaises(bridged.UntrustedRuntime):
            bridged.runtime_dir(self.env())

    def test_a_symlinked_blip_dir_is_refused(self):
        real = os.path.join(self.tmp, "elsewhere")
        os.mkdir(real, 0o700)
        os.symlink(real, os.path.join(self.tmp, "blip"))
        with self.assertRaises(bridged.UntrustedRuntime):
            bridged.runtime_dir(self.env())

    def test_a_directory_owned_by_someone_else_is_refused(self):
        with self.assertRaises(bridged.UntrustedRuntime):
            bridged.runtime_dir(self.env(), uid=UID + 1)

    def test_a_relative_runtime_dir_is_refused(self):
        with self.assertRaises(bridged.UntrustedRuntime):
            bridged.runtime_dir({"XDG_RUNTIME_DIR": "relative/dir"})

    def test_the_tmp_fallback_refuses_a_precreated_directory(self):
        # /tmp/blip-<uid> is a name anyone can take first. makedirs(exist_ok)
        # used to adopt it; now its mode (and owner) decide.
        planted = os.path.join(self.tmp, f"blip-{UID}")
        os.mkdir(planted)
        os.chmod(planted, 0o777)
        with self.assertRaises(bridged.UntrustedRuntime):
            bridged.runtime_dir({}, tmp_root=self.tmp)
        os.rmdir(planted)
        os.symlink(self.tmp, planted)
        with self.assertRaises(bridged.UntrustedRuntime):
            bridged.runtime_dir({}, tmp_root=self.tmp)

    def test_the_tmp_fallback_creates_its_own_private_tree(self):
        d = bridged.runtime_dir({}, tmp_root=self.tmp)
        self.assertEqual(d, os.path.join(self.tmp, f"blip-{UID}", "blip"))
        for level in (os.path.dirname(d), d):
            self.assertEqual(stat.S_IMODE(os.lstat(level).st_mode), 0o700)

    def test_something_other_than_our_socket_is_never_claimed(self):
        path = os.path.join(bridged.runtime_dir(self.env()), "bridge.sock")
        with open(path, "w") as fh:
            fh.write("not a socket")
        with self.assertRaises(bridged.UntrustedRuntime):
            bridged._claim_socket(path, UID)
        self.assertTrue(os.path.exists(path))

    def test_a_stale_socket_is_replaced_and_a_live_one_is_left_alone(self):
        path = os.path.join(bridged.runtime_dir(self.env()), "bridge.sock")
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        old = os.umask(0o077)
        try:
            srv.bind(path)
        finally:
            os.umask(old)
        srv.listen(1)
        self.assertFalse(bridged._claim_socket(path, UID))     # live: we are the second copy
        srv.close()
        self.assertTrue(bridged._claim_socket(path, UID))      # stale: removed
        self.assertFalse(os.path.exists(path))

    def test_a_peer_with_another_uid_gets_nothing(self):
        a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        b.sendall(b'{"argv":["--json","recent","5"]}\n')

        class NoPool:
            called = False

            def request(self, *_a):
                NoPool.called = True
                return b""
        bridged.serve_client(a, NoPool(), UID + 1)
        b.settimeout(1)
        try:
            said = b.recv(100)
        except ConnectionResetError:        # closed with our request unread
            said = b""
        self.assertEqual(said, b"")         # closed, nothing said
        self.assertFalse(NoPool.called)
        b.close()

    def test_a_peer_with_our_uid_is_answered(self):
        a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        b.sendall(b'{"argv":["--json","recent","5"]}\n')
        spawn = Spawner("serve")
        pool = bridged.Pool(size=1, channel=lambda: bridged.Channel(popen=spawn))
        saved = bridged.read_conf
        bridged.read_conf = lambda env=None: conf()
        try:
            bridged.serve_client(a, pool, UID)
        finally:
            bridged.read_conf = saved
        b.settimeout(2)
        data = b""
        while True:
            chunk = b.recv(65536)
            if not chunk:
                break
            data += chunk
        b.close()
        self.assertEqual(json.loads(data.split(b"\n", 1)[0])["status"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
