import QtQuick

// A small layered surface, with no backdrop capture or blur passes.
Item {
  id: root
  property color color: Qt.rgba(1, 1, 1, 0.10)
  property color foreground: "white"
  property color accent: "#0a84ff"
  property real radius: height / 2
  property bool focused: false
  property bool hovered: false
  property bool pressed: false
  property bool shadow: true
  property int motionDuration: 120
  Rectangle {
    anchors.fill: parent
    anchors.topMargin: 1
    anchors.bottomMargin: -1
    radius: root.radius
    color: "#24000000"
    visible: root.shadow
  }
  Rectangle {
    anchors.fill: parent
    radius: root.radius
    color: root.color
  }
  Rectangle {
    anchors.fill: parent
    radius: root.radius
    gradient: Gradient {
      GradientStop { position: 0; color: Qt.rgba(1, 1, 1, root.pressed ? 0.05 : root.hovered ? 0.20 : 0.12) }
      GradientStop { position: 0.50; color: Qt.rgba(1, 1, 1, root.pressed ? 0.02 : 0.035) }
      GradientStop { position: 1; color: Qt.rgba(0, 0, 0, root.pressed ? 0.10 : 0.035) }
    }
    border.width: 1
    border.color: Qt.alpha(root.foreground, root.hovered ? 0.27 : 0.18)
    Behavior on border.color { ColorAnimation { duration: root.motionDuration } }
  }
  Rectangle {
    anchors.fill: parent
    radius: root.radius
    color: "transparent"
    border.width: 2
    border.color: root.accent
    opacity: root.focused ? 0.90 : 0
    Behavior on opacity { NumberAnimation { duration: root.motionDuration } }
  }
}
