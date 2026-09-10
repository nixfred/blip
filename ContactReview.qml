import QtQuick
import QtQuick.Controls as QQC
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// A conversation tool. The helper supplies validated display rows; this view
// holds only session state and never changes preferences or contact cards.
FocusScope {
  id: root
  property bool opened: false
  property var threads: []
  property color foreground: Color.foreground
  property color accent: "#0a84ff"
  property string fontFamily: Style.font.family
  property int fontSize: Style.font.bodySmall
  property var model: null
  property var overview: null
  property string error: ""
  property string notice: ""
  property bool busy: false
  property var scanConversations: []
  property var selectedCard: null
  visible: opened
  readonly property string helper: decodeURIComponent(Qt.resolvedUrl("contact-review.ts").toString().replace(/^file:\/\//, ""))
  signal closed()
  signal copyRequested(string text)

  function close() { selectedCard = null; opened = false; closed() }
  function textField(value, maximum) { return typeof value === "string" ? value.slice(0, maximum) : "" }
  function metadata(thread) {
    return { chat: textField(thread.chat, 320), name: textField(thread.name, 160) }
  }
  function review(thread) {
    if (busy) return
    var data = metadata(thread)
    var people = Array.isArray(thread.participants) ? thread.participants.slice(0, 64) : []
    data.participants = people.map(function(person) {
      return typeof person === "string" ? textField(person, 320)
        : { handle: textField(person.handle, 320), name: textField(person.name, 160) }
    })
    model = null; overview = null; opened = true
    request("review", { conversation: data })
    forceActiveFocus()
  }
  function scan(page) {
    if (busy) return
    if (threads.length > 1000) { error = "Too many conversations to scan at once"; return }
    overview = null
    if (page === undefined) {
      page = 0
      scanConversations = threads.map(function(thread) {
        return {chat: textField(thread.chat, 320), participants: (thread.participants || []).slice(0, 64).map(function(p) {
          return {handle: textField(typeof p === "string" ? p : p.handle, 320)}
        })}
      })
    }
    request("audit", {conversations: scanConversations, page: page})
  }
  function back() {
    if (selectedCard) { selectedCard = null; return }
    if (busy) return
    if (overview) { model = overview; overview = null; error = ""; notice = "" }
    else close()
  }
  function request(operation, payload) {
    if (busy) return
    var encoded = JSON.stringify(payload)
    error = ""; notice = ""
    if (encoded.length > (operation === "audit" ? 4194304 : 49152)) { error = "Too many contacts in this request"; return }
    worker.received = false
    worker.command = ["bun", helper, operation]
    busy = true
    worker.stdinEnabled = true
    worker.running = true
    worker.write(encoded)
    worker.stdinEnabled = false
  }
  function validText(value, maximum) {
    return typeof value === "string" && value.length <= maximum
      && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value)
  }
  function consume(text) {
    worker.received = true
    if (!opened) return
    if (text.length > 49152) { error = "Contact response is too large"; return }
    try {
      var result = JSON.parse(text)
      if (!result || result.ok !== true) {
        error = result && validText(result.error, 180) ? result.error : "Contact review failed"
        return
      }
      if (["people", "cards", "scan", "opened"].indexOf(result.view) < 0
          || !validText(result.title, 160) || !validText(result.detail, 480)
          || !Array.isArray(result.rows) || result.rows.length > 200) throw "schema"
      if (result.view === "scan" && (!Number.isInteger(result.page) || !Number.isInteger(result.pageCount)
          || result.page < 0 || result.pageCount < 1 || result.pageCount > 250 || result.page >= result.pageCount)) throw "page"
      for (var i = 0; i < result.rows.length; i++) {
        var row = result.rows[i]
        if (!row || !validText(row.name, 320) || !validText(row.detail, 480)
            || !validText(row.handle, 320) || ["candidates", "open"].indexOf(row.action) < 0
            || typeof row.token !== "string" || (row.action === "open"
              ? !/^sha256:[0-9a-f]{64}$/.test(row.token) : row.token !== "")) throw "row"
      }
      if (result.view === "opened") notice = result.detail
      else { model = result; reviewFlick.contentY = 0 }
    } catch (e) { error = "Contact review returned an invalid response" }
  }
  Keys.onEscapePressed: back()

  Process {
    id: worker
    property bool received: false
    stdout: StdioCollector { onStreamFinished: root.consume(text.trim()) }
    onRunningChanged: if (!running) Qt.callLater(function() {
      root.busy = false
      if (!worker.received) root.error = "Could not start contact review"
    })
  }

  Loader {
    anchors.fill: parent
    active: root.selectedCard !== null
    sourceComponent: ContactDetails {
      card: root.selectedCard
      foreground: root.foreground; accent: root.accent; fontFamily: root.fontFamily; fontSize: root.fontSize
      onClosed: root.selectedCard = null
      onCopyRequested: function(text) { root.copyRequested(text) }
      onOpenOnMac: {
        var card = root.selectedCard
        root.selectedCard = null
        root.request("open", {handle: card.handle, token: card.token})
      }
    }
  }
  ColumnLayout {
    visible: root.selectedCard === null
    anchors.fill: parent
    spacing: Style.space(10)
    RowLayout {
      Layout.fillWidth: true
      PanelActionButton {
        iconText: "←"; tooltipText: "Back"; enabled: !root.busy; focusable: true
        foreground: root.foreground; hoverColor: root.accent
        onClicked: root.back()
      }
      Text {
        Layout.fillWidth: true
        text: root.model ? root.model.title : "Contact review"
        textFormat: Text.PlainText; color: root.foreground
        font.family: root.fontFamily; font.pixelSize: root.fontSize + 2; font.bold: true
        elide: Text.ElideRight
      }

    }
    Text {
      Layout.fillWidth: true
      text: "Matching cards from Mac Contacts."
      textFormat: Text.PlainText; wrapMode: Text.WordWrap
      color: Qt.darker(root.foreground, 1.4)
      font.family: root.fontFamily; font.pixelSize: root.fontSize
    }
    Text {
      Layout.fillWidth: true
      text: root.busy ? "Checking Mac Contacts…" : root.error || root.notice || (root.model ? root.model.detail : "")
      textFormat: Text.PlainText; wrapMode: Text.WordWrap
      color: root.error !== "" ? Color.urgent : root.foreground
      font.family: root.fontFamily; font.pixelSize: root.fontSize
    }
    PanelSeparator { Layout.fillWidth: true; foreground: root.foreground }
    Flickable {
      id: reviewFlick
      Layout.fillWidth: true; Layout.fillHeight: true
      contentWidth: width; contentHeight: rows.implicitHeight
      clip: true; boundsBehavior: Flickable.StopAtBounds
      QQC.ScrollBar.vertical: QQC.ScrollBar { }
      ColumnLayout {
        id: rows
        width: parent.width
        spacing: Style.space(12)
        Text {
          Layout.fillWidth: true
          visible: !root.busy && root.error === "" && root.model !== null && root.model.rows.length === 0
          text: root.model && root.model.view === "cards" ? "No matching contact cards found."
            : root.model && root.model.view === "scan" ? "No duplicate candidates or name conflicts found." : ""
          textFormat: Text.PlainText; wrapMode: Text.WordWrap
          color: root.foreground; font.family: root.fontFamily; font.pixelSize: root.fontSize
        }
        Repeater {
          model: root.model ? root.model.rows : []
          delegate: Rectangle {
            required property var modelData
            Layout.fillWidth: true
            implicitHeight: card.implicitHeight + Style.space(20)
            radius: Style.cornerRadius
            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.06)
            ColumnLayout {
              id: card
              anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top
              anchors.margins: Style.space(10)
              spacing: Style.space(4)
              Text {
                Layout.fillWidth: true; text: modelData.name; textFormat: Text.PlainText
                wrapMode: Text.WordWrap; color: root.foreground
                font.family: root.fontFamily; font.pixelSize: root.fontSize; font.bold: true
              }
              Text {
                Layout.fillWidth: true; text: modelData.detail; textFormat: Text.PlainText
                wrapMode: Text.WordWrap; color: Qt.darker(root.foreground, 1.3)
                font.family: root.fontFamily; font.pixelSize: root.fontSize
              }
              ContactButton {
                Layout.fillWidth: true
                visible: modelData.action === "open"
                text: "View details"
                enabled: !root.busy
                foreground: root.foreground; accent: root.accent; fontFamily: root.fontFamily; fontSize: root.fontSize
                onClicked: root.selectedCard = modelData
              }
              ContactButton {
                Layout.fillWidth: true
                foreground: root.foreground; accent: root.accent
                fontFamily: root.fontFamily; fontSize: root.fontSize
                enabled: !root.busy
                text: modelData.action === "open" ? "Open on Mac ↗" : "Review"
                onClicked: {
                  if (modelData.action === "candidates" && root.model.view !== "cards") root.overview = root.model
                  root.request(modelData.action, { handle: modelData.handle, token: modelData.token })
                }
              }
            }
          }
        }
      }
    }
    RowLayout {
      Layout.fillWidth: true
      visible: root.model !== null && root.model.view === "scan" && root.model.pageCount > 1
      ContactButton {
        text: "Previous"; enabled: !root.busy && root.model && root.model.page > 0
        foreground: root.foreground; accent: root.accent; fontFamily: root.fontFamily; fontSize: root.fontSize
        onClicked: root.scan(root.model.page - 1)
      }
      Text {
        Layout.fillWidth: true; horizontalAlignment: Text.AlignHCenter
        text: root.model ? (root.model.page + 1) + " / " + root.model.pageCount : ""
        color: root.foreground; font.family: root.fontFamily; font.pixelSize: root.fontSize; textFormat: Text.PlainText
      }
      ContactButton {
        text: "Next"; enabled: !root.busy && root.model && root.model.page + 1 < root.model.pageCount
        foreground: root.foreground; accent: root.accent; fontFamily: root.fontFamily; fontSize: root.fontSize
        onClicked: root.scan(root.model.page + 1)
      }
    }
    ContactButton {
      Layout.fillWidth: true
      text: "Scan contacts"
      enabled: !root.busy
      foreground: root.foreground; accent: root.accent
      fontFamily: root.fontFamily; fontSize: root.fontSize
      onClicked: root.scan()
    }

  }
}
