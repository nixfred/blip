#!/usr/bin/env python3
"""Drive the shipping conversation menu with mouse/key events and fake actions."""
from pathlib import Path
import os, shutil, subprocess, tempfile
repo=Path(__file__).resolve().parents[1]
source=(repo/'BlipView.qml').read_text()
def chunk(marker):
    start=source.index(marker); begin=source.index('{',start); depth=0
    for end in range(begin,len(source)):
        if source[end]=='{': depth+=1
        elif source[end]=='}':
            depth-=1
            if depth==0:return source[start:end+1]
    raise ValueError(marker)
menu=chunk('  Menu {\n    id: contactMenu')
parts=[chunk('  component ConversationMenuItem:'),chunk('  component ConversationMenuSeparator:'),menu,chunk('  function openContactMenu(')]
parts='\n'.join(parts).replace('Style.','style.').replace('Commons.Color.background','"#202126"')
qml='''import QtQuick
import QtQuick.Controls
import QtTest
Item {
  width:720; height:480; visible:true
  Item {
    id:root
    anchors.fill:parent
    property string fontFamily:"sans-serif"
    property int fontBodySmall:13
    property color foreground:"white"
    property color accent:"#0a84ff"
    property bool backgroundBusy:false
    property string backgroundChat:"synthetic"
    property var contactContext:null
    property bool toastAllowlistReady:true
    property bool toastAllowlistLoaded:true
    property bool toastAllowlistBusy:false
    property bool peeking:false
    property int actions:0
    property int outsideClicks:0
    property var hostWidget:QtObject {
      function reloadToastAllowlist() {}
      function conversationAct(kind,chat) { root.actions++ }
      function setToastAllowed(chat,handle,allow) { root.actions++ }
    }
    QtObject { id:style; function space(n) {return n} }
    QtObject { id:contactReview; function review(thread) {root.actions++} }
    function isDmChat(t) { return true }
    function blipNotificationsAllowed(t) { return false }
    function changeBackground(action,chat) { actions++ }
    function markUnread(t) { actions++ }
    function markRead(chat,ts,kind) { actions++ }
    function menuIcon(name) { return "" }
    MouseArea { anchors.fill:parent; onClicked:root.outsideClicks++ }
    Button { id:anchor; x:660; y:20; width:34; height:34; text:"⋯"; onClicked:root.openContactMenu({chat:"synthetic"},anchor) }
    @PARTS@
    TestCase {
      name:"ConversationMenu"; when:windowShown
      function init() { contactMenu.close(); root.actions=0; root.outsideClicks=0; wait(20) }
      function open() { mouseClick(anchor); tryCompare(contactMenu,"opened",true); wait(20) }
      function test_outside_click_closes_without_triggering_content_and_can_reopen() {
        open(); mouseClick(root,10,10); tryCompare(contactMenu,"visible",false); compare(root.outsideClicks,0);
        open(); verify(contactMenu.opened); mouseClick(root,10,450); tryCompare(contactMenu,"visible",false);
      }
      function test_action_click_runs_once_and_closes() {
        open(); var item=contactMenu.itemAt(0); mouseClick(item,item.width/2,item.height/2);
        compare(root.actions,1); tryCompare(contactMenu,"visible",false);
      }
      function test_escape_closes_and_retains_action_on_reopen() {
        open(); keyClick(Qt.Key_Escape); tryCompare(contactMenu,"visible",false);
        open(); var item=contactMenu.itemAt(1); mouseClick(item,item.width/2,item.height/2);
        compare(root.actions,1); tryCompare(contactMenu,"visible",false);
      }
      function test_small_window_keeps_menu_inside_surface() {
        open(); verify(contactMenu.x>=0); verify(contactMenu.y>=0);
        verify(contactMenu.x+contactMenu.width<=root.width); verify(contactMenu.y+contactMenu.height<=root.height);
      }
    }
  }
}
'''.replace('@PARTS@',parts)
runner=shutil.which('qmltestrunner') or '/usr/lib/qt6/bin/qmltestrunner'
with tempfile.TemporaryDirectory(prefix='blip-menu-test-') as temp:
    p=Path(temp);(p/'tst_menu.qml').write_text(qml);shutil.copy2(repo/'GlassSurface.qml',p/'GlassSurface.qml')
    env={**os.environ,'QT_QPA_PLATFORM':'offscreen','QT_QPA_PLATFORMTHEME':'generic','QT_QUICK_BACKEND':'software'}
    raise SystemExit(subprocess.run([runner,'-input',temp],env=env).returncode)
