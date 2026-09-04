import QtQuick
import QtQuick.Controls as QQC
import QtQuick.Layouts
import QtQuick.Shapes
import qs.Commons
import qs.Ui

// In-app contacts review: cross-source duplicate scan, per-person card
// review, and optional Blip-local display names. Read-only toward the Mac.
FocusScope {
  id: root

  property var preferences: null
  property color foreground: Color.foreground
  property color urgent: Color.urgent
  property color accent: Color.accent
  property color outgoingFill: accent
  property color outgoingText: "#ffffff"
  property color incomingFill: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.14)
  property color incomingText: foreground
  property string fontFamily: Style.font.family
  property real fontScale: 1.0
  property real density: 1.0
  property real cornerScale: 1.0
  property var hostWidget: null
  property var threads: []
  property string page: "contacts"
  readonly property bool editorActive: identitySettings.editorActive

  signal closeRequested()

  function fontSize(value) { return Math.max(1, Math.round(value * fontScale)) }
  function space(value) { return Math.max(1, Math.round(Style.spaceReal(value) * density)) }
  function corner(value) { return Math.max(0, Math.round(value * cornerScale)) }
  function focusDefault() { forceActiveFocus() }
  function showPage(value) {
    page = "contacts"
    settingsFlick.contentY = 0
  }

  function reviewContact(handle) {
    showPage("contacts")
    identitySettings.beginReview(handle, true)
  }

  BlipIdentities {
    id: identityResolver
    onChoicesChanged: {
      if (root.hostWidget) root.hostWidget.refresh(true, false)
    }
  }

  Keys.onEscapePressed: {
    if (root.page === "contacts" && identitySettings.reviewActive) identitySettings.closeReview()
    else root.closeRequested()
  }

  ColumnLayout {
    anchors.fill: parent
    spacing: root.space(10)

    RowLayout {
      Layout.fillWidth: true
      PanelHero {
        Layout.fillWidth: true
        title: "Blip settings"
        meta: "Contacts"
        detail: ""
        foreground: root.foreground
        fontFamily: root.fontFamily
      }
      PanelActionButton {
        Layout.alignment: Qt.AlignTop
        focusable: true
        iconText: "×"
        tooltipText: "Close settings (Esc)"
        bordered: true
        foreground: root.foreground
        hoverColor: root.accent
        fontFamily: root.fontFamily
        fontSize: root.fontSize(Style.font.icon)
        onClicked: root.closeRequested()
      }
    }

    PanelSeparator { Layout.fillWidth: true; foreground: root.foreground }

    RowLayout {
      Layout.fillWidth: true
      spacing: root.space(8)
      ActionButton {
        label: "Contacts"
        selected: root.page === "contacts"
        onClicked: root.showPage("contacts")
      }
      Item { Layout.fillWidth: true }
      Text {
        text: "Review Mac Contacts or set an optional display preference"
        textFormat: Text.PlainText
        color: Qt.darker(root.foreground, 1.4)
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.caption)
      }
    }

    PanelSeparator { Layout.fillWidth: true; foreground: root.foreground }

    Flickable {
      id: settingsFlick
      Layout.fillWidth: true
      Layout.fillHeight: true
      contentWidth: width
      contentHeight: settingsContent.implicitHeight
      clip: true
      boundsBehavior: Flickable.StopAtBounds
      interactive: contentHeight > height
      QQC.ScrollBar.vertical: QQC.ScrollBar { policy: QQC.ScrollBar.AsNeeded }

      MouseArea {
        anchors.fill: parent
        z: -1
        acceptedButtons: Qt.NoButton
        onWheel: function(wheel) {
          var delta = wheel.pixelDelta.y !== 0 ? wheel.pixelDelta.y * 3.0 : wheel.angleDelta.y * 4.5
          var maximum = Math.max(0, settingsFlick.contentHeight - settingsFlick.height)
          settingsFlick.contentY = Math.max(0, Math.min(maximum, settingsFlick.contentY - delta))
          wheel.accepted = true
        }
      }

      ColumnLayout {
        id: settingsContent
        width: Math.min(parent.width, root.space(1120))
        anchors.horizontalCenter: parent.horizontalCenter
        spacing: root.space(16)

        ColumnLayout {
          Layout.fillWidth: true
          visible: root.page === "contacts"
          spacing: root.space(12)

        IdentitySettings {
          id: identitySettings
          Layout.fillWidth: true
          resolver: identityResolver
          threads: root.threads
          preferences: root.preferences
          foreground: root.foreground
          urgent: root.urgent
          accent: root.accent
          fontFamily: root.fontFamily
          fontScale: root.fontScale
          density: root.density
          cornerScale: root.cornerScale
          onFocusAreaRequested: function(localY) {
            Qt.callLater(function() {
              var mapped = identitySettings.mapToItem(settingsContent, 0, localY).y
              var maximum = Math.max(0, settingsFlick.contentHeight - settingsFlick.height)
              settingsFlick.contentY = Math.max(0, Math.min(maximum, mapped - root.space(12)))
            })
          }
        }

        Item { Layout.preferredHeight: root.space(6) }
        }
      }
    }
  }

  component ActionButton: Rectangle {
    id: action
    property string label: ""
    property bool danger: false
    property bool selected: false
    signal clicked()
    implicitWidth: actionText.implicitWidth + root.space(18)
    implicitHeight: actionText.implicitHeight + root.space(12)
    radius: root.corner(root.space(8))
    color: actionHover.hovered
      ? Qt.rgba((danger ? root.urgent : root.accent).r,
                (danger ? root.urgent : root.accent).g,
                (danger ? root.urgent : root.accent).b, 0.18)
      : selected ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.18)
      : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.06)
    border.width: 1
    border.color: danger ? root.urgent : selected ? root.accent
      : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.35)
    Text {
      id: actionText
      anchors.centerIn: parent
      text: action.label
      textFormat: Text.PlainText
      color: action.danger ? root.urgent : root.foreground
      font.family: root.fontFamily
      font.pixelSize: root.fontSize(Style.font.caption)
      font.bold: action.danger || action.selected
    }
    HoverHandler { id: actionHover; cursorShape: Qt.PointingHandCursor }
    TapHandler { onTapped: action.clicked() }
  }
}
