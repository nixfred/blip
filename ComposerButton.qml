import QtQuick
import QtQuick.Controls

AbstractButton {
  id: root
  property string iconName: ""
  property string iconText: ""
  property string tooltipText: ""
  property color foreground: "white"
  property color fill: Qt.alpha(foreground, 0.10)
  property color accent: "#0a84ff"
  property int motionDuration: 120
  implicitWidth: 34
  implicitHeight: implicitWidth
  opacity: enabled ? 1 : 0.45
  Accessible.name: tooltipText
  ToolTip.visible: hovered
  ToolTip.delay: 600
  ToolTip.text: tooltipText
  background: GlassSurface {
    color: root.fill
    foreground: root.foreground
    accent: root.accent
    focused: root.activeFocus
    hovered: root.hovered
    pressed: root.down
    motionDuration: root.motionDuration
  }
  contentItem: Item {
    LineIcon {
      anchors.centerIn: parent
      width: Math.min(22, root.width * 0.60); height: width
      visible: root.iconName !== ""
      name: root.iconName
      color: root.foreground
    }
    Text {
      anchors.fill: parent
      visible: root.iconName === ""
      text: root.iconText
      textFormat: Text.PlainText
      horizontalAlignment: Text.AlignHCenter
      verticalAlignment: Text.AlignVCenter
      color: root.foreground
      font.family: root.font.family
      font.pixelSize: root.font.pixelSize
    }
  }
}
