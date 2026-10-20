import "TapbackActions.mjs" as TapbackActions
import QtQuick
import QtQuick.Controls

// One menu for text bubbles, link previews and attachments. Actions stay in
// BlipView, using the same clipboard, browser, share-sheet and fetch paths as
// before. An attachment (picture or file chip) gets Open / Copy image / Save…
// in place of the text rows; which rows show comes from
// MessageActions.attachmentActions. With
// tapbacks=on, a row of the six classic tapbacks leads it: 1–6 pick one, or
// Left/Right move along the row and Enter/Space pick the marked one.
Menu {
  id: menu
  implicitWidth: 250
  padding: 6
  background: Rectangle {
    color: menu.palette.window
    border.color: Qt.alpha(menu.palette.windowText, 0.25)
    radius: 7
  }
  property string linkUrl: ""
  /** The right-clicked attachment's rows ({open, copy, save, saveLabel}); null = none. */
  property var attachmentRows: null
  readonly property bool attachmentShown: !!menu.attachmentRows && menu.attachmentRows.open === true
  readonly property bool textRowsShown: menu.linkUrl === "" && !menu.attachmentShown
  property bool canQuote: false
  property bool canCopy: false
  signal quoteRequested()
  signal copyRequested()
  signal openRequested(string url)
  signal copyLinkRequested(string url)
  signal shareRequested(string url)
  signal openAttachmentRequested()
  signal copyImageRequested()
  signal saveAttachmentRequested()
  // Tapbacks: shown only for a bubble imsg-react acts on; the one you have is
  // highlighted, and choosing it again takes it back. One at a time.
  property bool tapbacksShown: false
  property bool tapbacksBusy: false
  property string myTapback: ""
  /** Opened from the keyboard (Ctrl+E): each tapback shows its number key. */
  property bool keyHints: false
  signal tapbackRequested(string kind)
  // a click and a key go the same way, through the same busy gate
  function pickTapback(kind) {
    if (menu.tapbacksBusy) return
    menu.tapbackRequested(kind)
    menu.close()
  }
  // The row has the keys when the menu opens, whether by click or Ctrl+E, and
  // is the menu's first item: Down leaves it, Up from "Quote and reply" comes
  // back. Menu gives focus only to a MenuItem it moves to, so the row takes it.
  onOpened: {
    tapbackStrip.cursor = TapbackActions.initialTapbackCursor(menu.myTapback, menu.keyHints)
    if (menu.tapbacksShown) menu.currentIndex = 0
  }
  onCurrentIndexChanged: if (menu.currentIndex === 0 && menu.tapbacksShown) tapbackStrip.forceActiveFocus()

  Item {
    id: tapbackStrip
    visible: menu.tapbacksShown
    focus: menu.tapbacksShown
    // what Menu's Up/Down look for; without it Up stops at the first MenuItem
    activeFocusOnTab: menu.tapbacksShown
    /** The marked tapback, for Left/Right and Enter; -1 for none. */
    property int cursor: -1
    // Up/Down, Esc, and Enter with nothing marked are left unaccepted: they stay the menu's
    Keys.onPressed: function(event) {
      if (event.modifiers & (Qt.ControlModifier | Qt.AltModifier | Qt.MetaModifier)) return
      if (event.key === Qt.Key_Left || event.key === Qt.Key_Right) {
        event.accepted = true
        tapbackStrip.cursor = TapbackActions.moveTapbackCursor(tapbackStrip.cursor, event.key === Qt.Key_Right ? 1 : -1)
        return
      }
      var marked = tapbackStrip.cursor >= 0 && (event.key === Qt.Key_Return || event.key === Qt.Key_Enter || event.key === Qt.Key_Space)
      var kind = marked ? TapbackActions.TAPBACKS[tapbackStrip.cursor].kind : TapbackActions.tapbackForKey(event.text)
      if (kind === "") return
      event.accepted = true
      menu.pickTapback(kind)
    }
    width: menu.availableWidth
    height: visible ? tapbackRow.implicitHeight + 4 : 0
    Row {
      id: tapbackRow
      anchors.centerIn: parent
      spacing: 2
      Repeater {
        model: TapbackActions.TAPBACKS
        delegate: Rectangle {
          id: tapbackCell
          required property var modelData
          required property int index
          readonly property bool current: modelData.kind === menu.myTapback
          readonly property bool marked: tapbackStrip.activeFocus && tapbackStrip.cursor === index
          width: 36
          height: 32
          radius: 6
          color: current ? Qt.alpha(menu.palette.highlight, 0.45)
            : hover.hovered && !menu.tapbacksBusy ? Qt.alpha(menu.palette.windowText, 0.12) : "transparent"
          border.width: marked ? 2 : 0
          border.color: menu.palette.highlight
          opacity: menu.tapbacksBusy ? 0.35 : 1
          Accessible.role: Accessible.Button
          Accessible.name: (current ? "Remove " : "") + modelData.kind
          Text {
            anchors.centerIn: parent
            text: tapbackCell.modelData.emoji
            textFormat: Text.PlainText
            font.pixelSize: menu.font.pixelSize + 5
          }
          Text {
            visible: menu.keyHints
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            anchors.rightMargin: 2
            text: String(index + 1)
            textFormat: Text.PlainText
            font.pixelSize: Math.max(8, menu.font.pixelSize - 4)
            color: Qt.alpha(menu.palette.windowText, 0.6)
          }
          HoverHandler { id: hover }
          TapHandler {
            enabled: !menu.tapbacksBusy
            onTapped: menu.pickTapback(tapbackCell.modelData.kind)
          }
        }
      }
    }
  }
  MenuSeparator {
    visible: menu.tapbacksShown
    height: visible ? implicitHeight : 0
  }

  MenuItem {
    text: "Open"
    visible: menu.attachmentShown
    enabled: visible
    height: visible ? implicitHeight : 0
    onTriggered: menu.openAttachmentRequested()
  }
  MenuItem {
    text: "Copy image"
    visible: menu.attachmentShown && menu.attachmentRows.copy === true
    enabled: visible
    height: visible ? implicitHeight : 0
    onTriggered: menu.copyImageRequested()
  }
  MenuItem {
    text: menu.attachmentShown ? String(menu.attachmentRows.saveLabel || "Save…") : "Save…"
    visible: menu.attachmentShown && menu.attachmentRows.save === true
    enabled: visible
    height: visible ? implicitHeight : 0
    onTriggered: menu.saveAttachmentRequested()
  }
  MenuItem {
    text: "Quote and reply"
    visible: menu.textRowsShown
    height: visible ? implicitHeight : 0
    enabled: visible && menu.canQuote
    onTriggered: menu.quoteRequested()
  }
  MenuItem {
    text: "Copy message"
    visible: menu.textRowsShown
    height: visible ? implicitHeight : 0
    enabled: visible && menu.canCopy
    onTriggered: menu.copyRequested()
  }
  MenuItem {
    text: "Open in browser"
    visible: menu.linkUrl !== ""
    enabled: visible
    height: visible ? implicitHeight : 0
    onTriggered: menu.openRequested(menu.linkUrl)
  }
  MenuItem {
    text: "Copy link"
    visible: menu.linkUrl !== ""
    enabled: visible
    height: visible ? implicitHeight : 0
    onTriggered: menu.copyLinkRequested(menu.linkUrl)
  }
  MenuItem {
    text: "Share link…"
    visible: menu.linkUrl !== ""
    enabled: visible
    height: visible ? implicitHeight : 0
    onTriggered: menu.shareRequested(menu.linkUrl)
  }
}
