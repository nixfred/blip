import QtQuick

// Presentation only. Attribution, animation detection, and geometry come
// from TypeScript; the parent owns fetching and conversation positioning.
Item {
  id: root
  property var attachment: ({})
  property url source: ""
  property bool loading: false
  property bool failed: false
  property bool animated: false
  property bool animationUnavailable: false
  property bool playing: true
  property bool compact: false
  property bool iconOnly: false
  property color textColor: "#8e8e93"
  property int fontSize: 12
  readonly property bool ready: animated ? motion.status === Image.Ready : still.status === Image.Ready
  readonly property bool decodeFailed: animated ? motion.status === Image.Error : still.status === Image.Error
  readonly property real paintedWidth: animated ? motion.paintedWidth : still.paintedWidth
  readonly property real paintedHeight: animated ? motion.paintedHeight : still.paintedHeight
  readonly property int currentFrame: motion.currentFrame
  readonly property int frameCount: motion.frameCount
  signal tapped()
  signal contextRequested()

  implicitWidth: compact ? 48 : 160
  implicitHeight: compact ? 48 : 160
  activeFocusOnTab: true
  Accessible.role: Accessible.Button
  Accessible.name: String(attachment.sticker && attachment.sticker.label || "Sticker")
  Accessible.description: failed || decodeFailed ? "Unavailable. Activate to retry."
    : animationUnavailable ? "Static preview; animation unavailable. Open sticker." : "Open sticker"
  Accessible.onPressAction: tapped()

  Image {
    id: still
    anchors.fill: parent
    source: !root.animated ? root.source : ""
    visible: !root.animated
    asynchronous: true
    autoTransform: true
    fillMode: Image.PreserveAspectFit
    sourceSize.width: 640
    sourceSize.height: 640
    smooth: true
    mipmap: true
  }
  AnimatedImage {
    id: motion
    anchors.fill: parent
    source: root.animated ? root.source : ""
    visible: root.animated
    playing: root.playing && root.visible && root.animated
    asynchronous: true
    autoTransform: true
    fillMode: Image.PreserveAspectFit
    // AnimatedImage.sourceSize was read-only in Qt 6.4. A static assignment
    // prevents the whole component from loading there. Newer Qt can bound
    // decoder output; older Qt still receives validated <=2048px rasters.
    Component.onCompleted: {
      try { motion.sourceSize = Qt.size(640, 640) } catch (error) { }
    }
    cache: false
    smooth: true
  }
  Text {
    anchors.centerIn: parent
    width: parent.width
    visible: !root.ready
    text: root.iconOnly ? (root.loading ? "…" : root.failed || root.decodeFailed ? "!" : "◇")
      : root.loading ? "Loading…" : root.failed || root.decodeFailed ? "Sticker unavailable" : "Sticker"
    textFormat: Text.PlainText
    horizontalAlignment: Text.AlignHCenter
    wrapMode: Text.Wrap
    color: root.textColor
    font.pixelSize: root.fontSize
  }
  Rectangle {
    anchors.fill: parent
    visible: root.activeFocus
    color: "transparent"
    border.color: root.textColor
    border.width: 1
    radius: 6
  }
  TapHandler { onTapped: root.tapped() }
  TapHandler {
    acceptedButtons: Qt.RightButton
    onTapped: root.contextRequested()
  }
  Keys.onReturnPressed: tapped()
  Keys.onEnterPressed: tapped()
  Keys.onMenuPressed: contextRequested()
}
