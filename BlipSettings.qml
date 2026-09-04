import QtQuick
import QtQuick.Controls as QQC
import QtQuick.Layouts
import QtQuick.Shapes
import qs.Commons
import qs.Ui

// In-app appearance editor. Changes apply immediately through the shared
// BlipPreferences object and are debounced to ~/.config/blip/preferences.json.
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
  property string localError: ""
  property bool resetArmed: false
  property string page: "contacts"
  readonly property bool editorActive: outgoingSetting.editorActive || incomingSetting.editorActive
    || identitySettings.editorActive

  signal closeRequested()
  signal vcardFinished(string message, bool success)

  function fontSize(value) { return Math.max(1, Math.round(value * fontScale)) }
  function space(value) { return Math.max(1, Math.round(Style.spaceReal(value) * density)) }
  function corner(value) { return Math.max(0, Math.round(value * cornerScale)) }
  function focusDefault() { forceActiveFocus() }
  function showPage(value) {
    page = value === "appearance" ? "appearance" : "contacts"
    settingsFlick.contentY = 0
  }
  function copyVCard(handle) {
    return identityResolver.copyVCard(handle)
  }
  function editContact(handle) {
    showPage("contacts")
    identitySettings.editContact(handle)
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
    onVcardFinished: function(message, success) {
      root.vcardFinished(message, success)
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
        meta: root.page === "contacts" ? "Contacts" : "Appearance"
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
      ActionButton {
        label: "Appearance"
        selected: root.page === "appearance"
        onClicked: root.showPage("appearance")
      }
      Item { Layout.fillWidth: true }
      Text {
        text: root.page === "contacts"
          ? "Manage Mac Contacts or set an optional display preference"
          : "Changes preview and apply live"
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

        ColumnLayout {
          Layout.fillWidth: true
          visible: root.page === "appearance"
          spacing: root.space(16)

        Text {
          Layout.fillWidth: true
          text: "Changes apply live. The files under ~/.config/blip can be tracked in dotfiles or restored later."
          textFormat: Text.PlainText
          wrapMode: Text.WordWrap
          color: Qt.darker(root.foreground, 1.35)
          font.family: root.fontFamily
          font.pixelSize: root.fontSize(Style.font.bodySmall)
        }

        // A real preview makes color, type, density, and rounding adjustments
        // legible before the settings page is closed.
        ColumnLayout {
          Layout.fillWidth: true
          spacing: root.space(7)
          RowLayout {
            Layout.fillWidth: true
            Item { Layout.fillWidth: true }
            PreviewBubble {
              mine: true
              label: "Your bubble"
              fillColor: root.outgoingFill
              textColor: root.outgoingText
            }
          }
          RowLayout {
            Layout.fillWidth: true
            PreviewBubble {
              mine: false
              label: "Their bubble"
              fillColor: root.incomingFill
              textColor: root.incomingText
            }
            Item { Layout.fillWidth: true }
          }
        }

        PanelSectionHeader {
          Layout.fillWidth: true
          text: "COLORS"
          foreground: root.foreground
          fontFamily: root.fontFamily
          fontSize: root.fontSize(Style.font.caption)
        }

        ColorSetting {
          id: outgoingSetting
          Layout.fillWidth: true
          title: "Outgoing bubbles"
          preferenceKey: "outgoingBubbleColor"
          currentValue: root.preferences ? root.preferences.outgoingBubbleColor : "theme"
          resolvedColor: root.outgoingFill
        }

        ColorSetting {
          id: incomingSetting
          Layout.fillWidth: true
          title: "Incoming bubbles"
          preferenceKey: "incomingBubbleColor"
          currentValue: root.preferences ? root.preferences.incomingBubbleColor : "theme"
          resolvedColor: root.incomingFill
        }

        PanelSectionHeader {
          Layout.fillWidth: true
          text: "LAYOUT"
          foreground: root.foreground
          fontFamily: root.fontFamily
          fontSize: root.fontSize(Style.font.caption)
        }

        ColumnLayout {
          Layout.fillWidth: true
          spacing: root.space(5)
          Text {
            text: "Conversation list time"
            textFormat: Text.PlainText
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: root.fontSize(Style.font.bodySmall)
            font.bold: true
          }
          RowLayout {
            spacing: root.space(7)
            ActionButton {
              label: "12-hour (AM/PM)"
              selected: !root.preferences || root.preferences.use12HourConversationTimes
              onClicked: if (root.preferences)
                root.preferences.setBoolean("use12HourConversationTimes", true)
            }
            ActionButton {
              label: "24-hour"
              selected: root.preferences && !root.preferences.use12HourConversationTimes
              onClicked: if (root.preferences)
                root.preferences.setBoolean("use12HourConversationTimes", false)
            }
          }
        }

        PreferenceSlider {
          Layout.fillWidth: true
          title: "Window opacity"
          preferenceKey: "backgroundOpacity"
          currentValue: root.preferences ? root.preferences.backgroundOpacity : 0.70
          from: 0.20; to: 1.0; stepSize: 0.05; decimals: 0; multiplier: 100; suffix: "%"
        }
        PreferenceSlider {
          Layout.fillWidth: true
          title: "Font scale"
          preferenceKey: "fontScale"
          currentValue: root.preferences ? root.preferences.fontScale : 1.0
          from: 0.75; to: 1.50; stepSize: 0.05; decimals: 0; multiplier: 100; suffix: "%"
        }
        PreferenceSlider {
          Layout.fillWidth: true
          title: "Density"
          preferenceKey: "density"
          currentValue: root.preferences ? root.preferences.density : 1.0
          from: 0.70; to: 1.40; stepSize: 0.05; decimals: 0; multiplier: 100; suffix: "%"
        }
        PreferenceSlider {
          Layout.fillWidth: true
          title: "Sidebar width"
          preferenceKey: "sidebarWidth"
          currentValue: root.preferences ? root.preferences.sidebarWidth : 320
          from: 240; to: 520; stepSize: 10; decimals: 0; multiplier: 1; suffix: " px"
        }
        PreferenceSlider {
          Layout.fillWidth: true
          title: "Avatar size"
          preferenceKey: "avatarSize"
          currentValue: root.preferences ? root.preferences.avatarSize : 30
          from: 24; to: 64; stepSize: 2; decimals: 0; multiplier: 1; suffix: " px"
        }
        PreferenceSlider {
          Layout.fillWidth: true
          title: "Corner roundness"
          preferenceKey: "cornerScale"
          currentValue: root.preferences ? root.preferences.cornerScale : 1.0
          from: 0; to: 2.0; stepSize: 0.10; decimals: 1; multiplier: 1; suffix: "×"
        }

        Text {
          Layout.fillWidth: true
          visible: root.localError !== "" || (root.preferences && root.preferences.error !== "")
          text: root.localError !== "" ? root.localError : String(root.preferences ? root.preferences.error : "")
          textFormat: Text.PlainText
          wrapMode: Text.WordWrap
          color: root.urgent
          font.family: root.fontFamily
          font.pixelSize: root.fontSize(Style.font.caption)
        }

        Text {
          Layout.fillWidth: true
          text: root.preferences
            ? (root.preferences.saving ? "Saving…" : root.preferences.notice) + "\n" + root.preferences.configPath
            : "Preferences unavailable"
          textFormat: Text.PlainText
          wrapMode: Text.WrapAnywhere
          color: Qt.darker(root.foreground, 1.45)
          font.family: root.fontFamily
          font.pixelSize: root.fontSize(Style.font.caption)
        }

        RowLayout {
          Layout.fillWidth: true
          spacing: root.space(8)
          ActionButton {
            label: "Reload file"
            onClicked: {
              root.resetArmed = false
              root.localError = ""
              if (root.preferences) root.preferences.load(true)
            }
          }
          Item { Layout.fillWidth: true }
          ActionButton {
            label: root.resetArmed ? "Confirm reset" : "Reset to defaults"
            danger: root.resetArmed
            onClicked: {
              if (!root.resetArmed) {
                root.resetArmed = true
                return
              }
              root.resetArmed = false
              root.localError = ""
              if (root.preferences) root.preferences.restoreDefaults()
            }
          }
        }

        Item { Layout.preferredHeight: root.space(6) }
        }
      }
    }
  }

  component PreviewBubble: Item {
    id: previewBubble
    property bool mine: false
    property string label: ""
    property color fillColor: root.incomingFill
    property color textColor: root.incomingText

    Layout.preferredWidth: Math.ceil(previewLabel.implicitWidth) + root.space(22)
    Layout.preferredHeight: Math.ceil(previewLabel.implicitHeight) + root.space(14)

    Shape {
      anchors.fill: parent
      antialiasing: true
      ShapePath {
        id: previewPath
        readonly property real r: Math.min(
          root.corner(root.space(16)), previewBubble.width / 2, previewBubble.height / 2
        )
        strokeColor: "transparent"
        fillColor: previewBubble.fillColor
        startX: r
        startY: 0
        PathLine { x: previewBubble.width - previewPath.r; y: 0 }
        PathQuad {
          x: previewBubble.width; y: previewPath.r
          controlX: previewBubble.width; controlY: 0
        }
        PathLine {
          x: previewBubble.width
          y: previewBubble.mine ? previewBubble.height : previewBubble.height - previewPath.r
        }
        PathQuad {
          x: previewBubble.mine ? previewBubble.width : previewBubble.width - previewPath.r
          y: previewBubble.height
          controlX: previewBubble.width; controlY: previewBubble.height
        }
        PathLine { x: previewBubble.mine ? previewPath.r : 0; y: previewBubble.height }
        PathQuad {
          x: 0
          y: previewBubble.mine ? previewBubble.height - previewPath.r : previewBubble.height
          controlX: 0; controlY: previewBubble.height
        }
        PathLine { x: 0; y: previewPath.r }
        PathQuad {
          x: previewPath.r; y: 0
          controlX: 0; controlY: 0
        }
      }
    }

    Text {
      id: previewLabel
      anchors.centerIn: parent
      text: previewBubble.label
      textFormat: Text.PlainText
      color: previewBubble.textColor
      font.family: root.fontFamily
      font.pixelSize: root.fontSize(Style.font.bodySmall)
    }
  }

  component ColorSetting: ColumnLayout {
    id: colorSetting
    property string title: ""
    property string preferenceKey: ""
    property string currentValue: "theme"
    property color resolvedColor: root.accent
    readonly property bool editorActive: field.activeFocus
    spacing: root.space(5)

    function syncField() {
      if (!field.activeFocus) field.text = currentValue === "theme" ? "" : currentValue
    }
    function focusField() { field.forceActiveFocus() }
    function commit() {
      var candidate = field.text.trim().toLowerCase()
      if (candidate === "" || candidate === "theme") candidate = "theme"
      if (candidate !== "theme" && !/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(candidate)) {
        root.localError = title + ": use #rrggbb, #rrggbbaa, or Theme"
        return
      }
      root.localError = ""
      if (root.preferences) root.preferences.setColor(preferenceKey, candidate)
      syncField()
    }
    onCurrentValueChanged: syncField()
    Component.onCompleted: syncField()

    Text {
      text: colorSetting.title
      textFormat: Text.PlainText
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: root.fontSize(Style.font.bodySmall)
      font.bold: true
    }
    RowLayout {
      Layout.fillWidth: true
      spacing: root.space(8)
      Rectangle {
        width: root.space(28); height: width
        radius: root.corner(root.space(8))
        color: colorSetting.resolvedColor
        border.width: 1
        border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.45)
      }
      TextField {
        id: field
        Layout.fillWidth: true
        placeholderText: "theme"
        foreground: root.foreground
        accent: root.accent
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.bodySmall)
        maximumLength: 9
        onAccepted: colorSetting.commit()
        onEditingFinished: colorSetting.commit()
      }
      ActionButton {
        label: "Theme"
        onClicked: {
          field.text = ""
          root.localError = ""
          if (root.preferences) root.preferences.setColor(colorSetting.preferenceKey, "theme")
        }
      }
    }
  }

  component PreferenceSlider: ColumnLayout {
    id: sliderRow
    property string title: ""
    property string preferenceKey: ""
    property real currentValue: 0
    property real from: 0
    property real to: 1
    property real stepSize: 0.1
    property int decimals: 0
    property real multiplier: 1
    property string suffix: ""
    spacing: root.space(4)

    onCurrentValueChanged: if (!slider.pressed) slider.value = currentValue

    RowLayout {
      Layout.fillWidth: true
      Text {
        Layout.fillWidth: true
        text: sliderRow.title
        textFormat: Text.PlainText
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.bodySmall)
      }
      Text {
        text: (slider.value * sliderRow.multiplier).toFixed(sliderRow.decimals) + sliderRow.suffix
        textFormat: Text.PlainText
        color: root.accent
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.caption)
        font.bold: true
      }
    }
    QQC.Slider {
      id: slider
      Layout.fillWidth: true
      from: sliderRow.from
      to: sliderRow.to
      stepSize: sliderRow.stepSize
      value: sliderRow.currentValue
      onMoved: {
        root.resetArmed = false
        root.localError = ""
        if (root.preferences) root.preferences.setNumber(sliderRow.preferenceKey, value)
      }
      background: Rectangle {
        x: slider.leftPadding
        y: slider.topPadding + slider.availableHeight / 2 - height / 2
        implicitWidth: 200
        implicitHeight: root.space(4)
        width: slider.availableWidth
        height: implicitHeight
        radius: height / 2
        color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.18)
        Rectangle {
          width: slider.visualPosition * parent.width
          height: parent.height
          radius: parent.radius
          color: root.accent
        }
      }
      handle: Rectangle {
        x: slider.leftPadding + slider.visualPosition * (slider.availableWidth - width)
        y: slider.topPadding + slider.availableHeight / 2 - height / 2
        implicitWidth: root.space(16)
        implicitHeight: width
        radius: width / 2
        color: root.accent
        border.width: slider.activeFocus ? 2 : 1
        border.color: root.foreground
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
