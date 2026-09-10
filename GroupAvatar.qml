import QtQuick
import QtQuick.Effects
import "GroupAvatar.mjs" as AvatarModel

// Custom group photos are rendered by the caller. This is the fallback only.
Item {
  id: root
  property var participants: []
  property var avatarFiles: ({})
  property color foreground: "white"
  property string fontFamily: "sans-serif"
  readonly property var members: AvatarModel.members(Array.from(participants))
  signal requestAvatar(string handle)

  Repeater {
    model: root.members
    delegate: Rectangle {
      required property var modelData
      x: modelData.x * root.width
      y: modelData.y * root.height
      width: modelData.size * root.width
      height: width
      radius: width / 2
      color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.18)
      Component.onCompleted: root.requestAvatar(modelData.handle)
      Image {
        id: photo
        anchors.fill: parent
        visible: false
        source: root.avatarFiles[modelData.handle] || ""
        asynchronous: true
        autoTransform: true
        fillMode: Image.PreserveAspectCrop
        sourceSize: Qt.size(128,128)
      }
      Item {
        id: mask
        anchors.fill: parent
        visible: false
        layer.enabled: true
        Rectangle { anchors.fill: parent; radius: width / 2 }
      }
      MultiEffect {
        anchors.fill: parent
        source: photo
        visible: photo.status === Image.Ready
        maskEnabled: true
        maskSource: mask
      }
      Text {
        anchors.centerIn: parent
        visible: photo.status !== Image.Ready
        text: modelData.initials
        textFormat: Text.PlainText
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: parent.width * .36
        font.bold: true
      }
    }
  }
}
