#!/usr/bin/env python3
"""Render the shipping reaction badge and exercise its sticker interactions."""
from pathlib import Path
import os, shutil, subprocess, tempfile
repo=Path(__file__).resolve().parents[1]
qml='''import QtQuick
import QtTest
Item {
  width:400; height:240
  ReactionBadge { id:badge; x:60; y:60; width:implicitWidth; height:implicitHeight }
  SignalSpy { id:openSpy; target:badge; signalName:"stickerActivated" }
  SignalSpy { id:contextSpy; target:badge; signalName:"stickerContextRequested" }
  TestCase {
    name:"ReactionBadge"; when:windowShown
    function init() { badge.tapbacks=[]; badge.stickers=[]; badge.maximumWidth=180; openSpy.clear();contextSpy.clear() }
    function test_single_emoji_has_round_body_and_room_for_thought_tail() {
      badge.tapbacks=[{emoji:"❤️",from_me:true}]; tryCompare(badge,"visible",true);
      compare(badge.width,34); compare(badge.height,44); compare(badge.entries[0].emoji,"❤️");
    }
    function test_sticker_reaction_retains_open_and_context_actions() {
      badge.tapbacks=[{emoji:"👍"}];
      badge.stickers=[{reaction:true,attachment:{id:"",sticker:{label:"Unavailable synthetic star"}}}];
      tryCompare(badge,"width",60); wait(20);
      mouseClick(badge,43,17); compare(openSpy.count,1);
      mouseClick(badge,43,17,Qt.RightButton); compare(contextSpy.count,1);
    }
    function test_additive_stickers_do_not_become_reaction_balloons() {
      badge.stickers=[{attachment:{id:"synthetic-decoration"}}]; verify(!badge.visible);
      badge.maximumWidth=34; badge.tapbacks=[{emoji:"👍"},{emoji:"❤️"},{emoji:"🎉"}];
      compare(badge.width,34); compare(badge.entries[0].count,3);
    }
  }
}
'''
runner=shutil.which('qmltestrunner') or '/usr/lib/qt6/bin/qmltestrunner'
with tempfile.TemporaryDirectory(prefix='blip-badge-test-') as temp:
    p=Path(temp);(p/'tst_badge.qml').write_text(qml)
    for name in ['ReactionBadge.qml','ReactionBadges.mjs','StickerImage.qml']:shutil.copy2(repo/name,p/name)
    env={**os.environ,'QT_QPA_PLATFORM':'offscreen','QT_QPA_PLATFORMTHEME':'generic','QT_QUICK_BACKEND':'software'}
    raise SystemExit(subprocess.run([runner,'-input',temp],env=env).returncode)
