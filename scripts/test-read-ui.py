#!/usr/bin/env python3
"""Run the shipping badge/read bindings with synthetic data, without Blip or a Mac.

Requires Qt 6's qmltestrunner and QtQuick/QtTest QML modules. An optional source
argument lets the same regression test be run against an older BarWidget.qml.
"""
from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile


def harness(source):
    def function(name):
        start = source.index(f"  function {name}(")
        end = source.index("\n  }", start) + len("\n  }")
        return source[start:end]

    binding = next(line for line in source.splitlines()
                   if "property string threadsJson:" in line)
    start = source.index("            var j = JSON.stringify(list)")
    end = source.index("            root.healthy", start)
    return '''import QtQuick
import QtTest
Item {
    id: root
    property var threads: []
    property var localReads: ({})
    property var localUnreads: ({})
    property int unread: 0
    property int generation: 0
    @BINDING@
    function refresh() {}
    function anySurfaceOpen() { return false }
    @FUNCTIONS@
    function poll(list) {
        @UPDATE@
    }
    TestCase {
        name: "BlipBadge"
        function rows() {
            return [
                {chat:"A", unread:1, generation:root.generation, last_ts:"2026-09-01T10:00:00Z"},
                {chat:"B", unread:1, generation:root.generation, last_ts:"2026-09-01T10:00:00Z"}
            ]
        }
        function init() {
            root.generation++
            root.threads = []
            root.localReads = ({})
            root.localUnreads = ({})
            root.unread = 0
        }
        function test_expired_read_then_identical_poll() {
            var original = rows()
            root.poll(original)
            root.markThreadRead("A", original[0].last_ts)
            compare(root.unread, 1)
            // A slow/failed collector write can outlive optimistic suppression.
            root.localReads = {A: {ts: original[0].last_ts, at: Date.now() - 61000}}
            root.poll(root.applyLocalReads(original))
            compare(root.threads[0].unread, 1)
            compare(root.unread, 2)
        }
        function test_mark_all_then_identical_poll() {
            var original = rows()
            root.poll(original)
            root.markAllRead()
            compare(root.unread, 0)
            root.localReads = ({})
            root.poll(root.applyLocalReads(original))
            compare(root.threads[0].unread, 1)
            compare(root.threads[1].unread, 1)
            compare(root.unread, 2)
        }
        function test_read_suppresses_inflight_poll_until_new_activity() {
            var original = rows()
            root.poll(original)
            root.markThreadRead("A", original[0].last_ts)
            root.poll(root.applyLocalReads(original))
            compare(root.unread, 1)
            compare(root.threads[0].unread, 0)
            original[0].last_ts = "2026-09-01T11:00:00Z"
            root.poll(root.applyLocalReads(original))
            compare(root.unread, 2)
            compare(root.threads[0].unread, 1)
        }
        function test_unread_suppresses_inflight_poll() {
            var original = rows()
            original[0].unread = 0
            root.poll(original)
            root.markThreadUnread("A")
            root.poll(root.applyLocalReads(original))
            compare(root.unread, 2)
            compare(root.threads[0].unread, 1)
        }
        function test_identical_poll_does_not_replace_model() {
            root.poll(rows())
            var model = root.threads
            root.poll(rows())
            verify(root.threads === model)
        }
    }
}
'''.replace("@BINDING@", binding).replace("@FUNCTIONS@", "\n".join(
        function(name) for name in ("unreadChatCount", "noteLocalRead", "noteLocalUnread", "markThreadUnread", "applyLocalReads",
                                    "markThreadRead", "markAllRead")
    )).replace("@UPDATE@", source[start:end])


def main():
    source = (Path(sys.argv[1]) if len(sys.argv) > 1 else
              Path(__file__).resolve().parents[1] / "BarWidget.qml")
    runner = os.environ.get("QMLTESTRUNNER") or shutil.which("qmltestrunner")
    if not runner:
        runner = next((str(path) for path in (
            Path("/usr/lib/qt6/bin/qmltestrunner"),
            Path("/usr/lib/qt6/libexec/qmltestrunner")) if path.is_file()), None)
    if not runner:
        sys.exit("Qt 6 qmltestrunner not found; set QMLTESTRUNNER to its path")
    with tempfile.TemporaryDirectory(prefix="blip-read-ui-") as directory:
        (Path(directory) / "tst_badge.qml").write_text(harness(source.read_text()))
        result = subprocess.run(
            [runner, "-input", directory, "-platform", "offscreen"],
            env={**os.environ, "QT_QPA_PLATFORM": "offscreen",
                 "QT_QPA_PLATFORMTHEME": "generic"}, check=False)
        return result.returncode


if __name__ == "__main__":
    sys.exit(main())
