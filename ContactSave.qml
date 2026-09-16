import QtQuick
import QtQuick.Controls as QQC
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

FocusScope {
  id: root
  objectName: "blipContactSaveForm"
  // The parent supplies a DM handle or the explicitly selected group participant.
  required property string handle
  property color foreground: Color.foreground
  property color accent: "#0a84ff"
  property string fontFamily: Style.font.family
  property int fontSize: Style.font.bodySmall
  property string error: ""
  property var preview: null
  property bool ready: false
  property bool busy: false
  property bool uncertain: false
  property bool done: false
  property string savedName: ""
  signal closed()
  signal saved()
  readonly property string helper: decodeURIComponent(Qt.resolvedUrl("contact-save.ts").toString().replace(/^file:\/\//, ""))
  Keys.onEscapePressed: { if (!root.busy) root.closed() }
  function request(mode, value) {
    if (root.busy) return
    root.busy = true
    root.error = ""
    worker.mode = mode
    worker.payload = JSON.stringify(value)
    worker.received = false
    worker.stdinEnabled = true
    worker.running = true
  }
  Component.onCompleted: {
    request("prepare", {handle: root.handle})
    forceActiveFocus()
  }
  Process {
    id: worker
    property string mode: "prepare"
    property string payload: ""
    property bool received: false
    command: ["bun", root.helper, mode]
    onStarted: {
      write(payload)
      payload = ""
      stdinEnabled = false
    }
    stdout: StdioCollector {
      onStreamFinished: {
        worker.received = true
        try {
          if (text.length > 8192) throw "large"
          var value = JSON.parse(text)
          if (!value || value.ok !== true) {
            root.error = value && typeof value.error === "string" ? value.error : "Contact request failed"
            root.uncertain = worker.mode === "save" && (!value || value.uncertain !== false)
            return
          }
          if (worker.mode === "prepare") {
            phone.text = value.draft.phone
            email.text = value.draft.email
            root.ready = true
            firstName.forceActiveFocus()
          } else if (worker.mode === "preview") {
            root.preview = value
          } else {
            root.done = true
            root.savedName = value.name
            root.preview = null
            firstName.text = ""
            lastName.text = ""
            phone.text = ""
            email.text = ""
            root.saved()
          }
        } catch (_) {
          root.error = worker.mode === "save" ? "Save could not be verified. Check Contacts on the Mac before trying again." : "Invalid contact response"
          root.uncertain = worker.mode === "save"
        }
      }
    }
    onExited: Qt.callLater(function() {
      root.busy = false
      if (!worker.received) {
        root.error = worker.mode === "save" ? "Save could not be verified. Check Contacts on the Mac before trying again." : "Could not start the contact helper"
        root.uncertain = worker.mode === "save"
      }
    })
  }
  ColumnLayout {
    anchors.fill: parent
    spacing: Style.space(10)
    RowLayout {
      Layout.fillWidth: true
      PanelActionButton {
        iconText: "←"; tooltipText: "Back to conversation"
        foreground: root.foreground; hoverColor: root.accent
        enabled: !root.busy
        onClicked: root.closed()
      }
      Text {
        Layout.fillWidth: true; text: root.done ? "Contact saved" : root.preview ? "Review new contact" : "Save new contact"
        textFormat: Text.PlainText; color: root.foreground
        font.family: root.fontFamily; font.pixelSize: root.fontSize+2; font.bold: true
        wrapMode: Text.WordWrap
      }
    }
    Text {
      Layout.fillWidth: true
      text: root.error || (root.done ? root.savedName + " was saved to Contacts on the Mac."
        : root.busy && worker.mode === "save" ? "Saving to Contacts on the Mac… Approve Contacts access there if asked."
        : "Create a new card in Contacts on the Mac. Keep this sender’s number or email on the card.")
      textFormat: Text.PlainText; wrapMode: Text.WordWrap
      color: root.error ? Color.urgent : root.foreground
      font.family: root.fontFamily; font.pixelSize: root.fontSize
    }
    PanelSeparator { Layout.fillWidth: true; foreground: root.foreground }
    Flickable {
      Layout.fillWidth: true; Layout.fillHeight: true
      contentWidth: width; contentHeight: form.implicitHeight
      clip: true; boundsBehavior: Flickable.StopAtBounds
      QQC.ScrollBar.vertical: QQC.ScrollBar {}
      ColumnLayout {
        id: form
        width: parent.width
        spacing: Style.space(8)
        visible: !root.done
        enabled: root.ready && !root.busy && !root.uncertain
        Text {
          Layout.fillWidth: true; text: root.handle; textFormat: Text.PlainText
          color: root.foreground; wrapMode: Text.WrapAnywhere
          font.family: root.fontFamily; font.pixelSize: root.fontSize
        }
        ColumnLayout {
          Layout.fillWidth: true
          visible: !root.preview
          Text { textFormat: Text.PlainText; text: "First name"; color: root.foreground; font.family: root.fontFamily; font.pixelSize: root.fontSize }
          QQC.TextField {
            id: firstName
            objectName: "blipSaveFirstName"
            Layout.fillWidth: true; maximumLength: 160; selectByMouse: true
            color: root.foreground; font.family: root.fontFamily; font.pixelSize: root.fontSize
            background: Rectangle {
              color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.06)
              radius: Style.cornerRadius
              border.width: 1
              border.color: parent.activeFocus ? root.accent : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.3)
            }
            Accessible.name: "First name"
          }
          Text { textFormat: Text.PlainText; text: "Last name"; color: root.foreground; font.family: root.fontFamily; font.pixelSize: root.fontSize }
          QQC.TextField {
            id: lastName
            objectName: "blipSaveLastName"
            Layout.fillWidth: true; maximumLength: 160; selectByMouse: true
            color: root.foreground; font.family: root.fontFamily; font.pixelSize: root.fontSize
            background: Rectangle {
              color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.06)
              radius: Style.cornerRadius
              border.width: 1
              border.color: parent.activeFocus ? root.accent : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.3)
            }
            Accessible.name: "Last name"
          }
          Text { textFormat: Text.PlainText; text: "Phone"; color: root.foreground; font.family: root.fontFamily; font.pixelSize: root.fontSize }
          QQC.TextField {
            id: phone
            objectName: "blipSavePhone"
            Layout.fillWidth: true; maximumLength: 80; selectByMouse: true
            color: root.foreground; font.family: root.fontFamily; font.pixelSize: root.fontSize
            background: Rectangle {
              color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.06)
              radius: Style.cornerRadius
              border.width: 1
              border.color: parent.activeFocus ? root.accent : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.3)
            }
            Accessible.name: "Phone"
          }
          Text { textFormat: Text.PlainText; text: "Email"; color: root.foreground; font.family: root.fontFamily; font.pixelSize: root.fontSize }
          QQC.TextField {
            id: email
            objectName: "blipSaveEmail"
            Layout.fillWidth: true; maximumLength: 254; selectByMouse: true
            color: root.foreground; font.family: root.fontFamily; font.pixelSize: root.fontSize
            background: Rectangle {
              color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.06)
              radius: Style.cornerRadius
              border.width: 1
              border.color: parent.activeFocus ? root.accent : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.3)
            }
            Accessible.name: "Email"
          }
        }
        Text {
          Layout.fillWidth: true; visible: !!root.preview
          text: root.preview ? root.preview.name + "\n" + root.preview.draft.phone + "\n" + root.preview.draft.email : ""
          textFormat: Text.PlainText; wrapMode: Text.WrapAnywhere; color: root.foreground
          font.family: root.fontFamily; font.pixelSize: root.fontSize
        }
      }
    }
    RowLayout {
      Layout.fillWidth: true
      ContactButton {
        Layout.fillWidth: true
        text: root.done || root.uncertain ? "Close" : root.preview ? "Edit" : "Cancel"
        foreground: root.foreground; accent: root.accent; fontFamily: root.fontFamily; fontSize: root.fontSize
        enabled: !root.busy
        onClicked: { if (root.preview && !root.uncertain && !root.done) root.preview = null; else root.closed() }
      }
      ContactButton {
        Layout.fillWidth: true
        visible: !root.done && !root.uncertain
        enabled: root.ready && !root.busy
        text: root.preview ? "Save to Contacts" : "Review"
        foreground: root.foreground; accent: root.accent; fontFamily: root.fontFamily; fontSize: root.fontSize
        onClicked: {
          if (root.preview) {
            var value = Object.assign({}, root.preview.draft, {confirmed: true})
            root.request("save", value)
          } else {
            root.request("preview", {handle: root.handle, firstName: firstName.text, lastName: lastName.text, phone: phone.text, email: email.text})
          }
        }
      }
    }
  }
}
