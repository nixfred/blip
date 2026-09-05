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
  readonly property string vcardUriPrefix: "file://" + runtimeDirectory + "/blip/vcards/"
  readonly property string helperPath:
    decodeURIComponent(Qt.resolvedUrl("identities.ts").toString().replace(/^file:\/\//, ""))

  property var identities: []
  property var candidates: []
  property var audit: null
  property var repairPreview: null
  property var comparison: null
  property var linkPreview: null
  property var mutationPreview: null
  property var mutationRequest: null
  property string comparisonOwnerToken: ""
  // Set only for an explicit cross-name merge (two candidates the user
  // identified as the same person); "" for the normal single-person scope.
  property string comparisonOtherOwnerToken: ""
  property string activeHandle: ""
  property bool contactWrites: false
  property string pendingRepairToken: ""
  property string pendingOwnerToken: ""
  property string undoToken: ""
  property string undoHandle: ""
  property string undoName: ""
  property int undoFieldCount: 0
  property string undoAction: ""
  property int undoCardCount: 0
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
  // long scan can start the moment a mutation lands without contending with
  // navigation, edits, or merges on the interactive worker.
  property bool auditRunning: false
  property string pendingAuditFingerprint: ""
  property string auditFingerprint: ""
  property bool vcardReported: false
  property bool vcardClipboardPending: false
  property string pendingVcardPayload: ""
  property string pendingVcardFileName: ""

  signal choicesChanged()
  // Fired after any operation that changed Mac Contacts (edit, delete,
  // merge, link, field removal, undo) so listeners can refresh derived
  // views like the cleanup scan.
  signal contactsMutated()
  signal vcardFinished(string message, bool success)

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

  function validRevision(value) {
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

  function safeRepairPreview(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    var handle = safeText(value.handle, 320)
    var name = safeText(value.name, 160)
    var kind = value.kind === "phone" ? "phone" : value.kind === "email" ? "email" : ""
    var fieldCount = Number(value.fieldCount)
    var cardNumber = Number(value.cardNumber)
    var cardCount = Number(value.cardCount)
    var accountNumber = Number(value.accountNumber)
    var sourceName = safeText(value.sourceName, 120)
    if (handle === "" || name === "" || kind === ""
        || !Number.isInteger(fieldCount) || fieldCount < 1 || fieldCount > 8
        || !Number.isInteger(cardNumber) || cardNumber < 1 || cardNumber > 64
        || !Number.isInteger(cardCount) || cardCount < cardNumber || cardCount > 64
        || !Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 64
        || sourceName === ""
        || !Array.isArray(value.labels) || value.labels.length !== fieldCount) return null
    var labels = []
    for (var i = 0; i < value.labels.length; i++) {
      if (typeof value.labels[i] !== "string" || value.labels[i].length > 80) return null
      labels.push(safeText(value.labels[i], 80))
    }
    return {
      handle: handle, name: name, kind: kind, fieldCount: fieldCount,
      labels: labels, cardNumber: cardNumber, cardCount: cardCount,
      accountNumber: accountNumber, sourceName: sourceName,
      writeEnabled: value.writeEnabled === true,
      token: pendingRepairToken, ownerToken: pendingOwnerToken
    }
  }

  function safeOptionalText(value, maximum) {
    if (typeof value !== "string" || value.length > maximum) return null
    return value
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
      .replace(/\s+/g, " ").trim()
  }

  function safeLabeledValues(value) {
    if (!Array.isArray(value) || value.length > 16) return null
    var result = []
    for (var i = 0; i < value.length; i++) {
      var item = value[i]
      if (!item || typeof item !== "object" || Array.isArray(item)) return null
      var label = safeOptionalText(item.label, 80)
      var itemValue = safeOptionalText(item.value, 320)
      if (label === null || itemValue === null || itemValue === "") return null
      result.push({ label: label, value: itemValue })
    }
    return result
  }

  function safeAddresses(value) {
    if (!Array.isArray(value) || value.length > 16) return null
    var result = []
    var keys = ["label", "street", "city", "state", "postalCode", "country", "countryCode"]
    var limits = [80, 320, 320, 320, 80, 160, 8]
    for (var i = 0; i < value.length; i++) {
      var item = value[i]
      if (!item || typeof item !== "object" || Array.isArray(item)) return null
      var address = ({})
      for (var keyIndex = 0; keyIndex < keys.length; keyIndex++) {
        var cleaned = safeOptionalText(item[keys[keyIndex]], limits[keyIndex])
        if (cleaned === null) return null
        address[keys[keyIndex]] = cleaned
      }
      if (address.street === "" && address.city === "" && address.state === ""
          && address.postalCode === "" && address.country === "") return null
      result.push(address)
    }
    return result
  }

  function safeComparisonCard(value, expectedNumber, seenTokens) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !validToken(value.token)
        || seenTokens[value.token]) return null
    var cardNumber = Number(value.cardNumber)
    var accountNumber = Number(value.accountNumber)
    var sourceName = safeText(value.sourceName, 120)
    if (!Number.isInteger(cardNumber) || cardNumber !== expectedNumber
        || !Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 64
        || sourceName === "") return null
    var scalarKeys = ["displayName", "firstName", "middleName", "lastName", "nickname",
      "organization", "department", "jobTitle", "birthday", "note"]
    var scalarLimits = [160, 160, 160, 160, 160, 320, 320, 320, 10, 1000]
    if (!validRevision(value.revision)) return null
    var card = ({ token: value.token, revision: value.revision,
      cardNumber: cardNumber, accountNumber: accountNumber,
      sourceName: sourceName,
      hasPhoto: value.hasPhoto === true })
    seenTokens[value.token] = true
    for (var i = 0; i < scalarKeys.length; i++) {
      var text = safeOptionalText(value[scalarKeys[i]], scalarLimits[i])
      if (text === null) return null
      card[scalarKeys[i]] = text
    }
    if (card.birthday !== "" && !/^(?:[0-9]{4}\-|--)[0-9]{2}\-[0-9]{2}$/.test(card.birthday)) return null
    card.phones = safeLabeledValues(value.phones)
    card.emails = safeLabeledValues(value.emails)
    card.urls = safeLabeledValues(value.urls)
    card.addresses = safeAddresses(value.addresses)
    if (card.phones === null || card.emails === null || card.urls === null || card.addresses === null)
      return null
    return card
  }

  function safeComparison(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    var handle = safeText(value.handle, 320)
    var name = safeText(value.name, 160)
    var cardCount = Number(value.cardCount)
    var sourceCount = Number(value.sourceCount)
    if (handle === "" || name === "" || !Number.isInteger(cardCount) || cardCount < 1 || cardCount > 8
        || !Number.isInteger(sourceCount) || sourceCount < 1 || sourceCount > 8
        || !Array.isArray(value.cards) || value.cards.length !== cardCount) return null
    var seen = ({})
    var accounts = ({})
    var cards = []
    for (var i = 0; i < value.cards.length; i++) {
      var card = safeComparisonCard(value.cards[i], i + 1, seen)
      if (!card) return null
      accounts[card.accountNumber] = true
      cards.push(card)
    }
    if (Object.keys(accounts).length !== sourceCount) return null
    return { handle: handle, name: name, cardCount: cardCount, sourceCount: sourceCount,
      writeEnabled: value.writeEnabled === true, cards: cards, ownerToken: comparisonOwnerToken,
      otherOwnerToken: comparisonOtherOwnerToken }
  }


  function safeMutationPreview(value, requireApplied) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    var action = ["edit", "delete", "consolidate"].indexOf(value.action) >= 0 ? value.action : ""
    var handle = safeText(value.handle, 320)
    var name = safeText(value.name, 160)
    var cardNumber = Number(value.cardNumber)
    var cardCount = Number(value.cardCount)
    var accountNumber = Number(value.accountNumber)
    var sourceName = safeText(value.sourceName, 120)
    var sourceCardCount = Number(value.sourceCardCount)
    if (action === "" || handle === "" || name === "" || !validRevision(value.planHash)
        || !Number.isInteger(cardNumber) || cardNumber < 1 || cardNumber > 8
        || !Number.isInteger(cardCount) || cardCount < cardNumber || cardCount > 8
        || !Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 64
        || sourceName === ""
        || !Number.isInteger(sourceCardCount) || sourceCardCount < 0 || sourceCardCount > 7
        || !Array.isArray(value.changedFields) || value.changedFields.length < 1
        || value.changedFields.length > 13) return null
    var changed = []
    for (var i = 0; i < value.changedFields.length; i++) {
      var field = safeText(value.changedFields[i], 40)
      if (field === "") return null
      changed.push(field)
    }
    if (requireApplied === true && (value.applied !== true
        || !/^undo:[0-9a-f]{32}$/.test(String(value.undoToken || "")))) return null
    if (requireApplied === true && action !== "delete"
        && (!validRevision(value.revision) || safeText(value.displayName, 160) === "")) return null
    return { action: action, handle: handle, name: name, cardNumber: cardNumber,
      cardCount: cardCount, accountNumber: accountNumber, sourceCardCount: sourceCardCount,
      sourceName: sourceName,
      changedFields: changed, planHash: value.planHash, writeEnabled: value.writeEnabled === true,
      applied: value.applied === true, undoToken: String(value.undoToken || ""),
      revision: String(value.revision || ""), displayName: safeText(value.displayName || "", 160) }
  }

  function safeLinkPreview(value, requireLinked) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    var handle = safeText(value.handle, 320)
    var name = safeText(value.name, 160)
    var cardCount = Number(value.cardCount)
    var sourceCount = Number(value.sourceCount)
    var action = safeText(value.action, 80)
    if (handle === "" || name === "" || !Number.isInteger(cardCount) || cardCount < 2 || cardCount > 8
        || !Number.isInteger(sourceCount) || sourceCount < 1 || sourceCount > 8
        || ["Link Selected Cards", "Merge Selected Cards", "Merge and Link Selected Cards"].indexOf(action) < 0)
      return null
    if (requireLinked === true && value.linked !== true) return null
    if (requireLinked !== true && typeof value.ready !== "boolean") return null
    return { handle: handle, name: name, cardCount: cardCount, sourceCount: sourceCount,
      writeEnabled: value.writeEnabled === true, action: action,
      ready: requireLinked === true ? false : value.ready, linked: value.linked === true }
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
    if (operation === "vcard") vcardReported = false
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
    repairPreview = null
    comparison = null
    linkPreview = null
    mutationPreview = null
    mutationRequest = null
    comparisonOwnerToken = ""
    comparisonOtherOwnerToken = ""
    pendingRepairToken = ""
    pendingOwnerToken = ""
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
    repairPreview = null
    comparison = null
    linkPreview = null
    mutationPreview = null
    mutationRequest = null
    comparisonOwnerToken = ""
    comparisonOtherOwnerToken = ""
    pendingRepairToken = ""
    pendingOwnerToken = ""
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

  function copyVCard(handle) {
    notice = "Exporting the contact from the Mac…"
    return start("vcard", { handle: handle })
  }

  function reportVCard(message, success) {
    if (currentOperation !== "vcard" || vcardReported) return
    vcardReported = true
    vcardFinished(message, success === true)
  }

  function startVcardClipboard() {
    if (pendingVcardPayload === "") return
    vcardClipboard.payload = pendingVcardPayload
    vcardClipboard.fileName = pendingVcardFileName
    vcardClipboardPending = true
    vcardClipboard.stdinEnabled = true
    vcardClipboard.running = true
  }

  function serveVCard(fileUri, fileName) {
    pendingVcardPayload = "copy\n" + fileUri + "\n"
    pendingVcardFileName = fileName
    vcardClipboardPending = true
    if (vcardClipboard.running) {
      vcardClipboard.replacing = true
      vcardClipboard.running = false
    } else {
      startVcardClipboard()
    }
  }

  function compareCards(handle, ownerToken, otherOwnerToken) {
    if (!validToken(ownerToken)) return false
    var cross = otherOwnerToken !== undefined && otherOwnerToken !== null
      && String(otherOwnerToken) !== ""
    if (cross && (!validToken(otherOwnerToken) || otherOwnerToken === ownerToken)) return false
    comparison = null
    linkPreview = null
    mutationPreview = null
    mutationRequest = null
    comparisonOwnerToken = ownerToken
    comparisonOtherOwnerToken = cross ? String(otherOwnerToken) : ""
    notice = cross
      ? "Loading both people's card details from Contacts…"
      : "Loading the active card details from Contacts…"
    var payload = ({ handle: handle, ownerToken: ownerToken })
    if (cross) payload.otherOwnerToken = String(otherOwnerToken)
    return start("compare", payload)
  }

  function prepareCardEdit(card, draft) {
    if (!contactWrites || !comparison || !card || !validToken(card.token)
        || !validRevision(card.revision) || !validToken(comparison.ownerToken)
        || String(comparison.otherOwnerToken || "") !== "") return false
    mutationPreview = null
    mutationRequest = { handle: comparison.handle, ownerToken: comparison.ownerToken,
      token: card.token, revision: card.revision, card: draft }
    notice = "Verifying this contact edit on the Mac…"
    return start("edit-prepare", mutationRequest)
  }

  function prepareCardDelete(card) {
    if (!contactWrites || !comparison || !card || !validToken(card.token)
        || !validRevision(card.revision) || !validToken(comparison.ownerToken)
        || String(comparison.otherOwnerToken || "") !== "") return false
    mutationPreview = null
    mutationRequest = { handle: comparison.handle, ownerToken: comparison.ownerToken,
      token: card.token, revision: card.revision }
    notice = "Verifying this source-card deletion on the Mac…"
    return start("delete-prepare", mutationRequest)
  }

  function prepareConsolidation(targetCard, draft) {
    if (!contactWrites || !comparison || comparison.cards.length < 2 || !targetCard
        || !validToken(targetCard.token) || !validToken(comparison.ownerToken)) return false
    var revisions = []
    for (var i = 0; i < comparison.cards.length; i++) {
      var card = comparison.cards[i]
      if (!validToken(card.token) || !validRevision(card.revision)) return false
      revisions.push({ token: card.token, revision: card.revision })
    }
    mutationPreview = null
    mutationRequest = { handle: comparison.handle, ownerToken: comparison.ownerToken,
      targetToken: targetCard.token, revisions: revisions, card: draft }
    if (String(comparison.otherOwnerToken || "") !== "")
      mutationRequest.otherOwnerToken = comparison.otherOwnerToken
    notice = "Verifying the merged card and every source card on the Mac…"
    return start("merge-prepare", mutationRequest)
  }

  function applyMutation() {
    if (!contactWrites || !mutationPreview || !mutationPreview.writeEnabled || !mutationRequest
        || !validRevision(mutationPreview.planHash)) return false
    var operation = mutationPreview.action === "edit" ? "edit"
      : mutationPreview.action === "delete" ? "delete" : "merge"
    var request = ({})
    var keys = Object.keys(mutationRequest)
    for (var i = 0; i < keys.length; i++) request[keys[i]] = mutationRequest[keys[i]]
    request.planHash = mutationPreview.planHash
    notice = operation === "edit" ? "Saving the verified contact edit…"
      : operation === "delete" ? "Deleting the verified source card…"
      : "Consolidating the verified source cards…"
    return start(operation, request)
  }

  function cancelMutation() {
    if (worker.running) return false
    mutationPreview = null
    mutationRequest = null
    notice = "No Contacts data was changed"
    return true
  }

  function discardUnsavedContacts() {
    if (!contactWrites) return false
    notice = "Closing Contacts on the Mac without saving its pending edit…"
    return start("discard-unsaved", {})
  }

  function prepareLink() {
    if (!contactWrites || !comparison || !comparison.writeEnabled
        || !validToken(comparison.ownerToken)) return false
    linkPreview = null
    notice = "Selecting the exact cards and checking Apple’s link action…"
    return start("link-prepare", {
      handle: comparison.handle, ownerToken: comparison.ownerToken
    })
  }

  function linkCards() {
    if (!contactWrites || !comparison || !linkPreview || !linkPreview.ready
        || !linkPreview.writeEnabled || !validToken(comparison.ownerToken)) return false
    notice = "Running Contacts’ verified “" + linkPreview.action + "” action…"
    return start("link", { handle: comparison.handle, ownerToken: comparison.ownerToken,
      expectedAction: linkPreview.action })
  }

  function cancelLink() {
    if (worker.running) return false
    linkPreview = null
    notice = "No Contacts data was changed"
    return true
  }

  function cancelComparison() {
    if (worker.running) return false
    comparison = null
    linkPreview = null
    mutationPreview = null
    mutationRequest = null
    comparisonOwnerToken = ""
    comparisonOtherOwnerToken = ""
    notice = candidates.length > 1 ? "Contacts has conflicting names" : "Contacts has one matching name"
    return true
  }

  function inspectOnMac(handle, token, ownerToken) {
    if (!contactWrites || !validToken(token) || !validToken(ownerToken) || token === ownerToken)
      return false
    pendingRepairToken = token
    pendingOwnerToken = ownerToken
    repairPreview = null
    notice = "Verifying the exact field with Contacts on the Mac…"
    return start("inspect", { handle: handle, token: token, ownerToken: ownerToken })
  }

  function cancelRepair() {
    if (worker.running) return false
    repairPreview = null
    pendingRepairToken = ""
    pendingOwnerToken = ""
    notice = candidates.length > 1 ? "Contacts has conflicting names" : "Contacts has one matching name"
    return true
  }

  function removeOnMac() {
    if (!contactWrites || !repairPreview || !repairPreview.writeEnabled
        || !validToken(repairPreview.token)
        || !validToken(repairPreview.ownerToken)) return false
    notice = "Removing the verified field from Mac Contacts…"
    return start("remove", {
      handle: repairPreview.handle, token: repairPreview.token,
      ownerToken: repairPreview.ownerToken
    })
  }

  function undoOnMac() {
    if (!contactWrites || !/^undo:[0-9a-f]{32}$/.test(undoToken)) return false
    notice = "Undoing the last Blip contact change…"
    return start("undo", { undoToken: undoToken })
  }

  function consume(raw) {
    if (raw.length > 49152) {
      error = "Identity helper returned too much data"
      reportVCard(error, false)
      return
    }
    var result
    try { result = JSON.parse(raw.trim()) }
    catch (e) {
      error = "Identity helper returned invalid JSON"
      reportVCard(error, false)
      return
    }
    if (!result || result.ok !== true) {
      error = safeError(result ? result.error : "Identity helper failed")
      reportVCard(error, false)
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
      contactWrites = result.contactWrites === true
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
    if (currentOperation === "vcard") {
      var copiedName = safeText(result.name, 160)
      var copiedHandle = safeText(result.handle, 320)
      var copiedFileName = safeText(result.fileName, 160)
      var copiedFileUri = safeText(result.fileUri, 700)
      var copiedBytes = Number(result.bytes)
      if (copiedName === "" || copiedHandle === "" || !Number.isInteger(copiedBytes)
          || copiedBytes < 1 || copiedBytes > 2097152
          || copiedFileName === "" || !copiedFileName.endsWith(".vcf")
          || root.runtimeDirectory === ""
          || !copiedFileUri.startsWith(root.vcardUriPrefix)
          || copiedFileUri.indexOf("..") >= 0 || !copiedFileUri.endsWith(".vcf")) {
        error = "Contacts returned an invalid vCard confirmation"
        reportVCard(error, false)
        return
      }
      // Keep wl-copy alive inside the shell process. A short-lived helper can
      // write the .vcf, but if it owns the Wayland selection and then exits,
      // the clipboard immediately becomes empty.
      serveVCard(copiedFileUri, copiedFileName)
      return
    }
    if (currentOperation === "discard-unsaved") {
      if (typeof result.discarded !== "boolean") {
        error = "Contacts returned an invalid unsaved-change confirmation"
        return
      }
      notice = result.discarded
        ? "Discarded the pending Contacts edit and closed Contacts on the Mac"
        : "Contacts had no pending edit to discard"
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
    if (currentOperation === "compare") {
      var compared = safeComparison(result.comparison)
      if (!compared || !validToken(compared.ownerToken)) {
        error = "Contacts returned an invalid card comparison"
        return
      }
      comparison = compared
      linkPreview = null
      notice = "Loaded " + compared.cardCount + " active cards for comparison; nothing was changed"
      return
    }
    if (currentOperation === "edit-prepare" || currentOperation === "delete-prepare"
        || currentOperation === "merge-prepare") {
      var mutation = safeMutationPreview(result.preview, false)
      var expectedAction = currentOperation === "edit-prepare" ? "edit"
        : currentOperation === "delete-prepare" ? "delete" : "consolidate"
      if (!mutation || mutation.action !== expectedAction || !comparison
          || mutation.handle !== comparison.handle) {
        error = "Contacts returned an invalid contact-change preview"
        return
      }
      mutationPreview = mutation
      notice = "Verified the exact Mac Contacts change; review the confirmation"
      return
    }
    if (currentOperation === "edit" || currentOperation === "delete"
        || currentOperation === "merge") {
      var appliedMutation = safeMutationPreview(result, true)
      var appliedAction = currentOperation === "edit" ? "edit"
        : currentOperation === "delete" ? "delete" : "consolidate"
      if (!appliedMutation || appliedMutation.action !== appliedAction) {
        error = "Contacts did not confirm the contact change"
        return
      }
      undoToken = appliedMutation.undoToken
      undoHandle = appliedMutation.handle
      undoName = appliedMutation.name
      undoFieldCount = appliedMutation.changedFields.length
      undoAction = appliedMutation.action
      undoCardCount = appliedMutation.action === "consolidate"
        ? appliedMutation.sourceCardCount + 1 : 1
      mutationPreview = null
      mutationRequest = null
      comparison = null
      linkPreview = null
      comparisonOwnerToken = ""
    comparisonOtherOwnerToken = ""
      notice = appliedMutation.action === "edit"
        ? "Saved the contact card in Mac Contacts"
        : appliedMutation.action === "delete"
          ? "Deleted the source card from Mac Contacts"
          : "Consolidated " + undoCardCount + " source cards in Mac Contacts"
      refreshCandidatesAfterExit = true
      contactsMutated()
      return
    }
    if (currentOperation === "link-prepare") {
      var prepared = safeLinkPreview(result.preview, false)
      if (!prepared || !comparison || prepared.handle !== comparison.handle
          || prepared.cardCount !== comparison.cardCount) {
        error = "Contacts returned an invalid link preview"
        return
      }
      linkPreview = prepared
      notice = prepared.ready
        ? "Contacts is ready; review the final link confirmation"
        : "Contacts does not offer a link for this exact selection; the cards may already be linked"
      return
    }
    if (currentOperation === "link") {
      var linked = safeLinkPreview(result, true)
      if (!linked || !comparison || linked.handle !== comparison.handle
          || linked.cardCount !== comparison.cardCount) {
        error = "Contacts did not confirm the link action"
        return
      }
      notice = "Contacts ran “" + linked.action + "” for the exact " + linked.cardCount + " cards"
      comparison = null
      linkPreview = null
      comparisonOwnerToken = ""
    comparisonOtherOwnerToken = ""
      refreshCandidatesAfterExit = true
      contactsMutated()
      return
    }
    if (currentOperation === "inspect") {
      var preview = safeRepairPreview(result.preview)
      if (!preview || !validToken(preview.token)) {
        error = "Contacts returned an invalid repair preview"
        return
      }
      repairPreview = preview
      notice = preview.writeEnabled
        ? "Verified the exact Mac Contacts field; review the confirmation below"
        : "The Mac-side contact-writes gate is disabled"
      return
    }
    if (currentOperation === "remove") {
      var removedPreview = safeRepairPreview(result)
      var returnedUndo = safeText(result.undoToken, 40)
      if (!removedPreview || result.removed !== true || !/^undo:[0-9a-f]{32}$/.test(returnedUndo)) {
        error = "Contacts did not confirm the removal"
        return
      }
      undoToken = returnedUndo
      undoHandle = removedPreview.handle
      undoName = removedPreview.name
      undoFieldCount = removedPreview.fieldCount
      undoAction = "field-removal"
      undoCardCount = 1
      repairPreview = null
      pendingRepairToken = ""
      pendingOwnerToken = ""
      notice = "Removed the verified " + removedPreview.kind + " from “" + removedPreview.name + "” on the Mac"
      refreshCandidatesAfterExit = true
      contactsMutated()
      return
    }
    if (currentOperation === "undo") {
      var restoredHandle = safeText(result.handle, 320)
      var restoredName = safeText(result.name, 160)
      var restoredCount = Number(result.fieldCount)
      var restoredCards = Number(result.cardCount)
      var restoredAction = ["field-removal", "edit", "delete", "consolidate"].indexOf(result.action) >= 0
        ? result.action : ""
      if (result.restored !== true || restoredHandle === "" || restoredName === ""
          || restoredAction === ""
          || !Number.isInteger(restoredCards) || restoredCards < 1 || restoredCards > 8
          || !Number.isInteger(restoredCount) || restoredCount < 1 || restoredCount > 13) {
        error = "Contacts did not confirm the restore"
        return
      }
      undoToken = ""
      undoHandle = ""
      undoName = ""
      undoFieldCount = 0
      undoAction = ""
      undoCardCount = 0
      notice = result.alreadyPresent === true
        ? "The field was already present in Mac Contacts"
        : restoredAction === "delete" ? "Recreated the deleted card for “" + restoredName + "”"
          : restoredAction === "consolidate" ? "Restored " + restoredCards + " pre-merge cards"
            : "Undid the contact change for “" + restoredName + "”"
      refreshCandidatesAfterExit = true
      contactsMutated()
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
      if (root.currentOperation === "vcard" && !root.vcardReported
          && !root.vcardClipboardPending)
        root.reportVCard(root.error || "Could not copy the contact vCard", false)
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

  Process {
    id: vcardClipboard
    property string payload: ""
    property string fileName: ""
    property bool replacing: false
    command: ["wl-copy", "--foreground", "--type", "x-special/gnome-copied-files"]
    onStarted: {
      write(payload)
      stdinEnabled = false
      root.vcardClipboardPending = false
      root.pendingVcardPayload = ""
      root.pendingVcardFileName = ""
      root.notice = "Copied “" + fileName + "” — paste it as a vCard file"
      root.reportVCard(root.notice, true)
    }
    onExited: function(code, status) {
      if (replacing) {
        replacing = false
        Qt.callLater(root.startVcardClipboard)
        return
      }
      if (root.vcardClipboardPending && !root.vcardReported) {
        root.vcardClipboardPending = false
        root.reportVCard("Could not keep the vCard on the clipboard", false)
      }
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
