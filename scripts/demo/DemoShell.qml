import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons

// Screenshot harness. Renders the REAL BlipView against the fake bridge, in a
// plain window, with no bar and no second Omarchy shell fighting the live one.
//
// It stands in for BarWidget: BlipView asks its host for twelve things, and this
// supplies all twelve — `threads` from a genuine `bun collector.ts --deep` run,
// which in the sandbox reaches scripts/demo/fake-imsg instead of a Mac. So the
// list, the avatars, the bubbles, the link card and the share sheet are all
// produced by the shipping code paths.
//
// Run it with scripts/demo/blip-shots, never by hand: it needs the sandbox
// HOME, or the collector would read a real chat.db.
ShellRoot {
  id: shell

  QtObject {
    id: host
    property var threads: []
    property bool online: true
    property int unread: 0
    property bool healthy: true
    property string lastError: ""
    property var draftCache: ({})
    property var avatarCache: ({})
    // The version, from the same manifest.json the shipped widget reads.
    property string version: ""
    // Clock and date patterns, as BarWidget would supply them (README defaults);
    // BLIP_DEMO_TIME_FORMAT etc. override, so a shot can show them configured.
    property string timeFormat: Quickshell.env("BLIP_DEMO_TIME_FORMAT") || "h:mm AP"
    property string dateFormat: Quickshell.env("BLIP_DEMO_DATE_FORMAT") || "MMM d"
    property string dateFormatWithYear: Quickshell.env("BLIP_DEMO_DATE_FORMAT_WITH_YEAR") || "MMM d, yyyy"
    function refresh(deep, markRead, readChat, seen, unreadChat, act, actTarget) { collector.reload() }
    function markAllRead() { }
    function markThreadRead(chat) { }
    function markThreadUnread(chat) { }
    function conversationAct(kind, chat) { }
    function showApp() { }
  }

  FileView {
    path: Qt.resolvedUrl("manifest.json").toString().replace(/^file:\/\//, "")
    onLoaded: { try { host.version = String(JSON.parse(text()).version || "") } catch (e) { host.version = "" } }
  }

  Process {
    id: collector
    property string script: Qt.resolvedUrl("collector.ts").toString().replace(/^file:\/\//, "")
    command: ["bun", script, "--deep"]
    running: true
    function reload() { if (!running) running = true }
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          var d = JSON.parse(text.trim())
          if (d.ok === true) {
            host.threads = Array.isArray(d.threads) ? d.threads : []
            host.unread = host.threads.reduce(function (n, t) { return n + (Number(t.unread) || 0) }, 0)
            host.online = true
          }
        } catch (e) { console.log("demo collector: " + e) }
      }
    }
  }

  // A layer-shell panel, not a FloatingWindow: Hyprland TILES a floating
  // window to whatever the layout wants (1253x1375 here), and every shot came
  // out half empty. A layer surface is exactly the size asked for, at the
  // position asked for, so `grim -g` frames it identically every run.
  PanelWindow {
    id: win
    color: "transparent"
    // OVERLAY, above every panel and desk: a full-screen Infomarchy desk on
    // the "top" layer sat over this surface and four README screenshots
    // captured the desktop instead of Blip (2026-09-05). The crop is fixed;
    // what is under it must be ours.
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.namespace: "blip-demo"
    exclusionMode: ExclusionMode.Ignore
    anchors { top: true; left: true }
    margins { top: win.originY; left: win.originX }
    readonly property int originX: 220
    readonly property int originY: 140
    /** narrow = the bar popout (one column); wide = the app window (two). */
    property bool narrow: false
    implicitWidth: narrow ? 560 : 1120
    implicitHeight: 760
    visible: true

    Rectangle {
      anchors.fill: parent
      color: Color.background
      radius: Style.space(12)

    BlipView {
      id: view
      anchors.fill: parent
      anchors.margins: Style.space(14)
      hostWidget: host
      surfaceOpen: true
      readActive: false          // a screenshot must never move a read mark
      splitView: !win.narrow
      foreground: Color.foreground
      urgent: Color.urgent
      themeFont: Style.font.family
    }

    }

    // Drive the shot from outside: `qs -p <demo shell> ipc call demo open <chat>`
    IpcHandler {
      target: "demo"
      function open(chat: string): string {
        for (var i = 0; i < host.threads.length; i++) {
          if (String(host.threads[i].chat) === chat) { view.openThread(host.threads[i]); return "opened" }
        }
        return "unknown chat"
      }
      function list(): string { view.resetToList(); return "list" }
      function mode(m: string): string { win.narrow = (m === "narrow"); return m }
      function share(url: string): string { return view.shareLink(url) }
      function threads(): string { return String(host.threads.length) }
      function menu(): string { view.closeShare(); view.openConversationMenu(host.threads[0]); return "menu" }
    }
  }
}
