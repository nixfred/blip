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
  /** The surface hosting this view is showing (popout: opened; window:
   *  visible). Gates reads, reloads, and autofocus — a hidden surface must
   *  never mark anything read. */
  property bool surfaceOpen: false
  // The window may be visible but unfocused / on another workspace: it still
  // renders and refreshes, but must not mark conversations read (war room #25).
  property bool readActive: true
  property color foreground: Color.foreground
  property color urgent: Color.urgent
  property string fontFamily: Style.font.family
  readonly property color dim: Qt.darker(foreground, 1.45)
  /** An editor owns the keyboard — the host's key catcher must stand down. */
  readonly property bool editorActive:
    composeField.activeFocus || searchField.activeFocus || newField.activeFocus || bubbleFocused
  readonly property alias composeEditor: composeField
  readonly property real contentHeightHint: listContent.implicitHeight
  /** The view wants keyboard navigation focus back (list mode). */
  signal navigationFocusRequested()
  // Palette follows the Omarchy theme (Fred, 2026-08-31). Color.* is the
  // live theme singleton — it hot-reloads on theme switch, so every accent,
  // bubble, and link repaints with the rest of the desktop. If the theme
  // ships no distinct accent (accent == foreground), fall back to iMessage
  // blue so "my" bubbles stay readable as mine.
  readonly property bool themeHasAccent: Color.accent.toString() !== Color.foreground.toString()
  readonly property color accent: themeHasAccent ? Color.accent : "#0a84ff"
  readonly property color cyan: accent            // legacy name; accents/links
  readonly property color okColor: accent

  readonly property color mineFill: accent
  // Bubble text picks black/white by which CONTRASTS better with the fill:
  // (L+0.05)/0.15 vs 1.05/(L+0.05) cross over near L≈0.35. A 0.6 threshold
  // chose white on medium accents where dark text is clearly more legible
  // (e.g. Evergreen #4a9a68: white 3.4:1 vs dark 5.1:1).
  readonly property color mineText:
    (0.299 * mineFill.r + 0.587 * mineFill.g + 0.114 * mineFill.b) > 0.35 ? "#1a1a1a" : "#ffffff"
  readonly property color theirsFill: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.14)
  readonly property color theirsText: foreground

  readonly property string home: Quickshell.env("HOME")
  readonly property string threadScript:
    decodeURIComponent(Qt.resolvedUrl("thread.ts").toString().replace(/^file:\/\//, ""))
  readonly property string fetchScript:
    decodeURIComponent(Qt.resolvedUrl("fetch.ts").toString().replace(/^file:\/\//, ""))
  readonly property string pasteScript:
    decodeURIComponent(Qt.resolvedUrl("paste.ts").toString().replace(/^file:\/\//, ""))
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

  // ---- search state (list view only; `/` opens, Esc closes)
  property bool searching: false
  property var searchResults: []
  property string searchNote: ""
  // Results replace the thread list only once a search has actually produced
  // something to show — focusing the box alone must not blank the list.
  readonly property bool searchShowing:
    searching && (searchResults.length > 0 || searchNote !== "")

  // Fetched attachments: id → file:// url; "" = fetch failed (chip shows ⚠).
  // The cache under ~/.cache/blip/att is global, so results never go stale on
  // a thread switch — no ownership tracking needed, unlike thread loads.
  property var attFiles: ({})
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
  readonly property bool online: hostWidget ? hostWidget.online : false
  readonly property int unread: hostWidget ? hostWidget.unread : 0

  // ---- view state
  property var active: null          // selected thread object, null = list view
  property var bubbles: []           // decorated messages for `active` (see thread.ts)
  property bool loading: false
  property string note: ""           // transient status line (send result, errors)
  property int cursor: -1            // keyboard row selection in list view
  property bool pinToBottom: false   // scroll to the newest bubble once layout settles
  property bool bubbleFocused: false // a bubble's TextEdit has focus (text selection in progress)
  property string threadRunningChat: "" // chat owned by the current threadProc
  property string bubblesJson: ""       // last rendered bubbles, for no-op reload detection
  property bool firstLoad: true         // first load of the open thread pins to bottom
  property string pendingThreadChat: "" // latest chat requested while it runs
  property string sendChat: ""          // immutable context for the current send
  property string sendText: ""
  property string reloadChat: ""

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
    threadProc.command = ["bun", root.threadScript, threadRunningChat, "80"]
    threadProc.running = true
  }

  /** IPC test hook: drive the exact user send path minus the keyboard.
   *  Keystroke injection (wtype) proved non-deterministic — a virtual
   *  keyboard's events can land on whatever surface Hyprland favors. */
  /** Clear every badge/dot locally. Read state never goes back to iMessage. */
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
  property var avatarFiles: ({})     // handle → file:// url, "" = no photo
  property var avatarQueue: []
  function requestAvatar(handle) {
    handle = String(handle || "")
    if (handle === "" || isGroupId(handle)) return
    if (avatarFiles[handle] !== undefined || avatarQueue.indexOf(handle) >= 0) return
    avatarQueue.push(handle)
    pumpAvatar()
  }
  function pumpAvatar() {
    if (avatarProc.running || avatarQueue.length === 0) return
    avatarProc.handle = avatarQueue.shift()
    avatarProc.command = ["bun", root.avatarScript, avatarProc.handle]
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

  function enqueueFetch(att, openWhenDone, auto) {
    var id = String(att.id || "")
    if (id === "" || fetchingId === id) return
    if (attFiles[id] !== undefined && !openWhenDone) return
    for (var i = 0; i < fetchQueue.length; i++) {
      if (fetchQueue[i].id === id) {
        if (openWhenDone) fetchQueue[i].open = true
        return
      }
    }
    fetchQueue.push({ id: id, name: String(att.name || "file"),
                      mime: String(att.mime || ""), open: openWhenDone === true,
                      auto: auto === true })
    pumpFetch()
  }

  property bool fetchJobOpen: false
  property string fetchJobMime: ""
  function pumpFetch() {
    if (fetchProc.running || fetchQueue.length === 0) return
    var job = fetchQueue.shift()
    fetchingId = job.id
    fetchJobOpen = job.open === true
    fetchJobMime = job.mime
    // Auto-pulls carry a hard transfer cap: claimed metadata is not the limit.
    fetchProc.command = ["bun", root.fetchScript, job.id, job.name, job.mime, job.auto ? "5242880" : ""]
    fetchProc.running = true
  }

  /** Images ≤ 5 MB in the open conversation fetch themselves (Fred's call —
   *  it's what makes the panel feel like Messages, and cached hits are free). */
  function autoFetchImages() {
    if (!inThread) return
    for (var i = 0; i < bubbles.length; i++) {
      var atts = bubbles[i].attachments || []
      for (var j = 0; j < atts.length; j++) {
        // bytes must be KNOWN and small — null/0 must not slip under the cap
        // and auto-pull something the click-path 100 MB ceiling would allow.
        var b = atts[j].bytes
        if (isImageMime(atts[j].mime) && typeof b === "number" && b > 0 && b <= 5 * 1024 * 1024)
          enqueueFetch(atts[j], false, true)
      }
      // link-card preview PNGs are small; the auto-fetch transfer cap bounds them
      var l = bubbles[i].link
      if (l && l.image_id) enqueueFetch({ id: String(l.image_id), name: "preview.png", mime: "image/png", bytes: 0 }, false, true)
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
    enqueueFetch(att, true)
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
    // Flipping several visibilities in one handler can miss the layout
    // pass — the panel collapsed to its hero until results forced a
    // rearrange (Fred's screenshot). Force it.
    Qt.callLater(function() { content.forceLayout(); newField.forceActiveFocus(); newField.selectAll() })
  }

  function exitNew() {
    newMode = false
    newResults = []
    newNote = ""
    newField.text = ""
    Qt.callLater(function() { content.forceLayout(); root.navigationFocusRequested() })
  }

  // Same identity discipline as message search: a stale completion must
  // never surface Alice's results under Bob's query (Codex HIGH, 1.2.0).
  property int contactSeq: 0
  property string contactPending: ""
  function runContactSearch() {
    var q = newField.text.trim()
    if (q === "") return
    // Bump the generation NOW so the in-flight (older) result is rejected,
    // never shown as clickable rows under the newer query (Codex audit #5).
    if (contactProc.running) { contactSeq++; newResults = []; newNote = "searching contacts…"; contactPending = q; return }
    contactSeq++
    newNote = "searching contacts…"
    newResults = []
    contactProc.command = ["bun", root.contactScript, q]
    contactProc.running = true
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
    Qt.callLater(function() { searchField.forceActiveFocus(); searchField.selectAll() })
  }

  function exitSearch() {
    searching = false
    searchResults = []
    searchNote = ""
    searchField.text = ""
    Qt.callLater(function() { root.navigationFocusRequested() })
  }

  // Monotonic id so a stale completion can never label itself with a newer
  // query; a query typed while one runs is queued (latest wins) and fires
  // when the runner frees up — same pattern as thread loads.
  property int searchSeq: 0
  property string searchPending: ""
  function runSearch() {
    var q = searchField.text.trim()
    if (q === "") return
    if (searchProc.running) { searchSeq++; searchResults = []; searchNote = "searching…"; searchPending = q; return }
    searchSeq++
    searchNote = "searching…"
    searchResults = []
    searchProc.command = ["bun", root.searchScript, q, "40"]
    searchProc.running = true
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

  /** SMS/RCS, or SMS after a failed iMessage to a phone (error 22). */
  function sendService() {
    var chat = String(root.active && root.active.chat ? root.active.chat : "")
    var phone = /^\+?[0-9]{5,}$/.test(chat)
    if (phone) {
      for (var i = 0; i < root.bubbles.length; i++) {
        if (root.bubbles[i].from_me === true && root.bubbles[i].failed === true) return "SMS"
      }
    }
    var s = String(root.active && root.active.service ? root.active.service : "")
    if (s === "SMS" || s === "RCS") return s
    return "iMessage"
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
        .concat(/^(SMS|RCS)$/i.test(root.sendService()) ? ["--service", root.sendService()] : [])
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
    // green-bubble (SMS/RCS) threads send on their own service (war room #2).
    // A failed iMessage to a phone (error 22) also sends SMS on the next try.
    var svc = root.sendService()
    if (!root.activeIsGroup && /^(SMS|RCS)$/i.test(svc)) target = target.concat(["--service", svc])
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
  Timer { id: noteTimer; interval: 1500; onTriggered: if (root.note === "copied") root.note = "" }

  function fmtTime(ts) {
    var s = String(ts || "")
    if (s.length < 16) return s
    var today = Qt.formatDateTime(new Date(), "yyyy-MM-dd")
    return s.substring(0, 10) === today ? s.substring(11, 16) : s.substring(5, 16)
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
          var m = Object.assign({}, root.attFiles)
          m[id] = d.ok === true ? String(d.url || "") : ""
          root.attFiles = m
          if (d.ok === true && root.fetchJobOpen) {
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
          if (d.kind === "image") root.setDraft(String(d.path || ""))
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
    if (inThread) return
    if (text === "/") startSearch()
    else if (text === "n" || text === "N") startNew()
    else if (searching || newMode) return
    else if (text === "r" || text === "R") { if (hostWidget) hostWidget.refresh(true, false) }
    else if (text === "a" || text === "A") markAllRead()
    else if (text >= "1" && text <= "9") {
      var i = Number(text) - 1
      if (i < threads.length) openThread(threads[i])
    }
  }
  /** Esc semantics for a host without a PanelKeyCatcher (the window): true if
   *  something was unwound, false if the host should close. */
  function unwind() {
    if (inThread) { back(); return true }
    if (newMode) { exitNew(); return true }
    if (searching) { exitSearch(); return true }
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
              font.pixelSize: Style.font.bodySmall
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
              font.pixelSize: Style.font.bodySmall
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
                font.pixelSize: Style.font.caption
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
              placeholderText: "name, number, or email — Enter searches contacts"
              foreground: root.foreground
              accent: root.accent
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              onAccepted: root.runContactSearch()
              Keys.onEscapePressed: root.exitNew()
            }

            Text {
              Layout.fillWidth: true
              visible: root.newMode && root.newNote !== ""
              text: root.newNote
              textFormat: Text.PlainText
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            Repeater {
              model: root.online && root.listShowing && root.newMode ? root.newResults : []
              delegate: Rectangle {
                required property var modelData
                Layout.fillWidth: true
                implicitHeight: contactRow.implicitHeight + Style.space(12)
                radius: Style.cornerRadius
                color: contactHover.hovered
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
                    font.pixelSize: Style.font.bodySmall
                    font.bold: true
                  }
                  Text {
                    Layout.fillWidth: true
                    text: String(modelData.handle || "") + "  ·  " + String(modelData.kind || "")
                    textFormat: Text.PlainText
                    elide: Text.ElideRight
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }
                }
              }
            }

            TextField {
              id: searchField
              Layout.fillWidth: true
              visible: root.online && root.listShowing && !root.newMode
              placeholderText: "🔍 search all messages"
              foreground: root.foreground
              accent: root.accent
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              onAccepted: root.runSearch()
              onActiveFocusChanged: if (activeFocus && !root.searching) root.searching = true
              Keys.onEscapePressed: root.exitSearch()
            }

            Text {
              Layout.fillWidth: true
              visible: root.searching && root.searchNote !== ""
              text: root.searchNote
              textFormat: Text.PlainText
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            Repeater {
              model: root.online && root.listShowing && root.searchShowing ? root.searchResults : []
              delegate: Rectangle {
                required property var modelData
                Layout.fillWidth: true
                implicitHeight: hitCol.implicitHeight + Style.space(12)
                radius: Style.cornerRadius
                color: hitHover.hovered
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
                            + (modelData.group ? "  ·  group" : "")
                      textFormat: Text.PlainText
                      elide: Text.ElideRight
                      color: root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.bodySmall
                      font.bold: true
                    }
                    Text {
                      text: String(modelData.ts || "").slice(0, 16)
                      textFormat: Text.PlainText
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                    }
                  }
                  Text {
                    Layout.fillWidth: true
                    text: (modelData.from_me ? "you: " : "") + String(modelData.text || "")
                    textFormat: Text.PlainText
                    elide: Text.ElideRight
                    maximumLineCount: 2
                    wrapMode: Text.WordWrap
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
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
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.WordWrap
            }

            Repeater {
              model: root.online && root.listShowing && !root.searchShowing && !root.newMode ? root.threads : []
              delegate: Rectangle {
                required property var modelData
                required property int index

                Layout.fillWidth: true
                implicitHeight: rowRow.implicitHeight + Style.space(root.splitView ? 20 : 12)
                radius: Style.cornerRadius
                color: rowHover.hovered || root.cursor === index
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
                    width: Style.space(30); height: width; radius: width / 2
                    color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.18)
                    readonly property string avatarHandle: String(modelData.handle || modelData.chat || "")
                    Component.onCompleted: if (!root.isGroupId(String(modelData.chat || ""))) root.requestAvatar(avatarHandle)
                    Image {
                      id: avatarImg
                      anchors.fill: parent
                      visible: false
                      source: root.avatarFiles[avatarCircle.avatarHandle] || ""
                      asynchronous: true
                      fillMode: Image.PreserveAspectCrop
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
                      text: {
                        var n = String(modelData.name || "")
                        if (/^[+0-9]/.test(n) || n === "") return "#"
                        var parts = n.trim().split(/\s+/).filter(function(p) { return p.length > 0 })
                        if (parts.length === 0) return "#"
                        return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase()
                      }
                      color: root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
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
                        font.pixelSize: Style.font.bodySmall
                        font.bold: modelData.unread > 0
                      }
                      Text {
                        text: root.fmtTime(modelData.last_ts)
                        textFormat: Text.PlainText
                        color: modelData.unread > 0 ? root.mineFill : root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                      }
                    }
                    Text {
                      Layout.fillWidth: true
                      text: (modelData.last_from_me ? "You: " : "") + String(modelData.last_text || "")
                      textFormat: Text.PlainText
                      elide: Text.ElideRight
                      maximumLineCount: 1
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
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
              var max = Math.max(0, flick.contentHeight - flick.height)
              flick.contentY = Math.max(0, Math.min(max, flick.contentY - d))
              // the wheel bypasses Flickable movement signals — maintain the
              // bottom-stick here too
              flick.stick = flick.contentY >= max - 4
              wheel.accepted = true
            }
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
              font.pixelSize: Style.font.caption
            }

            Repeater {
              model: root.inThread ? root.bubbles : []
              delegate: ColumnLayout {
                id: bubbleRow
                required property var modelData
                readonly property bool mine: modelData.from_me === true

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
                  font.pixelSize: Style.font.caption
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
                  font.pixelSize: Style.font.caption
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
                    font.pixelSize: Style.font.caption
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
                      font.pixelSize: Style.font.caption
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
                      source: chipRow.showImage ? chipRow.fileUrl : ""
                      asynchronous: true
                      fillMode: Image.PreserveAspectFit
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
                      Layout.preferredWidth: status === Image.Ready ? Math.min(maxW, implicitWidth) : maxW
                      Layout.preferredHeight: status === Image.Ready && implicitWidth > 0
                        ? Layout.preferredWidth * implicitHeight / implicitWidth
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
                        font.pixelSize: Style.font.caption
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
                  visible: !modelData.retracted && !!modelData.link
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
                    readonly property var link: modelData.link || ({})
                    readonly property string imgUrl: link.image_id ? String(root.attFiles[String(link.image_id)] || "") : ""
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
                        Layout.preferredHeight: visible && implicitWidth > 0
                          ? Math.min(Style.space(220), Math.round(linkCard.width * implicitHeight / implicitWidth))
                          : 0
                        source: linkCard.imgUrl
                        asynchronous: true
                        fillMode: Image.PreserveAspectCrop
                        sourceSize.width: 800
                        sourceSize.height: 800
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
                          font.pixelSize: Style.font.bodySmall
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
                          font.pixelSize: Style.font.caption
                        }
                        Text {
                          Layout.fillWidth: true
                          text: root.linkHost(String(linkCard.link.url || ""))
                          textFormat: Text.PlainText
                          elide: Text.ElideRight
                          color: bubbleRow.mine ? root.mineText : root.theirsText
                          opacity: 0.6
                          font.family: root.fontFamily
                          font.pixelSize: Style.font.caption
                        }
                      }
                    }
                    HoverHandler { cursorShape: Qt.PointingHandCursor }
                    TapHandler { onTapped: root.openLink(String(linkCard.link.url || "")) }
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
                           !(modelData.link && String(modelData.text || "").trim() === String(modelData.link.url))
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
                    Rectangle {
                      visible: modelData.groupEnd === true
                      width: Style.space(16); height: Style.space(16)
                      color: bubble.color
                      anchors.bottom: parent.bottom
                      anchors.right: bubbleRow.mine ? parent.right : undefined
                      anchors.left: bubbleRow.mine ? undefined : parent.left
                    }

                    // TextEdit, not Text: read-only but selectable, so a message
                    // can be highlighted and Ctrl+C'd like any other text.
                    TextEdit {
                      id: bubbleText
                      x: Style.space(11); y: Style.space(7)
                      width: bubble.maxInner
                      // html is pre-escaped + linkified in thread.ts (tested);
                      // plain messages keep the cheap PlainText path.
                      readonly property bool hasLink: String(modelData.html || "") !== ""
                      text: hasLink ? String(modelData.html) : String(modelData.text || "")
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
                      font.pixelSize: Style.font.bodySmall
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

                    // right-click = copy the whole message
                    TapHandler {
                      acceptedButtons: Qt.RightButton
                      onTapped: root.copyText(String(modelData.text || ""))
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
                        font.pixelSize: Style.font.caption
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
                    font.pixelSize: Style.font.caption
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
                    font.pixelSize: Style.font.caption
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
              font.pixelSize: Style.font.bodySmall
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
              font.pixelSize: Style.font.caption
            }
            HoverHandler { cursorShape: Qt.PointingHandCursor }
            TapHandler { onTapped: root.clearDraft() }
          }
          Item { Layout.fillWidth: true }
        }

        RowLayout {
          Layout.fillWidth: true
          visible: root.inThread
          spacing: Style.space(6)

          TextField {
            id: composeField
            Layout.fillWidth: true
            // NEVER disabled: this field is the panel's exclusive keyboard-focus
            // holder, and disabling the focused editor dismisses the whole
            // panel (0.7.2 postmortem; Codex design review #8). readOnly
            // instead; send() is the authoritative online/sendability guard.
            enabled: true
            readOnly: !root.online || !root.isSendable(root.active)
            placeholderText: root.draftPath !== ""
              ? "caption (optional) — Enter sends the file"
              : root.isSendable(root.active) ? root.sendService() : "Read-only — group id unknown"
            foreground: root.foreground
            accent: root.mineFill
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            onAccepted: root.send()
            Keys.onEscapePressed: root.back()
            // Ctrl+V goes through paste.ts: an image on the clipboard becomes
            // a draft chip; text falls through to a manual insert. One process
            // snapshots types AND data — probing then re-reading races.
            Keys.onPressed: (event) => {
              if (event.matches(StandardKey.Paste)) {
                event.accepted = true
                root.startPaste()
              }
            }
          }

          // send button — the blue arrow circle (lit when text OR a file is queued)
          Rectangle {
            readonly property bool armed: composeField.text.trim() !== "" || root.draftPath !== ""
            width: Style.space(28); height: width; radius: width / 2
            color: armed ? root.mineFill : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.15)
            Text {
              anchors.centerIn: parent
              text: "↑"
              color: parent.armed ? "#ffffff" : root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              font.bold: true
            }
            TapHandler { onTapped: root.send() }
          }
        }

        Text {
          Layout.fillWidth: true
          visible: root.note !== ""
          text: root.note
          textFormat: Text.PlainText
          color: root.note === "sending…" ? root.dim : root.urgent
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
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
}
