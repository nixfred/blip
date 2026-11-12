import "TapbackActions.mjs" as TapbackActions
import QtQuick
import QtQuick.Controls

// One menu for text bubbles, link previews and attachments. Actions stay in
// BlipView, using the same clipboard, browser, share-sheet and fetch paths as
// before. An attachment (picture or file chip) gets Open / Copy image / Save…
// in place of the text rows; which rows show comes from
// MessageActions.attachmentActions. With
// tapbacks=on, classic tapbacks and the expandable emoji picker lead it:
// 1–6 pick a classic, or Left/Right and Enter/Space choose from the strip.
Menu {
  id: menu
  implicitWidth: 314
  padding: 6
  background: Rectangle {
    color: menu.palette.window
    border.color: Qt.alpha(menu.palette.windowText, 0.25)
    radius: 14
  }
  property string linkUrl: ""
  /** The right-clicked attachment's rows ({open, copy, save, saveLabel}); null = none. */
  property var attachmentRows: null
  readonly property bool attachmentShown: !!menu.attachmentRows && menu.attachmentRows.open === true
  readonly property bool textRowsShown: menu.linkUrl === "" && !menu.attachmentShown
  property bool canReply: false
  property bool canQuote: false
  property bool canCopy: false
  signal replyRequested()
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
    tapbackStrip.reset(menu.keyHints)
    if (menu.tapbacksShown) menu.currentIndex = 0
  }
  onCurrentIndexChanged: if (menu.currentIndex === 0 && menu.tapbacksShown) tapbackStrip.forceActiveFocus()

  ReactionPicker {
    id: tapbackStrip
    visible: menu.tapbacksShown
    focus: menu.tapbacksShown
    activeFocusOnTab: menu.tapbacksShown
    width: menu.availableWidth
    height: visible ? implicitHeight + 4 : 0
    font: menu.font
    palette: menu.palette
    busy: menu.tapbacksBusy
    currentKind: menu.myTapback
    keyHints: menu.keyHints
    onChosen: function(kind) { menu.pickTapback(kind) }
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
    text: "Reply"
    visible: menu.canReply && menu.linkUrl === ""
    height: visible ? implicitHeight : 0
    enabled: visible
    onTriggered: menu.replyRequested()
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
