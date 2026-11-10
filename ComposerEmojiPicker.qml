import QtQuick
import QtQuick.Controls
import "EmojiPicker.mjs" as EmojiPicker

// Reusable picker: reactions emit a kind, composer insertion emits the glyph.
// Search/category/identity policy lives in tapback-actions.ts. GridView only
// instantiates visible cells, even with the complete Unicode catalogue open.
Control {
  id: picker
  objectName: "blipReactionPicker"
  implicitWidth: 302
  implicitHeight: column.implicitHeight
  padding: 0
  property bool busy: false
  property string currentKind: ""
  signal emojiChosen(string emoji)
  function choose(kind) {
    if (!picker.busy && kind.indexOf("emoji:") === 0) picker.emojiChosen(kind.slice(6))
  }
  contentItem: Column {
    id: column
    spacing: 8
    Column {
      width: parent.width
      visible: true
      height: visible ? implicitHeight : 0
      spacing: 8
      TextField {
        id: search
        objectName: "reactionEmojiSearch"
        width: parent.width
        placeholderText: "Search or paste an emoji"
        font: picker.font
        palette: picker.palette
        color: picker.palette.windowText
        placeholderTextColor: Qt.alpha(picker.palette.windowText, 0.45)
        background: Rectangle {
          radius: 8
          color: Qt.alpha(picker.palette.windowText, 0.06)
          border.width: 1
          border.color: search.activeFocus ? picker.palette.highlight : Qt.alpha(picker.palette.windowText, 0.12)
        }
        maximumLength: 160
        selectByMouse: true
        Accessible.name: "Search emoji"
        Keys.onDownPressed: { grid.currentIndex = 0; grid.forceActiveFocus() }
        onAccepted: if (grid.count > 0) picker.choose(grid.model[0].kind)
        onTextChanged: grid.currentIndex = -1
      }
      ComboBox {
        id: categories
        width: parent.width
        model: EmojiPicker.EMOJI_GROUPS
        font: picker.font
        palette.buttonText: picker.palette.windowText
        palette.button: picker.palette.window
        palette.text: picker.palette.windowText
        palette.base: picker.palette.window
        palette.window: picker.palette.window
        palette.highlight: picker.palette.highlight
        background: Rectangle {
          radius: 8
          color: Qt.alpha(picker.palette.windowText, 0.06)
          border.color: Qt.alpha(picker.palette.windowText, 0.12)
        }
        Accessible.name: "Emoji category"
      }
      GridView {
        id: grid
        objectName: "reactionEmojiGrid"
        width: parent.width
        height: 220
        clip: true
        cellWidth: width / 7
        cellHeight: 42
        model: EmojiPicker.searchReactionEmoji(search.text, categories.currentText || "All")
        currentIndex: -1
        keyNavigationEnabled: true
        boundsBehavior: Flickable.StopAtBounds
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
        Keys.onReturnPressed: if (currentIndex >= 0) picker.choose(model[currentIndex].kind)
        Keys.onEnterPressed: if (currentIndex >= 0) picker.choose(model[currentIndex].kind)
        Keys.onEscapePressed: search.forceActiveFocus()
        delegate: ToolButton {
          required property var modelData
          required property int index
          width: grid.cellWidth
          height: grid.cellHeight
          enabled: !picker.busy
          hoverEnabled: true
          Accessible.name: modelData.name
          ToolTip.visible: hovered
          ToolTip.text: modelData.name
          background: Rectangle {
            radius: 8
            color: parent.modelData.kind === picker.currentKind ? Qt.alpha(picker.palette.highlight, 0.3)
              : parent.hovered ? Qt.alpha(picker.palette.windowText, 0.10) : "transparent"
            border.width: grid.activeFocus && grid.currentIndex === parent.index ? 2 : 0
            border.color: picker.palette.highlight
          }
          contentItem: Text {
            text: parent.modelData.emoji
            textFormat: Text.PlainText
            font.pixelSize: 25
            color: picker.palette.windowText
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
          }
          onClicked: picker.choose(modelData.kind)
        }
        Text {
          anchors.centerIn: parent
          visible: grid.count === 0
          text: "No matching emoji"
          textFormat: Text.PlainText
          color: picker.palette.windowText
          font: picker.font
        }
      }

    }
  }
}
