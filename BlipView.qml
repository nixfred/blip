import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import QtQuick.Effects
import qs.Commons
import qs.Ui

// Blip panel — threads, then an iMessage-style conversation with a compose box.
//
//   list         → every thread, newest first, unread marked
//   conversation → bubbles: mine blue on the right, theirs grey on the left,
//                  grouped by sender with one timestamp per run, day dividers,
//                  compose box pinned at the bottom. Esc goes back.
//
// Reads its thread list from the host widget so there is exactly one poller.
// Bubble decoration (grouping, day labels, times) is computed in thread.ts,
// where it is unit-tested; this file only renders.
FocusScope {
  id: root

  // ---- host contract (docs/app-design-review.md) ----------------------
  property var hostWidget: null
  /** Qt format strings, owned by the host widget (see BarWidget). Empty when no host is
   *  attached or the host has none, which thread.ts and Qt both read as "use the defaults". */
  readonly property string timeFormat: (hostWidget && hostWidget.timeFormat) || ""
  readonly property string dateFormat: (hostWidget && hostWidget.dateFormat) || ""
  readonly property string dateFormatWithYear: (hostWidget && hostWidget.dateFormatWithYear) || ""
  /** The surface hosting this view is showing (popout: opened; window:
   *  visible). Gates reads, reloads, and autofocus — a hidden surface must
   *  never mark anything read. */
  property bool surfaceOpen: false
  // The window may be visible but unfocused / on another workspace: it still
  // renders and refreshes, but must not mark conversations read (war room #25).
  property bool readActive: true
  property color foreground: Color.foreground
  property color urgent: Color.urgent
  /** The theme's font, injected by whichever surface hosts this view. */
  property string themeFont: Style.font.family
  /**
   * The font Messages actually uses, when this machine has it.
   *
   * Omarchy resolves its family to JetBrainsMono system-wide, so every label
   * here was monospace — the loudest remaining difference from Messages, more
   * than any spacing. Apple ships SF Pro Text with Messages; a machine themed
   * to look like a Mac usually already has it, and Qt.fontFamilies() says so
   * for certain rather than guessing (asking for a missing family silently
   * yields a default sans, which would be a worse wrong answer than the
   * theme font).
   * Order: SF Pro if the machine has it, then Inter — which is OFL-licensed,
   * ships in Arch's `extra`, and was drawn for exactly this job — then the
   * theme font, so nothing changes for anyone who has installed neither.
   * `ui_font=theme` in bridge.conf opts out.
   *
   * Blip will never SHIP a font: SF Pro is Apple's and its licence forbids
   * redistribution, which is why blip-setup installs Inter and only points at
   * Apple's own download for SF Pro.
   */
  readonly property string messagesFont: {
    var want = ["SF Pro Text", "SF Pro Display", "SF Pro", "Inter"]
    var have = Qt.fontFamilies()
    for (var i = 0; i < want.length; i++) if (have.indexOf(want[i]) >= 0) return want[i]
    return ""
  }
  readonly property bool themeFontForced: !!hostWidget && hostWidget.uiFontTheme === true
  readonly property string fontFamily:
    (messagesFont !== "" && !themeFontForced) ? messagesFont : themeFont
  // `ui_font_size=N` in bridge.conf: N is bubble text in px. Unset (0) keeps
  // Omarchy's tokens. Caption/body keep the same ratios as Style.font.
  readonly property int uiFontSizePx: {
    if (!hostWidget) return 0
    var n = hostWidget.uiFontSize
    return (typeof n === "number" && n > 0) ? n : 0
  }
  readonly property real uiFontScale: {
    if (uiFontSizePx <= 0) return 1
    var small = Style.font.bodySmall
    return small > 0 ? uiFontSizePx / small : 1
  }
  readonly property int fontCaption: Math.max(1, Math.round(Style.font.caption * uiFontScale))
  readonly property int fontBodySmall: Math.max(1, Math.round(Style.font.bodySmall * uiFontScale))
  readonly property int fontBody: Math.max(1, Math.round(Style.font.body * uiFontScale))
  readonly property color dim: Qt.darker(foreground, 1.45)
  /** An editor owns the keyboard — the host's key catcher must stand down. */
  readonly property bool editorActive:
    composeField.activeFocus || searchField.activeFocus || newField.activeFocus || bubbleFocused
  readonly property alias composeEditor: composeField
  readonly property real contentHeightHint: listContent.implicitHeight
  /** The view wants keyboard navigation focus back (list mode). */
  signal navigationFocusRequested()
  // Foreground and background follow the Omarchy theme (Color.* is the live
  // theme singleton and hot-reloads on switch). The ACCENT does not: it is
  // iMessage blue, always. Bubbles followed the theme accent until 2.3.3, and
  // on the themes where that accent is red "my" messages read as errors;
  // Fred, 2026-09-04: "Yes make the bubbles blue too" — blue bubbles are the
  // look, not a theme preference. White text on that blue, as Messages does.
  readonly property color accent: "#0a84ff"
  readonly property color cyan: accent            // legacy name; accents/links
  readonly property color okColor: accent

  readonly property color mineFill: accent
  readonly property color mineText: "#ffffff"
  readonly property color theirsFill: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.14)
  readonly property color theirsText: foreground

  // Links inside a bubble take the bubble's readable text color instead of
  // Qt's default theme blue, which is illegible on the accent fill.
  function richMessageHtml(html, linkColor) {
    var color = String(linkColor || "").toLowerCase()
    if (!/^#[0-9a-f]{6}$/.test(color)) color = "#ffffff"
    return String(html || "").replace(
      /<a href=/g,
      '<a style="color: ' + color + '; text-decoration: underline;" href='
    )
  }

  readonly property string home: Quickshell.env("HOME")
  readonly property string threadScript:
    decodeURIComponent(Qt.resolvedUrl("thread.ts").toString().replace(/^file:\/\//, ""))
  readonly property string fetchScript:
    decodeURIComponent(Qt.resolvedUrl("fetch.ts").toString().replace(/^file:\/\//, ""))
  readonly property string pasteScript:
    decodeURIComponent(Qt.resolvedUrl("paste.ts").toString().replace(/^file:\/\//, ""))
  readonly property string previewScript:
    decodeURIComponent(Qt.resolvedUrl("linkpreview.ts").toString().replace(/^file:\/\//, ""))
  readonly property string sendFileScript:
    decodeURIComponent(Qt.resolvedUrl("send-file.ts").toString().replace(/^file:\/\//, ""))
  readonly property string searchScript:
    decodeURIComponent(Qt.resolvedUrl("search.ts").toString().replace(/^file:\/\//, ""))

  readonly property string contactScript:
    decodeURIComponent(Qt.resolvedUrl("contact-search.ts").toString().replace(/^file:\/\//, ""))

  // ---- new-conversation state (`n` opens, Esc closes)
  property bool newMode: false
  property var newResults: []
  property string newNote: ""
  property int newCursor: 0
  property string newQueryRan: ""

  // ---- search state (list view only; `/` opens, Esc closes)
  property bool searching: false
  property var searchResults: []
  property string searchNote: ""
  property int searchCursor: 0
  property string searchQueryRan: ""
  // Results replace the thread list only once a search has actually produced
  // something to show — focusing the box alone must not blank the list.
  readonly property bool searchShowing:
    searching && (searchResults.length > 0 || searchNote !== "")

  // Fetched attachments: id → file:// url; "" = fetch failed (chip shows ⚠).
  // The cache under ~/.cache/blip/att is global, so results never go stale on
  // a thread switch — no ownership tracking needed, unlike thread loads.
  property var attFiles: ({})
  // attachment id → {pixelRatio, pixelWidth, pixelHeight} from fetch.ts, so
  // Retina media can draw at its intended logical size (a 144-DPI screenshot
  // is a 2x image, not a wall of pixels).
  property var attMetrics: ({})
  property var fetchQueue: []
  property string fetchingId: ""
  // Compose draft attachment (one per message in v1).
  property string draftPath: ""
  property string draftLabel: ""
  // What the in-flight file send / paste belong to, so late completions
  // can't clobber a NEWER draft or land in a DIFFERENT conversation.
  property string sendDraftPath: ""
  property string pasteChat: ""

  readonly property var threads: hostWidget ? hostWidget.threads : []
  readonly property var pinnedThreads: root.threads.filter(function(t) { return t.pinned === true })
  readonly property var unpinnedThreads: root.threads.filter(function(t) { return t.pinned !== true })
  readonly property bool online: hostWidget ? hostWidget.online : false
  readonly property int unread: hostWidget ? hostWidget.unread : 0
  /** The plugin's version, from the host (manifest.json). "" hides the tag. */
  readonly property string version: hostWidget && hostWidget.version ? String(hostWidget.version) : ""

  // ---- share sheet (right-click a link in a bubble, or a link card)
  property string shareUrl: ""        // "" = closed
  property string shareQr: ""         // file:// of the rendered QR, "" while rendering
  readonly property string shareDir: Quickshell.env("XDG_RUNTIME_DIR") + "/blip"
  /** Open the share sheet for one http(s) URL. Anything else is ignored. The
   *  URL is message content: it reaches qrencode and the LocalSend temp file
   *  on STDIN, never argv (CLAUDE.md: message text never rides argv). */
  function openShare(u) {
    u = String(u || "")
    if (!/^https?:\/\//i.test(u)) return
    shareUrl = u
    shareQr = ""
    var out = shareDir + "/qr-" + Date.now() + ".png"
    qrProc.outFile = out
    qrProc.command = ["sh", "-c", 'mkdir -p "$1" && chmod 700 "$1" && umask 077 && exec qrencode -o "$2" -s 6 -m 2 -l M', "blip", shareDir, out]
    qrProc.stdinEnabled = true
    qrProc.running = true
    qrProc.write(u)
    qrProc.stdinEnabled = false
  }
  function closeShare() { shareUrl = ""; shareQr = "" }
  /** First http(s) URL in a string, or "" — mirrors collector.firstUrl. */
  function firstUrl(t) {
    var m = /https?:\/\/[^\s<>"']+/i.exec(String(t || ""))
    return m ? m[0].replace(/[.,;:!?)\]}'"]+$/, "") : ""
  }
  /** IPC `share <url>` (host gates it behind automation=on). */
  function shareLink(u) {
    u = String(u || "")
    if (!/^https?:\/\//i.test(u)) return "not an http(s) url"
    openShare(u)
    return "share sheet"
  }
  /** The full app window. The host owns creation (Quickshell never re-maps a
   *  hidden FloatingWindow), so this asks the widget, exactly like SUPER+M.
   *  The popout closes behind it — the same order the bar's own double-click
   *  uses, and leaving both up put the same conversation on screen twice. */
  function openApp() {
    closeShare()
    if (!hostWidget) return
    if (typeof hostWidget.close === "function") hostWidget.close()
    if (typeof hostWidget.showApp === "function") hostWidget.showApp()
  }
  function shareOpen() { var u = shareUrl; closeShare(); openLink(u) }
  function shareCopy() { var u = shareUrl; closeShare(); copyText(u) }
  /** Omarchy's share sheet. Same path as `omarchy-menu-share clipboard`: the
   *  text lands in a temp .txt and LocalSend's device picker takes it from
   *  there (the official headless CLI sends files, not text). */
  function shareSend() {
    var u = shareUrl; closeShare()
    var f = shareDir + "/share-" + Date.now() + ".txt"
    sendShareProc.command = ["sh", "-c", 'mkdir -p "$1" && chmod 700 "$1" && umask 077 && cat > "$2" && exec systemd-run --user --quiet --collect localsend --headless send "$2"', "blip", shareDir, f]
    sendShareProc.stdinEnabled = true
    sendShareProc.running = true
    sendShareProc.write(u)
    sendShareProc.stdinEnabled = false
    note = "sent to LocalSend"
    noteTimer.restart()
  }
  Process {
    id: qrProc
    property string outFile: ""
    onExited: function(code) { if (code === 0 && root.shareUrl !== "") root.shareQr = "file://" + outFile }
  }
  Process { id: sendShareProc }

  // ---- view state
  property var active: null          // selected thread object, null = list view
  property var bubbles: []           // decorated messages for `active` (see thread.ts)
  property bool loading: false
  property string note: ""           // transient status line (send result, errors)
  property int cursor: -1            // keyboard row selection in list view
  // The bubble the arrows have selected in a conversation (-1 = none) and the
  // delegate drawing it — registered by the row itself, like cursorRow. The
  // selection is a TARGET for actions (copy, open, reply), not a scroll state.
  property int bubbleCursor: -1
  property Item bubbleCursorItem: null
  onBubblesChanged: clearBubbleCursor()   // a reload renumbers the rows
  property bool pinToBottom: false   // scroll to the newest bubble once layout settles
  property bool bubbleFocused: false // a bubble's TextEdit has focus (text selection in progress)
  property string threadRunningChat: "" // chat owned by the current threadProc
  property string bubblesJson: ""       // last rendered bubbles, for no-op reload detection
  property bool firstLoad: true         // first load of the open thread pins to bottom
  property string pendingThreadChat: "" // latest chat requested while it runs
  property string sendChat: ""          // immutable context for the current send
  property string sendText: ""
  property string reloadChat: ""

  function threadIndex(thread) {
    for (var i = 0; i < root.threads.length; i++) {
      if (String(root.threads[i].chat) === String(thread.chat)) return i
    }
    return -1
  }
  function avatarInitials(thread) {
    var n = String(thread.name || "")
    if (/^[+0-9]/.test(n) || n === "") return "#"
    var parts = n.trim().split(/\s+/).filter(function(p) { return p.length > 0 })
    if (parts.length === 0) return "#"
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase()
  }

  readonly property bool inThread: active !== null
  // last_ts of the open conversation as of its last load — the push watcher
  // refreshes the thread list, and when OUR thread advances, the bubbles
  // reload themselves. The guard makes unchanged refreshes free.
  property string activeLastTs: ""
  onThreadsChanged: {
    // LIST view: a rebuilt Repeater collapses contentHeight for a frame and
    // StopAtBounds clamps contentY to 0 — the reader's place in a long list
    // was lost on every genuine refresh. Restore it once layout settles.
    if (!inThread && surfaceOpen) {
      var y = threadFlick.contentY
      if (y > 0) Qt.callLater(function() {
        if (!root.inThread)
          threadFlick.contentY = Math.max(0, Math.min(y, threadFlick.contentHeight - threadFlick.height))
      })
      return
    }
    // `opened` too, not just inThread: a CLOSED panel still holds `active`,
    // and reloading a hidden thread marks it read without it ever being
    // seen (Codex HIGH, 1.1.0 review).
    if (!inThread || !surfaceOpen) return
    for (var i = 0; i < threads.length; i++) {
      var t = threads[i]
      if (String(t.chat) !== String(active.chat)) continue
      if (String(t.last_ts) !== activeLastTs) {
        activeLastTs = String(t.last_ts)
        active = t              // fresher name/guid too (a group can BECOME sendable)
        // The push ping usually started this exact load already — don't
        // stack a second one behind it.
        var busyHere = (threadProc.running && threadRunningChat === String(t.chat))
                       || pendingThreadChat === String(t.chat)
        if (!busyHere) {
          if (!flick.stick) { pushPending = true }  // reading history — defer
          else {
            pinToBottom = true
            requestThreadLoad(String(t.chat))
          }
        }
      }
      return
    }
  }
  // Same rule as collector.isGroupChat(): anything that is not a phone/email.
  function isGroupId(c) { c = String(c || ""); return c !== "" && !/^\+?[0-9]{5,}$/.test(c) && c.indexOf("@") < 0 }
  readonly property bool activeIsGroup: inThread && isGroupId(active.chat)

  /**
   * DMs send --to the chat id (a phone/email). Groups send --chat-id with the
   * full AppleScript GUID ("any;+;<id>") that `imsg groups` supplies; a group
   * whose GUID is not cached yet stays read-only rather than guess. Never the
   * handle: a group's handle is whichever member spoke last, and sending to it
   * would DM that one person while the panel shows the group.
   */
  function isSendable(t) {
    if (!t) return false
    var c = String(t.chat || "")
    if (isGroupId(c)) return /^[A-Za-z]+;[+-];.+$/.test(String(t.guid || ""))
    return /^\+?[0-9]{5,}$/.test(c) || c.indexOf("@") > 0
  }

  /** Back to the list view, scrolled to top — the host calls this on open. */
  function resetToList() {
    active = null
    bubbles = []
    note = ""
    cursor = -1
    loading = false
    pendingThreadChat = ""
    composeField.text = ""
    searching = false
    searchResults = []
    searchNote = ""
    searchField.text = ""
    newMode = false
    newResults = []
    newNote = ""
    newField.text = ""
    // Deep fetch for a real thread list. Does NOT clear dots: like iMessage,
    // a thread stays marked until that conversation is opened.
    if (hostWidget) hostWidget.refresh(true, false)
    Qt.callLater(function() { threadFlick.contentY = 0 })
  }

  function back() {
    active = null
    bubbles = []
    note = ""
    loading = false
    pendingThreadChat = ""
    composeField.text = ""
    clearDraft()   // a queued file must never survive into another thread
    pinToBottom = false
    Qt.callLater(function() { threadFlick.contentY = 0; root.navigationFocusRequested() })
  }

  function openThread(t) {
    if (!t) return
    active = t
    activeLastTs = String(t.last_ts || "")
    bubbles = []
    bubblesJson = ""
    firstLoad = true
    pushPending = false
    note = ""
    loading = true
    composeField.text = ""
    clearDraft()   // a queued file must never survive into another thread
    requestThreadLoad(String(t.chat))
    Qt.callLater(function() { composeField.forceActiveFocus() })
  }

  function requestThreadLoad(chat) {
    pendingThreadChat = String(chat || "")
    if (!threadProc.running) startNextThreadLoad()
  }

  function startNextThreadLoad() {
    if (threadProc.running || pendingThreadChat === "") return
    threadRunningChat = pendingThreadChat
    pendingThreadChat = ""
    threadProc.command = ["bun", root.threadScript, threadRunningChat, "80",
                          "--time-format", root.timeFormat,
                          "--date-format", root.dateFormat,
                          "--date-format-with-year", root.dateFormatWithYear]
    threadProc.running = true
  }

  /** IPC test hook: drive the exact user send path minus the keyboard.
   *  Keystroke injection (wtype) proved non-deterministic — a virtual
   *  keyboard's events can land on whatever surface Hyprland favors. */
  /** Clear every badge/dot locally. Read state never goes back to iMessage. */
  /** Move the conversation by dy pixels — the wheel and the keys share this,
   *  so the bottom-stick (which gates the deferred push reload) behaves the
   *  same whichever way the reader moves. */
  function scrollConversation(dy) {
    var max = Math.max(0, flick.contentHeight - flick.height)
    flick.contentY = Math.max(0, Math.min(max, flick.contentY + dy))
    flick.stick = flick.contentY >= max - 4
  }
  /** Pixels a key moves the conversation from the compose field, 0 = not a
   *  scroll key. PageUp/PageDown always page; Home/End only while the field
   *  is empty — with text typed they keep moving the caret. */
  function conversationStep(key, fieldEmpty) {
    if (key === Qt.Key_PageUp) return -flick.height * 0.9
    if (key === Qt.Key_PageDown) return flick.height * 0.9
    if (!fieldEmpty) return 0
    if (key === Qt.Key_Home) return -flick.contentHeight
    if (key === Qt.Key_End) return flick.contentHeight
    return 0
  }
  /** Up/Down in an empty compose field walk the bubbles, newest first, and
   *  keep the selected one in view. Down past the newest drops the selection
   *  and re-sticks to the bottom, so the conversation follows new messages
   *  again — the reader is back where they started. */
  function moveBubbleCursor(dy) {
    var n = bubbles.length
    if (n === 0) return
    if (bubbleCursor < 0) {
      if (dy > 0) return
      bubbleCursor = n - 1
    } else if (dy > 0 && bubbleCursor >= n - 1) {
      leaveBubbles()
      return
    } else {
      bubbleCursor = Math.max(0, bubbleCursor + dy)
    }
    var it = bubbleCursorItem   // set synchronously by the row's hasCursor binding
    if (!it) return
    var margin = Style.space(6)
    if (it.y < flick.contentY + margin)
      scrollConversation(it.y - margin - flick.contentY)
    else if (it.y + it.height > flick.contentY + flick.height - margin)
      scrollConversation(it.y + it.height + margin - flick.height - flick.contentY)
  }
  function clearBubbleCursor() { bubbleCursor = -1; bubbleCursorItem = null }
  /** Out of the selection and back where reading started: newest at the
   *  bottom, stick re-armed. Down past the newest and Esc both land here. */
  function leaveBubbles() {
    clearBubbleCursor()
    scrollConversation(flick.contentHeight)
  }
  function selectedBubble() {
    return bubbleCursor >= 0 && bubbleCursor < bubbles.length ? bubbles[bubbleCursor] : null
  }
  /** Enter on the selected bubble: its first attachment, else its link card,
   *  else the first URL in its text — the same handlers a click reaches. */
  function openBubble(b) {
    if (b.attachments && b.attachments.length > 0) { openAttachment(b.attachments[0]); return }
    var u = b.link && b.link.url ? String(b.link.url) : firstUrl(b.text)
    if (u !== "") openLink(u)
  }
  /** Ctrl+C on the selected bubble: its text, or — for a bubble that is only
   *  a picture — the first image attachment, as an image. */
  function copyBubble(b) {
    var t = String(b.text || "")
    if (t !== "") { copyText(t); return }
    var atts = b.attachments || []
    for (var i = 0; i < atts.length; i++) {
      if (isImageMime(atts[i].mime)) { copyAttachment(atts[i]); return }
    }
  }
  /** Ctrl+R: quote the selected bubble into the compose field. iMessage's
   *  inline reply is not reachable through the bridge (no message GUID leaves
   *  the Mac and AppleScript has no reply-to), so this is a plain "> quote". */
  function quoteBubble(b) {
    composeField.text = "> " + String(b.text || "").replace(/\s+/g, " ").slice(0, 200) + "\n"
    composeField.cursorPosition = composeField.length
    leaveBubbles()
  }
  function markAllRead() {
    if (!root.hostWidget || root.unread === 0) return
    root.hostWidget.markAllRead()
  }

  /** Chip icon for an attachment's mime type. */
  function attachmentIcon(mime) {
    var m = String(mime || "")
    if (m.indexOf("image/") === 0) return "📷"
    if (m.indexOf("video/") === 0) return "🎬"
    if (m.indexOf("audio/") === 0) return "🎤"
    if (m === "application/pdf") return "📄"
    return "📎"
  }

  /** "❤️👍" — the emoji string for a bubble's tapback pill. */
  function tapbackRow(list) {
    var s = ""
    for (var i = 0; i < (list || []).length; i++) s += list[i].emoji
    return s
  }

  // ---------------------------------------------------- attachment fetching

  function isImageMime(m) { return String(m || "").indexOf("image/") === 0 }
  function linkHost(u) { var m = /^https?:\/\/([^/?#]+)/i.exec(String(u || "")); return (m ? m[1] : String(u || "")).replace(/^www\./, "").toLowerCase() }
  /** Only http(s) ever reaches xdg-open from a card (thread.ts filters too). */
  function openLink(u) {
    u = String(u || "")
    if (!/^https?:\/\//i.test(u)) return
    // Open, then FOCUS the default browser's window: Omarchy sets
    // focus_on_activate=false (no focus stealing), so a new tab in an existing
    // browser on another workspace is invisible — "clicking links does
    // nothing" (Fred, 2.1.4). The class is derived from the default handler's
    // .desktop name (brave-browser, firefox, chromium, google-chrome…).
    Quickshell.execDetached(["sh", "-c",
      'xdg-open "$1" >/dev/null 2>&1; b=$(xdg-settings get default-web-browser 2>/dev/null | sed "s/[.]desktop$//" | tr "[:upper:]" "[:lower:]"); [ -n "$b" ] || exit 0; ' +
      'for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do a=$(hyprctl clients -j 2>/dev/null | jq -r --arg b "$b" "$2"); ' +
      '[ -n "$a" ] && { hyprctl dispatch "hl.dsp.focus({ window = \\"address:$a\\" })" >/dev/null 2>&1; exit 0; }; sleep 0.2; done',
      "blip", u,
      // the jq filter travels as $2 so no quote ever nests inside this QML string
      '[.[] | select(((.class // "") | ascii_downcase | contains($b)) or ((.initialClass // "") | ascii_downcase | contains($b)))] | sort_by(.focusHistoryID) | .[0].address // empty'])
  }


  // ---------------------------------------------------- contact photos
  // Sidebar avatars: `imsg avatar <handle>` via avatar.ts (7-day cache, negative
  // markers). One request in flight; rows ask on creation; groups never ask.
  readonly property string avatarScript: fetchScript.replace(/fetch\.ts$/, "avatar.ts")
  // ---- link previews for URLs Messages never decorated
  // Apple builds an LPLinkMetadata balloon for some links and not others (on
  // this Mac: 7 of 27). linkpreview.ts fetches the page's own Open Graph card
  // for the rest, so a bare URL still shows its picture and title.
  property var linkCards: ({})       // url → {title,summary,image,host}, null = none
  property var previewQueue: []
  function requestPreview(url) {
    url = String(url || "")
    if (url === "" || !/^https?:\/\//i.test(url)) return
    if (linkCards[url] !== undefined || previewQueue.indexOf(url) >= 0) return
    previewQueue.push(url)
    pumpPreview()
  }
  function pumpPreview() {
    if (previewProc.running || previewQueue.length === 0) return
    previewProc.url = previewQueue.shift()
    // The URL is message content: stdin, never argv (Astra #6).
    previewProc.command = ["bun", root.previewScript, "--stdin"]
    previewProc.stdinEnabled = true
    previewProc.running = true
    previewProc.write(previewProc.url)
    previewProc.stdinEnabled = false
  }
  Process {
    id: previewProc
    property string url: ""
    stdout: StdioCollector {
      onStreamFinished: {
        var card = null
        try {
          var d = JSON.parse(text.trim())
          if (d.ok === true) card = { title: String(d.title || ""), summary: String(d.summary || ""),
                                      image: String(d.image || ""), url: String(d.url || previewProc.url) }
        } catch (e) {}
        var m = Object.assign({}, root.linkCards)
        m[previewProc.url] = card
        root.linkCards = m
        root.pumpPreview()
      }
    }
    onExited: Qt.callLater(root.pumpPreview)
  }

  property var avatarFiles: ({})     // handle → file:// url, "" = no photo
  property var avatarQueue: []
  function requestAvatar(handle) {
    handle = String(handle || "")
    if (handle === "") return          // groups are welcome: avatar.ts asks for the group's own photo
    if (avatarFiles[handle] !== undefined || avatarQueue.indexOf(handle) >= 0) return
    avatarQueue.push(handle)
    pumpAvatar()
  }
  // Letters stick in avatarFiles as "". Opening the panel/window again drops
  // those and re-asks, so a photo set a minute ago is not stuck until tomorrow.
  function retryBareAvatars() {
    var m = Object.assign({}, root.avatarFiles)
    var keys = []
    for (var k in m) {
      if (m[k] === "") { keys.push(k); delete m[k] }
    }
    if (keys.length === 0) return
    root.avatarFiles = m
    for (var i = 0; i < keys.length; i++) root.requestAvatar(keys[i])
  }
  onSurfaceOpenChanged: if (surfaceOpen) root.retryBareAvatars()
  function pumpAvatar() {
    if (avatarProc.running || avatarQueue.length === 0) return
    avatarProc.handle = avatarQueue.shift()
    // --retry skips the 24h "no photo" marker so a picture set after the
    // first ask (a new group photo, a Contacts card) shows up this session.
    avatarProc.command = ["bun", root.avatarScript, "--retry", avatarProc.handle]
    avatarProc.running = true
  }
  Process {
    id: avatarProc
    property string handle: ""
    stdout: StdioCollector {
      onStreamFinished: {
        var url = ""
        try { var d = JSON.parse(text.trim()); if (d.ok === true) url = String(d.url || "") } catch (e) {}
        var m = Object.assign({}, root.avatarFiles)
        m[avatarProc.handle] = url
        root.avatarFiles = m
        root.pumpAvatar()
      }
    }
    onExited: Qt.callLater(root.pumpAvatar)
  }
  /** Only media/documents are handed to xdg-open. Anything a sender could
   *  make executable (scripts, .desktop, unknown blobs) is saved and named,
   *  never launched (Codex audit #10). */
  function openableMime(m) {
    m = String(m || "")
    return m.indexOf("image/") === 0 || m.indexOf("video/") === 0 || m.indexOf("audio/") === 0 ||
           m === "application/pdf" || m === "text/plain" || m === "text/vcard" || m === "text/calendar"
  }

  /** action: "" = just cache it, "open" = xdg-open when it lands, "copy" =
   *  put it on the clipboard when it lands. */
  function enqueueFetch(att, action, auto) {
    var id = String(att.id || "")
    if (id === "" || fetchingId === id) return
    if (attFiles[id] !== undefined && !action) return
    for (var i = 0; i < fetchQueue.length; i++) {
      if (fetchQueue[i].id === id) {
        if (action) fetchQueue[i].action = action
        return
      }
    }
    fetchQueue.push({ id: id, name: String(att.name || "file"),
                      mime: String(att.mime || ""), action: action || "",
                      auto: auto === true })
    pumpFetch()
  }

  property string fetchJobAction: ""
  property string fetchJobMime: ""
  function pumpFetch() {
    if (fetchProc.running || fetchQueue.length === 0) return
    var job = fetchQueue.shift()
    fetchingId = job.id
    fetchJobAction = job.action
    fetchJobMime = job.mime
    // Auto-pulls carry a hard transfer cap: claimed metadata is not the limit.
    fetchProc.command = ["bun", root.fetchScript, job.id, job.name, job.mime, job.auto ? "5242880" : ""]
    fetchProc.running = true
  }

  /** Images ≤ 5 MB in the open conversation fetch themselves (Fred's call —
   *  it's what makes the panel feel like Messages, and cached hits are free). */
  /** Source-size ceiling for an auto-fetch. Bigger than any photo a phone
   *  produces, small enough that a raw camera dump is still a click. */
  readonly property int autoFetchMaxSource: 32 * 1024 * 1024
  function autoFetchImages() {
    if (!inThread) return
    for (var i = 0; i < bubbles.length; i++) {
      var atts = bubbles[i].attachments || []
      for (var j = 0; j < atts.length; j++) {
        // Bytes must be KNOWN — null/0 must not slip through and auto-pull
        // something the click-path 100 MB ceiling would allow. The SOURCE cap
        // is generous because the Mac resamples an auto-fetch to 1600 px
        // before sending: the old 5 MB gate was measured against the source,
        // while sips turns a 5.07 MB HEIC into a 7.80 MB JPEG, so full-size
        // iPhone photos were rejected at both ends and simply never appeared.
        var b = atts[j].bytes
        if (isImageMime(atts[j].mime) && typeof b === "number" && b > 0 && b <= root.autoFetchMaxSource)
          enqueueFetch(atts[j], "", true)
      }
      // link-card preview PNGs are small; the auto-fetch transfer cap bounds them
      var l = bubbles[i].link
      if (l && l.image_id) enqueueFetch({ id: String(l.image_id), name: "preview.png", mime: "image/png", bytes: 0 }, "", true)
    }
  }

  /** Chip/image click: fetch-then-open. ALWAYS round-trips fetch.ts, even
   *  when attFiles already has a url — the LRU may have evicted the file
   *  since (Codex finding #5); a cache hit is instant anyway. */
  function openAttachment(att) {
    var id = String(att.id || "")
    if (id === "") return
    if (attFiles[id] === "") {   // failed marker — clear it so a retry runs
      var m = Object.assign({}, attFiles); delete m[id]; attFiles = m
    }
    enqueueFetch(att, "open")
  }
  /** Ctrl+C on an image bubble: fetch-then-clipboard, the same round trip as
   *  a click, ending in wl-copy with the image's own MIME type. */
  function copyAttachment(att) {
    if (String(att.id || "") === "") return
    enqueueFetch(att, "copy")
  }

  // ------------------------------------------------------ compose attachment

  function setDraft(path) {
    var p = String(path || "")
    if (p === "") return
    draftPath = p
    var parts = p.split("/")
    draftLabel = parts[parts.length - 1] || "file"
    Qt.callLater(function() { composeField.forceActiveFocus() })
  }

  function clearDraft() {
    draftPath = ""
    draftLabel = ""
  }

  function startPaste() {
    if (pasteProc.running || !inThread) return
    pasteChat = String(active.chat)
    pasteProc.command = ["bun", root.pasteScript]
    pasteProc.running = true
  }

  // ------------------------------------------------- new conversation

  function startNew() {
    if (inThread && !splitView) return   // split view: the list pane is right there
    exitSearch()
    newMode = true
    newResults = []
    newNote = ""
    newCursor = 0
    newQueryRan = ""
    Qt.callLater(function() {
      newField.forceActiveFocus()
      newField.selectAll()
    })
  }

  function exitNew() {
    newMode = false
    newResults = []
    newNote = ""
    newCursor = 0
    newQueryRan = ""
    newField.text = ""
    newField.focus = false
    root.navigationFocusRequested()
  }

  // Same identity discipline as message search: a stale completion must
  // never surface Alice's results under Bob's query (Codex HIGH, 1.2.0).
  property int contactSeq: 0
  property string contactPending: ""
  function threadRecencyJson() {
    var rec = {}
    for (var i = 0; i < threads.length; i++) {
      var t = threads[i]
      var ts = String(t.last_ts || "")
      if (ts === "") continue
      if (t.handle) rec[String(t.handle)] = ts
      if (t.chat) rec[String(t.chat)] = ts
    }
    return JSON.stringify(rec)
  }
  function newFieldQuery() {
    var d = String(newField.displayText || "")
    var t = String(newField.text || "")
    return (d !== "" ? d : t).trim()
  }
  function scheduleContactSearch() {
    if (!newMode) return
    if (newFieldQuery() === "") {
      newSearchTimer.stop()
      newResults = []
      newNote = ""
      newQueryRan = ""
      newCursor = 0
      return
    }
    if (newFieldQuery() !== newQueryRan) contactSeq++
    newNote = "searching…"
    newSearchTimer.restart()
  }
  function runContactSearch() {
    var q = newFieldQuery()
    if (q === "") return
    // Bump the generation NOW so the in-flight (older) result is rejected,
    // never shown as clickable rows under the newer query (Codex audit #5).
    if (contactProc.running) { contactSeq++; contactPending = q; return }
    contactSeq++
    newQueryRan = q
    newNote = "searching…"
    // The recency map names every conversation you have. argv is world-readable
    // through `ps`, so it goes on stdin — the same rule message text follows.
    contactProc.command = ["bun", root.contactScript, q, "--recency-stdin"]
    contactProc.stdinEnabled = true
    contactProc.running = true
    contactProc.write(root.threadRecencyJson())
    contactProc.stdinEnabled = false
  }
  function acceptNewField() {
    var q = newFieldQuery()
    if (q !== "" && q === newQueryRan && newResults.length > 0) {
      var i = Math.max(0, Math.min(newCursor, newResults.length - 1))
      openContact(newResults[i])
      return
    }
    runContactSearch()
  }
  function moveNewCursor(dy) {
    if (newResults.length === 0 || dy === 0) return
    newCursor = (newCursor + dy + newResults.length) % newResults.length
  }

  /** Start (or resume) a DM with a picked handle. An existing thread is
   *  reused so history shows; otherwise a synthetic DM thread — sendable,
   *  because DMs only need --to <handle>. */
  function openContact(hit) {
    newMode = false
    for (var i = 0; i < threads.length; i++) {
      if (String(threads[i].chat) === String(hit.handle)) { openThread(threads[i]); return }
    }
    openThread({ chat: hit.handle, guid: "", name: hit.name, handle: hit.handle,
                 service: "iMessage", last_ts: "", last_text: "",
                 last_from_me: false, count: 0, unread: 0 })
  }

  // ------------------------------------------------------------- search

  function startSearch() {
    if (inThread && !splitView) return
    searching = true
    searchResults = []
    searchNote = ""
    searchCursor = 0
    searchQueryRan = ""
    searchWatch.lastQ = ""
    Qt.callLater(function() { searchField.forceActiveFocus(); searchField.selectAll() })
  }

  function exitSearch() {
    searching = false
    searchResults = []
    searchNote = ""
    searchCursor = 0
    searchQueryRan = ""
    searchField.text = ""
    searchField.focus = false
    if (!newMode) root.navigationFocusRequested()
  }

  // Instant sidebar preview. search.ts matchConversations ranks the list
  // once bun returns. Haystack is name, handle, and chat id only.
  function fuzzyScore(query, text) {
    var q = String(query || "").trim().toLowerCase()
    var t = String(text || "").toLowerCase()
    if (q === "" || t === "") return 0
    if (t.indexOf(q) >= 0) return 1000 + (t.indexOf(q) === 0 ? 100 : 0) - Math.min(t.length, 100)
    var ti = 0, score = 0, consec = 0
    for (var qi = 0; qi < q.length; qi++) {
      var idx = t.indexOf(q.charAt(qi), ti)
      if (idx < 0) return 0
      if (idx === ti) { consec += 1; score += 10 + consec }
      else { consec = 0; score += 1 }
      if (idx === 0 || /\s/.test(t.charAt(idx - 1))) score += 20
      ti = idx + 1
    }
    return score
  }
  function searchFieldQuery() {
    var d = String(searchField.displayText || "")
    var t = String(searchField.text || "")
    return (d !== "" ? d : t).trim()
  }
  function conversationHits(q) {
    var scored = []
    for (var i = 0; i < threads.length; i++) {
      var th = threads[i]
      var hay = [th.name, th.handle, th.chat].filter(function(x) { return x }).join(" ")
      var s = fuzzyScore(q, hay)
      if (s <= 0) continue
      scored.push({ s: s, t: th })
    }
    scored.sort(function(a, b) { return b.s - a.s })
    var out = []
    var n = Math.min(scored.length, 8)
    for (var j = 0; j < n; j++) {
      var t = scored[j].t
      out.push({
        kind: "conversation",
        chat: String(t.chat || ""),
        name: String(t.name || t.handle || t.chat || ""),
        handle: String(t.handle || ""),
        service: String(t.service || ""),
        ts: String(t.last_ts || ""),
        from_me: t.last_from_me === true,
        text: String(t.last_text || ""),
        group: isGroupId(String(t.chat || ""))
      })
    }
    return out
  }
  function scheduleSearch() {
    var q = searchFieldQuery()
    if (q === "") {
      searchTimer.stop()
      searchResults = []
      searchNote = ""
      searchQueryRan = ""
      searchCursor = 0
      return
    }
    searching = true
    if (q !== searchQueryRan) searchSeq++
    searchResults = conversationHits(q)
    searchCursor = 0
    searchNote = searchResults.length === 0 ? "searching…" : ""
    searchTimer.restart()
  }
  function moveSearchCursor(dy) {
    if (searchResults.length === 0 || dy === 0) return
    searchCursor = (searchCursor + dy + searchResults.length) % searchResults.length
  }
  function acceptSearchField() {
    var q = searchFieldQuery()
    if (searchResults.length > 0 && (searchQueryRan === "" || searchQueryRan === q)) {
      var i = Math.max(0, Math.min(searchCursor, searchResults.length - 1))
      openSearchHit(searchResults[i])
      return
    }
    runSearch()
  }

  // Monotonic id so a stale completion can never label itself with a newer
  // query; a query typed while one runs is queued (latest wins) and fires
  // when the runner frees up — same pattern as thread loads.
  property int searchSeq: 0
  property string searchPending: ""
  function threadIdentitiesJson() {
    var out = []
    for (var i = 0; i < threads.length; i++) {
      var t = threads[i]
      out.push({
        chat: t.chat, name: t.name, handle: t.handle, service: t.service,
        last_ts: t.last_ts, last_from_me: t.last_from_me, last_text: t.last_text
      })
    }
    return JSON.stringify(out)
  }
  function runSearch() {
    var q = searchFieldQuery()
    if (q === "") return
    if (searchProc.running) { searchSeq++; searchPending = q; return }
    searchSeq++
    searchQueryRan = q
    if (searchResults.length === 0) searchNote = "searching…"
    searchProc.command = ["bun", root.searchScript, q, "40"]
    searchProc.stdinEnabled = true
    searchProc.running = true
    searchProc.write(threadIdentitiesJson())
    searchProc.stdinEnabled = false
  }

  /** Push ping while this conversation is open: reload its bubbles now,
   *  without waiting for the collector round-trip. Cheap when nothing
   *  changed; the thread loader already serializes concurrent requests. */
  // A reload REBUILDS every bubble and (when pinned) yanks the view to the
  // bottom — doing that on every push ping made reading history impossible
  // (Fred: "FIX SCROLLING!"). While the user is scrolled up, defer; the
  // reload fires the moment they return to the bottom.
  property bool pushPending: false
  function pushReload() {
    if (!inThread || !surfaceOpen) return
    if (!flick.stick) { pushPending = true; return }
    if (threadProc.running && pendingThreadChat !== "") return
    pinToBottom = true
    requestThreadLoad(String(active.chat))
  }

  /** IPC hook (`newchat <query>`): drive the composer path minus the keyboard. */
  function newChatFor(query) {
    if (inThread) back()
    startNew()
    newField.text = String(query || "")
    runContactSearch()
    return "contact search: " + newField.text
  }

  /** IPC hook (`find <query>`): drive the exact search path minus the keyboard. */
  function searchFor(query) {
    if (inThread) back()
    startSearch()
    searchField.text = String(query || "")
    runSearch()
    return "searching: " + searchField.text
  }

  /** Open the conversation a search hit belongs to. Prefer the live thread
   *  object (sendable, has the group guid); an old conversation outside the
   *  poll window opens read-mostly from the hit's identity. */
  function openSearchHit(hit) {
    searching = false
    for (var i = 0; i < threads.length; i++) {
      if (String(threads[i].chat) === String(hit.chat)) { openThread(threads[i]); return }
    }
    openThread({ chat: hit.chat, guid: "", name: hit.name, handle: hit.handle,
                 service: hit.service, last_ts: hit.ts, last_text: "",
                 last_from_me: false, count: 0, unread: 0 })
  }

  function composeAndSend(text) {
    if (!inThread) return "not in a thread"
    composeField.text = String(text || "")
    send()
    return note === "" ? "sent-dispatch" : note
  }

  /** Model truth for the bubble view, for automated verification. */
  function bubbleModel() {
    return JSON.stringify(bubbles.map(function(b) {
      return { mine: b.from_me === true, text: String(b.text || "").substring(0, 30) }
    }))
  }

  function send() {
    var text = composeField.text
    if (!root.inThread) return

    // "/attach <path>" queues a file from anywhere on this machine as the draft.
    var trimmed = text.trim()
    if (trimmed.indexOf("/attach ") === 0) {
      var p = trimmed.slice(8).trim()
      if (p.indexOf("~/") === 0) p = root.home + p.slice(1)
      setDraft(p)
      composeField.text = ""
      note = "attached — type a caption or press Enter to send"
      return
    }

    if (draftPath === "" && trimmed === "") return
    if (sendProc.running || fileSendProc.running) {
      note = "a message is already sending"
      return
    }
    if (!isSendable(root.active)) {
      note = "Read-only — group id unknown — send from your phone"
      return
    }
    note = "sending…"
    sendChat = String(root.active.chat)
    sendText = text

    if (draftPath !== "") {
      // send-file.ts owns target resolution (group guid or DM handle).
      sendDraftPath = draftPath
      // caption on stdin — never in this process's argv (audit #4, war room #1/#13)
      fileSendProc.command = ["bun", root.sendFileScript, sendChat, draftPath, "--caption-stdin"]
        .concat(/^(SMS|RCS)$/i.test(String(root.active.service || "")) ? ["--service", String(root.active.service).toUpperCase()] : [])
      fileSendProc.stdinEnabled = true
      fileSendProc.running = true
      fileSendProc.write(trimmed !== "" ? text : "")
      fileSendProc.stdinEnabled = false
      return
    }

    // Body on STDIN (--text-stdin), never argv: argv is readable by every
    // process on this machine and travels through ssh into the Mac's ps.
    var target = root.activeIsGroup
      ? ["--chat-id", String(root.active.guid)]
      : ["--to", sendChat]
    // green-bubble (SMS/RCS) threads send on their own service (war room #2)
    var svc = String(root.active.service || "")
    if (!root.activeIsGroup && /^(SMS|RCS)$/i.test(svc)) target = target.concat(["--service", svc.toUpperCase()])
    sendProc.command = [root.home + "/bin/imsg-send"].concat(target).concat(["--yes", "--text-stdin", "--keep-dashes"])
    sendProc.stdinEnabled = true
    sendProc.running = true
    sendProc.write(text)
    sendProc.stdinEnabled = false
  }

  Process { id: copyProc }
  function copyText(t) {
    if (t === "") return
    // stdin, not argv: message text can be long and can start with "-".
    copyProc.command = ["sh", "-c", "wl-copy"]
    copyProc.stdinEnabled = true
    copyProc.running = true
    copyProc.write(t)
    copyProc.stdinEnabled = false
    note = "copied"
    noteTimer.restart()
  }
  Timer { id: noteTimer; interval: 1500; onTriggered: if (root.note === "copied" || root.note === "sent to LocalSend") root.note = "" }

  // The same patterns as the bubbles: today the time, older rows the date and
  // the time, with the year once it is not this year.
  function fmtTime(ts) {
    var s = String(ts || "")
    if (s.length < 16) return s
    var now = new Date()
    var at = new Date(+s.substring(0, 4), +s.substring(5, 7) - 1, +s.substring(8, 10),
                      +s.substring(11, 13), +s.substring(14, 16))
    var clock = Qt.formatTime(at, root.timeFormat)
    if (s.substring(0, 10) === Qt.formatDate(now, "yyyy-MM-dd")) return clock
    // Messages stamps a row "Yesterday", then the weekday for the last week,
    // then a date — never a date-plus-clock, which is what a mail client does.
    var midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    var days = Math.floor((midnight - new Date(at.getFullYear(), at.getMonth(), at.getDate())) / 86400000)
    if (days === 1) return "Yesterday"
    if (days > 1 && days < 7) return Qt.formatDate(at, "ddd")
    var date = at.getFullYear() === now.getFullYear() ? root.dateFormat : root.dateFormatWithYear
    return Qt.formatDate(at, date)
  }

  // ------------------------------------------------------------ processes
  Process {
    id: threadProc
    stdout: StdioCollector {
      onStreamFinished: {
        // `opened` matters: a load finishing after the panel closed must not
        // render into a hidden view or mark the thread read unseen.
        var belongsHere = root.surfaceOpen && root.inThread && String(root.active.chat) === root.threadRunningChat
        if (!belongsHere) return
        root.loading = false
        try {
          var d = JSON.parse(text.trim())
          if (d.ok === true) {
            var list = Array.isArray(d.bubbles) ? d.bubbles : []
            var j = JSON.stringify(list)
            if (j === root.bubblesJson) {
              // Nothing changed — do NOT rebuild the Repeater (a rebuild
              // resets scroll and re-decodes every image). Push pings mostly
              // produce identical content; this makes them free.
              if (root.hostWidget && root.readActive) root.hostWidget.markThreadRead(root.threadRunningChat)
              return
            }
            root.bubblesJson = j
            root.bubbles = list
            // Pin only on the thread's FIRST load or when the user was
            // already at the bottom — never while they read history.
            root.pinToBottom = root.firstLoad || flick.stick
            root.firstLoad = false
            Qt.callLater(root.autoFetchImages)
            // A dot means "looked at", so clear it only after content loaded.
            if (root.hostWidget && root.readActive) root.hostWidget.markThreadRead(root.threadRunningChat)
          } else {
            root.bubbles = []
            root.note = String(d.error || "could not load this thread")
          }
        } catch (e) {
          root.bubbles = []
          root.note = "could not load this thread"
        }
      }
    }
    onExited: function(code, status) {
      var completedChat = root.threadRunningChat
      var belongsHere = root.inThread && String(root.active.chat) === completedChat
      root.threadRunningChat = ""
      if (belongsHere && root.pendingThreadChat === "") root.loading = false
      if (belongsHere && code !== 0) root.note = "thread loader failed (exit " + code + ")"
      if (root.pendingThreadChat !== "") Qt.callLater(root.startNextThreadLoad)
    }
  }

  Process {
    id: sendProc
    property string lastErr: ""
    // imsg-send says WHY it refused (too long, not authorized, no SMS chat) on
    // stderr; "send failed (exit 1)" told the user nothing (war room #24).
    stderr: StdioCollector { onStreamFinished: sendProc.lastErr = text.trim().split("\n").filter(function(l) { return l.trim() !== "" }).pop() || "" }
    onExited: function(code, status) {
      var completedChat = root.sendChat
      var completedText = root.sendText
      var belongsHere = root.inThread && String(root.active.chat) === completedChat
      root.sendChat = ""
      root.sendText = ""
      if (code === 0) {
        // A URL you just SHARED opens the sheet too (Fred, 2.3.0): send it,
        // then offer the QR / LocalSend / copy for the same link.
        var sentUrl = root.firstUrl(completedText)
        if (belongsHere && sentUrl !== "") Qt.callLater(function() { root.openShare(sentUrl) })
        if (belongsHere) {
          root.note = ""
          // Never erase a newer draft typed after this send began.
          if (composeField.text === completedText) composeField.text = ""
        }
        // Give Messages.app a beat to write the row, then reload the thread.
        root.reloadChat = completedChat
        reloadTimer.restart()
      } else if (belongsHere) {
        if (code === 69 || code === 255) root.note = "not sent — Mac unreachable"
        else root.note = (sendProc.lastErr !== "" ? "send failed: " + sendProc.lastErr : "send failed (exit " + code + ")")
      }
      if (belongsHere) composeField.forceActiveFocus()
    }
  }

  // Attachment fetcher: one job at a time off root.fetchQueue.
  Process {
    id: fetchProc
    stdout: StdioCollector {
      onStreamFinished: {
        var id = root.fetchingId
        try {
          var d = JSON.parse(text.trim())
          // A copy fetches the ORIGINAL for the clipboard; the bubble keeps
          // the preview it already draws. Swapping its source and metrics
          // re-decodes and re-lays out the picture under the reader's eyes.
          var keepInline = root.fetchJobAction === "copy" && !!root.attFiles[id]
          var m = Object.assign({}, root.attFiles)
          if (!keepInline) m[id] = d.ok === true ? String(d.url || "") : ""
          root.attFiles = m
          var ratio = Number(d.pixelRatio)
          var pixelWidth = Number(d.pixelWidth)
          var pixelHeight = Number(d.pixelHeight)
          if (!isFinite(ratio) || ratio < 1 || ratio > 4) ratio = 1
          if (!isFinite(pixelWidth) || pixelWidth < 1 || pixelWidth > 100000) pixelWidth = 0
          if (!isFinite(pixelHeight) || pixelHeight < 1 || pixelHeight > 100000) pixelHeight = 0
          if (!keepInline) {
            var metrics = Object.assign({}, root.attMetrics)
            metrics[id] = { pixelRatio: ratio, pixelWidth: pixelWidth, pixelHeight: pixelHeight }
            root.attMetrics = metrics
          }
          if (d.ok === true && root.fetchJobAction === "copy") {
            // The Mac converts HEIC/HEIF to JPEG on the way (fetch.ts wantsJpeg),
            // so the clipboard type must say what the bytes are. Path and type
            // travel as arguments, never interpolated into the script.
            var mime = root.fetchJobMime === "image/heic" || root.fetchJobMime === "image/heif" ? "image/jpeg" : root.fetchJobMime
            Quickshell.execDetached(["sh", "-c", 'wl-copy --type "$1" < "$2"', "sh", mime, String(d.path || "")])
            root.note = "copied"
            noteTimer.restart()
          } else if (d.ok === true && root.fetchJobAction === "open") {
            if (root.openableMime(root.fetchJobMime)) {
              Quickshell.execDetached(["xdg-open", String(d.url || "")])
            } else {
              root.note = "saved, not opened (" + (root.fetchJobMime || "unknown type") + "): " + String(d.path || "")
            }
          }
          if (d.ok !== true && d.online === false) root.note = "fetch failed — Mac unreachable"
        } catch (e) {
          var m2 = Object.assign({}, root.attFiles)
          m2[id] = ""
          root.attFiles = m2
        }
      }
    }
    onExited: function(code, status) {
      root.fetchingId = ""
      Qt.callLater(root.pumpFetch)
    }
  }

  // Clipboard snapshot (Ctrl+V): image → draft chip, text → insert at cursor.
  Process {
    id: pasteProc
    stdout: StdioCollector {
      onStreamFinished: {
        // A slow clipboard read must never attach content to a conversation
        // the user has since navigated away from (Codex finding #2).
        if (!root.inThread || String(root.active.chat) !== root.pasteChat) return
        try {
          var d = JSON.parse(text.trim())
          if (d.kind === "image" || d.kind === "file") root.setDraft(String(d.path || ""))
          else if (d.kind === "text") {
            composeField.insert(composeField.cursorPosition, String(d.text || ""))
          }
        } catch (e) { /* clipboard empty or helper failed — nothing to paste */ }
      }
    }
  }

  // File send via send-file.ts (target resolution + stdin transfer live there).
  Process {
    id: fileSendProc
    stdout: StdioCollector {
      onStreamFinished: {
        var belongsHere = root.inThread && String(root.active.chat) === root.sendChat
        var ok = false, err = "file send failed"
        try {
          var d = JSON.parse(text.trim())
          ok = d.ok === true
          if (!ok) err = d.online === false ? "not sent — Mac unreachable" : String(d.error || err)
        } catch (e) { /* fall through */ }
        if (ok) {
          // Only clear the draft this send actually shipped — the user may
          // have queued a NEWER file while this one was in flight.
          if (root.draftPath === root.sendDraftPath) root.clearDraft()
          if (belongsHere) {
            root.note = ""
            if (composeField.text === root.sendText) composeField.text = ""
          }
          root.reloadChat = root.sendChat
          reloadTimer.restart()
        } else if (belongsHere) {
          root.note = err
        }
        root.sendChat = ""
        root.sendText = ""
        if (belongsHere) composeField.forceActiveFocus()
      }
    }
  }


  Process {
    id: contactProc
    property int seq: 0
    onStarted: seq = root.contactSeq
    stdout: StdioCollector {
      onStreamFinished: {
        if (!root.newMode || contactProc.seq !== root.contactSeq) return // Esc'd or superseded
        try {
          var d = JSON.parse(text.trim())
          if (d.ok === true) {
            root.newResults = Array.isArray(d.results) ? d.results : []
            root.newCursor = 0
            root.newNote = root.newResults.length === 0 ? "no matches — try a number or email" : ""
          } else {
            root.newNote = String(d.error || "contact search failed")
          }
        } catch (e) {
          root.newNote = "contact search failed"
        }
      }
    }
    onExited: if (root.contactPending !== "") {
      root.contactPending = ""
      if (root.newMode) Qt.callLater(root.runContactSearch)
    }
  }

  Process {
    id: searchProc
    property int seq: 0
    onStarted: seq = root.searchSeq
    stdout: StdioCollector {
      onStreamFinished: {
        if (!root.searching || searchProc.seq !== root.searchSeq) return // Esc'd or superseded
        try {
          var d = JSON.parse(text.trim())
          if (d.ok === true) {
            root.searchResults = Array.isArray(d.results) ? d.results : []
            root.searchNote = root.searchResults.length === 0 ? "no matches" : ""
            if (root.searchCursor >= root.searchResults.length)
              root.searchCursor = Math.max(0, root.searchResults.length - 1)
          } else {
            root.searchNote = String(d.error || "search failed")
          }
        } catch (e) {
          root.searchNote = "search failed"
        }
      }
    }
    // A query queued mid-run fires now; runSearch reads the LIVE field, so
    // anything typed since supersedes the queued text automatically.
    onExited: if (root.searchPending !== "") {
      root.searchPending = ""
      if (root.searching) Qt.callLater(root.runSearch)
    }
  }

  // TextField textChanged never reached this window. Poll the field
  // while composing. Enter still opens the highlight.
  Timer {
    id: newSearchWatch
    interval: 50
    repeat: true
    running: root.newMode
    property string lastQ: ""
    onRunningChanged: lastQ = ""
    onTriggered: {
      var q = root.newFieldQuery()
      if (q === lastQ) return
      lastQ = q
      root.scheduleContactSearch()
    }
  }
  Timer {
    id: newSearchTimer
    interval: 150
    repeat: false
    onTriggered: {
      if (!root.newMode) return
      if (root.newFieldQuery() === "") {
        root.newResults = []
        root.newNote = ""
        root.newQueryRan = ""
        root.newCursor = 0
        return
      }
      root.runContactSearch()
    }
  }
  Timer {
    id: searchWatch
    interval: 50
    repeat: true
    running: searchField.activeFocus || root.searching
    property string lastQ: ""
    onRunningChanged: lastQ = ""
    onTriggered: {
      var q = root.searchFieldQuery()
      if (q === lastQ) return
      lastQ = q
      root.scheduleSearch()
    }
  }
  Timer {
    id: searchTimer
    interval: 150
    repeat: false
    onTriggered: {
      if (root.searchFieldQuery() === "") return
      root.runSearch()
    }
  }
  Timer {
    id: reloadTimer
    interval: 1500
    onTriggered: if (root.inThread && String(root.active.chat) === root.reloadChat) {
      root.loading = true
      root.requestThreadLoad(root.reloadChat)
    }
  }

  // ---- keyboard navigation (the host's PanelKeyCatcher calls these)
  function moveCursor(dy) {
    if (inThread || threads.length === 0 || dy === 0) return
    cursor = (cursor + dy + threads.length) % threads.length
  }
  function activateCursor() {
    if (!inThread && cursor >= 0) openThread(threads[cursor])
  }
  function handleTextKey(text) {
    if (text === "/") { startSearch(); return true }
    if (text === "n" || text === "N") { startNew(); return true }
    if (text >= "1" && text <= "9") {
      if (searching || newMode) return false
      var i = Number(text) - 1
      if (i < 0 || i >= threads.length) return false
      openThread(threads[i])
      return true
    }
    if ((inThread && !splitView) || searching || newMode) return false
    if (text === "r" || text === "R") { if (hostWidget) hostWidget.refresh(true, false); return true }
    if (text === "a" || text === "A") { markAllRead(); return true }
    return false
  }
  function catchNavText(text) {
    var jump = text === "/" || text === "n" || text === "N"
      || (text >= "1" && text <= "9")
    if (!jump) return false
    if (searchField.activeFocus || newField.activeFocus || bubbleFocused) return false
    if (composeField.activeFocus && (composeField.text.length > 0 || root.draftPath !== ""))
      return false
    return handleTextKey(text) === true
  }
  function catchEscape() {
    if (newField.activeFocus || newMode) { exitNew(); return true }
    if (searchField.activeFocus || searching) { exitSearch(); return true }
    return false
  }
  /** Esc semantics for a host without a PanelKeyCatcher (the window): true if
   *  something was unwound, false if the host should close. */
  function unwind() {
    if (shareUrl !== "") { closeShare(); return true }
    if (catchEscape()) return true
    if (inThread) { back(); return true }
    return false
  }
  function focusDefault() {
    if (inThread) composeField.forceActiveFocus()
    else navigationFocusRequested()
  }

  // ---- layout: one pane (popout) or two (window). Both panes always exist —
  // hiding, not unloading, keeps image state, selection, and scroll position.
  property bool splitView: false
  property int sidebarWidth: 320
  readonly property bool listShowing: splitView || !inThread

  RowLayout {
    anchors.fill: parent
    spacing: 0

    // ------------------------------------------------------- thread pane
    Item {
      id: threadPane
      visible: root.listShowing
      Layout.fillHeight: true
      Layout.fillWidth: !root.splitView
      Layout.preferredWidth: root.splitView ? root.sidebarWidth : -1
      ColumnLayout {
        anchors.fill: parent
        // Gutters for the app: the popout's card supplies its own padding,
        // the window's panes had text flush against the borders (Fred).
        anchors.leftMargin: root.splitView ? Style.space(18) : 0
        anchors.rightMargin: root.splitView ? Style.space(18) : 0
        anchors.topMargin: root.splitView ? Style.space(10) : 0
        anchors.bottomMargin: root.splitView ? Style.space(10) : 0
        spacing: Style.space(root.splitView ? 14 : 8)
        PanelHero {
          Layout.fillWidth: true
          title: "Blip"
          meta: (!root.online
                ? "Mac unreachable — bridge offline"
                : (root.unread > 0 ? root.unread + " unread" : "all caught up"))
          detail: ""   // Fred: not needed — and it squeezed the title to "B…"
          foreground: root.foreground
          fontFamily: root.fontFamily
          // The version, pinned to the trailing edge: the hero reserves the
          // space itself, so unlike `detail` it never squeezes the title. One
          // header for the popout and the app window, so one place, always the
          // same number — and that number comes from manifest.json via the host.
          trailingControl: Component {
            Text {
              id: versionTag
              visible: root.version !== ""
              text: root.version
              textFormat: Text.PlainText
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: root.fontCaption
            }
          }
        }

        PanelSeparator { Layout.fillWidth: true; foreground: root.foreground }

        // ---------------------------------------------------- scroll body
        Flickable {
          id: threadFlick
          Layout.fillWidth: true
          Layout.fillHeight: true
          contentWidth: width
          contentHeight: listContent.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          interactive: contentHeight > height
          ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

          // Wheel scrolling is DIRECT, 1:1 — no animation. Two animated
          // schemes (restarted easing, SmoothedAnimation chase) both fought
          // the MX Master's hi-res event flood and felt broken; hi-res
          // wheels are smooth by HARDWARE, so applying each delta
          // immediately is what a browser does and what reads as smooth.
          // The handler owns the event outright so the Flickable's own
          // wheel path can never double-apply it.
          // MouseArea.onWheel, NOT WheelHandler: instrumentation proved the
          // WheelHandler never received a single event on this stack — every
          // "stride" tweak was a placebo and the Flickable's native kinetic
          // path (the decaying one) was doing the scrolling. Omarchy's own
          // panels use MouseArea.onWheel; it works. NoButton + z:-1 so it
          // never steals clicks/hover from the rows above it.
          MouseArea {
            anchors.fill: parent
            z: -1
            acceptedButtons: Qt.NoButton
            onWheel: function(wheel) {
              var d = wheel.pixelDelta.y !== 0 ? wheel.pixelDelta.y * 3.0 : wheel.angleDelta.y * 4.5
              var max = Math.max(0, threadFlick.contentHeight - threadFlick.height)
              threadFlick.contentY = Math.max(0, Math.min(max, threadFlick.contentY - d))
              wheel.accepted = true
            }
          }

          ColumnLayout {
            id: listContent
            width: parent.width
            spacing: root.inThread ? Style.space(2) : Style.space(root.splitView ? 10 : 6)

            // ------------------------------------------------- OFFLINE
            Text {
              Layout.fillWidth: true
              visible: !root.online
              text: "The Mac is not reachable, so there is no iMessage bridge right now. "
                  + "chat.db and the AppleScript send path both live on the Mac — this machine is only a client. "
                  + "Wake the Mac (or check the network) and Blip reconnects on its own."
              textFormat: Text.PlainText
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: root.fontBodySmall
              wrapMode: Text.WordWrap
            }
            // Reachable but broken — say exactly what to fix (Full Disk Access,
            // Automation, blip-setup). collector.explainBridgeError writes it.
            Text {
              Layout.fillWidth: true
              visible: root.online && root.hostWidget && !root.hostWidget.healthy
                       && String(root.hostWidget.lastError || "") !== ""
              text: "⚠ " + String(root.hostWidget ? root.hostWidget.lastError : "")
              textFormat: Text.PlainText
              color: root.urgent
              font.family: root.fontFamily
              font.pixelSize: root.fontBodySmall
              wrapMode: Text.WordWrap
            }

            // ---------------------------------------------- LIST VIEW
            RowLayout {
              Layout.fillWidth: true
              visible: root.online && root.listShowing
              PanelSectionHeader {
                Layout.fillWidth: true
                text: root.newMode ? "NEW MESSAGE" : root.searchShowing ? "SEARCH" : "MESSAGES"
                foreground: root.foreground
                fontFamily: root.fontFamily
              }
              // A real button (PanelActionButton = the stock panels' control).
              // The hand-rolled Text+MouseArea version lost its clicks to the
              // panel's dismiss layer — clicking it CLOSED the panel.
              PanelActionButton {
                visible: !root.newMode && !root.searchShowing && !root.splitView
                iconText: "＋"
                tooltipText: "New message (n)"
                bordered: true
                foreground: root.foreground
                hoverColor: root.accent
                fontFamily: root.fontFamily
                onClicked: root.startNew()
              }
              // Open the full app window. Hidden in the app itself (it IS the
              // window) and in the split/search/new views, like ＋.
              PanelActionButton {
                visible: !root.newMode && !root.searchShowing && !root.splitView
                iconText: "⇱"
                tooltipText: "Open the app window (SUPER+M)"
                bordered: true
                foreground: root.foreground
                hoverColor: root.accent
                fontFamily: root.fontFamily
                onClicked: root.openApp()
              }
              // Local only: moves readMark/readMarks in state.json so the
              // badge and dots clear. Nothing is written back to the Mac —
              // AppleScript cannot flip is_read (see "not possible" in CLAUDE.md).
              // TapHandler, not MouseArea: the thread rows' proven pattern —
              // the MouseArea version could lose clicks to the dismiss layer.
              Text {
                id: markAllBtn
                visible: root.unread > 0 && !root.searchShowing && !root.newMode
                text: "mark all read"
                textFormat: Text.PlainText
                color: markAllHover.hovered ? root.mineFill : root.cyan
                font.family: root.fontFamily
                font.pixelSize: root.fontCaption
                font.underline: markAllHover.hovered
                HoverHandler { id: markAllHover; cursorShape: Qt.PointingHandCursor }
                TapHandler { onTapped: root.markAllRead() }
              }
            }

            // ------------------------------------------------ SEARCH
            // The box is ALWAYS visible in list view — a hidden search
            // behind a key nobody presses is a search that does not exist
            // (Fred: "I don't see search"). Click it or press `/`.
            // ---------------------------------------- NEW CONVERSATION
            TextField {
              id: newField
              Layout.fillWidth: true
              visible: root.online && root.listShowing && root.newMode
              placeholderText: "name, number, or email"
              foreground: root.foreground
              accent: root.accent
              font.family: root.fontFamily
              font.pixelSize: root.fontBodySmall
              onAccepted: root.acceptNewField()
              Keys.onEscapePressed: root.exitNew()
              Keys.onPressed: function(event) {
                if (event.key === Qt.Key_Down) { root.moveNewCursor(1); event.accepted = true }
                else if (event.key === Qt.Key_Up) { root.moveNewCursor(-1); event.accepted = true }
              }
              onVisibleChanged: if (visible) {
                forceActiveFocus()
                selectAll()
              }
            }

            Text {
              Layout.fillWidth: true
              visible: root.newMode && root.newNote !== ""
              text: root.newNote
              textFormat: Text.PlainText
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: root.fontCaption
            }

            Repeater {
              model: root.online && root.listShowing && root.newMode ? root.newResults : []
              delegate: Rectangle {
                required property var modelData
                required property int index
                Layout.fillWidth: true
                implicitHeight: contactRow.implicitHeight + Style.space(12)
                radius: Style.cornerRadius
                color: contactHover.hovered || root.newCursor === index
                  ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08)
                  : "transparent"
                HoverHandler { id: contactHover }
                TapHandler { onTapped: root.openContact(modelData) }
                RowLayout {
                  id: contactRow
                  anchors.left: parent.left
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  anchors.leftMargin: Style.space(8)
                  anchors.rightMargin: Style.space(8)
                  spacing: Style.space(8)
                  Text {
                    text: String(modelData.name || "")
                    textFormat: Text.PlainText
                    elide: Text.ElideRight
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: root.fontBodySmall
                    font.bold: true
                  }
                  Text {
                    Layout.fillWidth: true
                    text: String(modelData.handle || "") + "  ·  " + String(modelData.kind || "")
                    textFormat: Text.PlainText
                    elide: Text.ElideRight
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: root.fontCaption
                  }
                }
              }
            }

            TextField {
              id: searchField
              Layout.fillWidth: true
              visible: root.online && root.listShowing && !root.newMode
              placeholderText: "name or message"
              foreground: root.foreground
              accent: root.accent
              font.family: root.fontFamily
              font.pixelSize: root.fontBodySmall
              onAccepted: root.acceptSearchField()
              onActiveFocusChanged: if (activeFocus && !root.searching) root.searching = true
              Keys.onEscapePressed: root.exitSearch()
              Keys.onPressed: function(event) {
                if (event.key === Qt.Key_Down) { root.moveSearchCursor(1); event.accepted = true }
                else if (event.key === Qt.Key_Up) { root.moveSearchCursor(-1); event.accepted = true }
              }
            }

            // Read-only mirror of Messages' pinned section. These tiles have
            // no preview: the Mac owns pinning, while Blip only renders the
            // ordered avatars and names above the ordinary conversation rows.
            GridLayout {
              id: pinnedGrid
              Layout.fillWidth: true
              visible: root.online && root.listShowing && !root.searchShowing && !root.newMode
                       && root.pinnedThreads.length > 0
              columns: 3
              columnSpacing: Style.space(8)
              rowSpacing: Style.space(10)
              Layout.topMargin: Style.space(8)
              Layout.bottomMargin: Style.space(8)

              Repeater {
                model: pinnedGrid.visible ? root.pinnedThreads : []
                delegate: Rectangle {
                  required property var modelData
                  Layout.fillWidth: true
                  Layout.preferredWidth: Math.max(1, (pinnedGrid.width - pinnedGrid.columnSpacing * 2) / 3)
                  implicitHeight: pinnedColumn.implicitHeight + Style.space(4)
                  radius: Style.cornerRadius
                  // j/k walk root.threads, and pinned threads sort FIRST in it —
                  // without this the cursor was invisible for those presses.
                  color: pinnedHover.hovered || root.cursor === root.threadIndex(modelData)
                    ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08)
                    : "transparent"

                  HoverHandler { id: pinnedHover }
                  TapHandler { onTapped: root.openThread(modelData) }

                  ColumnLayout {
                    id: pinnedColumn
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.top: parent.top
                    spacing: Style.space(4)

                    Rectangle {
                      id: pinnedAvatar
                      Layout.alignment: Qt.AlignHCenter
                      width: Math.min(88, Math.max(56,
                        (pinnedGrid.width - pinnedGrid.columnSpacing * 2) / 3 * 0.62))
                      height: width
                      radius: width / 2
                      color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.18)
                      readonly property string avatarHandle: root.isGroupId(String(modelData.chat || "")) ? String(modelData.chat) : String(modelData.handle || modelData.chat || "")
                      Component.onCompleted: root.requestAvatar(avatarHandle)

                      Image {
                        id: pinnedAvatarImg
                        anchors.fill: parent
                        visible: false
                        source: root.avatarFiles[pinnedAvatar.avatarHandle] || ""
                        asynchronous: true
                        fillMode: Image.PreserveAspectCrop
                        autoTransform: true
                        sourceSize.width: 192
                        sourceSize.height: 192
                        onStatusChanged: if (status === Image.Error && pinnedAvatar.avatarHandle !== "") {
                          var m = Object.assign({}, root.avatarFiles); m[pinnedAvatar.avatarHandle] = ""; root.avatarFiles = m
                        }
                      }
                      Item {
                        id: pinnedAvatarMask
                        anchors.fill: parent
                        visible: false
                        layer.enabled: true
                        Rectangle { anchors.fill: parent; radius: width / 2 }
                      }
                      MultiEffect {
                        anchors.fill: parent
                        source: pinnedAvatarImg
                        visible: pinnedAvatarImg.status === Image.Ready
                        maskEnabled: true
                        maskSource: pinnedAvatarMask
                      }
                      Text {
                        anchors.centerIn: parent
                        visible: pinnedAvatarImg.status !== Image.Ready
                        text: root.avatarInitials(modelData)
                        color: root.foreground
                        font.family: root.fontFamily
                        font.pixelSize: root.fontBody
                        font.bold: true
                      }

                      // The unread dot. Pinned threads live ONLY here — the list
                      // below is unpinnedThreads — so this is the one place a
                      // pinned conversation can say it has something new. The
                      // count under the tile went in 2.3.1 and took the signal
                      // with it: a bold caption at 11px is not a signal (2.3.2,
                      // one unread in a pinned group, badge 1, "nothing new in
                      // the app"). Messages puts a blue dot at the top-left of
                      // the pinned circle; the ring keeps it readable on a photo.
                      Rectangle {
                        id: pinnedUnreadDot
                        visible: modelData.unread > 0
                        width: Style.space(14); height: width; radius: width / 2
                        anchors.left: parent.left
                        anchors.top: parent.top
                        anchors.leftMargin: -Style.space(1)
                        anchors.topMargin: -Style.space(1)
                        color: Color.background
                        Rectangle {
                          anchors.centerIn: parent
                          width: Style.space(9); height: width; radius: width / 2
                          color: root.mineFill
                        }
                      }
                    }

                    // No number under the tile (Fred, 2.3.1). 1-9 still jumps —
                    // handleTextKey indexes threads[] directly and never needed
                    // the label; the digit was a hint, not the mechanism.
                    Text {
                      Layout.fillWidth: true
                      text: String(modelData.name || modelData.chat)
                      textFormat: Text.PlainText
                      horizontalAlignment: Text.AlignHCenter
                      elide: Text.ElideRight
                      color: root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: root.fontCaption
                      font.bold: modelData.unread > 0
                    }
                  }
                }
              }
            }

            Text {
              Layout.fillWidth: true
              visible: root.searching && root.searchNote !== ""
              text: root.searchNote
              textFormat: Text.PlainText
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: root.fontCaption
            }

            Repeater {
              model: root.online && root.listShowing && root.searchShowing ? root.searchResults : []
              delegate: Rectangle {
                required property var modelData
                required property int index
                Layout.fillWidth: true
                implicitHeight: hitCol.implicitHeight + Style.space(12)
                radius: Style.cornerRadius
                color: hitHover.hovered || root.searchCursor === index
                  ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08)
                  : "transparent"
                HoverHandler { id: hitHover }
                TapHandler { onTapped: root.openSearchHit(modelData) }

                ColumnLayout {
                  id: hitCol
                  anchors.left: parent.left
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  anchors.leftMargin: Style.space(8)
                  anchors.rightMargin: Style.space(8)
                  spacing: Style.space(2)
                  RowLayout {
                    Layout.fillWidth: true
                    Text {
                      Layout.fillWidth: true
                      text: String(modelData.name || modelData.chat)
                            + (modelData.kind === "conversation" ? "  ·  conversation"
                              : modelData.group ? "  ·  group" : "")
                      textFormat: Text.PlainText
                      elide: Text.ElideRight
                      color: root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: root.fontBodySmall
                      font.bold: true
                    }
                    Text {
                      text: String(modelData.ts || "").slice(0, 16)
                      textFormat: Text.PlainText
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: root.fontCaption
                    }
                  }
                  Text {
                    Layout.fillWidth: true
                    text: modelData.kind === "conversation"
                      ? String(modelData.text || modelData.handle || "")
                      : ((modelData.from_me ? "you: " : "") + String(modelData.text || ""))
                    textFormat: Text.PlainText
                    elide: Text.ElideRight
                    maximumLineCount: 2
                    wrapMode: Text.WordWrap
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: root.fontCaption
                  }
                }
              }
            }

            Text {
              Layout.fillWidth: true
              visible: root.online && root.listShowing && !root.searchShowing && !root.newMode && root.threads.length === 0
              text: "No threads in the current window yet — press r to refresh."
              textFormat: Text.PlainText
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: root.fontBodySmall
              wrapMode: Text.WordWrap
            }

            Repeater {
              model: root.online && root.listShowing && !root.searchShowing && !root.newMode ? root.unpinnedThreads : []
              delegate: Rectangle {
                required property var modelData
                required property int index

                Layout.fillWidth: true
                implicitHeight: rowRow.implicitHeight + Style.space(root.splitView ? 20 : 12)
                radius: Style.cornerRadius
                color: rowHover.hovered || root.cursor === root.threadIndex(modelData)
                  ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08)
                  : "transparent"

                HoverHandler { id: rowHover }
                TapHandler { onTapped: root.openThread(modelData) }

                RowLayout {
                  id: rowRow
                  anchors.fill: parent
                  anchors.margins: Style.space(6)
                  spacing: Style.space(8)

                  // the iMessage blue dot — present only while the thread has
                  // unread inbound; the slot stays so names line up.
                  Rectangle {
                    width: Style.space(9); height: width; radius: width / 2
                    color: root.mineFill
                    opacity: modelData.unread > 0 ? 1 : 0
                  }

                  // avatar circle — the contact's photo when Contacts has one,
                  // initials otherwise (the iMessage sidebar look)
                  Rectangle {
                    id: avatarCircle
                    // Messages' sidebar avatar is large relative to the row;
                    // 30 looked like a contact list, not a conversation list.
                    width: Style.space(34); height: width; radius: width / 2
                    color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.18)
                    // A group binds to ITS OWN chat id (its Messages group photo); a DM to
                    // the person. Binding a group to `handle` showed whoever spoke last —
                    // their cached contact photo one minute, initials the next.
                    readonly property string avatarHandle: root.isGroupId(String(modelData.chat || "")) ? String(modelData.chat) : String(modelData.handle || modelData.chat || "")
                    Component.onCompleted: root.requestAvatar(avatarHandle)
                    Image {
                      id: avatarImg
                      anchors.fill: parent
                      visible: false
                      source: root.avatarFiles[avatarCircle.avatarHandle] || ""
                      asynchronous: true
                      fillMode: Image.PreserveAspectCrop
                      autoTransform: true
                      sourceSize.width: 96
                      sourceSize.height: 96
                      // a stale/corrupt cache file → initials, and no retry this session
                      onStatusChanged: if (status === Image.Error && avatarCircle.avatarHandle !== "") {
                        var m = Object.assign({}, root.avatarFiles); m[avatarCircle.avatarHandle] = ""; root.avatarFiles = m
                      }
                    }
                    Item {
                      id: avatarMask
                      anchors.fill: parent
                      visible: false
                      layer.enabled: true
                      Rectangle { anchors.fill: parent; radius: width / 2 }
                    }
                    MultiEffect {
                      anchors.fill: parent
                      source: avatarImg
                      visible: avatarImg.status === Image.Ready
                      maskEnabled: true
                      maskSource: avatarMask
                    }
                    Text {
                      anchors.centerIn: parent
                      visible: avatarImg.status !== Image.Ready
                      text: root.avatarInitials(modelData)
                      color: root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: root.fontCaption
                      font.bold: true
                    }
                  }

                  ColumnLayout {
                    Layout.fillWidth: true
                    spacing: Style.space(1)
                    RowLayout {
                      Layout.fillWidth: true
                      spacing: Style.space(6)
                      Text {
                        Layout.fillWidth: true
                        text: String(modelData.name || modelData.chat)
                        textFormat: Text.PlainText
                        elide: Text.ElideRight
                        color: root.foreground
                        font.family: root.fontFamily
                        font.pixelSize: root.fontBodySmall
                        // Messages keeps the name semibold ALWAYS; unread is
                        // carried by the dot and the blue timestamp, not by
                        // the name suddenly changing weight.
                        font.weight: modelData.unread > 0 ? Font.Bold : Font.DemiBold
                      }
                      Text {
                        text: root.fmtTime(modelData.last_ts)
                        textFormat: Text.PlainText
                        color: modelData.unread > 0 ? root.mineFill : root.dim
                        font.family: root.fontFamily
                        font.pixelSize: root.fontCaption
                      }
                    }
                    // TWO lines, wrapped — the single most recognisable thing
                    // about the Messages sidebar. One elided line reads like a
                    // mail client; two lines of preview reads like Messages.
                    Text {
                      Layout.fillWidth: true
                      text: (modelData.last_from_me ? "You: " : "") + String(modelData.last_text || "")
                      textFormat: Text.PlainText
                      wrapMode: Text.Wrap
                      elide: Text.ElideRight
                      maximumLineCount: 2
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: root.fontCaption
                      lineHeight: 1.15
                    }
                  }

                }
              }
            }

          }
        }
      }
    }

    Rectangle {
      visible: root.splitView
      Layout.preferredWidth: 1
      Layout.fillHeight: true
      color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)
    }

    // ------------------------------------------------- conversation pane
    Item {
      id: conversationPane
      visible: root.splitView || root.inThread
      Layout.fillHeight: true
      Layout.fillWidth: true
      ColumnLayout {
        anchors.fill: parent
        // Gutters for the app: the popout's card supplies its own padding,
        // the window's panes had text flush against the borders (Fred).
        anchors.leftMargin: root.splitView ? Style.space(18) : 0
        anchors.rightMargin: root.splitView ? Style.space(18) : 0
        anchors.topMargin: root.splitView ? Style.space(10) : 0
        anchors.bottomMargin: root.splitView ? Style.space(10) : 0
        spacing: Style.space(8)
        RowLayout {
          Layout.fillWidth: true
          spacing: Style.space(8)
          PanelHero {
            Layout.fillWidth: true
            title: root.inThread ? String(root.active.name || root.active.chat) : "Select a conversation"
            meta: root.inThread
              ? (root.activeIsGroup
                  ? (root.isSendable(root.active) ? "group" : "group · read-only (id unknown)")
                  : String(root.active.handle))
              : ""
            detail: root.inThread
              ? (root.loading ? "loading…" : (root.splitView ? "" : "Esc = back"))
              : ""
            foreground: root.foreground
            fontFamily: root.fontFamily
          }
          // The app's NEW button lives up here (where "Esc = back" used to be).
          PanelActionButton {
            visible: root.splitView && !root.newMode
            Layout.alignment: Qt.AlignTop
            Layout.topMargin: Style.space(6)
            iconText: "＋"
            tooltipText: "New message (n)"
            bordered: true
            foreground: root.foreground
            hoverColor: root.accent
            fontFamily: root.fontFamily
            onClicked: root.startNew()
          }
        }

        PanelSeparator { Layout.fillWidth: true; foreground: root.foreground }

        // ---------------------------------------------------- scroll body
        Flickable {
          id: flick
          Layout.fillWidth: true
          Layout.fillHeight: true
          contentWidth: width
          contentHeight: content.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          // NOT interactive: wheel scrolling is MouseArea.onWheel (see CLAUDE.md),
          // and an interactive Flickable grabs every drag — which is exactly what
          // selecting text in a bubble is; a slightly-moving click on a link
          // became a flick instead of an activation.
          interactive: false
          ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
          // stick-to-bottom (BlueFerry's pattern): once pinned, KEEP the
          // view at the bottom through late content growth — async images
          // finishing their decode were pushing the newest bubble below
          // the fold. Scrolling up releases the stick; scrolling back to
          // the end re-arms it.
          property bool stick: false
          onContentHeightChanged: {
            if (!root.inThread) return
            if (root.pinToBottom) {
              stick = true
              contentY = Math.max(0, contentHeight - height)
              if (!root.loading) root.pinToBottom = false
            } else if (stick) {
              contentY = Math.max(0, contentHeight - height)
            }
          }
          onMovementStarted: stick = false
          onMovementEnded: stick = atYEnd
          // A reload deferred while the user read history fires the moment
          // they return to the bottom.
          onStickChanged: if (stick && root.pushPending) {
            root.pushPending = false
            Qt.callLater(root.pushReload)
          }

          // Wheel scrolling is DIRECT, 1:1 — no animation. Two animated
          // schemes (restarted easing, SmoothedAnimation chase) both fought
          // the MX Master's hi-res event flood and felt broken; hi-res
          // wheels are smooth by HARDWARE, so applying each delta
          // immediately is what a browser does and what reads as smooth.
          // The handler owns the event outright so the Flickable's own
          // wheel path can never double-apply it.
          // MouseArea.onWheel, NOT WheelHandler: instrumentation proved the
          // WheelHandler never received a single event on this stack — every
          // "stride" tweak was a placebo and the Flickable's native kinetic
          // path (the decaying one) was doing the scrolling. Omarchy's own
          // panels use MouseArea.onWheel; it works. NoButton + z:-1 so it
          // never steals clicks/hover from the rows above it.
          MouseArea {
            anchors.fill: parent
            z: -1
            acceptedButtons: Qt.NoButton
            onWheel: function(wheel) {
              var d = wheel.pixelDelta.y !== 0 ? wheel.pixelDelta.y * 3.0 : wheel.angleDelta.y * 4.5
              // the wheel bypasses Flickable movement signals — the helper
              // maintains the bottom-stick too
              root.scrollConversation(-d)
              wheel.accepted = true
            }
          }

          // The bubble cursor: one translucent band behind the selected row,
          // the list rows' fill. A sibling of `content`, not a child of the
          // layout, so no delegate carries a background of its own; the row's
          // y/height are in `content` space, which sits at the origin here.
          Rectangle {
            visible: root.bubbleCursorItem !== null
            width: content.width
            y: root.bubbleCursorItem ? root.bubbleCursorItem.y - Style.space(2) : 0
            height: root.bubbleCursorItem ? root.bubbleCursorItem.height + Style.space(4) : 0
            radius: Style.cornerRadius
            // Omarchy's cursor fill: the theme's hover-cursor colour and alpha
            // (foreground at 0.08 by default), not a hard-coded copy of them.
            color: Style.hoverFillFor(root.foreground, root.accent)
          }
          ColumnLayout {
            id: content
            width: parent.width
            spacing: root.inThread ? Style.space(2) : Style.space(6)

            // ------------------------------------------- CONVERSATION
            Text {
              Layout.fillWidth: true
              visible: root.inThread && root.loading
              text: "loading…"
              horizontalAlignment: Text.AlignHCenter
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: root.fontCaption
            }

            Repeater {
              model: root.inThread ? root.bubbles : []
              delegate: ColumnLayout {
                id: bubbleRow
                required property var modelData
                required property int index
                readonly property bool mine: modelData.from_me === true
                readonly property bool hasCursor: root.bubbleCursor === index
                onHasCursorChanged: if (hasCursor) root.bubbleCursorItem = bubbleRow

                Layout.fillWidth: true
                spacing: Style.space(2)

                // day divider — "Today", "Yesterday", "Aug 28"
                Text {
                  Layout.fillWidth: true
                  visible: String(modelData.day || "") !== ""
                  text: String(modelData.day || "")
                  horizontalAlignment: Text.AlignHCenter
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: root.fontCaption
                  font.bold: true
                  topPadding: Style.space(10)
                  bottomPadding: Style.space(4)
                }

                // in a group, iMessage names the sender above each run of theirs
                Text {
                  Layout.alignment: Qt.AlignLeft
                  Layout.leftMargin: Style.space(10)
                  Layout.topMargin: Style.space(6)
                  visible: root.activeIsGroup && !bubbleRow.mine && modelData.groupStart === true
                  text: String(modelData.name || "")
                  textFormat: Text.PlainText
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: root.fontCaption
                }

                // "You unsent a message" tombstone replaces a retracted bubble
                RowLayout {
                  Layout.fillWidth: true
                  visible: modelData.retracted === true
                  spacing: 0
                  Item { Layout.fillWidth: true; visible: bubbleRow.mine }
                  Text {
                    text: (bubbleRow.mine ? "You" : String(modelData.name || "They")) + " unsent a message"
                    textFormat: Text.PlainText
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: root.fontCaption
                    font.italic: true
                    padding: Style.space(4)
                  }
                  Item { Layout.fillWidth: true; visible: !bubbleRow.mine }
                }

                // inline-reply context: the quoted snippet, dimmed, above the bubble
                RowLayout {
                  Layout.fillWidth: true
                  visible: !modelData.retracted && String(modelData.replyText || "") !== ""
                  Layout.topMargin: modelData.groupStart ? Style.space(6) : 0
                  spacing: 0
                  Item { Layout.fillWidth: true; visible: bubbleRow.mine }
                  Rectangle {
                    Layout.preferredWidth: Math.min(Math.ceil(replySnippet.implicitWidth) + Style.space(18), Math.round(content.width * 0.7))
                    Layout.preferredHeight: Math.ceil(replySnippet.implicitHeight) + Style.space(10)
                    radius: Style.space(12)
                    color: "transparent"
                    border.color: root.dim
                    border.width: 1
                    opacity: 0.75
                    Text {
                      id: replySnippet
                      x: Style.space(9); y: Style.space(5)
                      width: Math.round(content.width * 0.7) - Style.space(18)
                      text: "↩ " + (modelData.replyMine ? "You: " : "") + String(modelData.replyText || "")
                      textFormat: Text.PlainText
                      elide: Text.ElideRight
                      maximumLineCount: 1
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: root.fontCaption
                    }
                  }
                  Item { Layout.fillWidth: true; visible: !bubbleRow.mine }
                }

                // attachment chips — metadata only, the file itself is on the
                // Mac. One chip per ROW: a single horizontal run of chips once
                // summed its implicit widths into the delegate and stretched
                // the whole column past the panel edge (a URL message can
                // carry several attachments).
                Repeater {
                  model: modelData.retracted ? [] : (modelData.attachments || [])
                  delegate: RowLayout {
                    id: chipRow
                    required property var modelData
                    required property int index
                    // THE scroll killer (Fred: "each scroll gets smaller and
                    // smaller until it stops"): while reading history, image
                    // fetches complete and each chip ABOVE the viewport grows
                    // ~10× — content expansion visually cancels every wheel
                    // motion. Compensate: when this row grows above the
                    // viewport top, shift contentY by the same delta so the
                    // reader's position is anchored.
                    property real prevH: -1
                    onHeightChanged: {
                      if (prevH < 0) { prevH = height; return }
                      var d = height - prevH
                      prevH = height
                      if (d === 0 || flick.stick || root.pinToBottom) return
                      var yc = chipRow.mapToItem(content, 0, 0).y
                      if (yc < flick.contentY)
                        flick.contentY = Math.max(0, flick.contentY + d)
                    }
                    readonly property string attId: String(modelData.id || "")
                    // undefined = not fetched, "" = failed, else file:// url
                    readonly property var fileUrl: root.attFiles[chipRow.attId]
                    readonly property bool failed: chipRow.fileUrl === ""
                    readonly property var imageMetrics: root.attMetrics[chipRow.attId] || ({})
                    readonly property bool showImage:
                      root.isImageMime(chipRow.modelData.mime) &&
                      chipRow.fileUrl !== undefined && chipRow.fileUrl !== ""
                    Layout.fillWidth: true
                    Layout.topMargin: index === 0 && bubbleRow.modelData.groupStart ? Style.space(6) : 0
                    spacing: 0
                    Item { Layout.fillWidth: true; visible: bubbleRow.mine }

                    // fetched image renders inline, like Messages; click = full view
                    Image {
                      id: attImage
                      visible: chipRow.showImage
                      readonly property real maxW: Math.round(content.width * 0.6)
                      // Retina PNGs carry their density in the header (read by
                      // fetch.ts); divide it out so a 2x screenshot draws at
                      // its intended logical size. sourceSize bounds the decode
                      // below, so implicitWidth alone can't be trusted here.
                      readonly property real pixelRatio:
                        Number(chipRow.imageMetrics.pixelRatio || 1)
                      readonly property real naturalWidth:
                        Number(chipRow.imageMetrics.pixelWidth || 0) > 0
                          ? Number(chipRow.imageMetrics.pixelWidth) / pixelRatio
                          : implicitWidth
                      readonly property real naturalHeight:
                        Number(chipRow.imageMetrics.pixelHeight || 0) > 0
                          ? Number(chipRow.imageMetrics.pixelHeight) / pixelRatio
                          : implicitHeight
                      source: chipRow.showImage ? chipRow.fileUrl : ""
                      asynchronous: true
                      fillMode: Image.PreserveAspectFit
                      // iPhone photos store rotation as an EXIF tag, not in
                      // the pixels (sips keeps the tag when it converts HEIC);
                      // Qt ignores it unless asked, so portraits came out on
                      // their side. implicitWidth/Height follow the transform.
                      autoTransform: true
                      // bound the DECODE in BOTH axes, not just the paint — a
                      // 12MP photo (or a 100×100000 sliver) must not cost
                      // 50 MB of texture (Codex review points 19 and #3)
                      sourceSize.width: 800
                      sourceSize.height: 800
                      // LRU eviction or a corrupt file: fall back to the chip
                      // (⚠ marker); a click re-fetches through fetch.ts.
                      onStatusChanged: if (status === Image.Error) {
                        var m = Object.assign({}, root.attFiles)
                        m[chipRow.attId] = ""
                        root.attFiles = m
                      }
                      Layout.preferredWidth: status === Image.Ready ? Math.min(maxW, naturalWidth) : maxW
                      Layout.preferredHeight: status === Image.Ready && naturalWidth > 0
                        ? Layout.preferredWidth * naturalHeight / naturalWidth
                        : Style.space(120)
                      HoverHandler { cursorShape: Qt.PointingHandCursor }
                      TapHandler { onTapped: root.openAttachment(chipRow.modelData) }
                    }

                    Rectangle {
                      visible: !chipRow.showImage
                      Layout.preferredWidth: Math.ceil(chipText.implicitWidth) + Style.space(18)
                      Layout.preferredHeight: Math.ceil(chipText.implicitHeight) + Style.space(12)
                      radius: Style.space(14)
                      color: bubbleRow.mine ? root.mineFill : root.theirsFill
                      opacity: 0.85
                      Text {
                        id: chipText
                        anchors.centerIn: parent
                        text: (chipRow.failed ? "⚠ " : "") +
                              (root.fetchingId === chipRow.attId ? "⏳ " : "") +
                              root.attachmentIcon(chipRow.modelData.mime) + " " +
                              (String(chipRow.modelData.name || "").length > 32
                                ? String(chipRow.modelData.name).slice(0, 29) + "…"
                                : String(chipRow.modelData.name || "file"))
                        textFormat: Text.PlainText
                        color: bubbleRow.mine ? root.mineText : root.theirsText
                        font.family: root.fontFamily
                        font.pixelSize: root.fontCaption
                      }
                      HoverHandler { cursorShape: Qt.PointingHandCursor }
                      TapHandler { onTapped: root.openAttachment(chipRow.modelData) }
                    }
                    Item { Layout.fillWidth: true; visible: !bubbleRow.mine }
                  }
                }

                // rich-link card (URL balloons): preview image + title + host;
                // click opens the link. A message that is ONLY the URL shows
                // just the card, like Messages.
                RowLayout {
                  id: linkRow
                  // Apple's card if there is one; otherwise the one Blip
                  // fetched for the bare URL in this message.
                  readonly property string bareUrl: modelData.link ? "" : root.firstUrl(modelData.text)
                  readonly property var fetched: bareUrl !== "" ? root.linkCards[bareUrl] : null
                  Component.onCompleted: if (bareUrl !== "") root.requestPreview(bareUrl)
                  onBareUrlChanged: if (bareUrl !== "") root.requestPreview(bareUrl)
                  visible: !modelData.retracted && (!!modelData.link || !!fetched)
                  Layout.fillWidth: true
                  Layout.topMargin: modelData.groupStart ? Style.space(6) : 0
                  spacing: 0
                  // same anchoring as the chips: a card image completing ABOVE
                  // the viewport must not shove the reader's position.
                  property real prevH: -1
                  onHeightChanged: {
                    if (prevH < 0) { prevH = height; return }
                    var d = height - prevH
                    prevH = height
                    if (d === 0 || flick.stick || root.pinToBottom) return
                    var yc = linkRow.mapToItem(content, 0, 0).y
                    if (yc < flick.contentY)
                      flick.contentY = Math.max(0, flick.contentY + d)
                  }
                  Item { Layout.fillWidth: true; visible: bubbleRow.mine }
                  Rectangle {
                    id: linkCard
                    readonly property var link: modelData.link || linkRow.fetched || ({})
                    // Apple's preview is an attachment id fetched over ssh;
                    // ours is already a file on disk.
                    readonly property string imgUrl: modelData.link
                      ? (link.image_id ? String(root.attFiles[String(link.image_id)] || "") : "")
                      : String((linkRow.fetched && linkRow.fetched.image) || "")
                    Layout.preferredWidth: Math.min(Math.round(content.width * 0.62), Style.space(380))
                    Layout.preferredHeight: linkCol.implicitHeight
                    radius: Style.space(14)
                    clip: true
                    color: bubbleRow.mine ? root.mineFill : root.theirsFill
                    ColumnLayout {
                      id: linkCol
                      width: parent.width
                      spacing: 0
                      Image {
                        id: linkImage
                        visible: linkCard.imgUrl !== "" && status === Image.Ready
                        Layout.fillWidth: true
                        // Link artwork is often portrait or square. Preserve
                        // its natural aspect ratio instead of clipping every
                        // preview to the old shallow 220-unit banner.
                        Layout.preferredHeight: visible && implicitWidth > 0
                          ? Math.min(Style.space(480), Math.round(linkCard.width * implicitHeight / implicitWidth))
                          : 0
                        source: linkCard.imgUrl
                        asynchronous: true
                        fillMode: Image.PreserveAspectFit
                        autoTransform: true
                        sourceSize.width: 960
                        sourceSize.height: 960
                      }
                      ColumnLayout {
                        Layout.fillWidth: true
                        Layout.margins: Style.space(10)
                        spacing: Style.space(2)
                        Text {
                          Layout.fillWidth: true
                          visible: text !== ""
                          text: String(linkCard.link.title || "")
                          textFormat: Text.PlainText
                          wrapMode: Text.Wrap
                          maximumLineCount: 2
                          elide: Text.ElideRight
                          color: bubbleRow.mine ? root.mineText : root.theirsText
                          font.family: root.fontFamily
                          font.pixelSize: root.fontBodySmall
                          font.bold: true
                        }
                        Text {
                          Layout.fillWidth: true
                          visible: text !== ""
                          text: String(linkCard.link.summary || "")
                          textFormat: Text.PlainText
                          wrapMode: Text.Wrap
                          maximumLineCount: 2
                          elide: Text.ElideRight
                          color: bubbleRow.mine ? root.mineText : root.theirsText
                          opacity: 0.85
                          font.family: root.fontFamily
                          font.pixelSize: root.fontCaption
                        }
                        Text {
                          Layout.fillWidth: true
                          text: root.linkHost(String(linkCard.link.url || ""))
                          textFormat: Text.PlainText
                          elide: Text.ElideRight
                          color: bubbleRow.mine ? root.mineText : root.theirsText
                          opacity: 0.6
                          font.family: root.fontFamily
                          font.pixelSize: root.fontCaption
                        }
                      }
                    }
                    HoverHandler { cursorShape: Qt.PointingHandCursor }
                    TapHandler { onTapped: root.openLink(String(linkCard.link.url || "")) }
                    TapHandler { acceptedButtons: Qt.RightButton; onTapped: root.openShare(String(linkCard.link.url || "")) }
                  }
                  Item { Layout.fillWidth: true; visible: !bubbleRow.mine }
                }

                // the bubble in an explicit spacer row: a stretchy Item on
                // the sender's far side guarantees right/left placement even
                // when the delegate's own width collapses to its content.
                RowLayout {
                  Layout.fillWidth: true
                  // a tapback pill overlaps the top edge — leave room for it
                  Layout.topMargin: (modelData.groupStart ? Style.space(6) : 0)
                                    + ((modelData.tapbacks || []).length > 0 ? Style.space(12) : 0)
                  visible: !modelData.retracted &&
                           (String(modelData.text || "") !== "" || (modelData.attachments || []).length === 0) &&
                           // a message that is ONLY the URL shows just the card,
                           // like Messages — for Apple's card and for ours
                           !(modelData.link && String(modelData.text || "").trim() === String(modelData.link.url)) &&
                           !(!modelData.link && !!linkRow.fetched
                             && String(modelData.text || "").trim() === linkRow.bareUrl)
                  spacing: 0

                  Item { Layout.fillWidth: true; visible: bubbleRow.mine }

                  Rectangle {
                    id: bubble
                    readonly property real maxInner: Math.round(content.width * 0.78) - Style.space(22)
                    Layout.preferredWidth: Math.ceil(bubbleText.contentWidth) + Style.space(22)
                    Layout.preferredHeight: Math.ceil(bubbleText.contentHeight) + Style.space(14)
                    radius: Style.space(16)
                    color: bubbleRow.mine ? root.mineFill : root.theirsFill

                    // iMessage squares off the corner nearest the sender on the
                    // last bubble of a run — the "tail" without drawing a tail.
                    // Per-corner radius (Qt 6.7+), NOT a second Rectangle over
                    // the corner: theirsFill is translucent, and stacking two
                    // copies of it double-alphas the overlap into a visibly
                    // lighter square (seen on every received run-ending bubble).
                    bottomLeftRadius: modelData.groupEnd === true && !bubbleRow.mine ? 0 : radius
                    bottomRightRadius: modelData.groupEnd === true && bubbleRow.mine ? 0 : radius

                    // TextEdit, not Text: read-only but selectable, so a message
                    // can be highlighted and Ctrl+C'd like any other text.
                    TextEdit {
                      id: bubbleText
                      x: Style.space(11); y: Style.space(7)
                      width: bubble.maxInner
                      // html is pre-escaped + linkified in thread.ts (tested);
                      // plain messages keep the cheap PlainText path.
                      readonly property bool hasLink: String(modelData.html || "") !== ""
                      text: hasLink
                        ? root.richMessageHtml(
                            modelData.html,
                            bubbleRow.mine ? root.mineText : root.theirsText
                          )
                        : String(modelData.text || "")
                      textFormat: hasLink ? TextEdit.RichText : TextEdit.PlainText
                      // No onLinkActivated: the TapHandler below opens links (it
                      // survives selectByMouse); having both opened every link twice.
                      wrapMode: TextEdit.Wrap
                      readOnly: true
                      selectByMouse: true
                      persistentSelection: false
                      color: bubbleRow.mine ? root.mineText : root.theirsText
                      selectionColor: bubbleRow.mine ? "#ffffff" : root.mineFill
                      selectedTextColor: bubbleRow.mine ? root.mineFill : "#ffffff"
                      font.family: root.fontFamily
                      font.pixelSize: root.fontBodySmall
                      onActiveFocusChanged: root.bubbleFocused = activeFocus
                      Keys.onEscapePressed: { deselect(); composeField.forceActiveFocus() }
                      // Ctrl+C through wl-copy: Qt's own clipboard does not reliably
                      // reach Wayland from a layer-shell popout.
                      Keys.onPressed: function(e) {
                        if ((e.modifiers & Qt.ControlModifier) && (e.key === Qt.Key_C || e.key === Qt.Key_Insert)) {
                          if (selectedText !== "") root.copyText(selectedText)
                          e.accepted = true
                        }
                      }
                      HoverHandler {
                        cursorShape: bubbleText.hoveredLink !== "" ? Qt.PointingHandCursor : Qt.IBeamCursor
                      }
                      // Explicit: TextEdit's own linkActivated is unreliable once
                      // selectByMouse owns the press. A tap (no drag) on a link
                      // opens it; a drag still selects text.
                      TapHandler {
                        acceptedButtons: Qt.LeftButton
                        onTapped: function(eventPoint) {
                          var l = bubbleText.linkAt(eventPoint.position.x, eventPoint.position.y)
                          if (l && l !== "") root.openLink(String(l))
                        }
                      }
                    }

                    // right-click on a LINK = share sheet; anywhere else = copy the whole message
                    TapHandler {
                      acceptedButtons: Qt.RightButton
                      onTapped: function(eventPoint) {
                        var p = bubbleText.mapFromItem(bubble, eventPoint.position.x, eventPoint.position.y)
                        var l = bubbleText.hasLink ? bubbleText.linkAt(p.x, p.y) : ""
                        if (l && l !== "") root.openShare(String(l))
                        else root.copyText(String(modelData.text || ""))
                      }
                    }

                    // tapback pill overlapping the corner opposite the tail
                    Rectangle {
                      visible: (modelData.tapbacks || []).length > 0
                      width: Math.ceil(tapbackText.implicitWidth) + Style.space(12)
                      height: Math.ceil(tapbackText.implicitHeight) + Style.space(8)
                      radius: height / 2
                      color: bubbleRow.mine ? Qt.darker(root.mineFill, 2.2) : root.mineFill
                      border.color: Qt.rgba(0, 0, 0, 0.5)
                      border.width: 2
                      anchors.top: parent.top
                      anchors.topMargin: -Style.space(12)
                      anchors.right: bubbleRow.mine ? undefined : parent.right
                      anchors.rightMargin: bubbleRow.mine ? 0 : -Style.space(6)
                      anchors.left: bubbleRow.mine ? parent.left : undefined
                      anchors.leftMargin: bubbleRow.mine ? -Style.space(6) : 0
                      Text {
                        id: tapbackText
                        anchors.centerIn: parent
                        text: root.tapbackRow(modelData.tapbacks)
                        textFormat: Text.PlainText
                        font.pixelSize: root.fontCaption
                      }
                    }
                  }

                  Item { Layout.fillWidth: true; visible: !bubbleRow.mine }
                }

                // timestamp under the last bubble of a run, same spacer trick;
                // carries the "Edited" and "sent with <effect>" tags too
                RowLayout {
                  Layout.fillWidth: true
                  visible: String(modelData.time || "") !== "" ||
                           modelData.edited === true || String(modelData.effect || "") !== "" ||
                           modelData.failed === true
                  spacing: 0
                  Item { Layout.fillWidth: true; visible: bubbleRow.mine }
                  Text {
                    Layout.rightMargin: bubbleRow.mine ? Style.space(6) : 0
                    Layout.leftMargin: bubbleRow.mine ? 0 : Style.space(6)
                    text: [modelData.failed === true ? "⚠ Not Delivered" : "",
                           String(modelData.time || ""),
                           modelData.edited === true ? "Edited" : "",
                           String(modelData.effect || "") !== "" ? "sent with " + modelData.effect : ""]
                          .filter(function(s) { return s !== "" }).join(" · ")
                    textFormat: Text.PlainText
                    // a failed send is the one thing here that must not be dim
                    color: modelData.failed === true ? root.urgent : root.dim
                    font.bold: modelData.failed === true
                    font.family: root.fontFamily
                    font.pixelSize: root.fontCaption
                    bottomPadding: Style.space(4)
                  }
                  Item { Layout.fillWidth: true; visible: !bubbleRow.mine }
                }

                // "Read 4:42 PM" — only ever under the newest read from-me bubble
                RowLayout {
                  Layout.fillWidth: true
                  visible: String(modelData.receipt || "") !== ""
                  spacing: 0
                  Item { Layout.fillWidth: true }
                  Text {
                    Layout.rightMargin: Style.space(6)
                    text: String(modelData.receipt || "")
                    textFormat: Text.PlainText
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: root.fontCaption
                    font.bold: true
                    bottomPadding: Style.space(4)
                  }
                }

              }
            }

            Text {
              Layout.fillWidth: true
              visible: root.inThread && !root.loading && root.bubbles.length === 0
              text: "No messages loaded for this thread."
              horizontalAlignment: Text.AlignHCenter
              textFormat: Text.PlainText
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: root.fontBodySmall
            }
          }
        }
        // ------------------------------------------------------ COMPOSE
        PanelSeparator {
          Layout.fillWidth: true
          visible: root.inThread
          foreground: root.foreground
        }

        // queued attachment — one per message; ✕ removes it
        RowLayout {
          Layout.fillWidth: true
          visible: root.inThread && root.draftPath !== ""
          spacing: 0
          Rectangle {
            Layout.preferredWidth: Math.ceil(draftText.implicitWidth) + Style.space(18)
            Layout.preferredHeight: Math.ceil(draftText.implicitHeight) + Style.space(12)
            radius: Style.space(14)
            color: root.mineFill
            opacity: 0.9
            Text {
              id: draftText
              anchors.centerIn: parent
              text: "📎 " + (root.draftLabel.length > 40
                              ? root.draftLabel.slice(0, 37) + "…"
                              : root.draftLabel) + "   ✕"
              textFormat: Text.PlainText
              color: root.mineText
              font.family: root.fontFamily
              font.pixelSize: root.fontCaption
            }
            HoverHandler { cursorShape: Qt.PointingHandCursor }
            TapHandler { onTapped: root.clearDraft() }
          }
          Item { Layout.fillWidth: true }
        }

        RowLayout {
          Layout.fillWidth: true
          Layout.maximumWidth: parent.width
          visible: root.inThread
          spacing: Style.space(6)

          // Width must be assigned by the layout *before* wrap can happen.
          // A bare TextArea's implicitWidth is the unwrapped line, so RowLayout
          // otherwise grows with the text and the caret scrolls sideways.
          Item {
            id: composeSlot
            Layout.fillWidth: true
            Layout.preferredWidth: 0
            Layout.minimumWidth: 0
            Layout.alignment: Qt.AlignBottom
            Layout.preferredHeight: {
              var line = Math.ceil(composeField.font.pixelSize * 1.35)
              var pad = composeField.topPadding + composeField.bottomPadding
              var h = composeField.contentHeight + pad
              return Math.round(Math.min(Math.max(h, line + pad), line * 5 + pad))
            }
            clip: true

            TextArea {
              id: composeField
              anchors.fill: parent
              wrapMode: TextEdit.Wrap
              // NEVER disabled: this field is the panel's exclusive keyboard-focus
              // holder, and disabling the focused editor dismisses the whole
              // panel (0.7.2 postmortem; Codex design review #8). readOnly
              // instead; send() is the authoritative online/sendability guard.
              enabled: true
              readOnly: !root.online || !root.isSendable(root.active)
              placeholderText: root.draftPath !== ""
                ? "caption (optional) — Enter sends the file"
                : root.isSendable(root.active) ? "iMessage" : "Read-only — group id unknown"
              color: root.foreground
              placeholderTextColor: Qt.darker(root.foreground, 1.6)
              selectionColor: Style.selectionFillFor(root.foreground, root.mineFill)
              selectedTextColor: root.foreground
              font.family: root.fontFamily
              font.pixelSize: root.fontBodySmall
              readonly property var _composeBorder: Border.controlSpec(
                activeFocus ? "focus" : (hovered ? "hover-cursor" : "normal"),
                root.foreground, root.mineFill)
              leftPadding: Style.spacing.controlPaddingX + Border.left(_composeBorder)
              rightPadding: Style.spacing.controlPaddingX + Border.right(_composeBorder)
              topPadding: Style.spacing.inputPaddingY + Border.top(_composeBorder)
              bottomPadding: Style.spacing.inputPaddingY + Border.bottom(_composeBorder)
              background: BorderSurface {
                color: Style.controlFill(composeField.activeFocus, composeField.hovered, root.foreground, root.mineFill)
                borderSpec: composeField._composeBorder
                radius: Style.cornerRadius
              }
              // Esc drops a bubble selection first (back to the bottom), then
              // leaves the thread — the two-step Esc a text selection gets.
              Keys.onEscapePressed: if (root.bubbleCursor >= 0) root.leaveBubbles(); else root.back()
              // Ctrl+V goes through paste.ts: an image on the clipboard becomes
              // a draft chip; text falls through to a manual insert. One process
              // snapshots types AND data — probing then re-reading races.
              // Enter sends (iMessage); Shift+Enter inserts a newline.
              Keys.onPressed: (event) => {
                if (event.matches(StandardKey.Paste)) {
                  event.accepted = true
                  root.startPaste()
                  return
                }
                // Reading history without the mouse: the compose field is the
                // thread's focus holder, so the keys live here. An empty field
                // has no caret for Up/Down to move; they select bubbles instead.
                var empty = text.length === 0
                if (empty && (event.key === Qt.Key_Up || event.key === Qt.Key_Down)) {
                  event.accepted = true
                  root.moveBubbleCursor(event.key === Qt.Key_Up ? -1 : 1)
                  return
                }
                // Actions on the selected bubble. Enter is free here: with no
                // text and no queued file, send() would do nothing anyway.
                var b = empty && root.draftPath === "" ? root.selectedBubble() : null
                if (b) {
                  if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) { event.accepted = true; root.openBubble(b); return }
                  if (event.matches(StandardKey.Copy)) { event.accepted = true; root.copyBubble(b); return }
                  if (event.key === Qt.Key_R && (event.modifiers & Qt.ControlModifier)) { event.accepted = true; root.quoteBubble(b); return }
                }
                var dy = root.conversationStep(event.key, empty)
                if (dy !== 0) {
                  event.accepted = true
                  root.scrollConversation(dy)
                  return
                }
                if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter)
                    && !(event.modifiers & Qt.ShiftModifier)) {
                  event.accepted = true
                  root.send()
                }
              }
            }
          }

          // send button — the blue arrow circle (lit when text OR a file is queued)
          Rectangle {
            Layout.alignment: Qt.AlignBottom
            readonly property bool armed: composeField.text.trim() !== "" || root.draftPath !== ""
            width: Style.space(28); height: width; radius: width / 2
            color: armed ? root.mineFill : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.15)
            Text {
              anchors.centerIn: parent
              text: "↑"
              color: parent.armed ? "#ffffff" : root.dim
              font.family: root.fontFamily
              font.pixelSize: root.fontBody
              font.bold: true
            }
            TapHandler { onTapped: root.send() }
          }
        }

        // Always one line tall, empty or not: a note that appears and vanishes
        // must not shove the compose box and the bubbles around. Only failures
        // are red; progress and confirmations are dim.
        Text {
          Layout.fillWidth: true
          text: root.note === "" ? " " : root.note
          textFormat: Text.PlainText
          readonly property bool calm: root.note === "copied" || root.note === "sending…"
            || root.note === "sent to LocalSend" || root.note.indexOf("attached") === 0
          color: calm ? root.dim : root.urgent
          font.family: root.fontFamily
          font.pixelSize: root.fontCaption
          wrapMode: Text.WordWrap
        }
      }
    }
  }

    // drag a file from a file manager onto the open conversation → draft chip
    DropArea {
      anchors.fill: parent
      enabled: root.inThread
      keys: ["text/uri-list"]
      onDropped: (drop) => {
        if (!drop.hasUrls || drop.urls.length === 0) return
        var u = String(drop.urls[0])
        if (u.indexOf("file://") !== 0) return
        root.setDraft(decodeURIComponent(u.replace(/^file:\/\//, "")))
        drop.accept()
      }
    }

  // ---------------------------------------------------- share sheet
  // Right-click a link (bubble text or link card): open · copy · QR for a
  // phone · send to a device through LocalSend, which is Omarchy's own share
  // sheet (omarchy-menu-share). Esc or a click outside closes it. Buttons are
  // Rectangle+TapHandler like the thread rows — a MouseArea here would lose
  // its clicks to the panel's dismiss layer.
  Item {
    id: shareSheet
    anchors.fill: parent
    visible: root.shareUrl !== ""
    z: 500
    Rectangle {
      anchors.fill: parent
      color: Qt.rgba(0, 0, 0, 0.45)
      TapHandler { onTapped: root.closeShare() }
    }
    Rectangle {
      id: shareCard
      anchors.centerIn: parent
      width: Math.min(parent.width - Style.space(32), Style.space(360))
      height: shareCol.implicitHeight + Style.space(28)
      radius: Style.cornerRadius
      color: Color.background
      border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.18)
      border.width: 1
      TapHandler { }   // swallow clicks on the card so they never reach the scrim
      ColumnLayout {
        id: shareCol
        anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top
        anchors.margins: Style.space(14)
        spacing: Style.space(8)
        Text {
          Layout.fillWidth: true
          text: "SHARE LINK"
          color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.6)
          font.family: root.fontFamily; font.pixelSize: root.fontCaption; font.letterSpacing: 1
        }
        Text {
          Layout.fillWidth: true
          text: root.linkHost(root.shareUrl)
          color: root.foreground
          font.family: root.fontFamily; font.pixelSize: root.fontBody; font.bold: true
          elide: Text.ElideRight
        }
        Text {
          Layout.fillWidth: true
          text: root.shareUrl
          color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.7)
          font.family: root.fontFamily; font.pixelSize: root.fontCaption
          elide: Text.ElideMiddle
          maximumLineCount: 1
        }
        // QR for a phone camera: white quiet zone so dark themes scan.
        Rectangle {
          Layout.alignment: Qt.AlignHCenter
          Layout.topMargin: Style.space(4)
          width: Style.space(176); height: width
          radius: Style.cornerRadius
          color: "white"
          visible: root.shareQr !== ""
          Image {
            anchors.fill: parent; anchors.margins: Style.space(8)
            source: root.shareQr
            fillMode: Image.PreserveAspectFit
            smooth: false
            sourceSize.width: 400; sourceSize.height: 400
          }
        }
        Repeater {
          model: [
            { label: "Open in browser", act: "open" },
            { label: "Copy link", act: "copy" },
            { label: "Send to a device  ·  LocalSend", act: "send" }
          ]
          delegate: Rectangle {
            required property var modelData
            Layout.fillWidth: true
            height: Style.space(40)
            radius: Style.cornerRadius
            color: shareHover.hovered
              ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)
              : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.06)
            Text {
              anchors.centerIn: parent
              text: modelData.label
              color: root.foreground
              font.family: root.fontFamily; font.pixelSize: root.fontBodySmall
            }
            HoverHandler { id: shareHover; cursorShape: Qt.PointingHandCursor }
            TapHandler {
              onTapped: {
                if (modelData.act === "open") root.shareOpen()
                else if (modelData.act === "copy") root.shareCopy()
                else root.shareSend()
              }
            }
          }
        }
        Text {
          Layout.fillWidth: true
          horizontalAlignment: Text.AlignHCenter
          text: "Esc closes"
          color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.45)
          font.family: root.fontFamily; font.pixelSize: root.fontCaption
        }
      }
    }
  }
}
