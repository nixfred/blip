import QtQuick
import QtQuick.Controls
import "ReactionBadges.mjs" as ReactionBadges

// A compact thought balloon. The two dots point outward, so neither the
// emoji nor the tail covers the message text underneath it.
FocusScope {
  id: root
  property var tapbacks: []
  property var stickers: []
  property var files: ({})
  property var metrics: ({})
  property var fetchQueue: []
  property string fetchingId: ""
  property bool mine: false
  property bool playing: true
  property int diameter: 34
  property int glyphSize: 22
  property real maximumWidth: 180
  property color fillColor: "#3c3c40"
  property color borderColor: "#202024"
  property color textColor: "white"
  readonly property var entries: ReactionBadges.badgeEntries(tapbacks, stickers,
    Math.floor((Math.max(diameter, maximumWidth) - 8) / (glyphSize + 4)))
  signal stickerActivated(var attachment)
  signal stickerContextRequested(var attachment)
  implicitWidth: Math.max(diameter, entries.length * glyphSize + Math.max(0, entries.length - 1) * 4 + 12)
  implicitHeight: diameter + 10
  visible: entries.length > 0
  opacity: (tapbacks || []).some(function(t) { return t.pending === true }) ? 0.45 : 1
  Accessible.role: Accessible.StaticText
  Accessible.name: "Reactions"
  Accessible.description: (tapbacks || []).map(function(t) { return String(t.emoji || "") + (t.from_me ? " by you" : t.by ? " by " + String(t.by) : "") }).concat((stickers || []).map(function(s) { return String(s.attachment.sticker && s.attachment.sticker.label || "Sticker reaction") })).join(", ")
  Rectangle {
    x: root.mine ? 3 : root.width - 11
    y: root.diameter - 3
    width: 8; height: width; radius: width / 2
    color: root.fillColor
    border.color: root.borderColor; border.width: 1
  }
  Rectangle {
    x: root.mine ? -1 : root.width - 3
    y: root.diameter + 5
    width: 4; height: width; radius: width / 2
    color: root.fillColor
  }
  Rectangle {
    width: root.width; height: root.diameter
    radius: height / 2
    color: root.fillColor
    border.color: root.borderColor; border.width: 1
    Row {
      anchors.centerIn: parent
      spacing: 4
      Repeater {
        model: root.entries
        delegate: Item {
          required property var modelData
          width: root.glyphSize; height: width
          Text {
            anchors.centerIn: parent
            visible: !modelData.sticker
            text: modelData.count ? "+" + String(modelData.count) : String(modelData.emoji || "")
            textFormat: Text.PlainText
            color: root.textColor
            font.pixelSize: modelData.count ? Math.round(root.glyphSize * 0.65) : root.glyphSize
            font.weight: modelData.count ? Font.DemiBold : Font.Normal
          }
          Loader {
            anchors.fill: parent
            active: !!modelData.sticker
            sourceComponent: StickerImage {
              readonly property var att: modelData.sticker.attachment
              readonly property string attachmentId: String(att.id || "")
              readonly property var metric: root.metrics[attachmentId] || ({})
              attachment: att
              source: root.files[attachmentId] || ""
              loading: attachmentId !== "" && (root.fetchingId === attachmentId || root.fetchQueue.some(function(job) { return job.id === attachmentId }))
              failed: attachmentId === "" || root.files[attachmentId] === ""
              animated: metric.animated === true
              animationUnavailable: metric.animationUnavailable === true
              playing: root.playing
              compact: true
              iconOnly: true
              textColor: root.textColor
              fontSize: 13
              onTapped: root.stickerActivated(att)
              onContextRequested: root.stickerContextRequested(att)
            }
          }
        }
      }
    }
  }
  HoverHandler { id: badgeHover }
  ToolTip {
    id: badgeTip
    visible: badgeHover.hovered
    text: root.Accessible.description
    delay: 450
    contentItem: Text { text: badgeTip.text; textFormat: Text.PlainText; color: root.textColor }
  }
}
