import QtQuick
import QtQuick.Controls

AbstractButton {
  id: root
  property string iconText: ""
  property string tooltipText: ""
  property color foreground: "white"
  property color fill: Qt.alpha(foreground, 0.10)
  property color accent: "#0a84ff"
  implicitWidth: 34
  implicitHeight: implicitWidth
  Accessible.name: tooltipText
  ToolTip.visible: hovered
  ToolTip.delay: 600
  ToolTip.text: tooltipText
  background: Rectangle {
    radius: height / 2
    color: root.down ? Qt.alpha(root.foreground, 0.22) : root.hovered ? Qt.alpha(root.foreground, 0.16) : root.fill
    border.width: root.activeFocus ? 1 : 0
    border.color: root.accent
  }
  contentItem: Text {
    text: root.iconText
    textFormat: Text.PlainText
    horizontalAlignment: Text.AlignHCenter
    verticalAlignment: Text.AlignVCenter
    color: root.foreground
    font.family: root.font.family
    font.pixelSize: root.font.pixelSize
  }
}
