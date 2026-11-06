#!/usr/bin/env python3
"""Drive the shipping swipe gesture with real wheel events and a synthetic row."""
from pathlib import Path
import os, shutil, subprocess, tempfile
repo=Path(__file__).resolve().parents[1]
qml='''import QtQuick
import QtTest
Item {
  width:400; height:200
  TimeRevealGesture { id:reveal; maxOffset:72 }
  property real scrolled:0
  MouseArea {
    id:area; anchors.fill:parent; acceptedButtons:Qt.NoButton
    onWheel:function(wheel) {
      var sideways=wheel.pixelDelta.x!==0?wheel.pixelDelta.x:wheel.angleDelta.x
      var vertical=wheel.pixelDelta.y!==0?wheel.pixelDelta.y:wheel.angleDelta.y
      wheel.accepted=true
      parent.scrolled+=reveal.route(sideways,vertical)
    }
  }
  TestCase {
    name:"TimeReveal"; when:windowShown
    function init() { tryCompare(reveal,"tracking",false,1000); reveal.offset=0; area.parent.scrolled=0; wait(300) }
    function test_swipe_left_opens_then_springs_back() {
      mouseWheel(area,200,100,-120,0); compare(reveal.offset,72); compare(reveal.progress,1); compare(area.parent.scrolled,0);
      wait(600); compare(reveal.offset,72);
      tryCompare(reveal,"offset",0,3000);
    }
    function test_swipe_right_closes_while_tracking() {
      mouseWheel(area,200,100,-60,0); compare(reveal.offset,60);
      mouseWheel(area,200,100,40,0); compare(reveal.offset,20);
    }
    function test_abandoned_partial_swipe_closes_fast() {
      mouseWheel(area,200,100,-20,0); compare(reveal.offset,20);
      tryCompare(reveal,"offset",0,800);
    }
    function test_vertical_scroll_does_not_reveal() {
      mouseWheel(area,200,100,-5,120); mouseWheel(area,200,100,-60,30);
      compare(reveal.offset,0); compare(area.parent.scrolled,150);
    }
  }
}
'''
runner=shutil.which('qmltestrunner') or '/usr/lib/qt6/bin/qmltestrunner'
with tempfile.TemporaryDirectory(prefix='blip-time-reveal-') as temp:
    p=Path(temp);(p/'tst_time_reveal.qml').write_text(qml)
    for name in ['TimeRevealGesture.qml','TimeReveal.mjs']:shutil.copy2(repo/name,p/name)
    env={**os.environ,'QT_QPA_PLATFORM':'offscreen','QT_QPA_PLATFORMTHEME':'generic','QT_QUICK_BACKEND':'software'}
    raise SystemExit(subprocess.run([runner,'-input',temp],env=env).returncode)
