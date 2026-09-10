import QtQuick
import QtQuick.Controls as QQC
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

FocusScope {
  id: root
  required property var card
  property color foreground: Color.foreground
  property color accent: "#0a84ff"
  property string fontFamily: Style.font.family
  property int fontSize: Style.font.bodySmall
  property var details: null
  property string error: ""
  signal closed()
  signal openOnMac()
  signal copyRequested(string text)
  readonly property string helper: decodeURIComponent(Qt.resolvedUrl("contact-details.ts").toString().replace(/^file:\/\//, ""))
  Keys.onEscapePressed: closed()
  function validText(value, limit) {
    return typeof value === "string" && value.length <= limit
      && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value)
  }
  Component.onCompleted: {
    worker.stdinEnabled = true
    worker.running = true
    forceActiveFocus()
  }
  Process {
    id: worker
    command: ["bun", root.helper]
    property bool received: false
    onStarted: {
      write(JSON.stringify({handle: root.card.handle, token: root.card.token}))
      stdinEnabled = false
    }
    stdout: StdioCollector {
      onStreamFinished: {
        worker.received = true
        try {
          if (text.length > 49152) throw "large"
          var value = JSON.parse(text)
          if (!value || value.ok !== true) {
            root.error = value && root.validText(value.error,180) ? value.error : "Could not read contact details"
            return
          }
          if (!root.validText(value.name,160) || !root.validText(value.source,160)
            || !Array.isArray(value.fields) || value.fields.length>160) throw "schema"
          for (var i=0;i<value.fields.length;i++) {
            if (!root.validText(value.fields[i].label,120) || !root.validText(value.fields[i].value,4096)) throw "field"
          }
          root.details=value
        } catch (_) { root.error="Invalid contact details" }
      }
    }
    onExited: Qt.callLater(function() { if (!worker.received) root.error="Could not start contact details" })
  }
  ColumnLayout {
    anchors.fill: parent
    spacing: Style.space(10)
    RowLayout {
      Layout.fillWidth: true
      PanelActionButton {
        iconText: "←"; tooltipText: "Back to contact review"
        foreground: root.foreground; hoverColor: root.accent
        onClicked: root.closed()
      }
      Text {
        Layout.fillWidth: true
        text: root.details ? root.details.name : root.card.name
        textFormat: Text.PlainText; wrapMode: Text.WordWrap
        color: root.foreground; font.family: root.fontFamily; font.pixelSize: root.fontSize+2; font.bold: true
      }
    }
    Text {
      Layout.fillWidth: true
      text: root.error || (root.details ? root.details.source : "Reading contact details…")
      textFormat: Text.PlainText; wrapMode: Text.WordWrap
      color: root.error ? Color.urgent : root.foreground
      font.family: root.fontFamily; font.pixelSize: root.fontSize
    }
    PanelSeparator { Layout.fillWidth: true; foreground: root.foreground }
    Flickable {
      Layout.fillWidth: true; Layout.fillHeight: true
      contentWidth: width; contentHeight: fields.implicitHeight
      clip: true; boundsBehavior: Flickable.StopAtBounds
      QQC.ScrollBar.vertical: QQC.ScrollBar {}
      ColumnLayout {
        id: fields
        width: parent.width
        spacing: Style.space(12)
        Repeater {
          model: root.details ? root.details.fields : []
          delegate: ColumnLayout {
            required property var modelData
            Layout.fillWidth: true
            spacing: Style.space(2)
            TapHandler {
              acceptedButtons: Qt.RightButton
              onTapped: root.copyRequested(modelData.value)
            }
            Text {
              Layout.fillWidth: true; text: modelData.label; textFormat: Text.PlainText
              wrapMode: Text.WordWrap; color: Qt.darker(root.foreground,1.4)
              font.family: root.fontFamily; font.pixelSize: root.fontSize
            }
            TextEdit {
              Layout.fillWidth: true; text: modelData.value; textFormat: TextEdit.PlainText
              readOnly: true; selectByMouse: true; wrapMode: TextEdit.Wrap
              color: root.foreground; font.family: root.fontFamily; font.pixelSize: root.fontSize
              Keys.onPressed: function(event) {
                if (event.matches(StandardKey.Copy)) {
                  if (selectedText !== "") root.copyRequested(selectedText)
                  event.accepted = true
                }
              }
            }
          }
        }
      }
    }
    ContactButton {
      Layout.fillWidth: true; text: "Open on Mac ↗"
      foreground: root.foreground; accent: root.accent; fontFamily: root.fontFamily; fontSize: root.fontSize
      onClicked: root.openOnMac()
    }
  }
}
