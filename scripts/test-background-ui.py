#!/usr/bin/env python3
"""Execute the shipping background picker callbacks with synthetic QtTest state.

No picker, bridge or real settings are opened. Covers thread switches while a
picker/decoder owns the process and config watcher events during that operation.
"""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

source = (Path(__file__).resolve().parents[1] / 'BlipView.qml').read_text()

def block(marker, after=0):
    start = source.index(marker, after)
    begin = source.index('{', start)
    depth = 0
    for end in range(begin, len(source)):
        if source[end] == '{':
            depth += 1
        elif source[end] == '}':
            depth -= 1
            if depth == 0:
                return source[begin + 1:end]
    raise ValueError(marker)

process = source.index('id: backgroundProc')
qml = '''import QtQuick
import QtTest
Item {
  id: root
  property string backgroundChat: "A"
  property string backgroundUrl: "file:///synthetic-a.png"
  property string backgroundScript: "/synthetic-helper.ts"
  property bool backgroundReloadPending: false
  property bool backgroundReady: true
  property bool backgroundBusy: false
  property string note: ""
  function changeBackground(action, targetChat) { @CHANGE@ }
  function changedChat() { @CHANGED@ }
  function receive(text) { backgroundProc.reply = text }
  function finishBackground(code) { @FINISH@ }
  function finished() { root.finishBackground(0) }
  QtObject {
    id: backgroundProc
    property bool running: false
    property string action: "load"
    property string chat: ""
    property var command: []
    property bool stdinEnabled: false
    property string body: ""
    property string reply: ""
    property bool sawExit: false
    function write(value) { body = value }
  }
  TestCase {
    name: "ConversationBackground"
    function init() {
      root.backgroundChat = "A"
      root.backgroundUrl = "file:///synthetic-a.png"
      root.backgroundReloadPending = false
      root.backgroundBusy = false
      root.backgroundReady = true
      root.note = ""
      backgroundProc.running = false
      backgroundProc.chat = ""
      backgroundProc.body = ""
    }
    function test_initial_signals_cannot_start_an_unready_process() {
      root.backgroundReady = false
      root.changeBackground("load")
      compare(backgroundProc.running, false)
      compare(root.backgroundBusy, false)
    }
    function test_switch_during_picker_keeps_result_with_original_chat() {
      root.changeBackground("choose")
      compare(backgroundProc.chat, "A")
      compare(JSON.parse(backgroundProc.body).chat, "A")
      root.backgroundChat = "B"
      root.changedChat()
      compare(root.backgroundUrl, "")
      verify(root.backgroundReloadPending)
      root.receive(JSON.stringify({ok:true, url:"file:///new-a.png"}))
      compare(root.backgroundUrl, "")
      backgroundProc.running = false
      root.finished()
      tryCompare(backgroundProc, "chat", "B")
      compare(backgroundProc.action, "load")
      root.receive(JSON.stringify({ok:true, url:"file:///b.png"}))
      root.finished()
      compare(root.backgroundUrl, "file:///b.png")
    }
    function test_config_watch_during_load_queues_a_fresh_read() {
      root.changeBackground("load")
      root.changeBackground("load")
      verify(root.backgroundReloadPending)
      backgroundProc.running = false
      root.finished()
      tryCompare(backgroundProc, "running", true)
      compare(backgroundProc.action, "load")
      compare(root.backgroundReloadPending, false)
    }
    function test_cancel_does_not_erase_current_background() {
      root.changeBackground("choose")
      root.receive(JSON.stringify({ok:true, cancelled:true}))
      root.finished()
      compare(root.backgroundUrl, "file:///synthetic-a.png")
      compare(root.note, "")
    }
    function test_default_change_reloads_current_override() {
      root.changeBackground("choose", "")
      compare(backgroundProc.chat, "")
      root.receive(JSON.stringify({ok:true, url:"file:///default.png"}))
      root.finished()
      compare(root.backgroundUrl, "file:///synthetic-a.png")
      backgroundProc.running = false
      tryCompare(backgroundProc, "chat", "A")
    }
    function test_failed_choose_retains_current_image_and_explains() {
      root.changeBackground("choose")
      root.receive(JSON.stringify({ok:false, error:"Choose a PNG or JPEG image"}))
      root.finished()
      compare(root.backgroundUrl, "file:///synthetic-a.png")
      compare(root.note, "Choose a PNG or JPEG image")
    }
  }
}
'''
qml = qml.replace('@CHANGE@', block('function changeBackground('))
qml = qml.replace('@CHANGED@', block('onBackgroundChatChanged:'))
qml = qml.replace('@FINISH@', block('function finishBackground('))
runner = shutil.which('qmltestrunner') or '/usr/lib/qt6/bin/qmltestrunner'
with tempfile.TemporaryDirectory(prefix='blip-background-ui-') as folder:
    Path(folder, 'tst_background.qml').write_text(qml)
    result = subprocess.run([runner, '-input', folder, '-platform', 'offscreen'], env={**os.environ, 'QT_QPA_PLATFORM':'offscreen', 'QT_QPA_PLATFORMTHEME':'generic'})
    raise SystemExit(result.returncode)
