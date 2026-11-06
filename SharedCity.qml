import QtQuick
import Quickshell.Io
import "City.mjs" as City

// One open conversation's city. No disk cache or message/read-state access.
Item {
  id: root
  visible: false
  property string chat: ""
  property bool active: false
  property string script: decodeURIComponent(Qt.resolvedUrl("city.ts").toString().replace(/^file:\/\//, ""))
  property var record: null
  property double clock: Date.now()
  property int epoch: 0
  property bool pending: false
  property bool ready: false
  readonly property string city: active ? City.visibleCity(record, chat, clock) : ""

  Component.onCompleted: { root.ready = true; Qt.callLater(root.invalidate) }

  onChatChanged: invalidate()
  onActiveChanged: invalidate()

  function invalidate() {
    epoch++
    record = null
    pending = false
    if (ready && active && chat !== "") reload()
  }

  function reload() {
    if (!ready || !active || chat === "") return
    if (lookup.running) { pending = true; return }
    pending = false
    lookup.requestChat = chat
    lookup.requestEpoch = epoch
    lookup.received = false
    lookup.command = ["bun", script]
    lookup.stdinEnabled = true
    lookup.running = true
    lookup.write(JSON.stringify({ chat: chat }))
    lookup.stdinEnabled = false
  }

  Timer {
    interval: 60000
    repeat: true
    running: root.active && root.chat !== ""
    onTriggered: root.reload()
  }
  Timer {
    interval: 1000
    repeat: true
    running: root.active && root.record !== null
    onTriggered: root.clock = Date.now()
  }
  Process {
    id: lookup
    property string requestChat: ""
    property int requestEpoch: -1
    property bool received: false
    function belongsHere() {
      return root.active && root.chat === requestChat && root.epoch === requestEpoch
    }
    stdout: StdioCollector {
      onStreamFinished: {
        lookup.received = true
        if (!lookup.belongsHere()) return
        root.clock = Date.now()
        try { root.record = JSON.parse(text) }
        catch (e) { root.record = null }
      }
    }
    // Never forward bridge stderr to the shell journal.
    stderr: StdioCollector {}
    onExited: function(exitCode, exitStatus) {
      if (lookup.belongsHere() && (!received || exitCode !== 0)) root.record = null
      if (root.pending) Qt.callLater(root.reload)
    }
  }
}
