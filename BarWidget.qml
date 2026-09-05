import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import Quickshell.Hyprland

// blip — iMessage in the bar.
//
// iMessage is macOS-only: chat.db and the AppleScript send path both live on
// the Mac. This Linux box is a thin client over a multiplexed SSH socket (~47ms warm). This
// widget owns the single poller; the panel reads its state rather than running
// its own collector.
//
// Badge counts EVERY unread. Toasts fire only for allowlisted handles
// (~/.config/blip/allowlist.json) — chat.db is mostly bank alerts and 2FA codes,
// and none of that deserves an interruption.
//
// Left-click = panel · double-click = the app window · middle-click = refresh · right-click = mark all read.
BarWidget {
  id: root
  moduleName: "nixfred.blip"

  readonly property string home: Quickshell.env("HOME")
  readonly property string collectorPath:
    decodeURIComponent(Qt.resolvedUrl("collector.ts").toString().replace(/^file:\/\//, ""))

  // One validated preference source for both render surfaces. The popout and
  // app update together, and external dotfile restores are picked up live.
  BlipPreferences { id: preferences }

  // Clock and date patterns from this widget's shell.json entry — Qt format
  // strings, exactly as Omarchy's clock takes `format`. Qt formats the list
  // with them and thread.ts formats the bubbles with the same strings, so the
  // two never disagree. An explicit shell.json format wins; otherwise the
  // portable Blip preference decides 12- vs 24-hour, and an unloaded
  // preference file falls back to the locale (an AM/PM marker = 12-hour).
  readonly property string localeTimeFormat:
    /ap/i.test(Qt.locale().timeFormat(Locale.ShortFormat)) ? "h:mm AP" : "HH:mm"
  readonly property string preferredTimeFormat: preferences.loaded
    ? (preferences.use12HourConversationTimes ? "h:mm AP" : "HH:mm")
    : localeTimeFormat
  readonly property string timeFormat: formatSetting("timeFormat", preferredTimeFormat)
  readonly property string dateFormat: formatSetting("dateFormat", "MMM d")
  readonly property string dateFormatWithYear: formatSetting("dateFormatWithYear", "MMM d, yyyy")
  function formatSetting(name, fallback) { var v = String(setting(name, "")); return v === "" ? fallback : v }

  // ---- collector state
  property var threads: []           // [{chat,name,handle,service,last_ts,last_text,last_from_me,count,unread,pinned,pin_order}]
  property string threadsJson: ""    // last assigned list, for no-op detection
  property int unread: 0
  property bool online: false        // the Mac is reachable
  property bool healthy: false       // last collector run parsed cleanly
  property string lastError: ""
  property string lastRun: ""

  readonly property bool hasUnread: unread > 0

  // ---- one leader per session (war room #0): Omarchy builds one bar — and
  // therefore one of these widgets — PER SCREEN. Only the widget on the first
  // screen polls, watches, toasts, owns the app window and answers IPC; the
  // others show the badge from state.json and hand clicks to the leader.
  readonly property var ownScreen: QsWindow.window ? QsWindow.window.screen : null
  readonly property bool leader: !ownScreen || Quickshell.screens.length === 0
    || String(ownScreen.name) === String(Quickshell.screens[0].name)
  FileView {
    id: followerState
    path: root.home + "/.local/state/blip/state.json"
    watchChanges: !root.leader
    printErrors: false
    onFileChanged: reload()
    onLoaded: if (!root.leader) {
      try {
        var st = JSON.parse(text())
        var counts = st.unreadCounts || {}
        var n = 0
        for (var k in counts) n += Number(counts[k]) || 0
        root.unread = n; root.online = true; root.healthy = true
      } catch (e) {}
    }
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function toggle() { if (panelLoader.item) panelLoader.item.toggle() }
  function show(chat) {
    if (!panelLoader.item) return
    panelLoader.item.open()
    // `qs ipc call` rejects a leading "+" as a flag, so accept the bare digits too.
    // Exact match FIRST, alias second: when both variants exist as threads,
    // the alias must never shadow the exact one (Codex HIGH, 1.2.0).
    var want = String(chat)
    var t = null
    for (var i = 0; i < threads.length; i++) {
      if (String(threads[i].chat) === want) { t = threads[i]; break }
    }
    if (!t) for (var j = 0; j < threads.length; j++) {
      if (String(threads[j].chat) === "+" + want) { t = threads[j]; break }
    }
    // Only a FULL number gets a "+": short codes (99123) are their own chat id.
    if (!t && /^[0-9]{10,}$/.test(want)) want = "+" + want
    // Unknown to the current window: still open it, with the id as the name.
    panelLoader.item.openThread(t || { chat: want, handle: want, name: want })
  }

  /** Newest arriving link → the share sheet on whichever surface is open. */
  function shareArrivingLink(link) {
    if (!link || !link.url) return
    var w = windowLoader.item
    if (w && root.windowVisible && typeof w.shareLink === "function") { w.shareLink(String(link.url)); return }
    var p = panelLoader.item
    if (p && p.opened === true && typeof p.shareLink === "function") p.shareLink(String(link.url))
  }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    target.bar = root.bar
    target.anchorItem = button
    target.hostWidget = root
    target.preferences = preferences
  }
  onBarChanged: injectPanel()

  Loader {
    id: panelLoader
    active: root.leader
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  // The app: a Messages-style FloatingWindow living in the same shell process,
  // sharing this widget's poller/push/read ledger (Tier 4, no daemon needed).
  // Quickshell never re-maps a FloatingWindow after it has been hidden once
  // (visible flips true, no client appears — found 2026-08-31 when SUPER+M
  // "did nothing"). So the window is RECREATED on every show and destroyed
  // on hide; it persists its own state to ~/.local/state/blip/window.json
  // and restores size + "was open" on creation.
  Loader {
    id: windowLoader
    active: root.leader                // created at start so it can self-restore
    source: Qt.resolvedUrl("BlipWindow.qml")
    onLoaded: {
      item.hostWidget = root
      item.preferences = preferences
    }
  }
  readonly property bool windowVisible: windowLoader.item ? windowLoader.item.visible === true : false
  function hideWindow() {
    if (!windowLoader.item) return
    windowLoader.item.visible = false  // writes visible:false to state
    windowLoader.active = false
  }
  function ensureWindow() {
    // An existing-but-hidden FloatingWindow is never re-mapped by Quickshell
    // (setting visible=true shows nothing). Recreate it instead — this also
    // covers a window the compositor closed (SUPER+M hide path).
    if (windowLoader.item && !windowLoader.item.visible) windowLoader.active = false
    if (!windowLoader.active) {
      windowLoader.active = true
      root.refresh(true, false)          // full list, like the panel
    }
    // A fresh BlipWindow honours window.json (which may say hidden) — this
    // call means SHOW, so make it so once its restore pass has run.
    Qt.callLater(function() { if (windowLoader.item && !windowLoader.item.visible) windowLoader.item.visible = true })
  }
  function toggleWindow() {
    if (root.windowVisible) hideWindow()
    else ensureWindow()
  }
  // Show AND focus: a window restored on another workspace is invisible to
  // the user, and a plain toggle would HIDE it ("SUPER+M doesn't load the
  // app"). Hyprland ≥0.56 dispatch takes Lua; classic focuswindow is rejected.
  function showApp() {
    ensureWindow()
    if (!windowLoader.item) return
    // Fire-and-forget on purpose: a Process object silently ignores
    // `running = true` while it thinks a previous run is alive, which left
    // showApp() "succeeding" without ever focusing (SUPER+M "nothing at all").
    Quickshell.execDetached(["sh", "-c",
      'for i in 1 2 3 4 5 6 7 8; do a=$(hyprctl clients -j | jq -r \'.[] | select(.title | startswith("Blip")) | .address\' | head -1); [ -n "$a" ] && break; sleep 0.15; done; ' +
      '[ -n "$a" ] && hyprctl dispatch "hl.dsp.focus({ window = \\"address:$a\\" })" >/dev/null'])
  }
  function showSettings(page) {
    showApp()
    Qt.callLater(function() {
      if (!windowLoader.item) return
      windowLoader.item.visible = true
      windowLoader.item.openSettings(page)
    })
  }
  /** Either surface open → keep the deep (complete) thread list. */
  function anySurfaceOpen() {
    return (panelLoader.item && panelLoader.item.opened === true)
        || (windowLoader.item && windowLoader.item.visible === true)
  }

  // Single click = panel (opens immediately — no double-click lag); a second
  // click within the double-click window = close the panel and open the APP.
  Timer { id: dblClick; interval: 320 }
  function leftClick() {
    if (!root.leader) {
      // a follower bar: ask the leader (only it answers IPC)
      if (dblClick.running) { dblClick.stop(); Quickshell.execDetached(["qs", "-p", "/usr/share/omarchy/shell", "ipc", "call", root.moduleName, "app"]); return }
      dblClick.restart()
      Quickshell.execDetached(["qs", "-p", "/usr/share/omarchy/shell", "ipc", "call", root.moduleName, "toggle"])
      return
    }
    if (dblClick.running) {
      dblClick.stop()
      root.close()
      root.showApp()
      return
    }
    dblClick.restart()
    root.toggle()
  }

  // ------------------------------------------------------------ collector
  // `deep` widens the fetch window for the panel; `markRead` clears the badge.
  // `readChat` clears one thread's blue dot — iMessage semantics: the dot
  // survives viewing the list and only goes when that conversation is opened.
  property var refreshQueue: []        // stateful requests are never overwritten
  // The complete conversation list (quiet chats, pins) only comes from a deep
  // run (`imsg chats`); a shallow poll returns the window's rows. Kept so a
  // shallow result can be overlaid rather than replacing the model.
  property var deepThreads: []
  function overlayThreads(deep, shallow) {
    var byChat = {}
    for (var i = 0; i < shallow.length; i++) byChat[String(shallow[i].chat)] = shallow[i]
    var out = []
    for (var j = 0; j < deep.length; j++) {
      var t = deep[j], c = String(t.chat)
      if (byChat[c] !== undefined) { out.push(byChat[c]); delete byChat[c]; continue }
      // Every unread conversation is inside the poll window (the ledger's
      // catch-up fetch guarantees it), so a row the poll did not return has
      // been read since the deep run.
      out.push(t.unread > 0 ? Object.assign({}, t, { unread: 0 }) : t)
    }
    for (var k in byChat) out.push(byChat[k])
    out.sort(root.compareThreads)   // mirrors collector.ts compareThreads
    return out
  }
  function compareThreads(a, b) {
    var ap = a.pinned === true, bp = b.pinned === true
    if (ap !== bp) return ap ? -1 : 1
    if (ap && bp) {
      var ao = a.pin_order, bo = b.pin_order
      var an = ao === null || ao === undefined, bn = bo === null || bo === undefined
      if (!an && !bn && ao !== bo) return ao - bo
      if (!an && bn) return -1
      if (an && !bn) return 1
    }
    var at = String(a.last_ts || ""), bt = String(b.last_ts || "")
    return at < bt ? 1 : at > bt ? -1 : 0
  }
  property bool collectorReserved: false // a queued run owns the next event-loop turn

  function normalizedReadAliases(readChat, values) {
    var chat = String(readChat || "")
    var source = Array.isArray(values) ? values : []
    var out = []
    for (var i = 0; i < source.length && out.length < 15; i++) {
      var alias = String(source[i] || "")
      if (alias !== "" && alias !== chat && out.indexOf(alias) < 0) out.push(alias)
    }
    return out
  }

  function refresh(deep, markRead, readChat, seen, readAliases) {
    var req = { deep: deep === true, markRead: markRead === true,
                readChat: String(readChat || ""), seen: String(seen || ""),
                readAliases: normalizedReadAliases(readChat, readAliases) }
    if (collector.running || collectorReserved) { enqueueRefresh(req); return }
    runRefresh(req)
  }
  function enqueueRefresh(req) {
    var q = refreshQueue.slice()
    // Coalesce identical state transitions: plain refreshes merge with plain
    // refreshes, and same-chat read refreshes merge too (viewing a thread
    // makes every ping carry its readChat — without this the queue grows one
    // entry per ping). mark-all stays FIFO and is never overwritten.
    if (!req.markRead) {
      for (var i = 0; i < q.length; i++) {
        if (!q[i].markRead && q[i].readChat === req.readChat
            && JSON.stringify(q[i].readAliases || []) === JSON.stringify(req.readAliases)) {
          q[i] = { deep: q[i].deep || req.deep, markRead: false, readChat: req.readChat,
                   seen: req.seen > q[i].seen ? req.seen : q[i].seen,
                   readAliases: req.readAliases }
          refreshQueue = q
          return
        }
      }
    }
    q.push(req)
    refreshQueue = q
  }
  function runRefresh(req) {
    var args = ["bun", collectorPath]
    if (req.deep) args.push("--deep")
    if (req.markRead) args.push("--mark-read")
    if (req.readChat !== "") {
      args.push("--read", req.readChat)
      for (var i = 0; i < req.readAliases.length; i++)
        args.push("--read-alias", req.readAliases[i])
      if (req.seen !== "") args.push("--seen", req.seen)
    }
    collector.command = args
    collector.running = true
  }
  // ---------------------------------------------------- read consistency
  //
  // Read state truly lives in state.json and moves via collector runs — but
  // a round-trip takes ~1s, and a poll already IN FLIGHT when the user opens
  // a thread can land after it and resurrect the dot (double-flash). So a
  // read is applied OPTIMISTICALLY to the local model, and remembered in
  // localReads[chat] = the thread's last_ts at read time. Every collector
  // result is then filtered: a chat read locally stays unread=0 unless a
  // genuinely NEWER inbound message exists. Entries expire once persisted
  // state has caught up (or after 60s, whichever first).
  property var localReads: ({})

  function noteLocalRead(chat, lastTs) {
    var m = Object.assign({}, localReads)
    m[String(chat)] = { ts: String(lastTs || ""), at: Date.now() }
    localReads = m
  }

  function applyLocalReads(list) {
    var now = Date.now()
    var m = Object.assign({}, localReads)
    var dirty = false
    var out = list.map(function(t) {
      var r = m[String(t.chat)]
      if (!r) return t
      // persistence caught up (or nothing left) — retire the entry so stale
      // suppression rules can't linger for the TTL (Codex #5)
      if (t.unread === 0) { delete m[String(t.chat)]; dirty = true; return t }
      if (now - r.at > 60000) { delete m[String(t.chat)]; dirty = true; return t }
      // ANY activity newer than what was read means the collector's count is
      // fresher than this suppression — trust it (direction-free: a
      // read→inbound→outbound sequence must not hide the inbound, Codex #2)
      if (String(t.last_ts) > r.ts) return t
      return Object.assign({}, t, { unread: 0 })
    })
    if (dirty) localReads = m
    return out
  }

  function markThreadRead(chat, aliases) {
    var c = String(chat)
    var lastTs = ""
    var list = threads.map(function(t) {
      if (String(t.chat) !== c) return t
      lastTs = String(t.last_ts || "")
      return t.unread > 0 ? Object.assign({}, t, { unread: 0 }) : t
    })
    noteLocalRead(c, lastTs)
    threads = list
    unread = list.reduce(function(n, t) { return n + (Number(t.unread) || 0) }, 0)
    refresh(true, false, c, lastTs, aliases)
  }

  function markAllRead() {
    for (var i = 0; i < threads.length; i++)
      noteLocalRead(String(threads[i].chat), String(threads[i].last_ts || ""))
    threads = threads.map(function(t) {
      return t.unread > 0 ? Object.assign({}, t, { unread: 0 }) : t
    })
    unread = 0
    // deep when a surface shows the full list: a shallow result would replace
    // it with the 150-row window's chats (war room #17)
    refresh(anySurfaceOpen(), true)
  }

  /** The open conversation's chat, "" when the panel is closed or listing —
   *  refreshes carry it so a message arriving in the thread the user is
   *  LOOKING AT is counted read in the same collector run, not flashed
   *  unread and cleared a round-trip later. */
  /** The surface currently showing a conversation: the popout wins when open
   *  (it is in front), else the window when visible, else none. Both hosts
   *  expose the same proxies (inThread/active/loading/activeLastTs). */
  function readingSurface() {
    var p = panelLoader.item
    if (p && p.opened === true && p.inThread === true) return p
    var w = windowLoader.item
    // the window must be FOCUSED to count as being read (war room #25)
    if (w && w.visible === true && w.focused === true && w.inThread === true) return w
    return null
  }
  function activeReadChat() {
    var s = readingSurface()
    // a still-LOADING conversation is not yet read (Codex #4)
    return (s && s.loading !== true) ? String(s.active.chat) : ""
  }
  function activeSeenTs() {
    var s = readingSurface()
    return s ? String(s.activeLastTs || "") : ""
  }
  function activeReadAliases() {
    var s = readingSurface()
    return s && s.active ? s.active.aliases || [] : []
  }

  Process {
    id: collector
    command: ["bun", root.collectorPath]
    // A Process that FAILS TO START (bun not on the shell's PATH) emits only
    // runningChanged — no exited, no stream end — and the icon would say
    // "Mac unreachable" forever (war room #18). Detect the missing exit.
    property bool sawExit: false
    onRunningChanged: {
      if (running) { sawExit = false; return }
      Qt.callLater(function() {
        if (!collector.sawExit && !collector.running) {
          root.online = false; root.healthy = false
          root.lastError = "cannot start `bun` — install it (pacman -S bun) and restart the shell"
        }
      })
    }
    stdout: StdioCollector {
      onStreamFinished: {
        // A garbled run keeps the last good thread list rather than flashing
        // the bar empty — same discipline as larry.status's session collector.
        try {
          var d = JSON.parse(text.trim())
          root.online = d.online === true
          root.lastError = String(d.error || "")
          root.lastRun = String(d.ts || "")
          if (d.ok === true) {
            // Filter through the optimistic-read ledger: a poll that was
            // already in flight when the user opened a thread must not
            // resurrect its dot for one round-trip (the double-flash).
            var list = root.applyLocalReads(Array.isArray(d.threads) ? d.threads : [])
            // A shallow poll carries only the message window's rows. Overlay
            // it on the last complete list so the panel never opens onto a
            // dozen rows that grow (and re-pin) a deep run later.
            if (d.deep === true) root.deepThreads = list
            else if (root.deepThreads.length > 0) list = root.overlayThreads(root.deepThreads, list)
            // Reassigning `threads` rebuilds the panel's list Repeater and
            // resets its scroll — with push, that was every few seconds.
            // Skip the assignment when nothing actually changed.
            var j = JSON.stringify(list)
            if (j !== root.threadsJson) {
              root.threadsJson = j
              root.threads = list
            }
            root.unread = list.reduce(function(n, t) { return n + (Number(t.unread) || 0) }, 0)
            root.healthy = d.persisted !== false
            // A message that carries a security code gets the code toast only:
            // its ordinary preview would put the digits into the daemon's
            // on-disk history like any other body (Astra #1).
            var codeKeys = {}
            if (Array.isArray(d.codes)) d.codes.forEach(function(c) { codeKeys[String(c.chat) + "\u0000" + String(c.ts)] = true })
            if (Array.isArray(d.toast)) root.fireToasts(d.toast.filter(function(t) { return !codeKeys[String(t.chat) + "\u0000" + String(t.ts)] }))
            // A link that just arrived opens the share sheet (Fred, 2.3.0).
            // Only onto a surface that is ALREADY open: Omarchy runs
            // focus_on_activate=false and Blip never steals focus, so a bank
            // alert must not throw a panel over full-screen work. When Blip is
            // closed the desktop toast is still the notification.
            if (Array.isArray(d.links) && d.links.length > 0) root.shareArrivingLink(d.links[d.links.length - 1])
            // A security code that just arrived: hold the newest, toast it.
            if (Array.isArray(d.codes) && d.codes.length > 0) root.noteCode(d.codes[d.codes.length - 1])
            // A send of YOURS that died — not allowlist-gated, interrupts once.
            if (Array.isArray(d.failures) && d.failures.length > 0)
              root.fireToasts(d.failures.map(function(f) {
                return { chat: f.chat, name: "⚠ Not delivered to " + f.name, text: f.text, ts: f.ts, key: f.key }
              }))
          } else {
            root.healthy = false
            if (!root.online) root.unread = 0     // offline: no honest count to show
          }
        } catch (e) {
          root.healthy = false
          root.lastError = "collector produced unparseable output"
        }
      }
    }
    onExited: function(code, status) {
      collector.sawExit = true
      if (code !== 0) root.healthy = false
      if (root.refreshQueue.length > 0) {
        var q = root.refreshQueue.slice()
        var next = q.shift()
        root.refreshQueue = q
        root.collectorReserved = true
        Qt.callLater(function() {
          root.collectorReserved = false
          root.runRefresh(next)
        })
      }
    }
  }

  Timer {
    // With the push watcher connected this is only a safety net; without it
    // (Mac down, watcher restarting) it is the old 6 s poll.
    // offline: back off to 30 s — a Mac that is off for the night must not
    // eat a bun + ssh probe every 6 s (war room #19); "ready" restores 6 s
    interval: root.watchAlive ? 60000 : (root.online ? 6000 : 30000)
    running: root.leader
    repeat: true
    triggeredOnStart: true
    // While the panel is open keep the wide window, or the list would shrink
    // from 40 threads to 14 on the next tick. Until ONE deep run has landed
    // (startup, or after a garbled one) go deep regardless, so the first
    // open finds the complete, pinned list already in memory.
    onTriggered: root.refresh(root.anySurfaceOpen() || root.deepThreads.length === 0, false,
                              root.activeReadChat(), root.activeSeenTs(), root.activeReadAliases())
  }

  // ------------------------------------------------- real-time push
  // `imsg watch` blocks on the Mac and emits one line per chat.db change — an
  // INVALIDATION, no content (BlueFerry's design: session-visible push
  // channels carry "something changed", clients fetch privately). Each ping
  // debounces into the normal refresh, so a burst of messages costs one
  // fetch. The ssh session rides the same ControlMaster mux as everything
  // else; if it dies (sleep, network), a timer restarts it and the 6 s poll
  // resumes in the meantime.
  property bool watchAlive: false
  property int watchFails: 0
  Process {
    id: watchProc
    command: [root.home + "/bin/imsg", "watch"]
    running: root.leader
    // arm liveness at START: a watcher that hangs before "ready" was never
    // killed or restarted (war room #20)
    onStarted: watchLiveness.restart()
    stdout: SplitParser {
      onRead: function(line) {
        var l = String(line).trim()
        watchLiveness.restart()          // any line proves the channel is real
        if (l === "ready") { root.watchAlive = true; root.watchFails = 0; return }
        if (l === "hb") return           // heartbeat only — no refresh
        pingDebounce.restart()
      }
    }
    onExited: {
      root.watchAlive = false
      watchLiveness.stop()
      root.watchFails = Math.min(root.watchFails + 1, 5)
      watchRestart.restart()
    }
  }
  // The server heartbeats every ~30 s; 90 s of total silence means a
  // half-open ssh channel — kill it so the restart path (and the fast poll)
  // takes over instead of trusting a dead pipe forever.
  Timer {
    id: watchLiveness
    interval: 90000
    onTriggered: { watchProc.running = false }
  }
  Timer {
    id: pingDebounce
    interval: 250
    onTriggered: {
      var panel = panelLoader.item
      // Carrying the open thread's chat means a message landing in the
      // conversation the user is READING is counted read in this same run —
      // no badge flash, no second round-trip.
      root.refresh(root.anySurfaceOpen(), false, root.activeReadChat(), root.activeSeenTs(),
                   root.activeReadAliases())
      // Reload the OPEN conversation in parallel — waiting for the collector
      // and then reloading serially added a visible second of latency.
      // Both surfaces: each gates itself on its own surfaceOpen.
      if (panel && panel.opened === true && typeof panel.pushReload === "function")
        panel.pushReload()
      var w = windowLoader.item
      if (w && w.visible === true && typeof w.pushReload === "function")
        w.pushReload()
    }
  }
  Timer {
    id: watchRestart
    // Exponential backoff on consecutive failures (8s → 128s cap): a Mac
    // that is off for the night must not eat an ssh probe every 8 seconds.
    // Any successful "ready" resets the ladder.
    interval: 8000 * Math.pow(2, root.watchFails)
    onTriggered: watchProc.running = true
  }

  // ------------------------------------------------------------ toasts
  // One notify-send per allowlisted inbound message. The collector has already
  // applied the allowlist and the dedupe ring, so anything arriving here is
  // meant to interrupt. Reuses the no-focus-steal notification behaviour.
  // With --wait + actions, clicking the toast (default) or its Reply button
  // opens the panel ON that conversation, compose focused — the daemon
  // advertises the "actions" capability (verified via GetCapabilities).
  Process {
    id: notifyProc
    stdout: StdioCollector {
      onStreamFinished: {
        var action = text.trim()
        if (action === "default" && notifyProc.toastCode !== "") { root.copyCode(notifyProc.toastCode); return }
        if ((action === "default" || action === "reply") && notifyProc.toastChat !== "")
          root.show(notifyProc.toastChat)
      }
    }
    property string toastChat: ""
    property string toastCode: ""    // set for a code toast: click = copy, not open
  }
  property var toastQueue: []

  function fireToasts(list) {
    if (!list || list.length === 0) return
    var q = toastQueue.slice()
    for (var i = 0; i < list.length; i++) q.push(list[i])
    // A hung notify-send must not grow the queue forever (Codex finding #14):
    // keep the newest 20 and drop the backlog — the badge still counts them.
    if (q.length > 20) q = q.slice(q.length - 20)
    toastQueue = q
    drainToasts()
  }
  function drainToasts() {
    if (notifyProc.running || toastQueue.length === 0) return
    var q = toastQueue.slice()
    var t = q.shift()
    toastQueue = q
    var body = String(t.text || "")
    if (body.length > 220) body = body.substring(0, 217) + "…"
    notifyProc.toastChat = String(t.chat || "")
    notifyProc.toastCode = String(t.code || "")
    // Where this toast came from, in a form that outlives it.
    //
    // --action=default lives inside this notify-send process and dies with it
    // after eight seconds, so an old row in the notification center could
    // never reach Blip. Omarchy also reads a hint, `omarchy-exec-argv`, which
    // it persists with the notification, and that is the supported way for a
    // restored notification to stay clickable. The value is built here and
    // never contains anything a sender chose: the chat id is a handle Blip
    // already resolved, it travels as its own argv element rather than inside
    // a shell string, and a leading "+" is dropped because `qs ipc call` would
    // read it as a flag (show() matches the bare digits as an alias).
    var reopen = []
    var chatArg = notifyProc.toastChat.replace(/^\+/, "")
    if (notifyProc.toastCode !== "")
      // popup only: the daemon must not write the code into its on-disk
      // history (~/.local/state/omarchy/notifications/history). It expires
      // from memory in five minutes; there is nothing to restore.
      reopen = ["--hint=boolean:transient:true"]
    else if (chatArg !== "" && /^[A-Za-z0-9._@:;$-]{1,256}$/.test(chatArg))
      reopen = ["--hint=string:omarchy-exec-argv:" + JSON.stringify(
        ["qs", "-p", "/usr/share/omarchy/shell", "ipc", "call",
         root.moduleName, "goto", chatArg])]

    notifyProc.command = [
      "notify-send",
      "--app-name=Blip",
      "--icon=mail-message-new",
      "--expire-time=8000",
      // --wait blocks until the toast closes and prints the chosen action.
      // Only `default` (clicking the card): the Omarchy notification daemon
      // renders no action BUTTONS and only ever invokes default — an
      // advertised Reply button would be a lie (Codex, read the daemon).
      "--wait",
      notifyProc.toastCode !== "" ? "--action=default=Copy" : "--action=default=Open",
    ].concat(reopen).concat([
      "--",                                   // a name or text starting with "-" is data, not a flag
      String(t.name || t.chat || "iMessage"),
      body
    ])
    notifyProc.running = true
    // The daemon PAUSES expiry while the pointer hovers a toast, and --wait
    // waits for closure — a toast parked under a stationary cursor must not
    // dam the whole serial queue (Codex, 1.2.0). 45 s is watchdog, not UX.
    toastWatchdog.restart()
  }
  Timer {
    id: toastWatchdog
    interval: 45000
    onTriggered: if (notifyProc.running) notifyProc.running = false
  }
  Connections {
    target: notifyProc
    function onExited(code, status) { toastWatchdog.stop(); Qt.callLater(root.drainToasts) }
  }

  // ------------------------------------------------------ security codes
  // macOS reads a 2FA code out of an SMS and offers it to the browser. Blip's
  // version: the collector spots the code, the widget holds it IN MEMORY for
  // five minutes (never state.json — it is message text), toasts it, and on
  // request copies it (click the toast, or `copycode`) or types it into
  // whatever has keyboard focus (`typecode`, bound to a hotkey). The code
  // reaches wl-copy through an environment variable and stdin, and the
  // focused window as key events over Hyprland's socket — never argv, where
  // any process could read it from /proc.
  //
  // NOT wtype. A virtual keyboard's key presses are merged with the physical
  // keyboard's modifier state, so the digits typed while the user's fingers
  // are still on Super+Shift became Super+Shift+<digit> — workspace binds.
  // `send_key_state` (what Omarchy's universal paste uses) hands the key
  // straight to the focused window without consulting binds.
  property var pendingCode: null         // {code, name, domain, ts} or null
  Timer {
    id: codeExpiry
    interval: 300000
    onTriggered: root.pendingCode = null
  }
  function noteCode(c) {
    if (!c || !c.code) return
    pendingCode = { code: String(c.code), name: String(c.name || c.chat || ""), domain: String(c.domain || ""), ts: String(c.ts || "") }
    codeExpiry.restart()
    var who = pendingCode.name !== "" ? pendingCode.name : "a message"
    // The digits are NOT in the body. Omarchy's daemon persists every displayed
    // toast's body to ~/.local/state/omarchy/notifications/history — its own
    // Service.qml says the transient hint only decides whether a DND-silenced
    // one is recorded — so a body with the code put the code on disk (Astra
    // #1). The toast says a code arrived; click copies it from memory.
    var body = (pendingCode.domain !== "" ? "For " + pendingCode.domain + " · " : "")
             + "Click to copy · Super+Shift+V types it"
    fireToasts([{ chat: "", name: "Security code from " + who, text: body, ts: pendingCode.ts, key: "", code: pendingCode.code }])
  }
  // sh reads the code from its environment, hands it to the tool on stdin.
  property string copyValue: ""          // what the NEXT copy hands to wl-copy
  Process {
    id: codeCopyProc
    environment: ({ BLIP_CODE: root.copyValue })
    command: ["sh", "-c", "printf %s \"$BLIP_CODE\" | wl-copy"]
    onExited: root.copyValue = ""
  }
  /** Copy a code. A toast passes the code it DISPLAYED, so clicking an older
   *  toast after a newer code arrived copies what was on the card, not the
   *  newer one (Astra #14). IPC `copycode` passes nothing: the newest. */
  function copyCode(code) {
    if (!pendingCode) return "no code pending"
    copyValue = String(code || pendingCode.code)
    codeCopyProc.running = true
    return "copied"
  }
  // One key event per tick: down, then up, 20 ms apart (Omarchy's paste
  // helper uses 50 between the two). A single dispatch per event keeps the
  // socket write small and the order guaranteed.
  property var keyQueue: []
  Timer {
    id: keyPump
    interval: 20
    repeat: true
    onTriggered: {
      if (root.keyQueue.length === 0) { stop(); return }
      var q = root.keyQueue.slice()
      var k = q.shift()
      root.keyQueue = q
      Hyprland.dispatch('hl.dsp.send_key_state({ mods = "' + k.mods + '", key = "' + k.key + '", state = "' + k.state + '" })')
    }
  }
  /** xkb key name + modifiers for one character of a code, or null. */
  function keyFor(ch) {
    if (/^[0-9a-z]$/.test(ch)) return { key: ch, mods: "" }
    if (/^[A-Z]$/.test(ch)) return { key: ch.toLowerCase(), mods: "SHIFT" }
    if (ch === "-") return { key: "minus", mods: "" }
    return null
  }
  function typeCode() {
    if (!pendingCode) return "no code pending"
    var q = []
    var code = String(pendingCode.code)
    for (var i = 0; i < code.length; i++) {
      var k = keyFor(code.charAt(i))
      if (!k) continue
      q.push({ key: k.key, mods: k.mods, state: "down" })
      q.push({ key: k.key, mods: k.mods, state: "up" })
    }
    keyQueue = q
    keyPump.start()
    return "typed"
  }

  // ------------------------------------------------------------ IPC
  // IPC that sends or reads message content is a deputy for any local
  // process (Codex audit #3). It is opt-in: automation=on in bridge.conf.
  // status/open/close/toggle/window/app/settings stay available — they expose nothing.
  property bool automationOn: false
  /** `ui_font=theme` in bridge.conf: never use SF Pro even when it is present. */
  property bool uiFontTheme: false
  /** `ui_font_size=N` in bridge.conf: bubble text in px (9–24). 0 = Omarchy default. */
  property int uiFontSize: 0
  // The version, read from THIS plugin's manifest.json — the one place it is
  // written, so a release bump is the only thing that ever updates what the
  // header shows (Fred, 2.3.3: "keep it there forever updated"). Both surfaces
  // take it from here through BlipView, so they can never disagree.
  property string version: ""
  FileView {
    id: manifestFile
    path: Qt.resolvedUrl("manifest.json").toString().replace(/^file:\/\//, "")
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      try { root.version = String(JSON.parse(text()).version || "") } catch (e) { root.version = "" }
    }
    onLoadFailed: root.version = ""
  }
  readonly property string automationOff: "blip: automation=off — set automation=on in ~/.config/blip/bridge.conf to allow ipc send/read"
  FileView {
    id: bridgeConf
    path: root.home + "/.config/blip/bridge.conf"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      var t = text()
      root.automationOn = /^\s*automation\s*=\s*['"]?(on|true|1|yes)\b/mi.test(t)
      // ui_font=theme keeps Omarchy's family even where SF Pro is installed.
      root.uiFontTheme = /^\s*ui_font\s*=\s*['"]?theme\b/mi.test(t)
      var sm = t.match(/^\s*ui_font_size\s*=\s*['"]?(\d+)/mi)
      var n = sm ? parseInt(sm[1], 10) : 0
      root.uiFontSize = (!isFinite(n) || n <= 0) ? 0 : Math.min(24, Math.max(9, n))
    }
    onLoadFailed: { root.automationOn = false; root.uiFontTheme = false; root.uiFontSize = 0 }
  }
  IpcHandler {
    target: root.moduleName
    enabled: root.leader
    function status(): string {
      var w = windowLoader.item
      return "online=" + root.online + " unread=" + root.unread + " leader=" + root.leader
        + " window=" + (w && w.visible ? (w.focused ? "focused" : "unfocused") : "hidden")
        + " threads=" + root.threads.length + " healthy=" + root.healthy
        + " push=" + root.watchAlive
        + (root.lastError !== "" ? " error=" + root.lastError : "")
    }
    function threads(): string { return root.automationOn ? JSON.stringify(root.threads) : root.automationOff }
    function refresh(): void { root.refresh(root.anySurfaceOpen(), false) }
    function read(): string { if (!root.automationOn) return root.automationOff; root.markAllRead(); return "read" }
    function open(): void { root.open() }
    function close(): void { root.close() }
    function toggle(): void { root.toggle() }
    function goto(chat: string): string { if (!root.automationOn) return root.automationOff; root.show(chat); return "shown" }
    function copycode(): string { if (!root.automationOn) return root.automationOff; return root.copyCode() }
    function typecode(): string { if (!root.automationOn) return root.automationOff; return root.typeCode() }
    function share(url: string): string { if (!root.automationOn) return root.automationOff; root.open(); return panelLoader.item ? panelLoader.item.shareLink(url) : "no panel" }
    function compose(text: string): string { if (!root.automationOn) return root.automationOff; return panelLoader.item ? panelLoader.item.composeAndSend(text) : "no panel" }
    function bubbles(): string { if (!root.automationOn) return root.automationOff; return panelLoader.item ? panelLoader.item.bubbleModel() : "[]" }
    function find(query: string): string { if (!root.automationOn) return root.automationOff; return panelLoader.item ? panelLoader.item.searchFor(query) : "no panel" }
    function newchat(query: string): string { if (!root.automationOn) return root.automationOff; return panelLoader.item ? panelLoader.item.newChatFor(query) : "no panel" }
    function window(): string { root.toggleWindow(); return root.windowVisible ? "window shown" : "window hidden" }
    function app(): string { root.showApp(); return "app shown + focused" }
    function settings(): string { root.showSettings(); return "settings shown" }
    function appearance(): string { root.showSettings("appearance"); return "appearance settings shown" }
    function windowgoto(chat: string): string {
      if (!root.automationOn) return root.automationOff
      root.ensureWindow()
      var w = windowLoader.item
      if (!w) return "no window"
      var want = String(chat)
      for (var i = 0; i < root.threads.length; i++) {
        var c = String(root.threads[i].chat)
        if (c === want || c === "+" + want) { w.openThread(root.threads[i]); return "opened " + c }
      }
      return "unknown chat"
    }
  }

  // ------------------------------------------------------------ bar button
  function tooltip() {
    var parts = []
    if (!root.online) parts.push("Mac unreachable — iMessage bridge offline")
    else if (root.unread === 0) parts.push("No unread messages")
    else parts.push(root.unread + " unread message" + (root.unread === 1 ? "" : "s"))

    if (root.online && root.unread > 0) {
      var hot = root.threads.filter(function(t){ return t.unread > 0 }).slice(0, 4)
      for (var i = 0; i < hot.length; i++)
        parts.push("  " + hot[i].name + " (" + hot[i].unread + ")")
    }
    if (root.online && !root.healthy && root.lastError !== "") parts.push("⚠ " + root.lastError)
    return parts.join("\n") + "\nclick: threads · double-click: app · middle: refresh · right: mark all read"
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: ""
    hasVisualContent: true
    labelVisible: false
    keepSpace: true
    fixedWidth: content.implicitWidth + Style.spaceReal(horizontalMargin) * 2
    dimmed: !root.online
    active: root.hasUnread
    useActiveColor: false
    tooltipText: root.tooltip()
    onPressed: function(code) {
      if (!root.leader && code !== Qt.LeftButton) {
        // A follower bar (second monitor): only the leader owns the collector.
        // A refresh or mark-all started HERE was a second collector racing the
        // leader's over state.json (Astra #10). Ask the leader, like leftClick.
        // `read` is automation-gated, so with automation=off this is a no-op.
        Quickshell.execDetached(["qs", "-p", "/usr/share/omarchy/shell", "ipc", "call",
                                 root.moduleName, code === Qt.RightButton ? "read" : "refresh"])
        return
      }
      if (code === Qt.MiddleButton) root.refresh(root.anySurfaceOpen(), false)
      else if (code === Qt.RightButton) root.markAllRead()
      else root.leftClick()
    }

    Row {
      id: content
      anchors.centerIn: parent
      spacing: Style.spaceReal(4)

      Text {
        anchors.verticalCenter: parent.verticalCenter
        // Nerd Font: filled speech bubble when unread, outline when quiet,
        // slashed when the bridge is down.
        text: !root.online ? "󰻞" : (root.hasUnread ? "󰭹" : "󰭻")
        textFormat: Text.PlainText
        color: root.hasUnread ? root.blipAccent : button.foreground
        font.family: button.fontFamily
        font.pixelSize: Style.font.body
        renderType: Text.NativeRendering
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        visible: root.online && root.unread > 0
        text: root.unread > 99 ? "99+" : root.unread
        textFormat: Text.PlainText
        color: root.blipAccent
        font.family: button.fontFamily
        font.pixelSize: Style.font.bodySmall
        font.bold: true
        renderType: Text.NativeRendering
      }
    }
  }

  // iMessage blue, always. The unread dot and the lit glyph are Blip's signal,
  // and the signal is "blue bubbles" — not whatever this theme uses for accent
  // (several Omarchy themes use red, which must stay reserved for alerts, and a
  // red dot on a messaging icon reads as an error). Fred, 2.3.3: "should ALWAYS
  // be BLUE no matter what."
  readonly property color blipAccent: "#0a84ff"
}
