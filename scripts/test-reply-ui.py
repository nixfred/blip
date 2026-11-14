#!/usr/bin/env python3
"""Render the actual reply target banner with invented context; no bridge or send."""
from pathlib import Path
import os, shutil, subprocess, tempfile
root = Path(__file__).resolve().parents[1]
s = (root / 'BlipView.qml').read_text()
a = s.index('        Rectangle {\n          id: replyBanner')
b = s.index('        // queued attachments', a)
banner = s[a:b].replace('Style.', 'style.')
qml = '''import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtTest
Item {
 id: root; width: 600; height: 100
 property bool inThread: true
 property var replyTarget: null
 property var attFiles: ({})
 property color foreground: "white"
 property color dim: "#aaaaaa"
 property string fontFamily: "sans-serif"
 property int fontCaption: 12
 function isImageMime(mime) { return mime.indexOf("image/") === 0 }
 QtObject { id: style; function space(n) { return n } }
 TextArea { id: composeField; visible: false }
 ColumnLayout { width: parent.width; @BANNER@ }
 TestCase {
  name: "ReplyTargetBanner"; when: windowShown
  function test_target_visibility_and_plain_text() {
   root.replyTarget = ({text:"<b>Invented reply target</b>", mine:false, name:"Demo contact"})
   tryCompare(replyBanner, "visible", true)
   compare(replyBannerText.textFormat, Text.PlainText)
   verify(replyBannerText.text.indexOf("<b>") >= 0)
   root.inThread = false
   tryCompare(replyBanner, "visible", false)
   root.inThread = true
   tryCompare(replyBanner, "visible", true)
   grabImage(root).save("/tmp/blip-reply-banner.png")
   root.replyTarget = null
   tryCompare(replyBanner, "visible", false)
  }
 }
}
'''.replace('@BANNER@', banner)
runner = shutil.which('qmltestrunner') or '/usr/lib/qt6/bin/qmltestrunner'
with tempfile.TemporaryDirectory(prefix='blip-reply-ui-') as folder:
 Path(folder, 'tst_reply.qml').write_text(qml)
 result = subprocess.run([runner, '-input', folder, '-platform', 'offscreen'], env={**os.environ,'QT_QPA_PLATFORM':'offscreen','QT_QPA_PLATFORMTHEME':'generic'})
 raise SystemExit(result.returncode)
