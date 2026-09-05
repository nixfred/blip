import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import qs.Commons

// Blip window — the "actual app": a Messages.app-style two-pane window.
//
// Hosted INSIDE the Omarchy shell (like the dev-gallery's FloatingWindow), so
// it shares the bar widget's poller, push watcher, and read-state ledger —
// no daemon, no second collector. `hostWidget` is injected by BarWidget.
//
// The content is the SAME BlipView the bar popout renders, in splitView:
// sidebar + conversation side by side, with every feature the popout has
// (tapbacks, receipts, inline photos, replies, search, composer,
// attachments). No PanelKeyCatcher here — a normal window keeps normal
// editor/Tab behavior; Esc unwinds the view (thread → list, search → list)
// and closes the window only when there is nothing left to unwind.
FloatingWindow {
  id: win
  property var hostWidget: null
  property var preferences: null
  // "Blip (3)" while unread exists — selectors match the "Blip" PREFIX.
  title: "Blip" + (hostWidget && hostWidget.unread > 0 ? " (" + hostWidget.unread + ")" : "")
  // Opaque unless the user deliberately lowers the portable appearance
  // preference. Omarchy 4.x does not guarantee window blur.
  readonly property real backdropAlpha: preferences ? preferences.backgroundOpacity : 0.70
  color: Qt.rgba(Color.background.r, Color.background.g, Color.background.b, backdropAlpha)
  implicitWidth: 1040
  implicitHeight: 720
  minimumSize: Qt.size(720, 480)
  visible: false
  // Focused = Hyprland's active toplevel is this window (title prefix "Blip").
  // A visible-but-unfocused window keeps refreshing but does not mark read.
  readonly property bool focused: visible && Hyprland.activeToplevel !== null
    && String(Hyprland.activeToplevel.title || "").indexOf("Blip") === 0

  // Proxies BarWidget relies on (same names as the popout host).
  readonly property bool inThread: view.inThread
  readonly property var active: view.active
  readonly property bool loading: view.loading
  readonly property string activeLastTs: view.activeLastTs
  function openThread(t) { view.openThread(t) }
  function shareLink(url) { return view.shareLink(url) }
  function openSettings(page) { view.openSettings(page) }
  function pushReload() { view.pushReload() }
  function navText(event) {
    if (event.key === Qt.Key_Slash) return "/"
    if (event.key === Qt.Key_N) return "n"
    var typed = event.text
    if (typed && typed.length > 0) return typed
    if (event.modifiers & (Qt.ShiftModifier | Qt.ControlModifier | Qt.AltModifier | Qt.MetaModifier))
      return ""
    if (event.key >= Qt.Key_1 && event.key <= Qt.Key_9) return String.fromCharCode(event.key)
    return typed
  }

  // ---- persistence: the window lives inside the shell process, so every
  // omarchy-restart-shell (every plugin deploy/update) would kill it. Remember
  // "was open" + size in ~/.local/state/blip/window.json and restore on start.
  readonly property string stateDir: Quickshell.env("HOME") + "/.local/state/blip"
  property bool restoring: true
  FileView {
    id: winState
    path: win.stateDir + "/window.json"
    blockLoading: true
    printErrors: false
  }
  function saveWinState() {
    if (restoring) return
    var j = JSON.stringify({ visible: visible, width: Math.round(width), height: Math.round(height) })
    // detached: a Process object drops writes while a previous one is alive,
    // and hideWindow() destroying this window mid-write lost the "hidden" state
    Quickshell.execDetached(["sh", "-c",
      "umask 077 && mkdir -p \"$1\" && printf '%s' \"$2\" > \"$1/window.json.tmp.$$\" && mv \"$1/window.json.tmp.$$\" \"$1/window.json\"",
      "blip", stateDir, j])
  }
  Component.onCompleted: {
    try {
      var d = JSON.parse(winState.text())
      if (d && d.width >= 720 && d.height >= 480) { implicitWidth = d.width; implicitHeight = d.height }
      if (d && d.visible === true) Qt.callLater(function() { win.visible = true; if (win.hostWidget) win.hostWidget.refresh(true, false) })
    } catch (e) { /* first run */ }
    Qt.callLater(function() { win.restoring = false })
  }
  onVisibleChanged: { saveWinState(); if (visible) Qt.callLater(view.focusDefault) }
  onWidthChanged: if (visible) saveWinState()
  onHeightChanged: if (visible) saveWinState()

  FocusScope {
    id: scope
    anchors.fill: parent
    focus: true

    Keys.priority: Keys.AfterItem
    Keys.onPressed: function(event) {
      if (event.key === Qt.Key_Escape) {
        if (!view.unwind()) win.visible = false
        event.accepted = true
        return
      }
      if (view.catchNavText(win.navText(event))) event.accepted = true
    }

    Item {
      id: navCatcher
      anchors.fill: parent
      focus: true
      Keys.priority: Keys.BeforeItem
      Keys.onPressed: function(event) {
        if (event.key === Qt.Key_Escape && view.catchEscape()) {
          event.accepted = true
          return
        }
        if (view.catchNavText(win.navText(event))) event.accepted = true
      }

      BlipView {
        id: view
        anchors.fill: parent
        // Inset from the window edge: Hyprland rounds the corners, and text
        // flush to the border got clipped by the radius (Fred).
        anchors.margins: Math.max(1, Math.round(Style.spaceReal(12)
          * (win.preferences ? win.preferences.density : 1.0)))
        hostWidget: win.hostWidget
        preferences: win.preferences
        splitView: true
        surfaceOpen: win.visible
        readActive: win.focused
        foreground: Color.foreground
        urgent: Color.urgent
        themeFont: Style.font.family
        onNavigationFocusRequested: navCatcher.forceActiveFocus()
      }
    }
  }
}
