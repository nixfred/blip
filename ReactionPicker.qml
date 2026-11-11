import QtQuick
import QtQuick.Controls
import "TapbackActions.mjs" as TapbackActions

// Reusable picker: reactions emit a kind, composer insertion emits the glyph.
// Search/category/identity policy lives in tapback-actions.ts. GridView only
// instantiates visible cells, even with the complete Unicode catalogue open.
Control {
  id: picker
  objectName: "blipReactionPicker"
  implicitWidth: 302
  implicitHeight: column.implicitHeight
  padding: 0
  property bool expanded: false
  property bool showClassics: true
  property bool busy: false
  property string currentKind: ""
  property bool keyHints: false
  property int cursor: -1
  signal chosen(string kind)
  signal emojiChosen(string emoji)
  function choose(kind) {
    if (picker.busy) return
    var emoji = TapbackActions.reactionEmoji(kind)
    if (!emoji) return
    picker.chosen(kind)
    picker.emojiChosen(emoji)
  }
  function reset(keyboard) {
    expanded = !showClassics
    search.text = ""
    categories.currentIndex = 0
    cursor = TapbackActions.initialTapbackCursor(currentKind, keyboard)
  }
  Keys.onPressed: function(event) {
    if (search.activeFocus || grid.activeFocus || categories.activeFocus) return
    if (event.modifiers & (Qt.ControlModifier | Qt.AltModifier | Qt.MetaModifier)) return
    if (event.key === Qt.Key_Left || event.key === Qt.Key_Right) {
      cursor = TapbackActions.moveTapbackCursor(cursor, event.key === Qt.Key_Right ? 1 : -1, 7)
      event.accepted = true
      return
    }
    var marked = cursor >= 0 && (event.key === Qt.Key_Return || event.key === Qt.Key_Enter || event.key === Qt.Key_Space)
    if (marked && cursor === 6) {
      expanded = !expanded
      if (expanded) search.forceActiveFocus()
      event.accepted = true
      return
    }
    var kind = marked ? TapbackActions.TAPBACKS[cursor].kind : TapbackActions.tapbackForKey(event.text)
    if (kind) { event.accepted = true; choose(kind) }
  }
  contentItem: Column {
    id: column
    spacing: 8
    Row {
      visible: picker.showClassics
      width: parent.width
      height: visible ? 44 : 0
      spacing: 2
      Repeater {
        model: 7
        delegate: ToolButton {
          id: classic
          required property int index
          readonly property bool more: index === 6
          readonly property var entry: more ? null : TapbackActions.TAPBACKS[index]
          readonly property bool selected: !more && picker.currentKind === entry.kind
          width: (column.width - 12) / 7
          height: 44
          enabled: !picker.busy
          hoverEnabled: true
          Accessible.name: more ? "More emoji" : (selected ? "Remove " : "React with ") + entry.kind
          ToolTip.visible: hovered
          ToolTip.text: Accessible.name
          background: Rectangle {
            radius: width / 2
            color: classic.selected ? Qt.alpha(picker.palette.highlight, 0.3)
              : classic.hovered || (classic.more && picker.expanded) ? Qt.alpha(picker.palette.windowText, 0.10) : "transparent"
            border.width: picker.activeFocus && picker.cursor === classic.index ? 2 : 0
            border.color: picker.palette.highlight
          }
          contentItem: Text {
            text: classic.more ? "⊕" : classic.entry.emoji
            textFormat: Text.PlainText
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
            font.pixelSize: classic.more ? 27 : 25
            color: picker.palette.windowText
            opacity: picker.busy ? 0.4 : 1
          }
          Text {
            visible: picker.keyHints && !classic.more
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            text: String(classic.index + 1)
            textFormat: Text.PlainText
            font.pixelSize: 9
            color: picker.palette.windowText
          }
          onClicked: {
            if (more) { picker.expanded = !picker.expanded; if (picker.expanded) search.forceActiveFocus() }
            else picker.choose(entry.kind)
          }
        }
      }
    }
    Column {
      width: parent.width
      visible: picker.expanded
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
        model: TapbackActions.EMOJI_GROUPS
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
        model: picker.expanded ? TapbackActions.searchReactionEmoji(search.text, categories.currentText || "All") : []
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
      Text {
        visible: picker.showClassics
        width: parent.width
        text: "Custom reactions depend on the Mac’s available emoji."
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        color: Qt.alpha(picker.palette.windowText, 0.65)
        font.pixelSize: Math.max(10, picker.font.pixelSize - 2)
      }
    }
  }
}
