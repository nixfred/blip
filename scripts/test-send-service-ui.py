#!/usr/bin/env python3
"""Run BlipView's shipping send-service wiring under QtTest, without Blip or a Mac.

BlipView keeps thread.ts's `service` with the chat it was loaded for
(noteThreadService) and asks SendState.sendServiceArg what a send carries
(sendServiceFor). Both functions are cut out of the real BlipView.qml and run
against the real SendState.mjs, so a change that drops the chat check or reads
the list row's label first fails here, not only in a text match (#165 review).

Requires Qt 6's qmltestrunner and the QtQuick/QtTest QML modules. An optional
argument runs the same checks against another BlipView.qml.
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

    return '''import QtQuick
import QtTest
import "SendState.mjs" as SendState
Item {
    id: root
    property var active: ({chat: "", service: ""})
    property bool activeIsGroup: false
    property string threadSendService: ""
    property string threadSendServiceChat: ""
    @FUNCTIONS@
    TestCase {
        name: "BlipSendService"
        function init() {
            root.active = {chat: "+15551234567", service: "iMessage"}
            root.activeIsGroup = false
            root.noteThreadService("", "")
        }
        // 2026-11-12: a contact texting on RCS whose chat row still said iMessage.
        function test_loaded_rows_beat_the_label() {
            root.noteThreadService("+15551234567", "RCS")
            compare(root.sendServiceFor("+15551234567"), "RCS")
        }
        function test_rows_loaded_for_another_chat_never_decide() {
            root.noteThreadService("+15550000000", "RCS")
            root.active = {chat: "+15551234567", service: "SMS"}
            compare(root.sendServiceFor("+15551234567"), "SMS")
        }
        function test_a_load_that_named_no_service_leaves_the_label() {
            root.noteThreadService("+15551234567", undefined)
            root.active = {chat: "+15551234567", service: "SMS"}
            compare(root.sendServiceFor("+15551234567"), "SMS")
        }
        function test_imessage_carries_no_service() {
            root.noteThreadService("+15551234567", "iMessage")
            root.active = {chat: "+15551234567", service: "SMS"}
            compare(root.sendServiceFor("+15551234567"), "")
        }
        function test_a_group_never_carries_a_service() {
            root.activeIsGroup = true
            root.active = {chat: "abcdef0123456789abcdef0123456789", service: "RCS"}
            root.noteThreadService("abcdef0123456789abcdef0123456789", "RCS")
            compare(root.sendServiceFor("abcdef0123456789abcdef0123456789"), "")
        }
        function test_an_email_never_carries_sms() {
            root.active = {chat: "pat@example.com", service: "SMS"}
            compare(root.sendServiceFor("pat@example.com"), "")
        }
    }
}
'''.replace("@FUNCTIONS@", "\n".join(function(name) for name in ("noteThreadService", "sendServiceFor")))


def main():
    repo = Path(__file__).resolve().parents[1]
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else repo / "BlipView.qml"
    runner = os.environ.get("QMLTESTRUNNER") or shutil.which("qmltestrunner")
    if not runner:
        runner = next((str(path) for path in (
            Path("/usr/lib/qt6/bin/qmltestrunner"),
            Path("/usr/lib/qt6/libexec/qmltestrunner")) if path.is_file()), None)
    if not runner:
        sys.exit("Qt 6 qmltestrunner not found; set QMLTESTRUNNER to its path")
    with tempfile.TemporaryDirectory(prefix="blip-send-service-ui-") as directory:
        dest = Path(directory)
        shutil.copyfile(repo / "SendState.mjs", dest / "SendState.mjs")
        (dest / "tst_send_service.qml").write_text(harness(source.read_text()))
        result = subprocess.run(
            [runner, "-input", directory, "-platform", "offscreen"],
            env={**os.environ, "QT_QPA_PLATFORM": "offscreen",
                 "QT_QPA_PLATFORMTHEME": "generic"}, check=False, timeout=60)
        return result.returncode


if __name__ == "__main__":
    sys.exit(main())
