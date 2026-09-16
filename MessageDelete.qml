import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons

FocusScope {
  id: root
  required property var message
  property color foreground: Color.foreground
  property color accent: "#0a84ff"
  property string fontFamily: Style.font.family
  property int fontSize: Style.font.bodySmall
  property bool busy: false
  property bool attempted: false
  property string error: ""
  signal closed()
  signal deleted()
  Keys.onEscapePressed: if (!busy) closed()
  Component.onCompleted: forceActiveFocus()
  function remove() {
    if (busy || attempted) return
    busy = true; attempted = true
    worker.payload = JSON.stringify({id: message.messageId, guid: message.messageGuid,
      chat: message.messageChat, confirmed: true})
    worker.stdinEnabled = true
    worker.running = true
  }
  Process {
    id: worker
    property string payload: ""
    property bool received: false
    command: ["bun", decodeURIComponent(Qt.resolvedUrl("message-delete.ts").toString().replace(/^file:\/\//, ""))]
    onStarted: { write(payload); payload = ""; stdinEnabled = false }
    stdout: StdioCollector {
      onStreamFinished: {
        worker.received = true
        try {
          if (text.length > 8192) throw "large"
          var result = JSON.parse(text)
          if (result.ok === true) { root.deleted(); return }
          root.error = result.error || "Deletion could not be verified. Check Messages on the Mac."
        } catch (_) { root.error = "Deletion could not be verified. Check Messages on the Mac." }
      }
    }
    onExited: Qt.callLater(function() {
      root.busy = false
      if (!worker.received) root.error = "Deletion could not be verified. Check Messages on the Mac."
    })
  }
  ColumnLayout {
    anchors.fill: parent
    anchors.margins: Style.space(18)
    spacing: Style.space(12)
    Text {
      textFormat: Text.PlainText; text: "Delete message?"; color: root.foreground
      font.family: root.fontFamily; font.pixelSize: root.fontSize+2; font.bold: true
    }
    Text {
      Layout.fillWidth: true
      text: "Deletes this message from Messages on the Mac. With Messages in iCloud, deletion also syncs to your devices. It does not unsend the message."
      textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: root.foreground
      font.family: root.fontFamily; font.pixelSize: root.fontSize
    }
    Rectangle {
      Layout.fillWidth: true
      implicitHeight: preview.implicitHeight + Style.space(24)
      color: Qt.alpha(root.foreground, 0.08); radius: Style.cornerRadius
      Text {
        id: preview
        anchors.centerIn: parent; width: parent.width-Style.space(24)
        text: String(root.message.text || "Attachment")
        textFormat: Text.PlainText; wrapMode: Text.WrapAnywhere
        maximumLineCount: 8; elide: Text.ElideRight; color: root.foreground
        font.family: root.fontFamily; font.pixelSize: root.fontSize
      }
    }
    Text {
      Layout.fillWidth: true
      text: root.error || (root.busy ? "Deleting in Messages on the Mac…" : "Keep Messages open and the Mac unlocked. The bridge will bring the selected message forward.")
      textFormat: Text.PlainText; wrapMode: Text.WordWrap
      color: root.error ? Color.urgent : root.foreground
      font.family: root.fontFamily; font.pixelSize: root.fontSize
    }
    Item { Layout.fillHeight: true }
    RowLayout {
      Layout.fillWidth: true
      ContactButton {
        Layout.fillWidth: true; text: root.attempted ? "Close" : "Cancel"
        enabled: !root.busy; onClicked: root.closed()
        foreground: root.foreground; accent: root.accent; fontFamily: root.fontFamily; fontSize: root.fontSize
      }
      ContactButton {
        objectName: "blipConfirmDelete"
        Layout.fillWidth: true; text: "Delete message"
        enabled: !root.busy && !root.attempted; onClicked: root.remove()
        foreground: Color.urgent; accent: Color.urgent; fontFamily: root.fontFamily; fontSize: root.fontSize
      }
    }
  }
}
