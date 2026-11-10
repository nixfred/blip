import QtQuick
import "Stickers.mjs" as Stickers

// Position only when the bridge supplied a body-part mapping we understand.
// Unknown placements stay in a separate attachment strip in BlipView.
Item {
  id: root
  property var stickers: []
  property var files: ({})
  property var metrics: ({})
  property bool playing: true
  property string fetchingId: ""
  property var fetchQueue: []
  property color textColor: "#8e8e93"
  signal openRequested(var attachment)
  signal contextRequested(var attachment)
  Repeater {
    model: root.stickers
    delegate: StickerImage {
      required property var modelData
      readonly property string attachmentId: String(modelData.attachment.id || "")
      readonly property var metric: root.metrics[attachmentId] || ({})
      readonly property var geometry: Stickers.stickerGeometry(modelData.placement, root.width, root.height, Number(metric.pixelWidth || 64), Number(metric.pixelHeight || 64))
      x: geometry.x; y: geometry.y
      width: geometry.width; height: geometry.height
      rotation: geometry.rotation
      z: 2
      attachment: modelData.attachment
      source: root.files[attachmentId] || ""
      loading: attachmentId !== "" && (root.fetchingId === attachmentId || root.fetchQueue.some(function(job) { return job.id === attachmentId }))
      failed: attachmentId === "" || root.files[attachmentId] === ""
      animated: metric.animated === true
      animationUnavailable: metric.animationUnavailable === true
      playing: root.playing
      compact: true
      textColor: root.textColor
      onTapped: root.openRequested(modelData.attachment)
      onContextRequested: root.contextRequested(modelData.attachment)
    }
  }
}
