import QtQuick
import QtQuick.Controls
import "AudioWaveform.mjs" as AudioWaveform

// One parent-owned playing intent selects the active voice message. Each
// item retains its paused position; a conversation reset stops it entirely.
Rectangle {
  id: root
  property var playback: null
  readonly property var player: playback || idle
  QtObject { id: idle; property real position: 0; property real duration: 0; property bool seekable: false; property bool ready: false; property bool decodeFailed: false; property bool actuallyPlaying: false; function seek(ms) {} }
  property url source: ""
  property var waveform: []
  property real durationMs: 0
  property bool playing: false
  property bool loading: false
  property bool failed: false
  property int resetToken: 0
  property bool muted: false
  property bool mine: false
  property color fillColor: mine ? "#0a84ff" : "#34343a"
  property color textColor: "white"
  property string fontFamily: "sans-serif"
  property int fontSize: 12
  readonly property var bars: AudioWaveform.fitWaveform(waveform, Math.max(1, width - 80))
  readonly property real positionMs: player.position
  readonly property real totalDurationMs: player.duration > 0 ? player.duration : durationMs
  readonly property real progress: AudioWaveform.playbackFraction(positionMs, totalDurationMs)
  readonly property bool actuallyPlaying: player.actuallyPlaying
  readonly property bool ready: player.ready
  readonly property bool seekable: player.seekable
  readonly property bool decodeFailed: player.decodeFailed
  readonly property bool controlsFocused: playButton.activeFocus || timeline.activeFocus
  signal toggleRequested()
  signal playbackEnded()
  signal playbackFailed()
  signal contextRequested()
  signal escapeRequested()
  Keys.onEscapePressed: root.escapeRequested()

  implicitWidth: 268
  implicitHeight: 68
  radius: 18
  color: fillColor
  Item {
    id: playButton
    x: 10; y: (root.height - height) / 2
    width: 38; height: 38
    activeFocusOnTab: true
    Accessible.role: Accessible.Button
    Accessible.name: root.loading ? "Loading audio message" : root.failed || root.decodeFailed ? "Retry audio message" : root.playing ? "Pause audio message" : "Play audio message"
    Accessible.description: AudioWaveform.durationLabel(root.totalDurationMs)
    Accessible.onPressAction: root.toggleRequested()
    Rectangle { anchors.fill: parent; radius: width / 2; color: root.textColor; opacity: playButton.activeFocus ? 0.22 : 0.13 }
    // Draw playback symbols geometrically, independent of emoji/font glyphs.
    Canvas {
      id: playSymbol
      anchors.centerIn: parent; width: 20; height: 22
      visible: !root.playing
      onPaint: {
        var c = getContext("2d")
        c.reset(); c.fillStyle = root.textColor
        c.beginPath(); c.moveTo(5, 3); c.lineTo(18, 11); c.lineTo(5, 19); c.closePath(); c.fill()
      }
      Connections { target: root; function onTextColorChanged() { playSymbol.requestPaint() } }
    }
    Row {
      anchors.centerIn: parent; spacing: 4; visible: root.playing
      Rectangle { width: 4; height: 17; radius: 1; color: root.textColor }
      Rectangle { width: 4; height: 17; radius: 1; color: root.textColor }
    }
    TapHandler { onTapped: root.toggleRequested() }
    HoverHandler { cursorShape: Qt.PointingHandCursor }
    Keys.onSpacePressed: root.toggleRequested()
    Keys.onReturnPressed: root.toggleRequested()
    Keys.onEnterPressed: root.toggleRequested()
  }

  Slider {
    id: timeline
    objectName: "audioTimeline"
    x: 58; y: 10
    width: Math.max(24, root.width - x - 14); height: 30
    from: 0; to: Math.max(1, root.totalDurationMs)
    value: root.positionMs
    stepSize: 1000
    enabled: root.seekable && !root.loading && !root.decodeFailed
    activeFocusOnTab: enabled
    Accessible.name: "Audio message position"
    Accessible.description: (root.bars.length === 0 ? "Waveform unavailable. " : "")
      + AudioWaveform.durationLabel(root.positionMs) + " of " + AudioWaveform.durationLabel(root.totalDurationMs)
    onMoved: player.seek(Math.round(value))
    background: Item {
      x: timeline.leftPadding; y: timeline.topPadding
      width: timeline.availableWidth; height: timeline.availableHeight
      Row {
        anchors.fill: parent
        spacing: root.bars.length > 1 ? 2 : 0
        Repeater {
          model: root.bars
          delegate: Rectangle {
            required property int index
            required property real modelData
            width: Math.max(1, (timeline.availableWidth - Math.max(0, root.bars.length - 1) * 2) / Math.max(1, root.bars.length))
            height: Math.max(3, modelData * timeline.availableHeight)
            y: (timeline.availableHeight - height) / 2
            radius: 1.5
            color: root.textColor
            opacity: (index + 0.5) / root.bars.length <= root.progress ? 1 : 0.38
          }
        }
      }
      Rectangle {
        visible: root.bars.length === 0
        anchors.verticalCenter: parent.verticalCenter
        width: parent.width; height: 3; radius: 1.5
        color: root.textColor; opacity: 0.3
      }
      Rectangle {
        visible: root.bars.length === 0
        anchors.verticalCenter: parent.verticalCenter
        width: parent.width * root.progress; height: 3; radius: 1.5
        color: root.textColor
      }
    }
    handle: Rectangle {
      x: timeline.leftPadding + timeline.visualPosition * Math.max(0, timeline.availableWidth - width)
      y: timeline.topPadding - 1
      width: 2; height: timeline.availableHeight + 2; radius: 1
      visible: timeline.pressed || timeline.activeFocus
      color: root.textColor
    }
    Keys.onLeftPressed: player.seek(Math.max(0, player.position - 5000))
    Keys.onRightPressed: player.seek(Math.min(root.totalDurationMs, player.position + 5000))
    Keys.onSpacePressed: root.toggleRequested()
    Keys.onReturnPressed: root.toggleRequested()
    Keys.onEnterPressed: root.toggleRequested()
  }
  Text {
    x: timeline.x + 4; y: 42
    width: timeline.width - 8
    text: root.loading ? "Loading…" : root.failed || root.decodeFailed ? "Audio unavailable · retry"
      : root.totalDurationMs > 0 ? AudioWaveform.durationLabel(Math.max(0, root.totalDurationMs - root.positionMs)) : "Audio message"
    textFormat: Text.PlainText
    color: root.textColor
    opacity: 0.88
    font.family: root.fontFamily
    font.pixelSize: root.fontSize
  }
  TapHandler { acceptedButtons: Qt.RightButton; onTapped: root.contextRequested() }
}
