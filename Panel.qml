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
  property var preferences: null
  readonly property var barIdentity: hostWidget || root

  // ---- proxies: BarWidget and the IPC hooks talk to the panel, the view does the work
  readonly property bool inThread: view.inThread
  readonly property var active: view.active
  readonly property bool loading: view.loading
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
    focusTarget: view.settingsMode ? keyCatcher : (view.inThread ? view.composeEditor : keyCatcher)
    // 20% narrower than it was (Fred, 2.3.1). Messages' own sidebar is a
    // narrow column; 440 read like a file browser.
    contentWidth: panel.fittedContentWidth(Style.space(352))
    // The floor keeps the panel usable if a mode flip's relayout ever lags
    // again — search/new modes always have at least a field to show.
    contentHeight: panel.fittedContentHeight(
      view.settingsMode ? Style.space(640)
        : view.inThread ? Style.space(640)
        : Math.max(view.contentHeightHint,
                   (view.newMode || view.searching) ? Style.space(280) : 0),
      Style.space(640))

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
        preferences: root.preferences
        surfaceOpen: root.opened
        foreground: root.bar ? root.bar.foreground : Color.foreground
        urgent: root.bar ? root.bar.urgent : Color.urgent
        themeFont: root.bar ? root.bar.fontFamily : Style.font.family
        onNavigationFocusRequested: keyCatcher.forceActiveFocus()
      }
    }
  }
}
