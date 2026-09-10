import "SendState.mjs" as SendState
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

  PinnedShortcuts {
    pins: root.pinnedThreads
    active: root.surfaceOpen && !root.contactsOpen && root.shareUrl === ""
    onChosen: function(thread) {
      if (root.newMode) root.exitNew()
      if (root.searching) root.exitSearch()
      if (root.inThread && String(root.active.chat) === String(thread.chat)) root.focusDefault()
      else root.openThread(thread)
    }
  }

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
  readonly property int fontTitle: Math.max(1, Math.round(Style.font.title * uiFontScale))
  readonly property int fontCaption: Math.max(1, Math.round(Style.font.caption * uiFontScale))
  readonly property int fontBodySmall: Math.max(1, Math.round(Style.font.bodySmall * uiFontScale))
  readonly property int fontBody: Math.max(1, Math.round(Style.font.body * uiFontScale))
  readonly property color dim: Qt.darker(foreground, 1.45)
  /** An editor owns the keyboard — the host's key catcher must stand down. */
  readonly property bool editorActive:
    contactReview.opened || composeField.activeFocus || searchField.activeFocus || newField.activeFocus || bubbleFocused
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
  property var shareUrls: []       // the links the sheet was opened on
  property int shareIndex: 0       // which of them it shows; ←/→ and ‹ › step
  property int shareCursor: 0      // highlighted action (mouse and keys agree)
  property real shareKeysFrom: 0   // Enter and digits act from this time on
  /** Open the sheet on one URL or a list (a message's links, first showing).
   *  `auto`: it opened by itself — a link you sent, a link that arrived, IPC.
   *  The sheet is the warning either way (host, full URL, a button that says
   *  what Enter does), but for 700 ms after an auto sheet appears Enter and
   *  digits still belong to the draft, so a link landing as Enter is pressed
   *  to send is never opened by it. False when nothing in `u` is http(s). */
  function openShare(u, auto) {
    var urls = (Array.isArray(u) ? u : [u]).map(function(x) { return String(x || "") })
      .filter(function(x) { return /^https?:\/\//i.test(x) })
    if (urls.length === 0) return false
    shareUrls = urls
    shareIndex = 0
    shareCursor = 0
    shareKeysFrom = Date.now() + (auto === true ? 700 : 0)
    shareQr = ""
    showShareUrl(urls[0])
    return true
  }
  function shareStep(d) {
    var n = shareUrls.length
    if (n < 2) return
    shareIndex = (shareIndex + d + n) % n
    showShareUrl(shareUrls[shareIndex])
  }
  /** The QR for `u`. The box keeps the previous code until this one is
   *  written, so stepping swaps the image instead of re-flowing the card. */
  function showShareUrl(u) {
    shareUrl = u
    // A sheet opened over a still-rendering one: the old job's exit would have
    // published ITS result under the new outFile (Astra A#8). Kill it; the
    // non-zero exit keeps its result out. Stepping between links re-runs this,
    // so it matters more here than it did for one link.
    if (qrProc.running) qrProc.running = false
    var out = shareDir + "/qr-" + Date.now() + ".png"
    qrProc.outFile = out
    qrProc.command = ["sh", "-c", 'mkdir -p "$1" && chmod 700 "$1" && umask 077 && exec qrencode -o "$2" -s 6 -m 2 -l M', "blip", shareDir, out]
    qrProc.stdinEnabled = true
    qrProc.running = true
    qrProc.write(u)
    qrProc.stdinEnabled = false
  }
  function closeShare() { shareUrl = ""; shareQr = ""; shareUrls = [] }
  /** First http(s) URL in a string, or "" — mirrors collector.firstUrl. */
  function firstUrl(t) {
    var m = /https?:\/\/[^\s<>"']+/i.exec(String(t || ""))
    return m ? m[0].replace(/[.,;:!?)\]}'"]+$/, "") : ""
  }
  /** Every link in a message, in order, exactly as linkify() anchors them
   *  (same pattern, same trailing-punctuation rule, www. gets https://). */
  function allUrls(t) {
    var re = /\bhttps?:\/\/[^\s<>"']+|\bwww\.[^\s<>"']+\.[^\s<>"']+/gi, out = [], m
    while ((m = re.exec(String(t || ""))) !== null) {
      var u = m[0].replace(/[.,;:!?\]]+$/, "")
      while (u.endsWith(")") && u.split("(").length < u.split(")").length) u = u.slice(0, -1)
      u = u.replace(/[.,;:!?\]]+$/, "")
      if (/^www\./i.test(u)) u = "https://" + u
      if (out.indexOf(u) < 0) out.push(u)
    }
    return out
  }
  /** IPC `share <url>` (host gates it behind automation=on), and the host's
   *  arriving-link path, which hands over every link of the message. */
  function shareLink(u) {
    return openShare(u, true) ? "share sheet" : "not an http(s) url"
  }
  /** The full app window. The host owns creation (Quickshell never re-maps a
   *  hidden FloatingWindow), so this asks the widget, exactly like SUPER+M.
   *  The popout closes behind it — the same order the bar's own double-click
   *  uses, and leaving both up put the same conversation on screen twice. */
  function openApp() {
    closeShare()
    if (!hostWidget) return
    if (typeof hostWidget.showApp === "function") hostWidget.showApp()
  }
  /** The sheet's keys: Esc closes, ←/→ step links, ↑/↓ move the highlight,
   *  Enter takes it, 1/2/3 pick directly. Anything else falls through to the
   *  field (a sheet over a draft never blocks typing); see openShare for
   *  the grace on an auto sheet. True when the key was the sheet's. */
  function shareKey(key) {
    if (shareUrl === "") return false
    var acts = [shareOpen, shareCopy, shareSend]
    if (key === Qt.Key_Escape) { closeShare(); return true }
    // ←/→ are the sheet's only when there is something to step through; a
    // draft keeps its caret keys otherwise.
    if ((key === Qt.Key_Left || key === Qt.Key_Right) && shareUrls.length > 1) { shareStep(key === Qt.Key_Right ? 1 : -1); return true }
    if (key === Qt.Key_Up || key === Qt.Key_Down) { shareCursor = Math.max(0, Math.min(2, shareCursor + (key === Qt.Key_Down ? 1 : -1))); return true }
    if (Date.now() < shareKeysFrom) return false
    if (key === Qt.Key_Return || key === Qt.Key_Enter) { acts[shareCursor](); return true }
    if (key >= Qt.Key_1 && key <= Qt.Key_3) { acts[key - Qt.Key_1](); return true }
    return false
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
  // A conversation is READ only after a snapshot of it actually rendered.
  // `rendered` is false from openThread until bubbles land; a failed load
  // (timeout, bad JSON) leaves it false, so a later refresh cannot mark the
  // conversation read unseen (Astra A#2). `seenTs` is the newest ts IN that
  // snapshot — what the eye saw — and is what every read mark carries; the
  // sidebar's last_ts can be newer than anything on screen (Astra A#3).
  property bool rendered: false
  property string seenTs: ""
  property string note: ""           // transient status line (send result, errors)
  property int cursor: -1            // keyboard row selection in list view
  // Split view: the thread on screen because the cursor RESTED on its row, not
  // because the reader chose it. Read marks wait until they commit — Enter, a
  // click or typing all put focus in the compose field, which clears this.
  property bool peeking: false
  // Chat of the cursor row, so every row answers "am I the cursor?" with one
  // string compare instead of an O(n) scan of threads per row per keypress.
  readonly property string cursorChat: cursor >= 0 && cursor < threads.length ? String(threads[cursor].chat) : ""
  // The row drawing the keyboard cursor right now — a thread row, pinned tile,
  // search hit or contact hit registers itself when its hasCursor turns true,
  // so the move functions never translate indexes between the four models.
  // A destroyed row reads back as null (guarded QObject property).
  property Item cursorRow: null
  // The cursor is kept while the search field holds focus (Esc and Down
  // return to it), but a row must not LOOK selected while typing happens
  // elsewhere — Up from the top and a click in the field both got here.
  readonly property bool cursorShown: !searchField.activeFocus
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
  property string sendLocalId: ""
  property int nextSendId: 0
  property int pendingRevision: 0
  property int threadPendingRevision: 0
  property string sendStamp: ""         // local "YYYY-MM-DD HH:mm:ss" the current send was typed at
  // Text sends queue instead of refusing while one is on the wire; each gets
  // its bubble the instant Enter is pressed (see pendingSends).
  property var sendQueue: []
  // Sends the Mac has not written a row for yet, {chat, text, ts}. Every
  // thread reload carries them to thread.ts (--pending-stdin, never argv),
  // which keeps their bubbles until the real row lands. Memory only.
  property var pendingSends: []
  property int reloadTries: 0            // post-send reloads still waiting for the row
  property string reloadChat: ""

  function avatarInitials(thread) {
    var n = String(thread.name || "")
    if (/^[+0-9]/.test(n) || n === "") return "#"
    var parts = n.trim().split(/\s+/).filter(function(p) { return p.length > 0 })
    if (parts.length === 0) return "#"
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase()
  }

  readonly property bool contactsOpen: contactReview.opened
  readonly property bool inThread: active !== null && !contactReview.opened
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

  // Unsent compose text per chat id. It lives on the host (BarWidget.draftCache)
  // so the panel and the app window share it, and in memory only: message text
  // never lands on disk. Written in place: nothing binds to the map, so there
  // is no copy to make and no change to signal.
  readonly property var drafts: hostWidget ? hostWidget.draftCache : ({})

  /** Drop the thread on screen, peeked or opened: the pane is empty again, a
   *  load still in flight is ignored when it lands, and a share sheet over it
   *  goes too (it belonged to the link you were looking at). */
  function clearThread() {
    closeShare()
    peekTimer.stop()
    peeking = false
    active = null
    bubbles = []
    note = ""
    loading = false
    pendingThreadChat = ""
  }
  /** Leaving the list for the search or new-message field: a thread that was
   *  only peeked goes; one opened on purpose stays. */
  function endPeek() {
    peekTimer.stop()
    if (peeking) clearThread()
  }

  /** Back to the list view, scrolled to top — the host calls this on open. */
  function resetToList() {
    clearThread()
    contactReview.opened = false
    cursor = -1
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
    clearThread()
    composeField.text = ""
    clearDraft()   // a queued file must never survive into another thread
    pinToBottom = false
    // Top of the list for a mouse user; the cursor row for a keyboard user.
    Qt.callLater(function() {
      threadFlick.contentY = 0
      scrollCursorIntoView()
      root.navigationFocusRequested()
    })
  }

  function isShowing(t) { return inThread && String(active.chat) === String(t.chat) }
  function openThread(t) {
    if (!t) return
    // A sheet opened over the PREVIOUS conversation (an arriving link opens it
    // by itself) otherwise floats over this one, offering a QR for a link that
    // is no longer on screen. Found by driving the live panel, 2026-09-07.
    closeShare()
    // Enter on the row already peeked commits it (the compose field's focus
    // handler marks it read) without reloading what is on screen.
    if (!(peeking && isShowing(t))) { peeking = false; showThread(t) }
    Qt.callLater(function() { composeField.forceActiveFocus() })
  }
  /** peekTimer fired (split view only): show the cursor row's thread the way
   *  Messages' sidebar does, but leave focus in the list and the dot alone. */
  function peekCursor() {
    var t = threads[cursor]
    if (!t || !cursorShown || isShowing(t)) return   // no cursor shown, no peek
    peeking = true
    showThread(t)
  }
  function commitPeek() {
    if (!peeking) return
    peeking = false
    // A load still running marks it on completion (peeking is false by then).
    if (!loading) markRead(String(active.chat), seenTs)
  }
  /** The one gate for "this thread was looked at": a surface that marks read,
   *  and not a thread merely peeked. */
  function markRead(chat, seen) {
    if (hostWidget && readActive && !peeking) hostWidget.markThreadRead(chat, seen)
  }
  function showThread(t) {
    active = t
    activeLastTs = String(t.last_ts || "")
    bubbles = []
    bubblesJson = ""
    rendered = false
    seenTs = ""
    firstLoad = true
    pushPending = false
    note = ""
    loading = true
    composeField.text = drafts[String(t.chat)] || ""   // this conversation's unsent text
    composeField.cursorPosition = composeField.length
    clearDraft()   // a queued file must never survive into another thread
    requestThreadLoad(String(t.chat))
  }

  function requestThreadLoad(chat) {
    pendingThreadChat = String(chat || "")
    if (!threadProc.running) startNextThreadLoad()
  }

  function startNextThreadLoad() {
    if (threadProc.running || pendingThreadChat === "") return
    threadRunningChat = pendingThreadChat
    pendingThreadChat = ""
    root.threadPendingRevision = root.pendingRevision
    var pending = root.pendingSends.filter(function(p) { return p.chat === threadRunningChat })
    threadProc.command = ["bun", root.threadScript, threadRunningChat, "80",
                          "--time-format", root.timeFormat,
                          "--date-format", root.dateFormat,
                          "--date-format-with-year", root.dateFormatWithYear]
                         .concat(pending.length ? ["--pending-stdin"] : [])
    if (pending.length) {
      // In-flight sends ride stdin (message text never in argv) so their
      // bubbles survive the reload until the Mac has the row.
      threadProc.stdinEnabled = true
      threadProc.running = true
      threadProc.write(JSON.stringify(pending))
      threadProc.stdinEnabled = false
    } else {
      threadProc.running = true
    }
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
    revealBubbleCursor()
  }
  /** PgUp/PgDn walk the bubbles a screen at a time, and unlike the arrows
   *  they work with text in the compose field (they move no caret). PgUp
   *  selects the topmost visible bubble; already there, it pages up first.
   *  PgDn mirrors it with the bottommost, and past the newest leaves. */
  function pageBubbles(dy) {
    if (bubbles.length === 0) return
    var items = repeaterItems(bubbleRepeater)
    var edge = edgeVisible(flick, items, dy)
    if (edge === bubbleCursor && bubbleCursorItem) {
      if (dy > 0 && edge === bubbles.length - 1) { leaveBubbles(); return }
      // Page so the selected row lands at the OPPOSITE edge — a screen with
      // one row of overlap, the way a pager turns a page.
      var it = bubbleCursorItem, margin = Style.space(6)
      scrollConversation(dy < 0 ? it.y + it.height + margin - flick.height - flick.contentY
                                : it.y - margin - flick.contentY)
      edge = edgeVisible(flick, items, dy)
    }
    if (edge < 0) return
    bubbleCursor = edge
    revealBubbleCursor()
  }
  function revealBubbleCursor() {
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
    // A link goes to the share sheet, not straight to the browser: the sheet
    // shows the host and the URL and makes opening a deliberate second step.
    var urls = allUrls(b.text)
    if (b.link && b.link.url && urls.indexOf(String(b.link.url)) < 0) urls.unshift(String(b.link.url))
    openShare(urls, false)
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
  // The tapback pill, overlapping the top corner opposite the tail. One
  // definition for the text bubble and for the attachments: a picture-only
  // message hides its text bubble, so the pill sits on the picture (or the
  // file chip) itself, or the reaction is never seen.
  component TapbackPill: Rectangle {
    id: pill
    property bool mine: false
    property var tapbacks: []
    visible: (tapbacks || []).length > 0
    width: Math.ceil(pillText.implicitWidth) + Style.space(12)
    height: Math.ceil(pillText.implicitHeight) + Style.space(8)
    radius: height / 2
    color: mine ? Qt.darker(root.mineFill, 2.2) : root.mineFill
    border.color: Qt.rgba(0, 0, 0, 0.5)
    border.width: 2
    z: 2
    anchors.top: parent.top
    anchors.topMargin: -Style.space(12)
    anchors.right: mine ? undefined : parent.right
    anchors.rightMargin: mine ? 0 : -Style.space(6)
    anchors.left: mine ? parent.left : undefined
    anchors.leftMargin: mine ? -Style.space(6) : 0
    Text {
      id: pillText
      anchors.centerIn: parent
      text: root.tapbackRow(pill.tapbacks)
      textFormat: Text.PlainText
      font.pixelSize: root.fontCaption
    }
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
  property bool avatarBusy: false // hold the request identity until stdout is consumed
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
    if (avatarBusy || avatarProc.running || avatarQueue.length === 0) return
    avatarBusy = true
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
        root.avatarBusy = false
        Qt.callLater(root.pumpAvatar)
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
    endPeek()
    exitSearch()
    threadFlick.contentY = 0   // the field sits above the rows
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

  /** Down in an empty search or new-message field: back to the list, cursor
   *  on the first row — the list is showing its top, so that is where the eye
   *  is. Esc keeps the old cursor instead. */
  function listFromTop() {
    if (newMode) exitNew()
    else exitSearch()
    cursor = 0
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
    // The field pushed the list to the top; bring the cursor row back once
    // the rows have been rebuilt and laid out.
    Qt.callLater(scrollCursorIntoView)
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
      contactSeq++                      // an in-flight answer must not repopulate an emptied field (Astra A#5)
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
    // The previous query's rows are not answers to THIS query: clear them so
    // nothing stale is clickable — or Enter-able, since acceptNewField gates on
    // newQueryRan, which is about to become q (Astra A#5).
    if (q !== newQueryRan) { newResults = []; newCursor = 0 }
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
    // Up from the first hit brings the field (which already has focus) back
    // into view, as moveCursor does for the thread list.
    if (dy < 0 && newCursor <= 0) { threadFlick.contentY = 0; return }
    newCursor = Math.max(0, Math.min(newResults.length - 1, newCursor + dy))
    scrollCursorIntoView()
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
    endPeek()
    threadFlick.contentY = 0   // the field sits above the rows
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
    Qt.callLater(scrollCursorIntoView)   // no-op while the rows are gone
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
      searchSeq++                       // same rule as the contact search (Astra A#5)
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
    if (dy < 0 && searchCursor <= 0) { threadFlick.contentY = 0; return }
    searchCursor = Math.max(0, Math.min(searchResults.length - 1, searchCursor + dy))
    scrollCursorIntoView()
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
    // The query is message text once a sentence is pasted in: it rides the
    // same stdin payload as the sidebar identities, never argv (Astra B#2).
    searchProc.command = ["bun", root.searchScript, "--stdin", "40"]
    searchProc.stdinEnabled = true
    searchProc.running = true
    searchProc.write(JSON.stringify({ query: q, threads: JSON.parse(threadIdentitiesJson()) }))
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
    if (!isSendable(root.active)) {
      note = "Read-only — group id unknown — send from your phone"
      return
    }

    if (draftPath !== "") {
      if (sendProc.running || fileSendProc.running) {
        note = "a message is already sending"
        return
      }
      note = "sending…"
      sendChat = String(root.active.chat)
      sendText = text
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

    // The bubble appears NOW; the Mac round trip (ssh, osascript, Messages
    // writing the row) happens behind it. The field clears at once, so a
    // second message can follow without waiting — sends queue in order.
    var chat = String(root.active.chat)
    var stamp = root.localStamp()
    var target = root.activeIsGroup
      ? ["--chat-id", String(root.active.guid)]
      : ["--to", chat]
    // green-bubble (SMS/RCS) threads send on their own service (war room #2)
    var svc = String(root.active.service || "")
    if (!root.activeIsGroup && /^(SMS|RCS)$/i.test(svc)) target = target.concat(["--service", svc.toUpperCase()])
    var localId = String(++root.nextSendId)
    root.pendingRevision++
    root.pendingSends = root.pendingSends.concat([{ chat: chat, text: text, ts: stamp, localId: localId }])
    root.bubbles = root.appendPendingBubble(root.bubbles, text, stamp, localId)
    root.pinToBottom = true
    composeField.text = ""
    note = ""
    root.sendQueue = root.sendQueue.concat([{ chat: chat, text: text, stamp: stamp, localId: localId, target: target }])
    pumpSend()
  }

  /** Local wall clock as a chat.db-style stamp; the pending bubble's ts. */
  function localStamp() {
    return Qt.formatDateTime(new Date(), "yyyy-MM-dd HH:mm:ss")
  }

  /** The instant echo: thread.ts's pendingBubble() in miniature — enough to
   *  draw the bubble in the right run with the right clock. Every reload
   *  replaces it with the TypeScript version until the real row lands. */
  function appendPendingBubble(list, text, stamp, localId) {
    var out = (list || []).slice()
    var prev = out.length ? out[out.length - 1] : null
    var newDay = !prev || String(prev.ts || "").slice(0, 10) !== stamp.slice(0, 10)
    var gapMin = prev ? (Date.parse(stamp.replace(" ", "T")) - Date.parse(String(prev.ts || "").replace(" ", "T"))) / 60000 : Infinity
    var start = !prev || newDay || prev.from_me !== true || !(gapMin <= 15)
    if (!start) { var p = Object.assign({}, prev); p.groupEnd = false; p.time = ""; out[out.length - 1] = p }
    out.push({ localId: localId, ts: stamp, from_me: true, name: "", text: String(text).trim(), day: newDay ? "Today" : "",
               groupStart: start, groupEnd: true, time: Qt.formatTime(new Date(), root.timeFormat),
               receipt: "", tapbacks: [], attachments: [], replyText: "", replyMine: false, edited: false,
               link: null, retracted: false, effect: "", audio: false, html: "", failed: false, pending: true })
    return out
  }

  function failPending(chat, localId, reason, text, stamp) {
    root.pendingRevision++
    root.pendingSends = SendState.markSendFailed(root.pendingSends, localId, reason,
      {chat: chat, localId: localId, text: text, ts: stamp})
    if (root.inThread && String(root.active.chat) === chat) {
      if (!root.bubbles.some(function(b) { return b.localId === localId }))
        root.bubbles = root.appendPendingBubble(root.bubbles, text, stamp, localId)
      root.bubbles = SendState.markSendFailed(root.bubbles, localId, reason)
    }
  }

  /** Start the next queued text send when the wire is free. */
  function pumpSend() {
    if (sendProc.running || root.sendQueue.length === 0) return
    var job = root.sendQueue[0]
    root.sendQueue = root.sendQueue.slice(1)
    root.sendChat = job.chat
    root.sendText = job.text
    root.sendStamp = job.stamp
    root.sendLocalId = job.localId
    sendProc.lastErr = ""
    root.reloadTries = 0
    // Body on STDIN (--text-stdin), never argv: argv is readable by every
    // process on this machine and travels through ssh into the Mac's ps.
    sendProc.command = [root.home + "/bin/imsg-send"].concat(job.target).concat(["--yes", "--text-stdin", "--keep-dashes"])
    sendProc.stdinEnabled = true
    sendProc.running = true
    sendProc.write(job.text)
    sendProc.stdinEnabled = false
  }

  property string copyFeedback: ""
  Process {
    id: copyProc
    onExited: function(code, status) {
      copyTimeout.stop()
      root.copyFeedback = code === 0 && status === 0 ? "Copied to clipboard" : "Could not copy to clipboard"
      copyFeedbackTimer.restart()
    }
  }
  Timer {
    id: copyTimeout
    interval: 5000
    onTriggered: {
      copyProc.running = false
      root.copyFeedback = "Could not copy to clipboard"
      copyFeedbackTimer.restart()
    }
  }
  Timer { id: copyFeedbackTimer; interval: 2200; onTriggered: root.copyFeedback = "" }
  function copyText(t) {
    if (t === "") return
    // stdin, not argv: message text can be long and can start with "-".
    copyFeedback = ""
    copyFeedbackTimer.stop()
    copyTimeout.restart()
    copyProc.command = ["/usr/bin/wl-copy"]
    copyProc.stdinEnabled = true
    copyProc.running = true
    copyProc.write(t)
    copyProc.stdinEnabled = false
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
        // A send or failure happened after this request took its snapshot.
        // Keep the current bubbles and request a fresh snapshot on exit.
        if (root.threadPendingRevision !== root.pendingRevision) {
          root.requestThreadLoad(root.threadRunningChat)
          return
        }
        root.loading = false
        try {
          var d = JSON.parse(text.trim())
          if (d.ok === true) {
            var list = Array.isArray(d.bubbles) ? d.bubbles : []
            var j = JSON.stringify(list)
            // What the eye can now see: the newest ts in THIS snapshot — of
            // real rows; a pending bubble carries this machine's clock.
            var seen = ""
            for (var k = 0; k < list.length; k++) {
              if (list[k].pending === true) continue
              var ts = String(list[k].ts || ""); if (ts > seen) seen = ts
            }
            // thread.ts hands back the sends it is still waiting on for this
            // chat; keep asking for a few seconds, then leave it to the next
            // ordinary reload (the bubble stays up either way).
            if (Array.isArray(d.pending)) {
              var chat = root.threadRunningChat
              root.pendingSends = root.pendingSends.filter(function(p) { return p.chat !== chat }).concat(d.pending)
              if (d.pending.some(function(p) { return p.failed !== true }) && root.reloadTries < 8) {
                root.reloadTries++
                root.reloadChat = chat
                reloadTimer.restart()
              } else {
                root.reloadTries = 0
              }
            }
            if (j === root.bubblesJson) {
              // Nothing changed — do NOT rebuild the Repeater (a rebuild
              // resets scroll and re-decodes every image). Push pings mostly
              // produce identical content; this makes them free.
              root.rendered = true
              root.seenTs = seen
              root.markRead(root.threadRunningChat, seen)
              return
            }
            root.bubblesJson = j
            root.bubbles = list
            root.rendered = true
            root.seenTs = seen
            // Pin only on the thread's FIRST load or when the user was
            // already at the bottom — never while they read history.
            root.pinToBottom = root.firstLoad || flick.stick
            root.firstLoad = false
            Qt.callLater(root.autoFetchImages)
            // A dot means "looked at", so clear it only after content loaded —
            // and only through what loaded, never the sidebar's newer ts.
            root.markRead(root.threadRunningChat, seen)
          } else {
            root.bubbles = []
            root.rendered = false
            root.note = String(d.error || "could not load this thread")
          }
        } catch (e) {
          root.bubbles = []
          root.rendered = false
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
      var completedStamp = root.sendStamp
      var completedId = root.sendLocalId
      var belongsHere = root.inThread && String(root.active.chat) === completedChat
      root.sendChat = ""
      root.sendText = ""
      root.sendStamp = ""
      root.sendLocalId = ""
      if (code === 0) {
        // A URL you just SHARED opens the sheet too (Fred, 2.3.0): send it,
        // then offer the QR / LocalSend / copy for the same link.
        var sentUrls = root.allUrls(completedText)
        if (belongsHere && sentUrls.length > 0) Qt.callLater(function() { root.openShare(sentUrls, true) })
        // The bubble is already up; reload to swap it for the real row.
        root.reloadChat = completedChat
        reloadTimer.restart()
      } else {
        // Keep the failed bubble; put the words back in the field (unless a
        // newer draft is there), and the reason is on the status line.
        var reason = code === 69 || code === 255 ? "Mac unreachable"
          : sendProc.lastErr !== "" ? sendProc.lastErr : "Send failed (exit " + code + ")"
        root.failPending(completedChat, completedId, reason, completedText, completedStamp)
        if (belongsHere) {
          if (composeField.text === "") composeField.text = completedText
          if (code === 69 || code === 255) root.note = "not sent — Mac unreachable"
          else root.note = (sendProc.lastErr !== "" ? "send failed: " + sendProc.lastErr : "send failed (exit " + code + ")")
        }
      }
      if (belongsHere) composeField.forceActiveFocus()
      Qt.callLater(root.pumpSend)
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
          // A click deserves the reason (a photo Messages in iCloud has not
          // brought to the Mac yet reads as "no such attachment" otherwise);
          // auto-pulls stay quiet so a scroll through old media is not a toast storm.
          else if (d.ok !== true && root.fetchJobAction !== "")
            root.note = "fetch failed — " + String(d.error || "unknown error").replace(/^error:\s*/, "")
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
  // A cursor that rests on a row for a beat shows that thread (Messages'
  // sidebar behaviour). Restarted on every move, so a held arrow key does not
  // start a load per row; the thread loader's latest-wins queue drops whatever
  // a fast scroll still managed to start.
  Timer { id: peekTimer; interval: 250; onTriggered: root.peekCursor() }
  Timer {
    id: reloadTimer
    // Messages usually has the row within a few hundred ms of osascript
    // returning; a reload that beats it keeps the pending bubble (thread.ts)
    // and tries again. No `loading` flag: the bubble is already on screen,
    // and a "loading…" flash after every send is the thing we are removing.
    interval: 600
    onTriggered: if (root.inThread && String(root.active.chat) === root.reloadChat) {
      root.requestThreadLoad(root.reloadChat)
    }
  }

  // ---- keyboard navigation (the host's PanelKeyCatcher calls these).
  // The cursor stops at the ends rather than wrapping: with 300 threads a
  // press past the last row landing at the top reads as a jump, not a loop
  // (Omarchy's Dropdown clamps the same way).
  function moveCursor(dy) {
    if (contactReview.opened || !listShowing || threads.length === 0 || dy === 0) return
    // Up from the first row hands focus to the search field above the list,
    // and Down in an empty field hands it back (Omarchy's SearchableDropdown).
    if (dy < 0 && cursor <= 0) { startSearch(); return }
    cursor = Math.max(0, Math.min(threads.length - 1, cursor + dy))
    cursorMoved()
  }
  /** Every way the thread cursor moves ends here: keep the row in view and,
   *  in split view, arm the preview — arrows, paging and Home/End alike. */
  function cursorMoved() {
    scrollCursorIntoView()
    if (splitView) peekTimer.restart()
  }
  // Keep the cursor row inside threadFlick's viewport. The list is a
  // multi-section Column (pinned grid, headers, three Repeaters), so there is
  // no ListView.positionViewAtIndex — same helper as Omarchy's audio and
  // tailscale panels. Synchronous: a cursor move does not touch the model, so
  // the row is already laid out, and the binding that set cursorRow ran
  // before the caller reached this line.
  function scrollCursorIntoView() {
    var row = cursorRow
    if (!row) return
    var margin = Style.space(6)
    var top = row.mapToItem(threadFlick.contentItem, 0, 0).y
    var bottom = top + row.height
    var maxY = Math.max(0, threadFlick.contentHeight - threadFlick.height)
    if (top < threadFlick.contentY + margin)
      threadFlick.contentY = Math.max(0, top - margin)
    else if (bottom > threadFlick.contentY + threadFlick.height - margin)
      threadFlick.contentY = Math.min(maxY, bottom + margin - threadFlick.height)
  }
  function activateCursor() {
    if (listShowing && cursor >= 0) openThread(threads[cursor])
  }
  // ---- paging: PgUp/PgDn select the row at the edge of the viewport, and
  // page a screen (one row of overlap) when the cursor is already there;
  // Home/End take the first/last row. Omarchy's menu, clipboard and emoji
  // lists bind the same four keys. Whichever of the three lists is showing
  // — new-message hits, search hits, threads — is the one that moves.
  function repeaterItems(rep) {
    var out = []
    for (var i = 0; i < rep.count; i++) out.push(rep.itemAt(i))
    return out
  }
  /** Index into `items` of the topmost (dy < 0) or bottommost (dy > 0) row
   *  wholly inside `fl`'s viewport; a partly visible row is the fallback
   *  (a row taller than the view); -1 when nothing is laid out. Wholly, not
   *  partly: a sliver of the neighbour above the cursor must not count, or
   *  the next PgUp steps one row instead of paging. */
  function edgeVisible(fl, items, dy) {
    var top = fl.contentY, bottom = top + fl.height, partial = -1
    for (var k = 0; k < items.length; k++) {
      var i = dy < 0 ? k : items.length - 1 - k
      var it = items[i]
      if (!it) continue
      var y = it.mapToItem(fl.contentItem, 0, 0).y
      if (y >= bottom || y + it.height <= top) continue
      if (partial < 0) partial = i
      if (dy < 0 ? y >= top - 1 : y + it.height <= bottom + 1) return i
    }
    return partial
  }
  /** The row PgUp/PgDn lands on: the edge row, or — when the cursor already
   *  sits there — the edge row after paging so the cursor row lands at the
   *  opposite edge. null when the list has nothing laid out. */
  function pageTo(fl, items, currentItem, dy) {
    var edge = edgeVisible(fl, items, dy)
    if (edge >= 0 && items[edge] === currentItem) {
      var y = currentItem.mapToItem(fl.contentItem, 0, 0).y, m = Style.space(6)
      var max = Math.max(0, fl.contentHeight - fl.height)
      fl.contentY = Math.max(0, Math.min(max, dy < 0 ? y + currentItem.height + m - fl.height : y - m))
      edge = edgeVisible(fl, items, dy)
    }
    return edge >= 0 ? items[edge] : null
  }
  function indexOfChat(chat) {
    for (var i = 0; i < threads.length; i++) if (String(threads[i].chat) === String(chat)) return i
    return -1
  }
  // Which of the three lists the paging keys drive, answered once per press:
  // its rows, its length, how a landed row maps back to a cursor index
  // (search/new rows carry their model index; a thread row is found by chat,
  // since the thread list is two Repeaters), and how its cursor is set.
  function activeList() {
    if (newMode) return { items: repeaterItems(newRepeater), count: newResults.length,
      indexOf: function(it) { return it.index }, set: function(i) { newCursor = i; scrollCursorIntoView() } }
    if (searchShowing) return { items: repeaterItems(searchRepeater), count: searchResults.length,
      indexOf: function(it) { return it.index }, set: function(i) { searchCursor = i; scrollCursorIntoView() } }
    return { items: repeaterItems(pinnedRepeater).concat(repeaterItems(chronologicalRepeater)), count: threads.length,
      indexOf: function(it) { return indexOfChat(it.modelData.chat) }, set: function(i) { cursor = i; cursorMoved() } }
  }
  function pageActive(dy) {
    var l = activeList(), it = pageTo(threadFlick, l.items, cursorRow, dy)
    if (it) l.set(l.indexOf(it))
  }
  function jumpActive(toEnd) {
    var l = activeList()
    if (l.count > 0) l.set(toEnd ? l.count - 1 : 0)
  }
  /** PgUp/PgDn/Home/End for whichever list is showing; true if consumed. */
  function catchPagingKey(key) {
    if (key === Qt.Key_PageUp) { pageActive(-1); return true }
    if (key === Qt.Key_PageDown) { pageActive(1); return true }
    if (key === Qt.Key_Home) { jumpActive(false); return true }
    if (key === Qt.Key_End) { jumpActive(true); return true }
    return false
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
    if (contactReview.opened) return false
    var jump = text === "/" || text === "n" || text === "N"
      || (text >= "1" && text <= "9")
    if (!jump) return false
    if (searchField.activeFocus || newField.activeFocus || bubbleFocused) return false
    if (composeField.activeFocus && (composeField.text.length > 0 || root.draftPath !== ""))
      return false
    return handleTextKey(text) === true
  }
  /** Arrow/Enter list navigation for a host without a PanelKeyCatcher (the
   *  window): true if the key was consumed. A focused editor keeps its arrows
   *  — the search and new-message fields drive their own cursors. */
  function catchNavKey(key) {
    if (editorActive) return false
    if (key === Qt.Key_Down) { moveCursor(1); return true }
    if (key === Qt.Key_Up) { moveCursor(-1); return true }
    if (key === Qt.Key_Return || key === Qt.Key_Enter) { activateCursor(); return true }
    // Right = into the right pane: focus the compose field of the thread on
    // screen (which commits a peek). Left in an EMPTY compose field comes back.
    if (key === Qt.Key_Right && inThread) { composeField.forceActiveFocus(); return true }
    return listShowing && catchPagingKey(key)
  }
  /** List-mode focus holder. The panel's PanelKeyCatcher takes the arrows,
   *  Enter and letters BEFORE the focused item and lets the rest fall
   *  through; parking focus here (rather than on the catcher itself) is what
   *  lets PgUp/PgDn/Home/End reach the list. The window's navCatcher does
   *  the same job with its own handler. */
  readonly property alias navigationKeys: navKeys
  Item {
    id: navKeys
    Keys.onPressed: function(event) { if (root.catchNavKey(event.key)) event.accepted = true }
  }
  function catchEscape() {
    if (newField.activeFocus || newMode) { exitNew(); return true }
    if (searchField.activeFocus || searching) { exitSearch(); return true }
    return false
  }
  /** Esc semantics for a host without a PanelKeyCatcher (the window): true if
   *  something was unwound, false if the host should close. */
  function unwind() {
    if (contactReview.opened) { contactReview.back(); return true }
    if (shareUrl !== "") { closeShare(); return true }
    if (catchEscape()) return true
    if (inThread) { back(); return true }
    return false
  }
  function focusDefault() {
    if (contactReview.opened) contactReview.forceActiveFocus()
    else if (inThread) composeField.forceActiveFocus()
    else navigationFocusRequested()
  }

  // ---- layout: one pane (popout) or two (window). Both panes always exist —
  // hiding, not unloading, keeps image state, selection, and scroll position.
  property bool splitView: false
  property int sidebarWidth: 320
  readonly property bool listShowing: splitView || !inThread

  RowLayout {
    anchors.fill: parent
    visible: !contactReview.opened
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
        RowLayout {
          Layout.fillWidth: true
          spacing: Style.space(8)
          Text {
            text: "Blip"
            textFormat: Text.PlainText
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: root.fontTitle
            font.bold: true
          }
          Text {
            Layout.fillWidth: true
            text: (!root.online ? "Mac unreachable — bridge offline"
              : root.unread > 0 ? root.unread + " unread" : "all caught up").toUpperCase()
            textFormat: Text.PlainText
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: root.fontCaption
            font.bold: true
            font.letterSpacing: 1.2
            elide: Text.ElideRight
          }
          Text {
            visible: root.version !== ""
            text: root.version
            textFormat: Text.PlainText
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: root.fontCaption
          }
          PanelActionButton {
            visible: root.online && !root.newMode && !root.searchShowing
            iconText: "＋"
            tooltipText: "New message (n)"
            bordered: true
            foreground: root.foreground
            hoverColor: root.accent
            fontFamily: root.fontFamily
            onClicked: root.startNew()
          }
          PanelActionButton {
            visible: root.online && !root.splitView
            iconText: "⇱"
            tooltipText: "Open the app window"
            bordered: true
            foreground: root.foreground
            hoverColor: root.accent
            fontFamily: root.fontFamily
            onClicked: root.openApp()
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
            // One spacing in split view: inThread flips there with every preview,
            // and the sidebar must not shift. The popout tightens up in a thread.
            spacing: root.splitView ? Style.space(10) : (root.inThread ? Style.space(2) : Style.space(6))

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
                && (root.newMode || root.unread > 0 && !root.searchShowing)
              PanelSectionHeader {
                Layout.fillWidth: true
                text: root.newMode ? "NEW MESSAGE" : ""
                foreground: root.foreground
                fontFamily: root.fontFamily
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
                if (event.key === Qt.Key_Down) {
                  if (text === "") root.listFromTop()
                  else root.moveNewCursor(1)
                  event.accepted = true
                }
                else if (event.key === Qt.Key_Up) { root.moveNewCursor(-1); event.accepted = true }
                else if (root.catchPagingKey(event.key)) event.accepted = true
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
              id: newRepeater
              model: root.online && root.listShowing && root.newMode ? root.newResults : []
              delegate: Rectangle {
                id: contactHit
                required property var modelData
                required property int index
                readonly property bool hasCursor: root.newCursor === index
                onHasCursorChanged: if (hasCursor) root.cursorRow = contactHit
                Layout.fillWidth: true
                implicitHeight: contactRow.implicitHeight + Style.space(12)
                radius: Style.cornerRadius
                color: contactHover.hovered || hasCursor
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
              placeholderText: "Search"
              Accessible.name: "Search"
              leftPadding: horizontalPadding + searchGlyph.width + Style.space(7)
              Canvas {
                id: searchGlyph
                anchors.left: parent.left
                anchors.leftMargin: searchField.horizontalPadding
                anchors.verticalCenter: parent.verticalCenter
                width: Style.space(16)
                height: width
                readonly property color strokeColor: searchField.placeholderTextColor
                onStrokeColorChanged: requestPaint()
                onPaint: {
                  var ctx = getContext("2d")
                  ctx.reset()
                  ctx.scale(width / 16, height / 16)
                  ctx.strokeStyle = strokeColor
                  ctx.lineWidth = 1.5
                  ctx.lineCap = "round"
                  ctx.beginPath()
                  ctx.arc(6.5, 6.5, 5, 0, Math.PI * 2)
                  ctx.moveTo(10.1, 10.1)
                  ctx.lineTo(14.5, 14.5)
                  ctx.stroke()
                }
              }
              foreground: root.foreground
              accent: root.accent
              font.family: root.fontFamily
              font.pixelSize: root.fontBodySmall
              onAccepted: root.acceptSearchField()
              onActiveFocusChanged: if (activeFocus && !root.searching) root.searching = true
              Keys.onEscapePressed: root.exitSearch()
              Keys.onPressed: function(event) {
                if (event.key === Qt.Key_Down) {
                  if (text === "") root.listFromTop()
                  else root.moveSearchCursor(1)
                  event.accepted = true
                }
                else if (event.key === Qt.Key_Up) { root.moveSearchCursor(-1); event.accepted = true }
                else if (root.catchPagingKey(event.key)) event.accepted = true
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
                id: pinnedRepeater
                model: pinnedGrid.visible ? root.pinnedThreads : []
                delegate: Rectangle {
                  id: pinnedTile
                  required property var modelData
                  // pinned threads sit first in root.threads, so the cursor
                  // walks these tiles before the rows below
                  readonly property bool hasCursor: root.cursorChat === String(modelData.chat)
                  onHasCursorChanged: if (hasCursor) root.cursorRow = pinnedTile
                  Layout.fillWidth: true
                  Layout.preferredWidth: Math.max(1, (pinnedGrid.width - pinnedGrid.columnSpacing * 2) / 3)
                  implicitHeight: pinnedColumn.implicitHeight + Style.space(12)
                  radius: Style.cornerRadius
                  color: pinnedHover.hovered || (hasCursor && root.cursorShown)
                    ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08)
                    : "transparent"

                  HoverHandler { id: pinnedHover }
                  TapHandler { onTapped: root.openThread(modelData) }
                  TapHandler {
                    acceptedButtons: Qt.RightButton
                    onTapped: { root.contactContext = modelData; contactMenu.popup() }
                  }

                  ColumnLayout {
                    id: pinnedColumn
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.leftMargin: Style.space(4)
                    anchors.rightMargin: Style.space(4)
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: Style.space(4)

                    Rectangle {
                      id: pinnedAvatar
                      Layout.alignment: Qt.AlignHCenter
                      // Hidden layouts defer their first measurement. Derive
                      // the size from the pane's known width and supply both
                      // implicit size and layout hints before the first open.
                      readonly property real avatarSize: Math.min(88, Math.max(56,
                        ((root.splitView ? root.sidebarWidth - Style.space(36) : root.width)
                          - pinnedGrid.columnSpacing * 2) / 3 * 0.62))
                      implicitWidth: avatarSize
                      implicitHeight: avatarSize
                      Layout.preferredWidth: avatarSize
                      Layout.preferredHeight: avatarSize
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
                      Loader {
                        id: pinnedAvatarComposite
                        anchors.fill: parent
                        active: pinnedAvatarImg.status !== Image.Ready
                          && root.isGroupId(String(modelData.chat || ""))
                          && (modelData.participants || []).length > 0
                        sourceComponent: GroupAvatar {
                          participants: modelData.participants || []
                          avatarFiles: root.avatarFiles
                          foreground: root.foreground
                          fontFamily: root.fontFamily
                          onRequestAvatar: handle => root.requestAvatar(handle)
                        }
                      }
                      Text {
                        anchors.centerIn: parent
                        visible: pinnedAvatarImg.status !== Image.Ready && !pinnedAvatarComposite.active
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
              id: searchRepeater
              model: root.online && root.listShowing && root.searchShowing ? root.searchResults : []
              delegate: Rectangle {
                id: searchHit
                required property var modelData
                required property int index
                readonly property bool hasCursor: root.searchCursor === index
                onHasCursorChanged: if (hasCursor) root.cursorRow = searchHit
                Layout.fillWidth: true
                implicitHeight: hitCol.implicitHeight + Style.space(12)
                radius: Style.cornerRadius
                color: hitHover.hovered || hasCursor
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

            ColumnLayout {
              id: chronologicalRows
              property int hoveredRow: -1
              Layout.fillWidth: true
              visible: root.online && root.listShowing && !root.searchShowing && !root.newMode
              spacing: 0
              Repeater {
                id: chronologicalRepeater
                model: root.online && root.listShowing && !root.searchShowing && !root.newMode ? root.unpinnedThreads : []
                delegate: Rectangle {
                  id: threadRow
                  required property var modelData
                  required property int index
                  readonly property bool highlighted: rowHover.hovered || (hasCursor && root.cursorShown)
                  readonly property bool hasCursor: root.cursorChat === String(modelData.chat)
                  onHasCursorChanged: if (hasCursor) root.cursorRow = threadRow

                  Layout.fillWidth: true
                  implicitHeight: rowRow.implicitHeight + Style.space(root.splitView ? 30 : 18)
                  radius: Style.cornerRadius
                  color: highlighted
                    ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08)
                    : "transparent"

                  HoverHandler {
                    id: rowHover
                    onHoveredChanged: {
                      if (hovered) chronologicalRows.hoveredRow = index
                      else if (chronologicalRows.hoveredRow === index) chronologicalRows.hoveredRow = -1
                    }
                  }
                  TapHandler { onTapped: root.openThread(modelData) }
                    TapHandler {
                      acceptedButtons: Qt.RightButton
                      onTapped: { root.contactContext = modelData; contactMenu.popup() }
                    }

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
                      // Keep ordinary avatars legible beside two preview lines.
                      width: Style.space(40); height: width; radius: width / 2
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
                      Loader {
                        id: avatarCircleComposite
                        anchors.fill: parent
                        active: avatarImg.status !== Image.Ready
                          && root.isGroupId(String(modelData.chat || ""))
                          && (modelData.participants || []).length > 0
                        sourceComponent: GroupAvatar {
                          participants: modelData.participants || []
                          avatarFiles: root.avatarFiles
                          foreground: root.foreground
                          fontFamily: root.fontFamily
                          onRequestAvatar: handle => root.requestAvatar(handle)
                        }
                      }
                      Text {
                        anchors.centerIn: parent
                        visible: avatarImg.status !== Image.Ready && !avatarCircleComposite.active
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
                  Rectangle {
                    anchors.bottom: parent.bottom
                    anchors.right: parent.right
                    // Align the hairline with the text, beyond the dot and avatar.
                    anchors.left: parent.left
                    anchors.leftMargin: rowRow.x + avatarCircle.x + avatarCircle.width + rowRow.spacing
                    height: 1
                    color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)
                    visible: !threadRow.highlighted
                      && chronologicalRows.hoveredRow !== index + 1
                      && !(root.cursorShown && root.unpinnedThreads[index + 1]
                        && root.cursorChat === String(root.unpinnedThreads[index + 1].chat))
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
          PanelActionButton {
            visible: root.inThread && !root.splitView
            Layout.alignment: Qt.AlignTop
            Layout.topMargin: Style.space(6)
            iconText: "←"
            tooltipText: "Back to messages (Esc)"
            Accessible.name: "Back to messages"
            focusable: true
            foreground: root.foreground
            hoverColor: root.accent
            fontFamily: root.fontFamily
            onClicked: root.back()
          }
          PanelHero {
            Layout.fillWidth: true
            title: root.inThread ? String(root.active.name || root.active.chat) : "Select a conversation"
            meta: root.inThread
              ? (root.activeIsGroup
                  ? (root.isSendable(root.active) ? "group" : "group · read-only (id unknown)")
                  : String(root.active.handle))
              : ""
            detail: root.inThread && root.loading ? "loading…" : ""
            foreground: root.foreground
            fontFamily: root.fontFamily
          }
          PanelActionButton {
            visible: root.inThread
            iconText: "⋯"
            tooltipText: "Review contact"
            foreground: root.foreground
            hoverColor: root.accent
            onClicked: contactReview.review(root.active)
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
              id: bubbleRepeater
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
                  // A name is untrusted width: unconstrained, a long one is the
                  // "delegate wider than the panel" bug (CLAUDE.md) — Astra A#10.
                  Layout.maximumWidth: Math.max(1, bubbleRow.width - Style.space(40))
                  elide: Text.ElideRight
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
                    Layout.maximumWidth: Math.max(1, bubbleRow.width - Style.space(40))
                    elide: Text.ElideRight
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
                    // the pill lands here when the message has no text bubble to carry it
                    readonly property bool pillHere: index === 0 && String(bubbleRow.modelData.text || "") === ""
                                                     && (bubbleRow.modelData.tapbacks || []).length > 0
                    // undefined = not fetched, "" = failed, else file:// url
                    readonly property var fileUrl: root.attFiles[chipRow.attId]
                    readonly property bool failed: chipRow.fileUrl === ""
                    readonly property var imageMetrics: root.attMetrics[chipRow.attId] || ({})
                    readonly property bool showImage:
                      root.isImageMime(chipRow.modelData.mime) &&
                      chipRow.fileUrl !== undefined && chipRow.fileUrl !== ""
                    Layout.fillWidth: true
                    Layout.topMargin: (index === 0 && bubbleRow.modelData.groupStart ? Style.space(6) : 0)
                                      + (pillHere ? Style.space(12) : 0)
                    spacing: 0
                    Item { Layout.fillWidth: true; visible: bubbleRow.mine }

                    // fetched image renders inline, like Messages; click = full view
                    Image {
                      id: attImage
                      TapbackPill { visible: chipRow.pillHere; mine: bubbleRow.mine; tapbacks: bubbleRow.modelData.tapbacks }
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
                      TapbackPill { visible: chipRow.pillHere; mine: bubbleRow.mine; tapbacks: bubbleRow.modelData.tapbacks }
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

                    TapbackPill { mine: bubbleRow.mine; tapbacks: modelData.tapbacks }
                  }

                  Item { Layout.fillWidth: true; visible: !bubbleRow.mine }
                }

                // timestamp under the last bubble of a run, same spacer trick;
                // carries the "Edited" and "sent with <effect>" tags too
                RowLayout {
                  Layout.fillWidth: true
                  visible: String(modelData.time || "") !== "" ||
                           modelData.edited === true || String(modelData.effect || "") !== "" ||
                           modelData.failed === true || modelData.pending === true
                  spacing: 0
                  Item { Layout.fillWidth: true; visible: bubbleRow.mine }
                  Text {
                    Layout.rightMargin: bubbleRow.mine ? Style.space(6) : 0
                    Layout.leftMargin: bubbleRow.mine ? 0 : Style.space(6)
                    Layout.maximumWidth: Math.max(1, content.width * 0.78)
                    wrapMode: Text.WrapAnywhere
                    text: [modelData.failed === true ? "⚠ Not Delivered" : "",
                           modelData.failed === true ? String(modelData.failureReason || "")
                             : modelData.pending === true ? "Sending…" : String(modelData.time || ""),
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
          // Match the popup's bottom inset above the composer as well.
          Layout.topMargin: root.splitView ? 0 : Math.max(0, Style.spacing.popupPadding - Style.space(8))
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

            // The border belongs to the SLOT, not the field: inside composeFlick
            // the TextArea is as tall as its text, so a background there would
            // scroll away and its rounded bottom edge would be clipped off.
            BorderSurface {
              anchors.fill: parent
              color: Style.controlFill(composeField.activeFocus, composeField.hovered, root.foreground, root.mineFill)
              borderSpec: composeField._composeBorder
              radius: Style.cornerRadius
            }

            // A TextArea scrolls to its caret ONLY when it lives in a Flickable.
            // Anchored to fill this clipped slot it did not: past the fifth line
            // the text was still laid out, just below the visible area, and you
            // typed blind (Fred, 2026-09-07).
            Flickable {
              id: composeFlick
              anchors.fill: parent
              contentWidth: width
              contentHeight: composeField.height
              // Same reason the conversation's Flickable is not interactive: a
              // drag here IS text selection. The caret does the scrolling.
              interactive: false
              boundsBehavior: Flickable.StopAtBounds

              /** Keep the caret inside the viewport, both directions. */
              function showCaret() {
                var c = composeField.cursorRectangle
                var max = Math.max(0, contentHeight - height)
                if (c.y < contentY) contentY = Math.max(0, c.y)
                else if (c.y + c.height > contentY + height)
                  contentY = Math.min(max, c.y + c.height - height)
                else if (contentY > max) contentY = max
              }

              ComposerInput {
                id: composeField
                onActiveFocusChanged: if (activeFocus) root.commitPeek()
                spellingColor: root.urgent
                width: composeFlick.width
                // At least the viewport, so a click in empty space still lands in
                // the field; taller than it once the text outgrows five lines.
                height: Math.max(composeFlick.height, contentHeight + topPadding + bottomPadding)
                background: null
                onCursorRectangleChanged: composeFlick.showCaret()
                wrapMode: TextEdit.Wrap
                // Every edit is kept under the open conversation, so switching
                // threads does not lose it. A send clears the field and with it
                // the draft; leaving a thread nulls active BEFORE clearing, so the
                // draft stays. Loading a draft in openThread fires this too and
                // writes the same text back, which is harmless.
                onTextChanged: if (root.active) root.drafts[String(root.active.chat)] = text
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
                // Esc drops a bubble selection first (back to the bottom), then
                // leaves the thread — the two-step Esc a text selection gets.
                Keys.onEscapePressed: if (root.shareUrl !== "") root.closeShare(); else if (root.bubbleCursor >= 0) root.leaveBubbles(); else root.back()
                // Left from the START of the text (or an empty field) hands focus
                // back to the sidebar (split view); anywhere else it moves the
                // caret as usual — the arrows' edge rule. Not while the share
                // sheet is up: a specific-key handler runs before Keys.onPressed
                // and counts as accepted, and there Left is the sheet's.
                Keys.onLeftPressed: function(event) {
                  if (root.splitView && cursorPosition === 0 && root.shareUrl === "") root.navigationFocusRequested()
                  else event.accepted = false
                }
                // Ctrl+V goes through paste.ts: an image on the clipboard becomes
                // a draft chip; text falls through to a manual insert. One process
                // snapshots types AND data — probing then re-reading races.
                // Enter sends (iMessage); Shift+Enter inserts a newline.
                Keys.onPressed: (event) => {
                  if (root.shareKey(event.key)) { event.accepted = true; return }
                  if (event.matches(StandardKey.Paste)) {
                    event.accepted = true
                    root.startPaste()
                    return
                  }
                  var empty = text.length === 0
                  // Ordinary editing keys belong to the draft, including at
                  // its boundaries. History selection uses Page Up/Page Down.
                  if (event.key === Qt.Key_Up || event.key === Qt.Key_Down
                      || event.key === Qt.Key_Home || event.key === Qt.Key_End) {
                    root.clearBubbleCursor()
                    event.accepted = composeField.moveAtBoundary(event.key, event.modifiers)
                    return
                  }
                  // PgUp/PgDn work with a draft in the field (they move no caret):
                  // a screen at a time, or one bubble at a time with Shift held.
                  if (event.key === Qt.Key_PageUp || event.key === Qt.Key_PageDown) {
                    event.accepted = true
                    var dir = event.key === Qt.Key_PageUp ? -1 : 1
                    if (event.modifiers & Qt.ShiftModifier) root.moveBubbleCursor(dir)
                    else root.pageBubbles(dir)
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
                  if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter)
                      && !(event.modifiers & Qt.ShiftModifier)) {
                    event.accepted = true
                    root.send()
                  }
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

        // No empty status row below the composer. The resize grip overlays
        // the panel corner independently of this layout.
        Text {
          visible: root.note !== ""
          Layout.fillWidth: true
          text: root.note
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

  property var contactContext: null
  Menu {
    id: contactMenu
    MenuItem {
      text: "Review contact"
      onTriggered: if (root.contactContext) contactReview.review(root.contactContext)
    }
  }
  ContactReview {
    id: contactReview
    objectName: "blipContactReview"
    anchors.fill: parent
    threads: root.threads
    foreground: root.foreground
    accent: root.accent
    fontFamily: root.fontFamily
    fontSize: root.fontBodySmall
    onClosed: root.focusDefault()
    onCopyRequested: function(text) { root.copyText(text) }
  }

  // Copy feedback must remain visible above contact review and other subviews.
  // Only fixed status text is shown; copied contents never enter a notification.
  Rectangle {
    objectName: "blipCopyFeedback"
    visible: root.copyFeedback !== ""
    z: 1000
    anchors.horizontalCenter: parent.horizontalCenter
    anchors.bottom: parent.bottom
    anchors.bottomMargin: Style.space(56)
    width: Math.max(0, Math.min(parent.width - Style.space(16), copyFeedbackText.implicitWidth + Style.space(24)))
    height: copyFeedbackText.implicitHeight + Style.space(16)
    radius: Style.cornerRadius
    color: Color.background
    border.width: 1
    border.color: root.copyFeedback === "Copied to clipboard" ? root.accent : root.urgent
    Text {
      id: copyFeedbackText
      width: Math.max(0, parent.width - Style.space(24))
      wrapMode: Text.WordWrap; horizontalAlignment: Text.AlignHCenter
      anchors.centerIn: parent
      text: root.copyFeedback; textFormat: Text.PlainText
      color: root.foreground; font.family: root.fontFamily; font.pixelSize: root.fontCaption
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
      // ReleaseWithinBounds takes an exclusive grab on press: the tap ends
      // here instead of also reaching the row, bubble or link underneath.
      TapHandler { gesturePolicy: TapHandler.ReleaseWithinBounds; onTapped: root.closeShare() }
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
      TapHandler { gesturePolicy: TapHandler.ReleaseWithinBounds }   // clicks on the card stop here
      ColumnLayout {
        id: shareCol
        anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top
        anchors.margins: Style.space(14)
        spacing: Style.space(8)
        RowLayout {
          Layout.fillWidth: true
          spacing: Style.space(10)
          Text {
            Layout.fillWidth: true
            text: "SHARE LINK" + (root.shareUrls.length > 1 ? "  ·  " + (root.shareIndex + 1) + " of " + root.shareUrls.length : "")
            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.6)
            font.family: root.fontFamily; font.pixelSize: root.fontCaption; font.letterSpacing: 1
          }
          // ‹ › step through the message's links (the keyboard's ←/→)
          Repeater {
            model: root.shareUrls.length > 1 ? [-1, 1] : []
            delegate: Text {
              required property var modelData
              text: modelData < 0 ? "‹" : "›"
              color: root.foreground
              font.family: root.fontFamily; font.pixelSize: root.fontBody; font.bold: true
              HoverHandler { cursorShape: Qt.PointingHandCursor }
              TapHandler { gesturePolicy: TapHandler.ReleaseWithinBounds; onTapped: root.shareStep(modelData) }
            }
          }
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
          // shown while a code is being made too; hidden only when qrencode failed
          visible: root.shareQr !== "" || qrProc.running
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
            required property int index
            Layout.fillWidth: true
            height: Style.space(40)
            radius: Style.cornerRadius
            color: shareHover.hovered || index === root.shareCursor
              ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)
              : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.06)
            Text {
              anchors.centerIn: parent
              text: modelData.label
              color: root.foreground
              font.family: root.fontFamily; font.pixelSize: root.fontBodySmall
            }
            HoverHandler { id: shareHover; cursorShape: Qt.PointingHandCursor; onHoveredChanged: if (hovered) root.shareCursor = index }
            TapHandler {
              gesturePolicy: TapHandler.ReleaseWithinBounds
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
          text: (root.shareUrls.length > 1 ? "← → link  ·  " : "") + "1–3 or ↑↓ Enter  ·  Esc closes"
          color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.45)
          font.family: root.fontFamily; font.pixelSize: root.fontCaption
        }
      }
    }
  }
}
