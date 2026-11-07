#!/usr/bin/env python3
"""Drive the shipping notice with a synthetic message: size, lifetime, dismissal."""
from pathlib import Path
import os, shutil, subprocess, tempfile
repo=Path(__file__).resolve().parents[1]
qml='''import QtQuick
import QtTest
Item {
  width:500; height:200
  NoticeOverlay { id:notice; x:20; y:20; text:"Couldn't reach your Mac."; error:true; maximumWidth:260; fontPixelSize:13 }
  SignalSpy { id:spy; target:notice; signalName:"dismissed" }
  TestCase {
    name:"Notice"; when:windowShown
    function init() { spy.clear(); notice.timeoutMs=0; notice.text="Couldn't reach your Mac."; wait(20) }
    function test_click_dismisses() { mouseClick(notice,10,10); compare(spy.count,1) }
    function test_timeout_dismisses_and_zero_stays() {
      wait(200); compare(spy.count,0);
      notice.timeoutMs=120; tryCompare(spy,"count",1,1500);
    }
    function test_long_text_wraps_inside_maximum_width() {
      notice.text="A synthetic failure long enough that it has to wrap onto a second line of the notice";
      wait(30); verify(notice.width<=260); verify(notice.height>30);
    }
    function test_short_text_hugs_its_content() {
      notice.text="A synthetic failure long enough that it has to wrap onto a second line of the notice";
      wait(30); var wrapped=notice.height;
      notice.text="ok"; wait(30); verify(notice.width<160); verify(notice.height<wrapped);
    }
  }
}
'''
runner=shutil.which('qmltestrunner') or '/usr/lib/qt6/bin/qmltestrunner'
with tempfile.TemporaryDirectory(prefix='blip-notice-') as temp:
    p=Path(temp);(p/'tst_notice.qml').write_text(qml)
    for name in ['NoticeOverlay.qml','GlassSurface.qml']:shutil.copy2(repo/name,p/name)
    env={**os.environ,'QT_QPA_PLATFORM':'offscreen','QT_QPA_PLATFORMTHEME':'generic','QT_QUICK_BACKEND':'software'}
    raise SystemExit(subprocess.run([runner,'-input',temp],env=env).returncode)
