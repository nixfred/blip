import QtQuick
import QtQuick.Layouts
import qs.Commons
import qs.Ui

// Mac contact management and optional Blip display-name preferences are
// deliberately separate workflows. Selecting a candidate is session-only.
ColumnLayout {
  id: root

  property var resolver: null
  property var threads: []
  property var preferences: null
  property color foreground: Color.foreground
  property color urgent: Color.urgent
  property color accent: Color.accent
  property string fontFamily: Style.font.family
  property real fontScale: 1.0
  property real density: 1.0
  property real cornerScale: 1.0
  property string selectedToken: ""
  property bool macReviewExpanded: false
  property bool namingExpanded: false
  property bool auditActionableOnly: false
  property bool directContactPending: false
  property bool directWorkspacePending: false
  property bool directEditorPending: false
  property bool discardUnsavedConfirm: false
  readonly property bool editorActive: customField.activeFocus
  readonly property bool reviewActive: resolver && resolver.activeHandle !== ""
  readonly property var savedChoices: resolver ? resolver.identities : []
  readonly property bool hideShortCodeConversations: !preferences
    || preferences.hideShortCodeConversations
  readonly property var unresolvedWithShortCodes: unresolvedThreads(threads, true)
  readonly property var reviewableConversations: unresolvedThreads(threads, false)
  readonly property var auditableConversations: auditableThreads(threads)

  // Previous results stay on screen during a re-scan, visibly grayed out
  // until the fresh ones land. A first scan has nothing stale to dim.
  readonly property bool staleWhileScanning:
    resolver ? resolver.auditRunning === true && currentAudit !== null : false

  // Animated three-dot progress while a scan is in flight. The dots are
  // space-padded so the monospace label keeps one width and the button
  // never jitters.
  property int scanDotPhase: 0
  readonly property string animatedDots: [".  ", ".. ", "..."][scanDotPhase]
  Timer {
    running: root.resolver
      ? root.resolver.auditRunning === true || root.resolver.loading === true
      : false
    interval: 400
    repeat: true
    onTriggered: root.scanDotPhase = (root.scanDotPhase + 1) % 3
  }

  // A Contacts mutation makes a finished cleanup scan stale. The scan has
  // its own dedicated process, so the quiet re-run starts IMMEDIATELY after
  // the mutation; the list page shows the in-flight state and keeps the
  // previous results visible until the fresh ones land. If a scan is
  // already running when another mutation lands, the timer retries until
  // the worker frees up.
  Timer {
    id: auditRefreshTimer
    interval: 1000
    repeat: true
    property int attempts: 0
    onTriggered: {
      attempts += 1
      if (attempts > 90 || !root.resolver) { running = false; return }
      if (root.resolver.auditContacts(root.reviewHandles(), true)) running = false
    }
  }
  Connections {
    target: root.resolver
    function onContactsMutated() {
      if (root.resolver && root.resolver.audit && root.auditableConversations.length > 0) {
        auditRefreshTimer.attempts = 0
        auditRefreshTimer.running = true
        auditRefreshTimer.triggered()
      }
    }
  }

  // Load the cleanup results as soon as the contacts page opens: with the
  // fingerprint cache this is one cheap round-trip when nothing changed on
  // the Mac, and a quiet background scan (own process, spinner shown) when
  // something did.
  property bool autoAuditStarted: false
  function maybeAutoAudit() {
    if (autoAuditStarted || !visible || !resolver) return
    if (resolver.audit || resolver.auditRunning) return
    if (auditableConversations.length === 0) return
    autoAuditStarted = true
    resolver.auditContacts(reviewHandles(), true)
  }
  onVisibleChanged: maybeAutoAudit()
  onAuditableConversationsChanged: maybeAutoAudit()
  readonly property var visibleConversations: hideShortCodeConversations
    ? reviewableConversations : unresolvedWithShortCodes
  readonly property var currentAudit: resolver && resolver.audit
    && resolver.audit.handleCount === auditableConversations.length
    && resolver.auditFingerprint === reviewFingerprint() ? resolver.audit : null
  readonly property var unresolved: auditActionableOnly && currentAudit
    ? actionableConversations(reviewableConversations) : visibleConversations
  readonly property int hiddenShortCodeCount: shortCodeCount(unresolvedWithShortCodes)
  readonly property int unresolvedAuditActionableCount: currentAudit
    ? actionableConversations(reviewableConversations).length : 0
  readonly property var selectedCandidate: candidateForToken(selectedToken)
  readonly property var activeChoice: choiceForHandle(resolver ? resolver.activeHandle : "")
  readonly property bool selectedChoiceIsSaved: selectedCandidate && activeChoice
    && activeChoice.source === "contacts"
    && activeChoice.contactToken === selectedCandidate.token
    && activeChoice.name === selectedCandidate.name
  readonly property bool unsavedContactsError:
    String(resolver ? resolver.error : "").toLowerCase()
      .indexOf("contacts has unsaved changes") >= 0

  signal focusAreaRequested(real localY)

  spacing: space(10)

  function fontSize(value) { return Math.max(1, Math.round(value * fontScale)) }
  function space(value) { return Math.max(1, Math.round(Style.spaceReal(value) * density)) }
  function corner(value) { return Math.max(0, Math.round(value * cornerScale)) }
  function directHandle(value) {
    var handle = String(value || "")
    return /^\+?[0-9]{5,}$/.test(handle) || /^[^@\s]+@[^@\s]+$/.test(handle)
  }
  // "handle" is Blip-internal vocabulary; the UI says number/email.
  function handleNoun() {
    return String(resolver ? resolver.activeHandle : "").indexOf("@") >= 0 ? "email" : "number"
  }
  function handleKey(value) {
    var handle = String(value || "")
    if (handle.indexOf("@") >= 0) return "email:" + handle.toLowerCase()
    var digits = handle.replace(/\D/g, "")
    return "phone:" + (digits.length >= 10 ? digits.slice(-10) : digits)
  }
  function likelyServiceHandle(value) {
    var handle = String(value || "")
    return handle.indexOf("@") < 0 && handle.replace(/\D/g, "").length < 10
  }
  function unresolvedDetail(thread) {
    var handle = String(thread && (thread.handle || thread.chat) || "")
    var audited = auditEntryFor(handle)
    if (audited) {
      var suffix = thread && thread.pinned === true ? " · Pinned" : ""
      if (audited.kind === "duplicate") {
        var duplicate = audited.entry.candidates[0]
        return duplicate.recordCount + " matching cards · " + auditSources(audited.entry)
          + " · likely duplicate" + suffix
      }
      if (audited.kind === "conflict")
        return audited.entry.candidates.length + " different Contacts names share this handle · review required" + suffix
      return "One matching card for " + audited.entry.candidates[0].name + " · not a duplicate" + suffix
    }
    if (currentAudit && !likelyServiceHandle(handle))
      return "No matching Mac contact card found" + (thread && thread.pinned === true ? " · Pinned" : "")
    var detail = likelyServiceHandle(handle)
      ? "Short code or service sender · usually no contact cleanup needed"
      : handle.indexOf("@") >= 0
        ? "Email address · no single Contacts name found"
        : "Phone number · no single Contacts name found"
    return detail + (thread && thread.pinned === true ? " · Pinned" : "")
  }
  function auditEntryFor(handle) {
    if (!currentAudit) return null
    var groups = [
      { kind: "duplicate", entries: currentAudit.duplicates },
      { kind: "conflict", entries: currentAudit.conflicts },
      { kind: "single", entries: currentAudit.singleCards }
    ]
    for (var groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      var entries = groups[groupIndex].entries
      for (var i = 0; i < entries.length; i++) {
        if (handleKey(entries[i].handle) === handleKey(handle))
          return { kind: groups[groupIndex].kind, entry: entries[i] }
      }
    }
    return null
  }
  function actionableConversations(value) {
    if (!Array.isArray(value) || !currentAudit) return []
    return value.filter(function(thread) {
      return auditEntryFor(String(thread && (thread.handle || thread.chat) || "")) !== null
    })
  }
  function reviewHandles() {
    var result = []
    for (var i = 0; i < auditableConversations.length; i++)
      result.push(String(auditableConversations[i].handle || auditableConversations[i].chat || ""))
    return result
  }
  function reviewFingerprint() {
    var keys = []
    for (var i = 0; i < auditableConversations.length; i++)
      keys.push(handleKey(auditableConversations[i].handle || auditableConversations[i].chat || ""))
    keys.sort()
    return JSON.stringify(keys)
  }
  function auditSources(entry) {
    var seen = ({})
    var result = []
    var candidates = entry && Array.isArray(entry.candidates) ? entry.candidates : []
    for (var candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
      var cards = candidates[candidateIndex].cards || []
      for (var cardIndex = 0; cardIndex < cards.length; cardIndex++) {
        var source = String(cards[cardIndex].sourceName || "")
        if (source !== "" && !seen[source]) { seen[source] = true; result.push(source) }
      }
    }
    return result.join(" + ")
  }
  function auditNames(entry) {
    var result = []
    var candidates = entry && Array.isArray(entry.candidates) ? entry.candidates : []
    for (var i = 0; i < candidates.length; i++) result.push(candidates[i].name)
    return result.join(" · ")
  }
  function unresolvedThreads(value, includeShortCodes) {
    if (!Array.isArray(value)) return []
    var seen = ({})
    var result = []
    for (var i = 0; i < value.length; i++) {
      var thread = value[i]
      if (!thread) continue
      var chat = String(thread.chat || "")
      var handle = String(thread.handle || chat)
      var name = String(thread.name || "")
      if (!directHandle(chat) || (name !== chat && name !== handle && !directHandle(name))) continue
      if (includeShortCodes !== true && likelyServiceHandle(handle)) continue
      if (seen[chat]) continue
      seen[chat] = true
      result.push(thread)
    }
    result.sort(function(a, b) {
      var ap = a.pinned === true ? 0 : 1
      var bp = b.pinned === true ? 0 : 1
      if (ap !== bp) return ap - bp
      return String(a.last_ts || "") < String(b.last_ts || "") ? 1 : -1
    })
    return result
  }
  function auditableThreads(value) {
    if (!Array.isArray(value)) return []
    var seen = ({})
    var result = []
    for (var i = 0; i < value.length; i++) {
      var thread = value[i]
      if (!thread) continue
      var chat = String(thread.chat || "")
      var handle = String(thread.handle || chat)
      if (!directHandle(chat) || likelyServiceHandle(handle)) continue
      var key = handleKey(handle)
      if (seen[key]) continue
      seen[key] = true
      result.push(thread)
    }
    return result
  }
  function shortCodeCount(value) {
    if (!Array.isArray(value)) return 0
    var count = 0
    for (var i = 0; i < value.length; i++) {
      if (likelyServiceHandle(value[i] && (value[i].handle || value[i].chat))) count++
    }
    return count
  }
  function choiceForHandle(handle) {
    var key = handleKey(handle)
    if (key === "phone:" || key === "email:") return null
    for (var i = 0; i < savedChoices.length; i++) {
      if (handleKey(savedChoices[i].handle) === key) return savedChoices[i]
    }
    return null
  }
  function candidateForToken(token) {
    if (!resolver || token === "") return null
    for (var i = 0; i < resolver.candidates.length; i++) {
      if (resolver.candidates[i].token === token) return resolver.candidates[i]
    }
    return null
  }
  function candidateDetail(candidate) {
    var cards = candidate.recordCount === 1 ? "1 contact card" : candidate.recordCount + " contact cards"
    var sources = candidate.sourceCount === 1 ? "1 source" : candidate.sourceCount + " sources"
    return cards + " · " + sources + (candidate.hasPhoto ? " · has photo" : "")
  }
  function beginReview(handle, directEdit) {
    if (!resolver || resolver.loading) return
    directContactPending = false
    directWorkspacePending = false
    directEditorPending = false
    var saved = choiceForHandle(handle)
    selectedToken = saved && saved.source === "contacts" ? saved.contactToken : ""
    customField.text = saved && saved.source === "custom" ? saved.name : ""
    namingExpanded = false
    macReviewExpanded = false
    var started = resolver.findCandidates(handle)
    directContactPending = directEdit === true && started
  }
  function editContact(handle) {
    beginReview(handle, true)
  }
  function openNamePreference() {
    if (!resolver || resolver.loading) return
    if (resolver.comparison) resolver.cancelComparison()
    macReviewExpanded = false
    namingExpanded = true
  }
  function openContactManagement() {
    if (!resolver || resolver.loading || resolver.candidates.length === 0) return
    var candidate = selectedCandidate
    if (!candidate && resolver.candidates.length === 1) {
      selectedToken = resolver.candidates[0].token
      candidate = resolver.candidates[0]
    }
    namingExpanded = false
    macReviewExpanded = true
    if (candidate && (!resolver.comparison
        || resolver.comparison.ownerToken !== candidate.token)) {
      resolver.compareCards(resolver.activeHandle, candidate.token)
    }
  }
  function closeReview() {
    if (!resolver || resolver.loading) return
    if (resolver.dismissReview()) {
      selectedToken = ""
      customField.text = ""
      namingExpanded = false
      macReviewExpanded = false
      directContactPending = false
      directWorkspacePending = false
      directEditorPending = false
    }
  }
  function selectCandidate(candidate) {
    if (!candidate || !resolver || resolver.loading) return
    if (resolver.repairPreview) resolver.cancelRepair()
    if (resolver.comparison) resolver.cancelComparison()
    selectedToken = candidate.token
    customField.text = ""
  }

  Connections {
    target: root.resolver
    function onActiveHandleChanged() {
      var saved = root.choiceForHandle(root.resolver.activeHandle)
      root.selectedToken = saved && saved.source === "contacts" ? saved.contactToken : ""
      customField.text = saved && saved.source === "custom" ? saved.name : ""
      root.namingExpanded = false
    }
    function onIdentitiesChanged() {
      if (root.choiceForHandle(root.resolver.activeHandle)) root.namingExpanded = false
    }
    function onAuditChanged() {
      if (!root.resolver.audit) root.auditActionableOnly = false
    }
    function onCandidatesChanged() {
      var saved = root.activeChoice
      if (root.directContactPending && root.resolver.currentOperation === "candidates") {
        root.directContactPending = false
        var directCandidate = saved && saved.source === "contacts"
          ? root.candidateForToken(saved.contactToken) : null
        if (!directCandidate && root.resolver.candidates.length === 1)
          directCandidate = root.resolver.candidates[0]
        root.namingExpanded = false
        root.macReviewExpanded = true
        if (directCandidate) {
          root.selectedToken = directCandidate.token
          root.directWorkspacePending = true
          root.directEditorPending = directCandidate.recordCount === 1
          Qt.callLater(root.openContactManagement)
        } else {
          root.selectedToken = ""
          Qt.callLater(function() { root.focusAreaRequested(root.space(96)) })
        }
        return
      }
      if (saved && saved.source === "contacts"
          && root.candidateForToken(saved.contactToken)) {
        root.selectedToken = saved.contactToken
        return
      }
      if (root.selectedToken !== "" && root.candidateForToken(root.selectedToken)) return
      root.selectedToken = root.resolver.candidates.length === 1
        ? root.resolver.candidates[0].token : ""
    }
    function onComparisonChanged() {
      if (!root.directWorkspacePending || !root.resolver.comparison) return
      root.directWorkspacePending = false
      if (root.directEditorPending && root.resolver.comparison.cards.length === 1)
        contactWorkspace.editCard(root.resolver.comparison.cards[0])
      root.directEditorPending = false
      Qt.callLater(function() {
        root.focusAreaRequested(contactWorkspace.mapToItem(root, 0, 0).y)
      })
    }
  }

  ColumnLayout {
    Layout.fillWidth: true
    visible: !root.reviewActive
    spacing: root.space(12)

  Text {
    Layout.fillWidth: true
    visible: root.savedChoices.length > 0
    text: "SAVED DISPLAY PREFERENCES"
    textFormat: Text.PlainText
    color: Qt.darker(root.foreground, 1.25)
    font.family: root.fontFamily
    font.pixelSize: root.fontSize(Style.font.caption)
    font.bold: true
  }

  Repeater {
    model: root.savedChoices
    delegate: Rectangle {
      required property var modelData
      Layout.fillWidth: true
      implicitHeight: savedRow.implicitHeight + root.space(16)
      radius: root.corner(root.space(10))
      color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.055)
      border.width: 1
      border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.15)

      RowLayout {
        id: savedRow
        anchors.fill: parent
        anchors.margins: root.space(8)
        spacing: root.space(8)
        ColumnLayout {
          Layout.fillWidth: true
          spacing: root.space(2)
          Text {
            Layout.fillWidth: true
            text: String(modelData.name || "")
            textFormat: Text.PlainText
            elide: Text.ElideRight
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: root.fontSize(Style.font.bodySmall)
            font.bold: true
          }
          Text {
            Layout.fillWidth: true
            text: modelData.source === "contacts"
              ? String(modelData.handle || "") + " · From Contacts · contact unchanged"
              : String(modelData.handle || "") + " · custom Blip-only name"
            textFormat: Text.PlainText
            elide: Text.ElideMiddle
            color: Qt.darker(root.foreground, 1.4)
            font.family: root.fontFamily
            font.pixelSize: root.fontSize(Style.font.caption)
          }
        }
        SmallButton {
          label: "Open…"
          enabled: root.resolver && !root.resolver.loading
          onClicked: root.beginReview(modelData.handle)
        }
        SmallButton {
          label: modelData.source === "contacts" ? "Stop using name" : "Remove custom name"
          danger: true
          enabled: root.resolver && !root.resolver.loading
          onClicked: root.resolver.clearChoice(modelData.handle)
        }
      }
    }
  }

  Rectangle {
    Layout.fillWidth: true
    visible: root.unresolvedWithShortCodes.length > 0
    implicitHeight: unresolvedHelp.implicitHeight + root.space(20)
    radius: root.corner(root.space(9))
    color: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.07)
    border.width: 1
    border.color: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.32)
    ColumnLayout {
      id: unresolvedHelp
      anchors.fill: parent
      anchors.margins: root.space(10)
      spacing: root.space(4)
      Text {
        Layout.fillWidth: true
        text: "WHY THEY ARE HERE"
        textFormat: Text.PlainText
        color: root.accent
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.caption)
        font.bold: true
      }
      Text {
        Layout.fillWidth: true
        text: "Blip is using the phone number or email because Contacts did not provide one unambiguous name. Review a person to compare or merge matching Mac cards, or optionally choose what Blip displays. Short codes and service senders can simply be left alone. Nothing changes until you review and confirm it."
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.bodySmall)
      }
    }
  }

  Rectangle {
    Layout.fillWidth: true
    Layout.topMargin: root.space(8)
    visible: root.auditableConversations.length > 0
    implicitHeight: auditContent.implicitHeight + root.space(24)
    radius: root.corner(root.space(10))
    color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.035)
    border.width: 1
    border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.18)
    ColumnLayout {
      id: auditContent
      anchors.fill: parent
      anchors.margins: root.space(12)
      spacing: root.space(8)
      RowLayout {
        Layout.fillWidth: true
        spacing: root.space(8)
        Text {
          Layout.fillWidth: true
          text: "FIND CONTACT CLEANUP OPPORTUNITIES"
          textFormat: Text.PlainText
          color: root.currentAudit ? root.accent : root.foreground
          font.family: root.fontFamily
          font.pixelSize: root.fontSize(Style.font.caption)
          font.bold: true
        }
        SmallButton {
          label: root.resolver && root.resolver.auditRunning
            ? "Scanning" + root.animatedDots
            : root.currentAudit ? "Scan again"
            : "Scan " + root.auditableConversations.length + " conversations"
          enabled: root.resolver && !root.resolver.auditRunning
          onClicked: root.resolver.auditContacts(root.reviewHandles())
        }
      }
      Text {
        Layout.fillWidth: true
        text: root.currentAudit
          ? "Read-only scan complete. Account names and matching fields are evidence, not permission to merge. Every contact change still opens its own preview and confirmation."
          : "Run a read-only Mac Contacts scan to separate unmatched numbers, existing cards, likely duplicate cards, and handles assigned to conflicting names. Named conversations are included, so duplicates remain visible after Contacts supplies a display name. The scan changes nothing."
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        color: Qt.darker(root.foreground, 1.3)
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.bodySmall)
      }
      Text {
        Layout.fillWidth: true
        visible: root.currentAudit !== null
        opacity: root.staleWhileScanning ? 0.45 : 1
        Behavior on opacity { NumberAnimation { duration: 180 } }
        text: root.currentAudit
          ? root.currentAudit.noMatchCount + " no matching card · "
            + root.currentAudit.singleCards.length + " single-card matches · "
            + root.currentAudit.duplicates.length + " likely duplicates · "
            + root.currentAudit.conflicts.length + " naming conflicts"
          : ""
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.bodySmall)
        font.bold: true
      }
      Repeater {
        model: root.currentAudit ? root.currentAudit.duplicates : []
        AuditResultRow {
          required property var modelData
          entry: modelData
          kind: "duplicate"
          opacity: root.staleWhileScanning ? 0.45 : 1
          Behavior on opacity { NumberAnimation { duration: 180 } }
        }
      }
      Repeater {
        model: root.currentAudit ? root.currentAudit.conflicts : []
        AuditResultRow {
          required property var modelData
          entry: modelData
          kind: "conflict"
          opacity: root.staleWhileScanning ? 0.45 : 1
          Behavior on opacity { NumberAnimation { duration: 180 } }
        }
      }
      Text {
        Layout.fillWidth: true
        visible: root.currentAudit && root.currentAudit.singleCards.length > 0
        opacity: root.staleWhileScanning ? 0.45 : 1
        Behavior on opacity { NumberAnimation { duration: 180 } }
        text: root.currentAudit
          ? root.currentAudit.singleCards.length + " conversations already have one matching card. They are not duplicates."
          : ""
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        color: Qt.darker(root.foreground, 1.35)
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.caption)
      }
      Text {
        Layout.fillWidth: true
        visible: root.currentAudit && root.currentAudit.noMatchCount > 0
        opacity: root.staleWhileScanning ? 0.45 : 1
        Behavior on opacity { NumberAnimation { duration: 180 } }
        text: root.currentAudit
          ? root.currentAudit.noMatchCount + " conversations have no matching card. Blip recommends no bulk write for them."
          : ""
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        color: Qt.darker(root.foreground, 1.35)
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.caption)
      }
      RowLayout {
        Layout.fillWidth: true
        visible: root.currentAudit !== null
        Item { Layout.fillWidth: true }
        SmallButton {
          visible: root.unresolvedAuditActionableCount > 0
          primary: root.auditActionableOnly
          label: root.auditActionableOnly
            ? "Show all " + root.reviewableConversations.length
            : "Focus on " + root.unresolvedAuditActionableCount + " Contacts matches"
          onClicked: root.auditActionableOnly = !root.auditActionableOnly
        }
      }
    }
  }

  RowLayout {
    Layout.fillWidth: true
    Layout.topMargin: root.space(12)
    visible: root.unresolvedWithShortCodes.length > 0
    spacing: root.space(12)
    Text {
      Layout.fillWidth: true
      text: "CHOOSE A CONVERSATION TO REVIEW"
      textFormat: Text.PlainText
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: root.fontSize(Style.font.bodySmall)
      font.bold: true
    }
    ToggleSwitch {
      label: "Hide short-code senders"
      checked: root.hideShortCodeConversations
      enabled: root.preferences && root.preferences.loaded
      onToggled: function(value) {
        if (root.preferences) root.preferences.setBoolean("hideShortCodeConversations", value)
      }
    }
  }

  Text {
    Layout.fillWidth: true
    visible: root.unresolvedWithShortCodes.length > 0
    text: "These conversations show a phone number or email instead of one unambiguous Contacts name. Choose one to inspect its matching cards, clean up Contacts, or set an optional Blip display preference."
    textFormat: Text.PlainText
    wrapMode: Text.WordWrap
    color: Qt.darker(root.foreground, 1.3)
    font.family: root.fontFamily
    font.pixelSize: root.fontSize(Style.font.bodySmall)
  }

  Text {
    Layout.fillWidth: true
    visible: root.unresolvedWithShortCodes.length > 0
    text: root.auditActionableOnly && root.currentAudit
      ? root.unresolved.length + " Contacts matches shown · "
        + root.reviewableConversations.length + " phone/email conversations in the full queue."
      : root.hideShortCodeConversations
      ? root.reviewableConversations.length + (root.reviewableConversations.length === 1
        ? " phone/email conversation to review · "
        : " phone/email conversations to review · ")
        + root.hiddenShortCodeCount + (root.hiddenShortCodeCount === 1
          ? " short-code/service conversation hidden."
          : " short-code/service conversations hidden.")
      : root.visibleConversations.length + " conversations shown · "
        + root.hiddenShortCodeCount + (root.hiddenShortCodeCount === 1
          ? " looks like a short-code/service sender."
          : " look like short-code/service senders.")
    opacity: root.staleWhileScanning ? 0.45 : 1
    Behavior on opacity { NumberAnimation { duration: 180 } }
    textFormat: Text.PlainText
    color: Qt.darker(root.foreground, 1.4)
    font.family: root.fontFamily
    font.pixelSize: root.fontSize(Style.font.caption)
  }

  Repeater {
    model: root.unresolved
    delegate: Rectangle {
      required property var modelData
      Layout.fillWidth: true
      opacity: root.staleWhileScanning ? 0.45 : 1
      Behavior on opacity { NumberAnimation { duration: 180 } }
      implicitHeight: unresolvedRow.implicitHeight + root.space(22)
      radius: root.corner(root.space(9))
      color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.035)
      border.width: 1
      border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.13)
      RowLayout {
        id: unresolvedRow
        anchors.fill: parent
        anchors.margins: root.space(11)
        spacing: root.space(12)
        ColumnLayout {
          Layout.fillWidth: true
          spacing: root.space(2)
          Text {
            Layout.fillWidth: true
            text: String(modelData.chat || "")
            textFormat: Text.PlainText
            elide: Text.ElideMiddle
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: root.fontSize(Style.font.bodySmall)
            font.bold: true
          }
          Text {
            Layout.fillWidth: true
            text: root.unresolvedDetail(modelData)
            textFormat: Text.PlainText
            elide: Text.ElideRight
            color: Qt.darker(root.foreground, 1.4)
            font.family: root.fontFamily
            font.pixelSize: root.fontSize(Style.font.caption)
          }
        }
        SmallButton {
          label: root.likelyServiceHandle(modelData.chat) ? "Review anyway…" : "Review contact…"
          enabled: root.resolver && !root.resolver.loading
          onClicked: root.beginReview(modelData.chat)
        }
      }
    }
  }

  Text {
    Layout.fillWidth: true
    visible: root.savedChoices.length === 0 && root.unresolvedWithShortCodes.length === 0
    text: root.resolver && !root.resolver.loaded ? "Loading contact names…" : "No unresolved direct conversations."
    textFormat: Text.PlainText
    color: Qt.darker(root.foreground, 1.4)
    font.family: root.fontFamily
    font.pixelSize: root.fontSize(Style.font.bodySmall)
  }
  }

  Rectangle {
    Layout.fillWidth: true
    visible: root.resolver && root.resolver.activeHandle !== ""
    implicitHeight: guide.implicitHeight + root.space(32)
    radius: root.corner(root.space(12))
    color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.025)
    border.width: 1
    border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.16)

    ColumnLayout {
      id: guide
      anchors.fill: parent
      anchors.margins: root.space(16)
      spacing: root.space(18)

      RowLayout {
        Layout.fillWidth: true
        spacing: root.space(8)
        SmallButton {
          label: "← All conversations"
          enabled: root.resolver && !root.resolver.loading
          onClicked: root.closeReview()
        }
        ColumnLayout {
          Layout.fillWidth: true
          spacing: root.space(2)
          Text {
            Layout.fillWidth: true
            text: root.activeChoice ? root.activeChoice.name
              : root.selectedCandidate ? root.selectedCandidate.name : "Conversation contact"
            textFormat: Text.PlainText
            elide: Text.ElideRight
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: root.fontSize(Style.font.body)
            font.bold: true
          }
          Text {
            Layout.fillWidth: true
            text: String(root.resolver ? root.resolver.activeHandle : "")
            textFormat: Text.PlainText
            elide: Text.ElideMiddle
            color: Qt.darker(root.foreground, 1.4)
            font.family: root.fontFamily
            font.pixelSize: root.fontSize(Style.font.caption)
          }
        }
      }

      Text {
        Layout.fillWidth: true
        visible: !root.namingExpanded && !root.macReviewExpanded
        text: "What do you want to do? These are separate workflows."
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        color: Qt.darker(root.foreground, 1.3)
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.bodySmall)
      }

      GridLayout {
        id: taskGrid
        Layout.fillWidth: true
        visible: !root.namingExpanded && !root.macReviewExpanded
        columns: width >= root.space(760) ? 2 : 1
        rowSpacing: root.space(12)
        columnSpacing: root.space(12)
        // Side by side, both cards take the taller card's height so the pair
        // reads as one row; stacked, each keeps its own.
        readonly property real pairHeight:
          Math.max(manageTask.implicitHeight, namingTask.implicitHeight)

        Rectangle {
          Layout.fillWidth: true
          Layout.alignment: Qt.AlignTop
          implicitHeight: (taskGrid.columns === 2
            ? taskGrid.pairHeight : manageTask.implicitHeight) + root.space(24)
          radius: root.corner(root.space(10))
          color: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.1)
          border.width: 1
          border.color: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.4)
          ColumnLayout {
            id: manageTask
            anchors.fill: parent
            anchors.margins: root.space(12)
            spacing: root.space(7)
            Text {
              Layout.fillWidth: true
              text: "MANAGE MAC CONTACTS"
              textFormat: Text.PlainText
              color: root.accent
              font.family: root.fontFamily
              font.pixelSize: root.fontSize(Style.font.caption)
              font.bold: true
            }
            Text {
              Layout.fillWidth: true
              text: "Deduplicate, merge, edit, delete, or link source cards. This never creates a Blip display-name preference."
              textFormat: Text.PlainText
              wrapMode: Text.WordWrap
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: root.fontSize(Style.font.bodySmall)
            }
            Item { Layout.fillHeight: true }
            SmallButton {
              Layout.alignment: Qt.AlignRight
              primary: true
              label: root.selectedCandidate && root.selectedCandidate.recordCount > 1
                ? "Manage " + root.selectedCandidate.recordCount + " source cards…"
                : "Manage Contacts…"
              enabled: root.resolver && !root.resolver.loading
                && root.resolver.candidates.length > 0
              onClicked: root.openContactManagement()
            }
          }
        }

        Rectangle {
          Layout.fillWidth: true
          Layout.alignment: Qt.AlignTop
          implicitHeight: (taskGrid.columns === 2
            ? taskGrid.pairHeight : namingTask.implicitHeight) + root.space(24)
          radius: root.corner(root.space(10))
          color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.04)
          border.width: 1
          border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.2)
          ColumnLayout {
            id: namingTask
            anchors.fill: parent
            anchors.margins: root.space(12)
            spacing: root.space(7)
            Text {
              Layout.fillWidth: true
              text: "SET A BLIP DISPLAY PREFERENCE · OPTIONAL"
              textFormat: Text.PlainText
              color: Qt.darker(root.foreground, 1.25)
              font.family: root.fontFamily
              font.pixelSize: root.fontSize(Style.font.caption)
              font.bold: true
            }
            Text {
              Layout.fillWidth: true
              text: root.activeChoice
                ? "Current preference: “" + root.activeChoice.name + "”. Change or remove the portable rule Blip uses for this conversation."
                : "Use only when Blip shows a number or an unwanted name. Skip this when you only want to deduplicate Contacts."
              textFormat: Text.PlainText
              wrapMode: Text.WordWrap
              color: Qt.darker(root.foreground, 1.3)
              font.family: root.fontFamily
              font.pixelSize: root.fontSize(Style.font.bodySmall)
            }
            Item { Layout.fillHeight: true }
            SmallButton {
              Layout.alignment: Qt.AlignRight
              label: root.activeChoice ? "Change display preference…" : "Choose display name…"
              enabled: root.resolver && !root.resolver.loading
              onClicked: root.openNamePreference()
            }
          }
        }
      }

      ColumnLayout {
        Layout.fillWidth: true
        visible: root.namingExpanded
          && (!root.resolver || root.resolver.comparison === null)
        spacing: root.space(10)

      RowLayout {
        Layout.fillWidth: true
        spacing: root.space(8)
        SectionHeading { label: "OPTIONAL BLIP DISPLAY NAME" }
        SmallButton {
          visible: root.activeChoice !== null
          danger: true
          label: "Remove display preference"
          enabled: root.resolver && !root.resolver.loading
          onClicked: root.resolver.clearChoice(root.resolver.activeHandle)
        }
        SmallButton {
          label: "Back to tasks"
          enabled: root.resolver && !root.resolver.loading
          onClicked: root.namingExpanded = false
        }
      }

      Text {
        Layout.fillWidth: true
        text: "This saves a portable rule in identities.json for what Blip displays. It does not edit Mac Contacts, and it is not needed to compare or merge duplicate cards."
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        color: Qt.darker(root.foreground, 1.35)
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.caption)
      }

      Text {
        Layout.fillWidth: true
        visible: root.resolver && root.resolver.loading
        text: "Checking Contacts on the Mac…"
        textFormat: Text.PlainText
        color: Qt.darker(root.foreground, 1.35)
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.caption)
      }

      Repeater {
        model: root.resolver ? root.resolver.candidates : []
        delegate: Rectangle {
          id: candidateBox
          required property var modelData
          readonly property bool selected: root.selectedToken === modelData.token
          Layout.fillWidth: true
          implicitHeight: candidateRow.implicitHeight + root.space(16)
          radius: root.corner(root.space(9))
          color: selected
            ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.16)
            : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.055)
          border.width: selected ? 2 : 1
          border.color: selected ? root.accent : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.16)

          RowLayout {
            id: candidateRow
            anchors.fill: parent
            anchors.margins: root.space(8)
            spacing: root.space(9)
            Rectangle {
              implicitWidth: root.space(16)
              implicitHeight: implicitWidth
              radius: width / 2
              color: candidateBox.selected ? root.accent : "transparent"
              border.width: 2
              border.color: candidateBox.selected ? root.accent : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.4)
              Text {
                anchors.centerIn: parent
                visible: candidateBox.selected
                text: "✓"
                color: Color.background
                font.family: root.fontFamily
                font.pixelSize: root.fontSize(Style.font.caption)
                font.bold: true
              }
            }
            ColumnLayout {
              Layout.fillWidth: true
              spacing: root.space(2)
              Text {
                Layout.fillWidth: true
                text: String(modelData.name || "")
                textFormat: Text.PlainText
                elide: Text.ElideRight
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: root.fontSize(Style.font.bodySmall)
                font.bold: true
              }
              Text {
                Layout.fillWidth: true
                text: root.candidateDetail(modelData)
                textFormat: Text.PlainText
                elide: Text.ElideRight
                color: Qt.darker(root.foreground, 1.4)
                font.family: root.fontFamily
                font.pixelSize: root.fontSize(Style.font.caption)
              }
            }
            SmallButton {
              label: candidateBox.selected ? "Selected" : "Select"
              enabled: root.resolver && !root.resolver.loading && !candidateBox.selected
              onClicked: root.selectCandidate(modelData)
            }
          }
          HoverHandler { cursorShape: Qt.PointingHandCursor }
          TapHandler { onTapped: root.selectCandidate(modelData) }
        }
      }

      Text {
        Layout.fillWidth: true
        visible: root.resolver && !root.resolver.loading && root.resolver.candidates.length === 0
        text: "No matching Contacts card was found. Add this handle to a person on the Mac, check again, or save a custom Blip-only name below."
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        color: Qt.darker(root.foreground, 1.35)
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.caption)
      }

      Rectangle {
        Layout.fillWidth: true
        visible: root.selectedCandidate !== null
        implicitHeight: selectedSummary.implicitHeight + root.space(16)
        radius: root.corner(root.space(9))
        color: root.selectedChoiceIsSaved
          ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.14)
          : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.055)
        border.width: 2
        border.color: root.selectedChoiceIsSaved
          ? root.accent : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.22)
        ColumnLayout {
          id: selectedSummary
          anchors.fill: parent
          anchors.margins: root.space(8)
          spacing: root.space(5)
          Text {
            Layout.fillWidth: true
            text: root.selectedCandidate
              ? root.selectedChoiceIsSaved
                ? "✓ Current display preference: “" + root.selectedCandidate.name + "”"
                : "Save “" + root.selectedCandidate.name + "” as Blip’s display preference"
              : ""
            textFormat: Text.PlainText
            wrapMode: Text.WordWrap
            color: root.selectedChoiceIsSaved ? root.accent : root.foreground
            font.family: root.fontFamily
            font.pixelSize: root.fontSize(Style.font.bodySmall)
            font.bold: true
          }
          Text {
            Layout.fillWidth: true
            text: root.selectedChoiceIsSaved
              ? "Stored in identities.json. Mac Contacts remains unchanged; remove this preference to return to Blip’s normal contact-name lookup."
              : "This adds a portable name rule for this number. Skip it if your only goal is to deduplicate or edit the contact cards."
            textFormat: Text.PlainText
            wrapMode: Text.WordWrap
            color: Qt.darker(root.foreground, 1.35)
            font.family: root.fontFamily
            font.pixelSize: root.fontSize(Style.font.caption)
          }
          SmallButton {
            Layout.alignment: Qt.AlignLeft
            visible: !root.selectedChoiceIsSaved
            primary: true
            label: root.selectedCandidate
              ? "Save Contacts name as display preference"
              : "Save Contacts display preference"
            enabled: root.resolver && !root.resolver.loading && root.selectedCandidate !== null
            onClicked: root.resolver.choose(
              root.resolver.activeHandle, root.selectedCandidate.name, root.selectedCandidate.token)
          }
        }
      }

      Text {
        Layout.fillWidth: true
        text: "OR SAVE A CUSTOM BLIP-ONLY DISPLAY NAME"
        textFormat: Text.PlainText
        color: Qt.darker(root.foreground, 1.35)
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.caption)
        font.bold: true
      }
      RowLayout {
        Layout.fillWidth: true
        spacing: root.space(8)
        TextField {
          id: customField
          Layout.fillWidth: true
          placeholderText: "Type a local display name"
          foreground: root.foreground
          accent: root.accent
          font.family: root.fontFamily
          font.pixelSize: root.fontSize(Style.font.bodySmall)
          maximumLength: 160
          onTextChanged: if (activeFocus && text.trim() !== "") root.selectedToken = ""
        }
        SmallButton {
          label: "Save custom name in Blip only"
          enabled: root.resolver && !root.resolver.loading && customField.text.trim() !== ""
          onClicked: root.resolver.setCustom(root.resolver.activeHandle, customField.text)
        }
      }

      }

      Rectangle {
        Layout.fillWidth: true
        visible: root.macReviewExpanded
        implicitHeight: 1
        color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.18)
      }

      RowLayout {
        Layout.fillWidth: true
        visible: root.macReviewExpanded
        spacing: root.space(8)
        SectionHeading { label: "MANAGE MAC CONTACTS" }
        SmallButton {
          visible: contactWorkspace.editorCard === null
            && (!root.resolver || root.resolver.mutationPreview === null)
            && (!root.resolver || root.resolver.repairPreview === null)
            && (!root.resolver || root.resolver.comparison === null)
          label: "Refresh source cards"
          enabled: root.resolver && !root.resolver.loading
          onClicked: root.resolver.findCandidates(root.resolver.activeHandle)
        }
        SmallButton {
          visible: !root.resolver || root.resolver.comparison === null
          label: "Back to tasks"
          enabled: root.resolver && !root.resolver.loading
          onClicked: {
            if (root.resolver.comparison) root.resolver.cancelComparison()
            root.macReviewExpanded = false
          }
        }
      }

      Text {
        Layout.fillWidth: true
        visible: root.macReviewExpanded
        text: root.resolver && root.resolver.candidates.length > 1
          ? root.resolver.candidates.length + " different people are named for this " + root.handleNoun() + " in Contacts. Pick who this conversation belongs to — from there you can merge the cards or remove the " + root.handleNoun() + " from the wrong one."
          : root.selectedCandidate && root.selectedCandidate.recordCount > 1
            ? root.selectedCandidate.recordCount + " source cards found. Compare, edit, consolidate, delete, or link them from Blip."
            : "One source card found. You can review, edit, or delete it from Blip."
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        color: Qt.darker(root.foreground, 1.35)
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.caption)
      }

      ColumnLayout {
        Layout.fillWidth: true
        visible: root.macReviewExpanded
        spacing: root.space(12)

      Text {
        Layout.fillWidth: true
        visible: root.resolver && root.resolver.candidates.length > 0 && root.selectedCandidate === null
        text: "Pick a person below. That only opens their cards for review — it is temporary, never saved, and changes nothing in Contacts."
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        color: root.urgent
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.caption)
        font.bold: true
      }

      Repeater {
        model: root.resolver ? root.resolver.candidates : []
        delegate: Rectangle {
          id: sourceCandidate
          required property var modelData
          readonly property bool intended: root.selectedToken === modelData.token
          property bool cardsExpanded: !intended && modelData.recordCount <= 3
          visible: !(intended && root.resolver && root.resolver.comparison
            && root.resolver.comparison.ownerToken === modelData.token)
          Layout.fillWidth: true
          implicitHeight: sourceGroup.implicitHeight + root.space(16)
          radius: root.corner(root.space(9))
          color: intended
            ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.09)
            : root.selectedCandidate
              ? Qt.rgba(root.urgent.r, root.urgent.g, root.urgent.b, 0.07)
              : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.04)
          border.width: 1
          border.color: intended
            ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.35)
            : root.selectedCandidate
              ? Qt.rgba(root.urgent.r, root.urgent.g, root.urgent.b, 0.35)
              : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.2)

          ColumnLayout {
            id: sourceGroup
            anchors.fill: parent
            anchors.margins: root.space(8)
            spacing: root.space(6)
            RowLayout {
              Layout.fillWidth: true
              spacing: root.space(8)
              Text {
                Layout.fillWidth: true
                text: (sourceCandidate.intended ? "WORKING ON: "
                  : root.selectedCandidate
                    ? "OTHER PERSON USING THIS " + root.handleNoun().toUpperCase() + ": "
                    : "POSSIBLE PERSON: ")
                  + String(sourceCandidate.modelData.name || "")
                textFormat: Text.PlainText
                wrapMode: Text.WordWrap
                color: sourceCandidate.intended || !root.selectedCandidate
                  ? root.foreground : root.urgent
                font.family: root.fontFamily
                font.pixelSize: root.fontSize(Style.font.caption)
                font.bold: true
              }
              SmallButton {
                // Explicit same-person declaration: opens the standard
                // compare/merge workspace spanning BOTH people's cards.
                visible: !sourceCandidate.intended && root.selectedCandidate !== null
                  && root.resolver && root.resolver.contactWrites
                label: "Merge with " + (root.selectedCandidate ? root.selectedCandidate.name : "") + "…"
                enabled: root.resolver && !root.resolver.loading
                onClicked: root.resolver.compareCards(
                  root.resolver.activeHandle, root.selectedToken, sourceCandidate.modelData.token)
              }
              SmallButton {
                label: !sourceCandidate.intended ? "Work on this person…"
                  : root.resolver && root.resolver.comparison
                  && root.resolver.comparison.ownerToken === sourceCandidate.modelData.token
                  ? "Contact workspace open"
                  : sourceCandidate.modelData.recordCount === 1 ? "Manage contact…"
                    : "Manage " + sourceCandidate.modelData.recordCount + " cards…"
                enabled: root.resolver && !root.resolver.loading
                  && (!sourceCandidate.intended || !root.resolver.comparison
                    || root.resolver.comparison.ownerToken !== sourceCandidate.modelData.token)
                onClicked: {
                  if (sourceCandidate.intended) root.resolver.compareCards(
                    root.resolver.activeHandle, sourceCandidate.modelData.token)
                  else root.selectCandidate(sourceCandidate.modelData)
                }
              }
              SmallButton {
                label: sourceCandidate.cardsExpanded
                  ? "Hide cards"
                  : "Show " + sourceCandidate.modelData.recordCount
                    + (sourceCandidate.modelData.recordCount === 1 ? " card" : " cards")
                enabled: root.resolver && !root.resolver.loading
                onClicked: sourceCandidate.cardsExpanded = !sourceCandidate.cardsExpanded
              }
            }
            Text {
              Layout.fillWidth: true
              text: sourceCandidate.intended
                ? "You’re reviewing this person’s cards temporarily — nothing is saved as a Blip name, and every Mac Contacts change asks for its own confirmation."
                : root.selectedCandidate
                  ? "A different person? Remove just this " + root.handleNoun() + " from their card. The same person under another name (a married-name change, say)? Merge the cards — you can adjust the surviving name during the review."
                  : "Opens their cards for review — from there you can edit them, merge duplicates, or remove this " + root.handleNoun() + " from the wrong card."
              textFormat: Text.PlainText
              wrapMode: Text.WordWrap
              color: Qt.darker(root.foreground, 1.4)
              font.family: root.fontFamily
              font.pixelSize: root.fontSize(Style.font.caption)
            }
            Repeater {
              model: sourceCandidate.cardsExpanded ? sourceCandidate.modelData.cards : []
              delegate: RowLayout {
                id: sourceCard
                required property var modelData
                required property int index
                Layout.fillWidth: true
                spacing: root.space(8)
                Text {
                  Layout.fillWidth: true
                  text: "Card " + (sourceCard.index + 1) + " of " + sourceCandidate.modelData.recordCount
                    + " · " + sourceCard.modelData.sourceName
                    + (sourceCandidate.modelData.sourceCount > 1
                      ? " · source " + sourceCard.modelData.accountNumber
                        + " of " + sourceCandidate.modelData.sourceCount : "")
                    + (sourceCard.modelData.matchCount > 1
                      ? " · " + sourceCard.modelData.matchCount + " matching fields" : "")
                    + (sourceCard.modelData.hasPhoto ? " · has photo" : "")
                  textFormat: Text.PlainText
                  elide: Text.ElideRight
                  color: Qt.darker(root.foreground, 1.4)
                  font.family: root.fontFamily
                  font.pixelSize: root.fontSize(Style.font.caption)
                }
                SmallButton {
                  label: "Open card " + (sourceCard.index + 1) + " on Mac…"
                  enabled: root.resolver && !root.resolver.loading
                  onClicked: root.resolver.openOnMac(root.resolver.activeHandle, sourceCard.modelData.token)
                }
                SmallButton {
                  visible: !sourceCandidate.intended && root.selectedCandidate !== null
                    && root.resolver && root.resolver.contactWrites
                  danger: true
                  label: "Remove this " + root.handleNoun() + "…"
                  enabled: root.resolver && !root.resolver.loading
                  onClicked: root.resolver.inspectOnMac(
                    root.resolver.activeHandle, sourceCard.modelData.token, root.selectedToken)
                }
              }
            }
          }
        }
      }

      ContactCardCompare {
        id: contactWorkspace
        Layout.fillWidth: true
        visible: root.resolver && root.resolver.comparison !== null
          && root.resolver.comparison.ownerToken === root.selectedToken
        resolver: root.resolver
        comparison: root.resolver ? root.resolver.comparison : null
        foreground: root.foreground
        urgent: root.urgent
        accent: root.accent
        fontFamily: root.fontFamily
        fontScale: root.fontScale
        density: root.density
        cornerScale: root.cornerScale
      }

      Rectangle {
        Layout.fillWidth: true
        visible: root.resolver && root.resolver.repairPreview !== null
        implicitHeight: repairConfirmation.implicitHeight + root.space(20)
        radius: root.corner(root.space(9))
        color: Qt.rgba(root.urgent.r, root.urgent.g, root.urgent.b, 0.09)
        border.width: 2
        border.color: root.urgent

        ColumnLayout {
          id: repairConfirmation
          anchors.fill: parent
          anchors.margins: root.space(10)
          spacing: root.space(7)
          Text {
            Layout.fillWidth: true
            text: root.resolver && root.resolver.repairPreview
              ? "Remove " + root.resolver.repairPreview.handle + " from “"
                + root.resolver.repairPreview.name + "”?"
              : ""
            textFormat: Text.PlainText
            wrapMode: Text.WordWrap
            color: root.urgent
            font.family: root.fontFamily
            font.pixelSize: root.fontSize(Style.font.bodySmall)
            font.bold: true
          }
          Text {
            Layout.fillWidth: true
            text: root.resolver && root.resolver.repairPreview
              ? "Verified card " + root.resolver.repairPreview.cardNumber + " of "
                + root.resolver.repairPreview.cardCount + " from "
                + root.resolver.repairPreview.sourceName + ". This will remove "
                + root.resolver.repairPreview.fieldCount + " matching "
                + root.resolver.repairPreview.kind
                + (root.resolver.repairPreview.fieldCount === 1 ? " field" : " fields")
                + " from synced Mac Contacts. An undo receipt will be saved on the Mac."
              : ""
            textFormat: Text.PlainText
            wrapMode: Text.WordWrap
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: root.fontSize(Style.font.caption)
          }
          Text {
            Layout.fillWidth: true
            visible: root.resolver && root.resolver.repairPreview
              && !root.resolver.repairPreview.writeEnabled
            text: "The Mac-side contact-writes gate is disabled. Re-run setup with explicit contact-write access."
            textFormat: Text.PlainText
            wrapMode: Text.WordWrap
            color: root.urgent
            font.family: root.fontFamily
            font.pixelSize: root.fontSize(Style.font.caption)
            font.bold: true
          }
          RowLayout {
            Layout.fillWidth: true
            spacing: root.space(8)
            Item { Layout.fillWidth: true }
            SmallButton {
              label: "Cancel"
              enabled: root.resolver && !root.resolver.loading
              onClicked: root.resolver.cancelRepair()
            }
            SmallButton {
              danger: true
              primary: true
              label: "Remove from Mac Contacts"
              enabled: root.resolver && !root.resolver.loading
                && root.resolver.repairPreview && root.resolver.repairPreview.writeEnabled
              onClicked: root.resolver.removeOnMac()
            }
          }
        }
      }

      Rectangle {
        Layout.fillWidth: true
        // The undo offer belongs to the contact it changed — one merge's
        // receipt must not follow the user into another person's workspace.
        // The token stays in memory, so returning to that contact within the
        // session re-offers it (the private Mac receipt outlives both).
        visible: root.resolver && /^undo:[0-9a-f]{32}$/.test(root.resolver.undoToken)
          && root.handleKey(root.resolver.undoHandle)
             === root.handleKey(root.resolver.activeHandle)
        implicitHeight: undoContents.implicitHeight + root.space(18)
        radius: root.corner(root.space(9))
        color: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.12)
        border.width: 1
        border.color: root.accent
        RowLayout {
          id: undoContents
          anchors.fill: parent
          anchors.margins: root.space(9)
          spacing: root.space(8)
          Text {
            Layout.fillWidth: true
            text: root.resolver
              ? (root.resolver.undoAction === "edit" ? "Edited one source card for “"
                : root.resolver.undoAction === "delete" ? "Deleted one source card for “"
                : root.resolver.undoAction === "consolidate"
                  ? "Consolidated " + root.resolver.undoCardCount + " source cards for “"
                  : "Removed " + root.resolver.undoHandle + " from “")
                + root.resolver.undoName
                + "”. Undo is available here now; its private Mac receipt expires in seven days."
              : ""
            textFormat: Text.PlainText
            wrapMode: Text.WordWrap
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: root.fontSize(Style.font.caption)
          }
          SmallButton {
            primary: true
            label: "Undo Mac change"
            enabled: root.resolver && !root.resolver.loading
            onClicked: root.resolver.undoOnMac()
          }
        }
      }

      Text {
        Layout.fillWidth: true
        visible: root.resolver && !root.resolver.contactWrites
        text: "Contact editing is disabled. Set contact_writes=on locally and enable the separate owner-only gate on the Mac to use it. Viewing and opening cards remain read-only."
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        color: Qt.darker(root.foreground, 1.35)
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.caption)
      }

      Text {
        Layout.fillWidth: true
        visible: contactWorkspace.editorCard === null && root.resolver
          && root.resolver.candidates.length > 0 && root.selectedCandidate !== null
        text: "Viewing or opening a card makes no change. Editing, deletion, consolidation, and handle removal all require a separate confirmation."
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        color: Qt.darker(root.foreground, 1.35)
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.caption)
      }

      }
    }
  }

  Text {
    Layout.fillWidth: true
    visible: root.resolver && (root.resolver.error !== "" || root.resolver.notice !== "")
    // While an operation runs ("Consolidating the verified source cards…"),
    // the notice's ellipsis animates as a three-dot progress indicator.
    text: root.resolver && root.resolver.error !== ""
      ? root.resolver.error
      : root.resolver && root.resolver.loading
        ? String(root.resolver.notice).replace(/…$/, "") + root.animatedDots
        : String(root.resolver ? root.resolver.notice : "")
    textFormat: Text.PlainText
    wrapMode: Text.WordWrap
    color: root.resolver && root.resolver.error !== "" ? root.urgent : Qt.darker(root.foreground, 1.4)
    font.family: root.fontFamily
    font.pixelSize: root.fontSize(Style.font.caption)
  }

  Rectangle {
    Layout.fillWidth: true
    implicitHeight: unsavedRecovery.implicitHeight + root.space(20)
    visible: root.unsavedContactsError
    radius: root.corner(root.space(8))
    color: Qt.rgba(root.urgent.r, root.urgent.g, root.urgent.b, 0.07)
    border.width: 1
    border.color: Qt.rgba(root.urgent.r, root.urgent.g, root.urgent.b, 0.55)

    ColumnLayout {
      id: unsavedRecovery
      anchors.fill: parent
      anchors.margins: root.space(10)
      spacing: root.space(8)

      Text {
        Layout.fillWidth: true
        text: root.discardUnsavedConfirm
          ? "Discard every pending change currently open in Contacts on the Mac?"
          : "Contacts is holding an unfinished in-memory edit."
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.bodySmall)
        font.bold: true
      }
      Text {
        Layout.fillWidth: true
        text: root.discardUnsavedConfirm
          ? "This closes Contacts without saving. Continue only if the pending edit is the failed Blip attempt; any separate edit you made directly on the Mac would also be discarded."
          : "Finish or discard a real edit in Contacts on the Mac. If this was left by Blip’s failed save, Blip can close Contacts without saving it after one more confirmation."
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        color: Qt.darker(root.foreground, 1.3)
        font.family: root.fontFamily
        font.pixelSize: root.fontSize(Style.font.caption)
      }
      RowLayout {
        Layout.fillWidth: true
        Item { Layout.fillWidth: true }
        SmallButton {
          visible: root.discardUnsavedConfirm
          label: "Cancel"
          onClicked: root.discardUnsavedConfirm = false
        }
        SmallButton {
          danger: root.discardUnsavedConfirm
          primary: !root.discardUnsavedConfirm
          label: root.discardUnsavedConfirm
            ? "Discard and close Contacts" : "Resolve pending edit…"
          enabled: root.resolver && !root.resolver.loading
          onClicked: {
            if (!root.discardUnsavedConfirm) {
              root.discardUnsavedConfirm = true
              return
            }
            root.discardUnsavedConfirm = false
            root.resolver.discardUnsavedContacts()
          }
        }
      }
    }
  }

  Text {
    Layout.fillWidth: true
    visible: !root.reviewActive
    text: root.resolver ? root.resolver.configPath : "~/.config/blip/identities.json"
    textFormat: Text.PlainText
    wrapMode: Text.WrapAnywhere
    color: Qt.darker(root.foreground, 1.5)
    font.family: root.fontFamily
    font.pixelSize: root.fontSize(Style.font.caption)
  }

  component SectionHeading: Text {
    property string label: ""
    Layout.fillWidth: true
    text: label
    textFormat: Text.PlainText
    color: Qt.darker(root.foreground, 1.2)
    font.family: root.fontFamily
    font.pixelSize: root.fontSize(Style.font.caption)
    font.bold: true
  }

  component SmallButton: Rectangle {
    id: button
    property string label: ""
    property bool danger: false
    property bool primary: false
    signal clicked()
    implicitWidth: buttonText.implicitWidth + root.space(16)
    implicitHeight: buttonText.implicitHeight + root.space(10)
    radius: root.corner(root.space(7))
    opacity: enabled ? 1.0 : 0.45
    color: buttonHover.hovered
      ? Qt.rgba((danger ? root.urgent : root.accent).r,
                (danger ? root.urgent : root.accent).g,
                (danger ? root.urgent : root.accent).b, 0.18)
      : primary ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.2)
      : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.055)
    border.width: 1
    border.color: danger ? root.urgent : primary ? root.accent
      : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.3)
    Text {
      id: buttonText
      anchors.centerIn: parent
      text: button.label
      textFormat: Text.PlainText
      color: button.danger ? root.urgent : root.foreground
      font.family: root.fontFamily
      font.pixelSize: root.fontSize(Style.font.caption)
      font.bold: button.primary
    }
    HoverHandler { id: buttonHover; enabled: button.enabled; cursorShape: Qt.PointingHandCursor }
    TapHandler { enabled: button.enabled; onTapped: button.clicked() }
  }

  component ToggleSwitch: RowLayout {
    id: toggle
    property string label: ""
    property bool checked: false
    signal toggled(bool value)
    spacing: root.space(7)
    opacity: enabled ? 1.0 : 0.45
    Text {
      text: toggle.label
      textFormat: Text.PlainText
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: root.fontSize(Style.font.caption)
    }
    Rectangle {
      Layout.preferredWidth: root.space(34)
      Layout.preferredHeight: root.space(20)
      radius: height / 2
      color: toggle.checked
        ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.65)
        : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.16)
      border.width: 1
      border.color: toggle.checked ? root.accent
        : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.35)
      Rectangle {
        width: parent.height - root.space(6)
        height: width
        radius: width / 2
        anchors.verticalCenter: parent.verticalCenter
        x: toggle.checked ? parent.width - width - root.space(3) : root.space(3)
        color: toggle.checked ? root.foreground
          : Qt.darker(root.foreground, 1.35)
      }
    }
    HoverHandler { enabled: toggle.enabled; cursorShape: Qt.PointingHandCursor }
    TapHandler { enabled: toggle.enabled; onTapped: toggle.toggled(!toggle.checked) }
  }

  component AuditResultRow: Rectangle {
    id: auditRow
    required property var entry
    property string kind: "duplicate"
    Layout.fillWidth: true
    implicitHeight: auditRowContent.implicitHeight + root.space(16)
    radius: root.corner(root.space(8))
    color: kind === "conflict"
      ? Qt.rgba(root.urgent.r, root.urgent.g, root.urgent.b, 0.07)
      : Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.07)
    border.width: 1
    border.color: kind === "conflict" ? Qt.rgba(root.urgent.r, root.urgent.g, root.urgent.b, 0.38)
      : Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.34)
    RowLayout {
      id: auditRowContent
      anchors.fill: parent
      anchors.margins: root.space(8)
      spacing: root.space(8)
      ColumnLayout {
        Layout.fillWidth: true
        spacing: root.space(2)
        Text {
          Layout.fillWidth: true
          text: auditRow.kind === "conflict"
            ? "CONFLICT · " + root.auditNames(auditRow.entry)
            : "LIKELY DUPLICATE · " + auditRow.entry.candidates[0].name
          textFormat: Text.PlainText
          elide: Text.ElideRight
          color: auditRow.kind === "conflict" ? root.urgent : root.accent
          font.family: root.fontFamily
          font.pixelSize: root.fontSize(Style.font.caption)
          font.bold: true
        }
        Text {
          Layout.fillWidth: true
          text: auditRow.entry.handle + (root.auditSources(auditRow.entry) === ""
            ? "" : " · " + root.auditSources(auditRow.entry))
          textFormat: Text.PlainText
          elide: Text.ElideMiddle
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: root.fontSize(Style.font.caption)
        }
      }
      SmallButton {
        label: auditRow.kind === "conflict" ? "Review conflict…" : "Review duplicate…"
        enabled: root.resolver && !root.resolver.loading
        onClicked: root.beginReview(auditRow.entry.handle)
      }
    }
  }
}
