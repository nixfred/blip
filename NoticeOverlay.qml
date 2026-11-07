import QtQuick

// One floating notice: small, quiet, gone by itself, or on a click.
Item {
  id: notice
  property string text: ""
  property bool error: false
  property int timeoutMs: 0
  property real maximumWidth: 320
  property color foreground: "white"
  property color accent: "#ff5f57"
  property string fontFamily: ""
  property int fontPixelSize: 13
  signal dismissed()

  implicitWidth: Math.min(label.implicitWidth + 16 + (error ? 14 : 0) + 8, maximumWidth)
  implicitHeight: Math.max(30, label.implicitHeight + 14)
  width: implicitWidth
  height: implicitHeight
  opacity: 0
  Component.onCompleted: opacity = 1
  Behavior on opacity { NumberAnimation { duration: 140; easing.type: Easing.OutCubic } }

  GlassSurface {
    anchors.fill: parent
    radius: 15
    color: Qt.rgba(0.11, 0.11, 0.13, 0.97)
    foreground: notice.foreground
    hovered: hover.hovered
  }
  Rectangle {
    visible: notice.error
    x: 12; width: 6; height: 6; radius: 3
    y: Math.round((parent.height - height) / 2)
    color: notice.accent
  }
  Text {
    id: label
    x: notice.error ? 26 : 12
    width: notice.maximumWidth - x - 12
    y: Math.round((parent.height - height) / 2)
    text: notice.text
    textFormat: Text.PlainText
    wrapMode: Text.Wrap
    color: notice.foreground
    font.family: notice.fontFamily
    font.pixelSize: notice.fontPixelSize
    onTextChanged: if (notice.timeoutMs > 0) lifetime.restart()
    // a one-line notice hugs its text rather than the width allowed
    Component.onCompleted: width = Qt.binding(function() {
      return Math.min(implicitWidth, notice.maximumWidth - x - 12)
    })
  }
  HoverHandler { id: hover; cursorShape: Qt.PointingHandCursor }
  TapHandler { onTapped: notice.dismissed() }
  Timer {
    id: lifetime
    interval: notice.timeoutMs
    running: notice.timeoutMs > 0 && !hover.hovered
    onTriggered: notice.dismissed()
  }
}
