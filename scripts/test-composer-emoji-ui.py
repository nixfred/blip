#!/usr/bin/env python3
"""Run the actual composer and emoji-popup wiring against a fake send counter.

Only theme tokens, the external spelling worker, and host actions are stubbed; the TextArea, shipping picker,
insert/close handlers and full composer key handler are the real source.
"""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[1]
source = (repo / 'BlipView.qml').read_text()

def block(marker):
    begin = source.index('{', source.index(marker))
    depth = 0
    for end in range(begin, len(source)):
        if source[end] == '{': depth += 1
        elif source[end] == '}':
            depth -= 1
            if depth == 0: return source[begin + 1:end]
    raise ValueError(marker)

composer = block('              ComposerInput {')
# Theme math does not change the editor's behavior; no Omarchy shell is loaded.
composer = composer.replace('Style.', 'style.').replace('Border.', 'borderStyle.')
popup = block('  Popup {\n    id: emojiPopup')
popup = popup.replace('Style.', 'style.').replace('appearance.background', '"#202126"')
qml = '''import QtQuick
import QtQuick.Controls
import QtTest
import "."
Item {
  id: root
  width: 740; height: 540
  property color foreground: "white"
  property color dim: "#aaaaaa"
  property color urgent: "#ff4444"
  property color mineFill: "#0a84ff"
  property color accent: "#0a84ff"
  property string fontFamily: "sans-serif"
  property int fontBodySmall: 13
  property int fontCaption: 11
  property bool online: true
  property bool inThread: true
  property bool splitView: true
  property var active: ({chat:"synthetic"})
  property var drafts: ({})
  property int attachCount: 0
  property string shareUrl: ""
  property int bubbleCursor: -1
  property int sends: 0
  function send() { sends++ }
  function isSendable(t) { return true }
  function commitPeek() {}
  function shareKey(key) { return false }
  function selectedBubble() { return null }
  function back() {}
  function openEmojiPicker() { @OPEN@ }
  function insertComposerEmoji(emoji) { @INSERT@ }
  QtObject {
    id: style
    function space(n) { return n }
    function selectionFillFor(a,b) { return b }
  }
  QtObject { id: borderStyle; function controlSpec(a,b,c) { return {} } }
  Item {
    id: composeSlot
    anchors.left: parent.left; anchors.right: parent.right; anchors.bottom: parent.bottom
    height: 46
    Flickable {
      id: composeFlick
      anchors.fill: parent
      function showCaret() {}
      ComposerInput { @COMPOSER@ }
    }
  }
  Popup { @POPUP@ }
  TestCase {
    name: "ComposerEmoji"
    when: windowShown
    function init() {
      emojiPopup.close()
      composeField.text = "A draft stays here"
      composeField.cursorPosition = composeField.length
      composeField.forceActiveFocus()
      root.sends = 0
    }
    function chooseRocketByKeyboard() {
      root.openEmojiPicker()
      tryCompare(emojiPopup, "visible", true)
      var search = findChild(emojiPicker, "reactionEmojiSearch")
      var grid = findChild(emojiPicker, "reactionEmojiGrid")
      search.text = "rocket"
      tryCompare(grid, "count", 1)
      grabImage(root).save("/tmp/blip-composer-emoji.png")
      search.forceActiveFocus()
      keyClick(Qt.Key_Return)
      tryCompare(emojiPopup, "visible", false)
    }
    function test_selected_text_is_replaced_and_enter_never_sends() {
      composeField.select(2,7)
      chooseRocketByKeyboard()
      compare(composeField.text, "A 🚀 stays here")
      compare(composeField.cursorPosition, 4)
      compare(root.sends, 0)
      verify(composeField.activeFocus)
    }
    function test_inserts_at_cursor_and_keeps_both_sides() {
      composeField.cursorPosition = 2
      chooseRocketByKeyboard()
      compare(composeField.text, "A 🚀draft stays here")
      compare(root.sends, 0)
      keyClick(Qt.Key_Return)
      compare(root.sends, 1)
    }
    function test_escape_retains_draft_and_restores_editor_focus() {
      root.openEmojiPicker()
      tryCompare(emojiPopup, "visible", true)
      var search = findChild(emojiPicker, "reactionEmojiSearch")
      search.forceActiveFocus()
      keyClick(Qt.Key_Escape)
      tryCompare(emojiPopup, "visible", false)
      compare(composeField.text, "A draft stays here")
      verify(composeField.activeFocus)
      compare(root.sends, 0)
    }
    function test_button_toggles_closed_without_losing_focus() {
      root.openEmojiPicker()
      tryCompare(emojiPopup, "visible", true)
      root.openEmojiPicker()
      tryCompare(emojiPopup, "visible", false)
      verify(composeField.activeFocus)
      compare(composeField.text, "A draft stays here")
      compare(root.sends, 0)
    }
  }
}
'''
qml = qml.replace('@OPEN@', block('function openEmojiPicker(')).replace('@INSERT@', block('function insertComposerEmoji('))
qml = qml.replace('@COMPOSER@', composer).replace('@POPUP@', popup)
runner = os.environ.get('QMLTESTRUNNER') or shutil.which('qmltestrunner') or '/usr/lib/qt6/bin/qmltestrunner'
with tempfile.TemporaryDirectory(prefix='blip-composer-emoji-') as folder:
    for name in ['ComposerInput.qml', 'ComposerEmojiPicker.qml', 'EmojiPicker.mjs']:
        shutil.copy2(repo / name, Path(folder) / name)
    editor = (repo / 'ComposerInput.qml').read_text().replace('import Quickshell.Io\n', '')
    start = editor.index('  Process {')
    end = editor.index('  Canvas {', start)
    editor = editor[:start] + """  QtObject {
    id: checker
    property bool running: false
    property var command: []
    property bool stdinEnabled: false
    function write(text) {}
  }
""" + editor[end:]
    Path(folder, 'ComposerInput.qml').write_text(editor)
    Path(folder, 'tst_composer.qml').write_text(qml)
    result = subprocess.run([runner, '-input', folder, '-platform', 'offscreen'], env={**os.environ, 'QT_QPA_PLATFORM':'offscreen', 'QT_QPA_PLATFORMTHEME':'generic'})
    raise SystemExit(result.returncode)
