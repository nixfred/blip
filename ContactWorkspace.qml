import QtQuick
import QtQuick.Controls as QQC
import QtQuick.Layouts
import qs.Commons
import qs.Ui

// Session-only contact workspace; native writes keep their own previews and gates.
FocusScope {
  id: root
  property bool opened: false
  property color foreground: Color.foreground
  property color urgent: Color.urgent
  property color accent: "#0a84ff"
  property string fontFamily: Style.font.family
  property real fontScale: 1.0
  visible: opened
  signal closed()
  signal contactsMutated()
  function review(handle) {
    if (opened) return operations.activeHandle === handle
    if (!operations.findCandidates(handle)) return false
    opened = true; forceActiveFocus()
    return true
  }
  function close() { if (!operations.loading) { opened = false; operations.dismissReview(); closed() } }
  Keys.onEscapePressed: close()
  ContactOperations {
    id: operations
    objectName: "blipContactOperations"
    onContactsMutated: root.contactsMutated()
    onInitialContactReady: function(token) { if (root.opened) management.selectCandidate(management.candidateForToken(token)) }
  }
  ColumnLayout {
    anchors.fill: parent
    spacing: Style.space(10)
    RowLayout {
      Layout.fillWidth: true
      PanelActionButton {
        iconText: "←"; tooltipText: "Back"; focusable: true
        enabled: !operations.loading
        foreground: root.foreground; hoverColor: root.accent
        onClicked: root.close()
      }
      Text {
        Layout.fillWidth: true
        text: "Manage contact"; textFormat: Text.PlainText
        color: root.foreground; font.family: root.fontFamily
        font.pixelSize: Math.round(Style.font.body * root.fontScale)
      }
      ContactButton {
        foreground: root.foreground; accent: root.accent
        fontFamily: root.fontFamily
        fontSize: Math.round(Style.font.bodySmall * root.fontScale)
        text: "Copy vCard"; enabled: !operations.loading
        onClicked: operations.copyVCard(operations.activeHandle)
      }
    }
    Text {
      Layout.fillWidth: true
      text: operations.activeHandle; textFormat: Text.PlainText
      color: root.foreground; font.family: root.fontFamily
      font.pixelSize: Math.round(Style.font.caption * root.fontScale)
    }
    Flickable {
      Layout.fillWidth: true; Layout.fillHeight: true
      contentWidth: width; contentHeight: management.implicitHeight
      clip: true; boundsBehavior: Flickable.StopAtBounds
      QQC.ScrollBar.vertical: QQC.ScrollBar { }
      ContactManagement {
        id: management
        width: parent.width
        resolver: operations
        foreground: root.foreground; urgent: root.urgent; accent: root.accent
        fontFamily: root.fontFamily; fontScale: root.fontScale
        onCloseRequested: root.close()
      }
    }
  }
}
