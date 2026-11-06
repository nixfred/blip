import "ConversationAppearance.mjs" as ConversationAppearance
import QtQuick
import QtQuick.Effects

// Shared circular profile rendering. The identity is the conversation for
// groups, never whichever participant happened to speak last.
Rectangle {
  id: root
  property var thread: null
  property var avatarFiles: ({})
  property color foreground: "white"
  property string fontFamily: "sans-serif"
  readonly property string chat: thread ? String(thread.chat || "") : ""
  readonly property bool group: chat !== "" && !/^\+?[0-9]{3,15}$/.test(chat) && chat.indexOf("@") < 0
  readonly property string handle: group ? chat : (thread ? String(thread.handle || chat) : "")
  signal requestAvatar(string handle)
  onHandleChanged: if (handle !== "") requestAvatar(handle)
  Component.onCompleted: if (handle !== "") requestAvatar(handle)
  radius: width / 2
  color: Qt.alpha(foreground, 0.16)
  Image {
    id: photo
    anchors.fill: parent
    visible: false
    source: root.avatarFiles[root.handle] || ""
    asynchronous: true
    fillMode: Image.PreserveAspectCrop
    autoTransform: true
    sourceSize: Qt.size(128, 128)
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
  Loader {
    anchors.fill: parent
    active: root.group && photo.status !== Image.Ready && (root.thread.participants || []).length > 0
    sourceComponent: GroupAvatar {
      participants: root.thread.participants || []
      avatarFiles: root.avatarFiles
      foreground: root.foreground
      fontFamily: root.fontFamily
      onRequestAvatar: function(handle) { root.requestAvatar(handle) }
    }
  }
  Text {
    anchors.centerIn: parent
    visible: photo.status !== Image.Ready && (!root.group || (root.thread.participants || []).length === 0)
    text: ConversationAppearance.conversationInitials(root.thread)
    textFormat: Text.PlainText
    color: root.foreground
    font.family: root.fontFamily
    font.pixelSize: Math.max(12, root.width * 0.34)
    font.weight: Font.DemiBold
  }
}
