import "PanelSize.mjs" as PanelSize
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// Blip panel — threads, then an iMessage-style conversation with a compose box.
//
//   list         → every thread, newest first, unread marked
//   conversation → bubbles: mine blue on the right, theirs grey on the left,
//                  grouped by sender with one timestamp per run, day dividers,
//                  compose box pinned at the bottom. Esc goes back.
//
// Reads its thread list from the host widget so there is exactly one poller.
// Bubble decoration (grouping, day labels, times) is computed in thread.ts,
// where it is unit-tested; this file only renders.
Panel {
  id: root
  moduleName: "nixfred.blip"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  property real preferredWidth: 0
  property real preferredHeight: 0
  property bool resized: false
  readonly property string sizeHelper: decodeURIComponent(Qt.resolvedUrl("panel-size-store.ts").toString().replace(/^file:\/\//, ""))
  Process {
    command: ["bun", root.sizeHelper]
    running: true
    stdout: StdioCollector {
      onStreamFinished: {
        if (root.resized || text.length > 256) return
        try {
          var size = PanelSize.parseSize(JSON.parse(text))
          if (size) { root.preferredWidth = size.width; root.preferredHeight = size.height }
        } catch (e) { }
      }
    }
  }
  Process { id: saveSize }
  Timer {
    id: saveDebounce
    interval: 250
    onTriggered: {
      if (saveSize.running) { restart(); return }
      saveSize.command = ["bun", root.sizeHelper, String(Math.round(root.preferredWidth)), String(Math.round(root.preferredHeight))]
      saveSize.running = true
    }
  }

  // ---- proxies: BarWidget and the IPC hooks talk to the panel, the view does the work
  readonly property bool inThread: view.inThread
  readonly property var active: view.active
  readonly property bool loading: view.loading
  readonly property bool rendered: view.rendered
  readonly property string seenTs: view.seenTs
  readonly property string activeLastTs: view.activeLastTs

  function open() {
    view.resetToList()
    controller.show()
  }
  function close() { controller.hide() }
  function toggle() { opened ? close() : open() }
  function switchPanel(direction) {
    if (bar && typeof bar.switchPanelFrom === "function")
      return bar.switchPanelFrom(barIdentity, direction)
    return false
  }
  function openThread(t) { view.openThread(t) }
  function markAllRead() { view.markAllRead() }
  function pushReload() { view.pushReload() }
  // A closed popout still remembers its last thread; never let IPC send into it blind.
  function composeAndSend(text) { if (!opened) return "panel closed — open the conversation first"; return view.composeAndSend(text) }
  function bubbleModel() { return view.bubbleModel() }
  function searchFor(query) { if (!opened) open(); return view.searchFor(query) }
  function newChatFor(query) { if (!opened) open(); return view.newChatFor(query) }
  function shareLink(url) { if (!opened) open(); return view.shareLink(url) }

  // ------------------------------------------------------------ panel
  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: view.inThread ? view.composeEditor : view.navigationKeys
    readonly property var fittedSize: PanelSize.fitSize(
      root.preferredWidth || Style.space(352),
      root.preferredHeight || panel.fittedContentHeight(
        view.contactsOpen || view.inThread ? Style.space(640) : Math.max(view.contentHeightHint,
          (view.newMode || view.searching) ? Style.space(280) : 0), Style.space(640)),
      panel.screenW, panel.screenH, panel.availableCardWidth, panel.availableCardHeight)
    contentWidth: fittedSize.width
    contentHeight: fittedSize.height


    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      // PanelKeyCatcher runs BEFORE any focused descendant (Keys.BeforeItem).
      // Without this it swallows every letter typed into the compose box.
      // Any focused editor — the compose box or a bubble being selected —
      // must receive its own keys (Ctrl+C, arrows, Esc).
      blocked: view.editorActive
      onCloseRequested: if (!view.unwind()) root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onMoveRequested: function(dx, dy) { view.moveCursor(dy) }
      onActivateRequested: view.activateCursor()
      onReturnRequested:   view.activateCursor()
      onTextKey: function(text) { view.handleTextKey(text) }

      BlipView {
        id: view
        anchors.fill: parent
        hostWidget: root.hostWidget
        surfaceOpen: root.opened
        foreground: root.bar ? root.bar.foreground : Color.foreground
        urgent: root.bar ? root.bar.urgent : Color.urgent
        themeFont: root.bar ? root.bar.fontFamily : Style.font.family
        onNavigationFocusRequested: view.navigationKeys.forceActiveFocus()
      }
    }
    MouseArea {
      id: resizeGrip
      anchors.right: parent.right
      anchors.bottom: parent.bottom
      // The parent is inset by popup padding; extend into that padding so
      // the grip sits against the card's inner border, not the content edge.
      anchors.rightMargin: -panel.padding
      anchors.bottomMargin: -panel.padding
      width: Style.space(20); height: Style.space(20)
      Accessible.name: "Resize Blip"
      z: 100
      cursorShape: Qt.SizeFDiagCursor
      preventStealing: true
      property point startPoint
      property real startWidth
      property real startHeight
      property real widthMultiplier: 1
      onPressed: function(mouse) {
        startPoint = mapToItem(null, mouse.x, mouse.y)
        startWidth = panel.contentWidth
        startHeight = panel.contentHeight
        widthMultiplier = panel.cardOrigin.x <= panel.margin + 1 ? 1 : 2
      }
      onPositionChanged: function(mouse) {
        if (!pressed) return
        var point = mapToItem(null, mouse.x, mouse.y)
        var size = PanelSize.fitSize(startWidth + (point.x-startPoint.x)*widthMultiplier,
          startHeight + point.y-startPoint.y, panel.screenW, panel.screenH,
          panel.availableCardWidth, panel.availableCardHeight)
        root.resized = true
        root.preferredWidth = size.width
        root.preferredHeight = size.height
      }
      onReleased: if (root.resized) saveDebounce.restart()
      onCanceled: if (root.resized) saveDebounce.restart()
      Repeater {
        model: 3
        Rectangle {
          required property int index
          width: Style.space(3 + index * 4)
          height: Math.max(1, Style.space(1))
          x: resizeGrip.width - width - Style.space(3)
          y: resizeGrip.height - Style.space(4 + index * 4)
          rotation: -45
          color: view.foreground
          opacity: resizeGrip.containsMouse || resizeGrip.pressed ? 0.8 : 0.35
        }
      }
      hoverEnabled: true
    }

  }
}
