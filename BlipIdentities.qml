import QtQuick
import Quickshell
import Quickshell.Io

// Short-lived, bounded bridge between the settings UI and identities.ts.
// No writable contact/config file is parsed inside the shell process.
Item {
  id: root
  visible: false
  implicitWidth: 0
  implicitHeight: 0

  readonly property string home: Quickshell.env("HOME")
  readonly property string configPath: home + "/.config/blip/identities.json"
  readonly property string runtimeDirectory: Quickshell.env("XDG_RUNTIME_DIR")
  readonly property string helperPath:
    decodeURIComponent(Qt.resolvedUrl("identities.ts").toString().replace(/^file:\/\//, ""))

  property var identities: []
  property var candidates: []
  property var audit: null
  property string activeHandle: ""
  property bool loaded: false
  property bool loading: false
  property string error: ""
  property string notice: "Loading contact choices…"
  property string currentOperation: ""
  property bool reloadAfterExit: false
  property bool readSilently: false
  property string identitiesJson: ""
  property string pendingReviewHandle: ""
  property bool refreshCandidatesAfterExit: false
  property int pendingAuditCount: 0
  property bool quietAudit: false
  // The cleanup scan runs on its own dedicated process (auditWorker) so a
  // long scan never contends with navigation or candidate lookups on the
  // interactive worker.
  property bool auditRunning: false
  property string pendingAuditFingerprint: ""
  property string auditFingerprint: ""

  signal choicesChanged()

  function safeText(value, maximum) {
    if (typeof value !== "string" || value.length > maximum) return ""
    return value
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
      .replace(/\s+/g, " ").trim()
  }

  function safeError(value) {
    return safeText(String(value || "Contact-name operation failed"), 180)
      || "Contact-name operation failed"
  }

  function handleKey(value) {
    var handle = String(value || "")
    if (handle.indexOf("@") >= 0) return "email:" + handle.toLowerCase()
    var digits = handle.replace(/\D/g, "")
    return "phone:" + (digits.length >= 10 ? digits.slice(-10) : digits)
  }

  function validToken(value) {
    return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value)
  }

  function safeIdentity(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    var handle = safeText(value.handle, 320)
    var name = safeText(value.name, 160)
    var source = value.source === "contacts" ? "contacts" : value.source === "custom" ? "custom" : ""
    if (handle === "" || name === "" || source === "") return null
    var result = { handle: handle, name: name, source: source, contactToken: "" }
    if (source === "contacts") {
      if (!validToken(value.contactToken)) return null
      result.contactToken = value.contactToken
    }
    return result
  }

  function safeCandidate(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    var name = safeText(value.name, 160)
    var records = Number(value.recordCount)
    var sources = Number(value.sourceCount)
    if (name === "" || !validToken(value.token)
        || !Number.isInteger(records) || records < 1 || records > 64
        || !Number.isInteger(sources) || sources < 1 || sources > 64) return null
    if (!Array.isArray(value.cards) || value.cards.length !== records) return null
    var cards = []
    var accounts = ({})
    var tokens = ({})
    tokens[value.token] = true
    for (var i = 0; i < value.cards.length; i++) {
      var rawCard = value.cards[i]
      if (!rawCard || typeof rawCard !== "object" || Array.isArray(rawCard)
          || !validToken(rawCard.token) || tokens[rawCard.token]) return null
      var account = Number(rawCard.accountNumber)
      var sourceName = safeText(rawCard.sourceName, 120)
      if (!Number.isInteger(account) || account < 1 || account > 64) return null
      if (sourceName === "") return null
      tokens[rawCard.token] = true
      accounts[account] = true
      cards.push({
        token: rawCard.token,
        accountNumber: account,
        sourceName: sourceName,
        hasPhoto: rawCard.hasPhoto === true,
        matchCount: Number.isInteger(Number(rawCard.matchCount))
          && Number(rawCard.matchCount) >= 1 && Number(rawCard.matchCount) <= 8
          ? Number(rawCard.matchCount) : 1
      })
    }
    if (Object.keys(accounts).length !== sources) return null
    return {
      token: value.token,
      name: name,
      recordCount: records,
      sourceCount: sources,
      hasPhoto: value.hasPhoto === true,
      cards: cards
    }
  }

  function safeAudit(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    var handleCount = Number(value.handleCount)
    var noMatchCount = Number(value.noMatchCount)
    if (!Number.isInteger(handleCount) || handleCount < 1 || handleCount > 200
        || handleCount !== pendingAuditCount
        || !Number.isInteger(noMatchCount) || noMatchCount < 0 || noMatchCount > handleCount)
      return null
    var seen = ({})
    function entries(raw, kind) {
      if (!Array.isArray(raw) || raw.length > 200) return null
      var result = []
      for (var i = 0; i < raw.length; i++) {
        var item = raw[i]
        if (!item || typeof item !== "object" || Array.isArray(item)) return null
        var handle = root.safeText(item.handle, 320)
        var key = root.handleKey(handle)
        var options = root.validatedList(item.candidates, function(candidate) {
          return root.safeCandidate(candidate)
        }, 8)
        if (handle === "" || seen[key] || options === null) return null
        if (kind === "single" && (options.length !== 1 || options[0].recordCount !== 1)) return null
        if (kind === "duplicate" && (options.length !== 1 || options[0].recordCount < 2)) return null
        if (kind === "conflict" && options.length < 2) return null
        seen[key] = true
        result.push({ handle: handle, candidates: options })
      }
      return result
    }
    var singleCards = entries(value.singleCards, "single")
    var duplicates = entries(value.duplicates, "duplicate")
    var conflicts = entries(value.conflicts, "conflict")
    if (singleCards === null || duplicates === null || conflicts === null
        || noMatchCount + singleCards.length + duplicates.length + conflicts.length !== handleCount)
      return null
    return { handleCount: handleCount, noMatchCount: noMatchCount,
      singleCards: singleCards, duplicates: duplicates, conflicts: conflicts }
  }

  function safeOptionalText(value, maximum) {
    if (typeof value !== "string" || value.length > maximum) return null
    return value
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
      .replace(/\s+/g, " ").trim()
  }


  function validatedList(value, validator, maximum) {
    if (!Array.isArray(value) || value.length > maximum) return null
    var result = []
    for (var i = 0; i < value.length; i++) {
      var item = validator(value[i])
      if (!item) return null
      result.push(item)
    }
    return result
  }

  function start(operation, payload, quiet) {
    if (worker.running) return false
    error = ""
    currentOperation = operation
    reloadAfterExit = false
    refreshCandidatesAfterExit = false
    // A periodic read is bookkeeping, not a visible operation. Toggling
    // `loading` here used to disable and repaint every settings row at 5 s.
    loading = quiet !== true
    worker.payload = payload === undefined ? "" : JSON.stringify(payload)
    worker.stdinEnabled = worker.payload !== ""
    worker.command = ["bun", helperPath, operation]
    worker.running = true
    return true
  }

  function load(silent) {
    readSilently = silent === true
    return start("read", undefined, readSilently && loaded)
  }

  function findCandidates(handle) {
    var requested = safeText(String(handle || ""), 320)
    if (requested === "") return false
    // A click that lands during the tiny local-file refresh window must not
    // be lost. Finish that read, then begin the user-visible Mac lookup.
    if (worker.running) {
      if (currentOperation === "read" && readSilently) {
        pendingReviewHandle = requested
        return true
      }
      return false
    }
    activeHandle = requested
    candidates = []
    notice = "Checking matching cards on the Mac…"
    return start("candidates", { handle: activeHandle }, false)
  }

  // quiet = an automatic freshness re-scan after a contact mutation: it must
  // not clobber the mutation's own success notice. Previous results stay
  // visible (stale) while the fresh scan runs; auditRunning drives the UI's
  // in-progress state.
  function auditContacts(handles, quiet) {
    if (auditWorker.running) return false
    if (!Array.isArray(handles) || handles.length < 1 || handles.length > 200) return false
    var accepted = []
    var seen = ({})
    for (var i = 0; i < handles.length; i++) {
      var handle = safeText(handles[i], 320)
      var key = handleKey(handle)
      if (handle === "" || seen[key]) return false
      seen[key] = true
      accepted.push(handle)
    }
    quietAudit = quiet === true
    pendingAuditCount = accepted.length
    pendingAuditFingerprint = JSON.stringify(Object.keys(seen).sort())
    if (!quietAudit) notice = "Scanning matching Contacts cards; nothing will be changed…"
    auditWorker.payload = JSON.stringify({ handles: accepted })
    auditWorker.stdinEnabled = true
    auditWorker.command = ["bun", helperPath, "audit"]
    auditRunning = true
    auditWorker.running = true
    return true
  }

  function consumeAudit(text) {
    auditRunning = false
    var result = null
    try { result = JSON.parse(text) } catch (e) { result = null }
    var audited = result && result.ok === true ? safeAudit(result.audit) : null
    if (!audited) {
      if (!quietAudit) error = "Identity helper returned an invalid contact audit"
      return
    }
    audit = audited
    auditFingerprint = pendingAuditFingerprint
    if (!quietAudit) notice = result.cached === true
      ? "Cleanup results are current — Contacts hasn't changed since the last scan"
      : "Contact cleanup scan finished; nothing was changed"
  }

  function clearAudit() {
    if (auditWorker.running) return false
    audit = null
    pendingAuditCount = 0
    pendingAuditFingerprint = ""
    auditFingerprint = ""
    return true
  }

  function dismissReview() {
    if (worker.running) return false
    activeHandle = ""
    candidates = []
    error = ""
    notice = identities.length === 0 ? "No saved contact choices" : "Loaded saved contact choices"
    return true
  }

  function choose(handle, name, token) {
    notice = "Saving an optional display preference in Blip…"
    return start("choose", { handle: handle, name: name, token: token })
  }

  function setCustom(handle, name) {
    notice = "Saving custom name…"
    return start("custom", { handle: handle, name: name })
  }

  function clearChoice(handle) {
    notice = "Removing the portable display preference…"
    return start("clear", { handle: handle })
  }

  function openOnMac(handle, token) {
    notice = "Opening one Contacts card on the Mac; no data will be changed…"
    return start("open", { handle: handle, token: token })
  }

  function consume(raw) {
    if (raw.length > 49152) {
      error = "Identity helper returned too much data"
      return
    }
    var result
    try { result = JSON.parse(raw.trim()) }
    catch (e) {
      error = "Identity helper returned invalid JSON"
      return
    }
    if (!result || result.ok !== true) {
      error = safeError(result ? result.error : "Identity helper failed")
      return
    }
    if (currentOperation === "read") {
      var saved = validatedList(result.identities, function(value) { return root.safeIdentity(value) }, 64)
      if (saved === null) { error = "Identity helper returned an invalid saved-choice list"; return }
      var serialized = JSON.stringify(saved)
      // A QML array assignment rebuilds every Repeater delegate, even when
      // the rows are identical. Preserve the existing model on no-op polls.
      if (serialized !== identitiesJson) {
        identitiesJson = serialized
        identities = saved
      }
      loaded = true
      if (!readSilently)
        notice = saved.length === 0 ? "No saved contact choices" : "Loaded saved contact choices"
      return
    }
    if (currentOperation === "candidates") {
      var options = validatedList(result.candidates, function(value) { return root.safeCandidate(value) }, 8)
      var handle = safeText(result.handle, 320)
      if (options === null || handle === "") {
        error = "Identity helper returned an invalid candidate list"
        return
      }
      var totalCards = 0
      var allTokens = ({})
      for (var candidateIndex = 0; candidateIndex < options.length; candidateIndex++) {
        var option = options[candidateIndex]
        if (allTokens[option.token]) { error = "Identity helper returned duplicate contact tokens"; return }
        allTokens[option.token] = true
        totalCards += option.cards.length
        for (var cardIndex = 0; cardIndex < option.cards.length; cardIndex++) {
          var cardToken = option.cards[cardIndex].token
          if (allTokens[cardToken]) { error = "Identity helper returned duplicate contact tokens"; return }
          allTokens[cardToken] = true
        }
      }
      if (totalCards > 64) { error = "Identity helper returned too many contact cards"; return }
      activeHandle = handle
      candidates = options
      notice = options.length === 0
        ? "No matching contact cards were found"
        : options.length === 1 ? "Contacts has one matching name" : "Contacts has conflicting names"
      return
    }
    if (currentOperation === "choose" || currentOperation === "custom") {
      var identity = safeIdentity(result.identity)
      if (!identity) { error = "Identity helper returned an invalid saved choice"; return }
      notice = identity.source === "contacts"
        ? "Blip will use “" + identity.name + "” from Contacts. The contact was not changed."
        : "Saved custom Blip-only name “" + identity.name + "”; Mac Contacts was not changed"
      reloadAfterExit = true
      choicesChanged()
      return
    }
    if (currentOperation === "clear") {
      var after = validatedList(result.identities, function(value) { return root.safeIdentity(value) }, 64)
      if (after === null) { error = "Identity helper returned an invalid saved-choice list"; return }
      identitiesJson = JSON.stringify(after)
      identities = after
      notice = "Removed the name Blip was using"
      choicesChanged()
      return
    }
    if (currentOperation === "open") {
      var openedName = safeText(result.name, 160)
      var openedCard = Number(result.cardNumber)
      var openedCount = Number(result.cardCount)
      var openedAccount = Number(result.accountNumber)
      var openedSource = safeText(result.sourceName, 120)
      if (result.opened !== true || openedName === ""
          || !Number.isInteger(openedCard) || openedCard < 1 || openedCard > 64
          || !Number.isInteger(openedCount) || openedCount < 1 || openedCount > 64
          || openedCard > openedCount
          || !Number.isInteger(openedAccount) || openedAccount < 1 || openedAccount > 64
          || openedSource === "") {
        error = "Contacts.app did not open the selected card"
        return
      }
      notice = "Opened “" + openedName + "” card " + openedCard + " of " + openedCount
        + " from " + openedSource + " in Contacts on the Mac. Nothing was changed."
      return
    }
  }

  Process {
    id: worker
    property string payload: ""
    stdout: StdioCollector { onStreamFinished: root.consume(text) }
    onStarted: {
      if (payload !== "") write(payload)
      stdinEnabled = false
    }
    onExited: function(code, status) {
      root.loading = false
      if (code !== 0 && root.error === "") root.error = "Contact-name operation failed"
      if (root.pendingReviewHandle !== "") {
        var requested = root.pendingReviewHandle
        root.pendingReviewHandle = ""
        Qt.callLater(function() { root.findCandidates(requested) })
        return
      }
      if (root.refreshCandidatesAfterExit) {
        root.refreshCandidatesAfterExit = false
        var active = root.activeHandle
        if (active !== "") Qt.callLater(function() { root.findCandidates(active) })
        return
      }
      if (root.reloadAfterExit) {
        root.reloadAfterExit = false
        Qt.callLater(function() { root.load(true) })
      }
    }
  }

  Process {
    id: auditWorker
    property string payload: ""
    stdout: StdioCollector { onStreamFinished: root.consumeAudit(text) }
    onStarted: {
      if (payload !== "") write(payload)
      stdinEnabled = false
    }
    onExited: function(code, status) {
      root.auditRunning = false
    }
  }

  Timer {
    interval: 5000
    repeat: true
    running: true
    // Source repair is deliberate and stable while open. Only poll the local
    // override file from the overview, and never overlap another operation.
    onTriggered: if (!worker.running && root.activeHandle === "") root.load(true)
  }

  Component.onCompleted: load(false)
}
