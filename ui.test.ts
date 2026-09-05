import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseUiFontSize, scaleFontPx } from "./ui-font";

// The renderer moved from Panel.qml into BlipView.qml in 1.8.0 (shared with the app window).
const panel = readFileSync(new URL("./BlipView.qml", import.meta.url), "utf8");
const widget = readFileSync(new URL("./BarWidget.qml", import.meta.url), "utf8");
const identitySettings = readFileSync(new URL("./IdentitySettings.qml", import.meta.url), "utf8");
const contactCompare = readFileSync(new URL("./ContactCardCompare.qml", import.meta.url), "utf8");
const contactEditor = readFileSync(new URL("./ContactCardEditor.qml", import.meta.url), "utf8");
const settings = readFileSync(new URL("./BlipSettings.qml", import.meta.url), "utf8");
const identities = readFileSync(new URL("./BlipIdentities.qml", import.meta.url), "utf8");
const identityHelper = readFileSync(new URL("./identities.ts", import.meta.url), "utf8");
const preferences = readFileSync(new URL("./BlipPreferences.qml", import.meta.url), "utf8");
const window = readFileSync(new URL("./BlipWindow.qml", import.meta.url), "utf8");

function handleTextKeySource() {
  const start = panel.indexOf("function handleTextKey");
  const end = panel.indexOf("function unwind");
  return panel.slice(start, end);
}

describe("QML safety invariants", () => {
  test("group sends use the cached AppleScript GUID", () => {
    expect(panel).toContain('["--chat-id", String(root.active.guid)]');
    expect(panel).toContain('["--to", sendChat]');
  });

  test("thread results are accepted only for the active chat", () => {
    expect(panel).toContain('String(root.active.chat) === root.threadRunningChat');
    expect(panel).toContain("if (!belongsHere) return");
  });

  test("the compose field is never disabled by an in-flight send", () => {
    // Disabling the exclusive-keyboard-focus holder dismisses the panel the
    // instant Enter is pressed — the send works but all feedback vanishes.
    expect(panel).not.toContain("!sendProc.running");
  });

  test("compose wraps at the box edge instead of scrolling sideways", () => {
    const start = panel.indexOf("id: composeField");
    expect(start).toBeGreaterThan(-1);
    const compose = panel.slice(Math.max(0, start - 80), start + 2800);
    expect(compose).toContain("TextArea {");
    expect(compose).toContain("wrapMode: TextEdit.Wrap");
    expect(compose).toContain("anchors.fill: parent");
  });

  test("send completion owns immutable chat and draft context", () => {
    expect(panel).toContain("var completedChat = root.sendChat");
    expect(panel).toContain("if (composeField.text === completedText) composeField.text = \"\"");
  });

  test("message text leaves this machine on stdin, never in argv (audit #4)", () => {
    expect(panel).toContain('"--text-stdin"');
    expect(panel).toContain("sendProc.write(text)");
    expect(panel).not.toContain('["--yes", "--", text]');
  });

  test("a bare URL asks linkpreview.ts and renders the same card", () => {
    expect(panel).toContain("function requestPreview(url)");
    expect(panel).toContain("root.previewScript");
    expect(panel).toContain("readonly property var fetched:");
    expect(panel).toContain("modelData.link || linkRow.fetched || ({})");
    // an Apple card still comes from the ssh-fetched attachment, ours from disk
    expect(panel).toContain("String((linkRow.fetched && linkRow.fetched.image)");
  });

  test("an arriving link opens the sheet only on a surface already open", () => {
    expect(widget).toContain("function shareArrivingLink(link)");
    expect(widget).toContain("d.links[d.links.length - 1]");          // newest only, never a queue
    expect(widget).toContain("p.opened === true");                    // panel must already be open
    expect(widget).toContain("root.windowVisible");                   // or the app window
  });

  test("a link you SEND opens the sheet too, and the app button asks the host", () => {
    expect(panel).toContain("var sentUrl = root.firstUrl(completedText)");
    expect(panel).toContain("function openApp()");
    expect(panel).toContain('hostWidget.showApp()');
    // the popout gets out of the way, and closes BEFORE the window is shown
    expect(panel).toContain('hostWidget.close()');
    expect(panel.indexOf("hostWidget.close()")).toBeLessThan(panel.indexOf("hostWidget.showApp()"));
    expect(panel).toContain('tooltipText: "Open the app window (SUPER+M)"');
  });

  test("group rows and tiles show the GROUP's photo, never the last speaker's", () => {
    const bind = 'root.isGroupId(String(modelData.chat || "")) ? String(modelData.chat) : String(modelData.handle || modelData.chat || "")';
    expect(panel.split(bind).length - 1).toBe(2);   // list row + pinned tile
    expect(panel).not.toContain('if (!root.isGroupId(String(modelData.chat || ""))) root.requestAvatar(avatarHandle)');
    expect(panel).not.toContain('if (handle === "" || isGroupId(handle)) return');
    expect(panel).toContain('avatarProc.command = ["bun", root.avatarScript, "--retry", avatarProc.handle]');
    expect(panel).toContain("function retryBareAvatars()");
    expect(panel).toContain("onSurfaceOpenChanged: if (surfaceOpen) root.retryBareAvatars()");
  });

  test("ui_font_size scales Blip text without touching Omarchy", () => {
    expect(widget).toContain("ui_font_size");
    expect(widget).toContain("root.uiFontSize");
    expect(panel).toContain("readonly property int fontBodySmall");
    expect(panel).toContain("uiFontScale");
    expect(panel).not.toContain("font.pixelSize: Style.font.");
    expect(parseUiFontSize("")).toBe(0);
    expect(parseUiFontSize("ui_font_size=14\n")).toBe(14);
    expect(parseUiFontSize("ui_font=theme\nui_font_size=14")).toBe(14);
    expect(parseUiFontSize("ui_font_size=3")).toBe(9);
    expect(parseUiFontSize("ui_font_size=99")).toBe(24);
    expect(scaleFontPx(11, 0, 11)).toBe(11);
    expect(scaleFontPx(11, 14, 11)).toBe(14);
    expect(scaleFontPx(10, 14, 11)).toBe(13);
  });

  test("share sheet: right-click a link, URL on stdin, never argv", () => {
    expect(panel).toContain("function openShare(u)");
    expect(panel).toContain("qrProc.write(u)");
    expect(panel).toContain("sendShareProc.write(u)");
    expect(panel).toContain('localsend --headless send "$2"');
    expect(panel).toContain('onTapped: root.openShare(String(linkCard.link.url || ""))');
    expect(panel).toContain('if (shareUrl !== "") { closeShare(); return true }');
    expect(widget).toContain('function share(url: string): string { if (!root.automationOn) return root.automationOff;');
    // never the URL as an argv element of qrencode / localsend
    expect(panel).not.toContain('qrencode", ');
    expect(panel).not.toContain("localsend --headless send \"$2\" \"$3\"");
  });

  test("IPC goto only E.164-ifies a full number, never a short code", () => {
    expect(widget).toContain('/^[0-9]{10,}$/.test(want)');
    expect(widget).not.toContain('/^[0-9]+$/.test(want)');
  });

  test("read marks are queued and only applied after a successful load", () => {
    expect(widget).toContain("property var refreshQueue: []");
    expect(widget).not.toContain("property var queued: null");
    const success = panel.indexOf("if (d.ok === true)");
    const mark = panel.indexOf("markThreadRead(root.threadRunningChat,");
    expect(success).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(success);
  });

  test("contact management and optional Blip display preferences are separate flows", () => {
    expect(identitySettings).toContain("CHOOSE A CONVERSATION TO REVIEW");
    expect(identitySettings).toContain("WHY THEY ARE HERE");
    expect(identitySettings).toContain("Short codes and service senders can simply be left alone.");
    expect(identitySettings).toContain("Review contact…");
    expect(identitySettings).toContain("Review anyway…");
    expect(identitySettings).toContain("var started = resolver.findCandidates(handle)");
    expect(identitySettings).toContain("directContactPending = directEdit === true && started");
    expect(identitySettings).toContain("Hide short-code senders");
    expect(identitySettings).not.toContain(".slice(0, 12)");
    expect(identitySettings).toContain("phone/email conversations to review");
    expect(identitySettings).toContain("readonly property var auditableConversations: auditableThreads(threads)");
    expect(identitySettings).toContain("resolver.audit.handleCount === auditableConversations.length");
    expect(identitySettings).toContain("Named conversations are included");
    expect(identitySettings).toContain("preferences.hideShortCodeConversations");
    expect(identitySettings).toContain('preferences.setBoolean("hideShortCodeConversations", value)');
    expect(settings).toContain("preferences: root.preferences");
    expect(identitySettings).toContain("What do you want to do? These are separate workflows.");
    expect(identitySettings).toContain("rowSpacing: root.space(12)");
    expect(identitySettings).toContain("columnSpacing: root.space(12)");
    expect(identitySettings).toContain("MANAGE MAC CONTACTS");
    expect(identitySettings).toContain("This never creates a Blip display-name preference.");
    expect(identitySettings).toContain("Skip this when you only want to deduplicate Contacts.");
    // side-by-side workflow cards share the taller card's height, and each
    // card's action pins to the bottom right through a flexible spacer
    expect(identitySettings).toContain("Math.max(manageTask.implicitHeight, namingTask.implicitHeight)");
    expect(identitySettings.split("Item { Layout.fillHeight: true }").length - 1).toBeGreaterThanOrEqual(2);
    expect(identitySettings).toContain("OPTIONAL BLIP DISPLAY NAME");
    expect(identitySettings).toContain("Save Contacts name as display preference");
    expect(identitySettings).toContain("CUSTOM BLIP-ONLY DISPLAY NAME");
    expect(identitySettings).toContain("it is temporary, never saved, and changes nothing in Contacts.");
    expect(identitySettings).toContain("Viewing or opening a card makes no change");
    expect(identitySettings).toContain("CHOOSE A CONVERSATION TO REVIEW");
    expect(identitySettings.indexOf("WHY THEY ARE HERE"))
      .toBeLessThan(identitySettings.indexOf("FIND CONTACT CLEANUP OPPORTUNITIES"));
    expect(identitySettings.indexOf("FIND CONTACT CLEANUP OPPORTUNITIES"))
      .toBeLessThan(identitySettings.indexOf("CHOOSE A CONVERSATION TO REVIEW"));
    expect(identitySettings.indexOf("CHOOSE A CONVERSATION TO REVIEW"))
      .toBeLessThan(identitySettings.indexOf("model: root.unresolved"));
    expect(identitySettings).toContain("Refresh source cards");
    expect(identitySettings).not.toContain("Check Mac Contacts again");
    expect(identitySettings.indexOf("Refresh source cards"))
      .toBeLessThan(identitySettings.indexOf("ContactCardCompare {"));
    expect(identitySettings).toContain("root.resolver.comparison === null");
    expect(identitySettings).toContain("visible: contactWorkspace.editorCard === null && root.resolver");
    expect(identitySettings).toContain("root.resolver.candidates.length === 1");
    expect(identitySettings).not.toContain("root.selectedChoiceIsSaved\n                  && (!root.resolver.comparison");
    expect(identityHelper).not.toContain("requireSavedRepairOwner");
    expect(identityHelper).not.toContain("save the correct Contacts name in Blip before repairing");
    expect(identitySettings).not.toContain("MATCH REMEMBERED BY BLIP");
    expect(identitySettings).not.toContain("Already saved in Blip\"");
    expect(identitySettings).not.toContain('label: "Use"');
    expect(identitySettings).not.toContain("Fix on Mac");
  });

  test("stale unsaved Contacts edits have an explicit two-step recovery", () => {
    expect(identitySettings).toContain("Contacts is holding an unfinished in-memory edit.");
    expect(identitySettings).toContain('? "Discard and close Contacts" : "Resolve pending edit…"');
    expect(identitySettings).toContain("root.resolver.discardUnsavedContacts()");
    expect(identities).toContain('start("discard-unsaved", {})');
  });

  test("contact cleanup scan is read-only triage, never a bulk merge", () => {
    expect(identitySettings).toContain("FIND CONTACT CLEANUP OPPORTUNITIES");
    expect(identitySettings).toContain("Run a read-only Mac Contacts scan");
    // every Contacts mutation announces itself, and a finished scan refreshes
    // quietly without clobbering the mutation's success notice
    expect(identities).toContain("signal contactsMutated()");
    expect(identities.split("contactsMutated()").length - 1).toBeGreaterThanOrEqual(5);
    expect(identities).toContain('if (!quietAudit) notice = result.cached === true');
    // a fingerprint cache hit reports freshness instead of a fake re-scan
    expect(identities).toContain("Contacts hasn't changed since the last scan");
    // the contacts page loads cleanup results on open (cheap when cached)
    expect(identitySettings).toContain("function maybeAutoAudit()");
    expect(identitySettings).toContain("root.resolver.auditContacts(root.reviewHandles(), true)");
    // the scan runs on its OWN process, kicked immediately after a mutation,
    // so it never contends with navigation or edits; the list page shows the
    // in-flight state while previous results stay visible
    expect(identities).toContain("id: auditWorker");
    expect(identities).toContain("property bool auditRunning");
    expect(identities).toContain("function consumeAudit(text)");
    // in-flight scans animate a three-dot indicator (width-stable, monospace)
    expect(identitySettings).toContain('"Scanning" + root.animatedDots');
    // busy notices ("Consolidating the verified source cards…") animate too
    expect(identitySettings).toContain('String(root.resolver.notice).replace(/…$/, "") + root.animatedDots');
    expect(identitySettings).toContain("property int scanDotPhase");
    // stale results gray out while a re-scan is in flight
    expect(identitySettings).toContain("readonly property bool staleWhileScanning");
    // dimming covers the cleanup-opportunities results AND the review list
    expect(identitySettings.split("root.staleWhileScanning ? 0.45 : 1").length - 1).toBeGreaterThanOrEqual(7);
    expect(identitySettings).toContain("likely duplicates");
    expect(identitySettings).toContain("naming conflicts");
    expect(identitySettings).toContain("Review duplicate…");
    expect(identitySettings).toContain("Review conflict…");
    expect(identitySettings).toContain("Focus on ");
    expect(identitySettings).toContain("Every contact change still opens its own preview and confirmation.");
    expect(identitySettings).not.toContain("Merge all");
    expect(identities).toContain("function auditContacts(handles, quiet)");
    expect(identities).toContain('auditWorker.command = ["bun", helperPath, "audit"]');
    expect(identityHelper).toContain('operation === "audit"');
  });

  test("settings navigation keeps contact repair compact and separate from appearance", () => {
    expect(settings).toContain('property string page: "contacts"');
    expect(settings).toContain('visible: root.page === "contacts"');
    expect(settings).toContain('visible: root.page === "appearance"');
    expect(settings).toContain("width: Math.min(parent.width, root.space(1120))");
    expect(identitySettings).toContain('label: "← All conversations"');
    expect(identitySettings).toContain("visible: !root.reviewActive");
    expect(identitySettings).toContain("visible: root.macReviewExpanded");
    expect(identitySettings).toContain("function openContactManagement()");
    expect(identitySettings).toContain("Manage Contacts…");
    expect(identitySettings).toContain("sourceCandidate.cardsExpanded ? sourceCandidate.modelData.cards : []");
    expect(identitySettings).toContain("root.candidateForToken(saved.contactToken)");
    expect(settings).not.toContain("Saved as portable JSON files");
    expect(settings).toContain("Layout.alignment: Qt.AlignTop");
  });

  test("silent settings refreshes preserve stable models and visible state", () => {
    expect(identities).toContain("loading = quiet !== true");
    expect(identities).toContain("if (serialized !== identitiesJson)");
    expect(identities).toContain("pendingReviewHandle = requested");
    expect(identities).toContain('if (!worker.running && root.activeHandle === "") root.load(true)');
    expect(preferences).toContain("if (loaded && serialized === lastSerialized) return true");
  });

  test("Mac contact writes require preview, confirmation, and expose undo", () => {
    expect(identitySettings).toContain('label: "Remove this " + root.handleNoun() + "…"');
    // the undo offer shows only in the workspace of the contact it changed
    expect(identitySettings).toContain("root.handleKey(root.resolver.undoHandle)");
    // the conflict flow speaks in outcomes, not implementation terms: picking
    // a person opens their cards; "session"/identities.json stay out of it
    expect(identitySettings).toContain('"WORKING ON: "');
    expect(identitySettings).toContain("Work on this person");
    expect(identitySettings).toContain("Pick a person below. That only opens their cards for review");
    expect(identitySettings).not.toContain("Select for this session");
    expect(identitySettings).not.toContain("SELECTED FOR THIS SESSION");
    expect(identitySettings).toContain('label: "Remove from Mac Contacts"');
    expect(identitySettings).toContain("An undo receipt will be saved on the Mac");
    expect(identitySettings).toContain('label: "Undo Mac change"');
    expect(identities).toContain("function inspectOnMac(handle, token, ownerToken)");
    expect(identities).toContain("function removeOnMac()");
    expect(identities).toContain("function undoOnMac()");
    expect(identities).toContain("repairPreview.writeEnabled");
    expect(identities).toContain("validToken(repairPreview.ownerToken)");
  });

  test("contact comparison is local and linking has a separate upstream confirmation", () => {
    expect(identitySettings).toContain("Manage " + '" + sourceCandidate.modelData.recordCount');
    expect(identitySettings).toContain("ContactCardCompare");
    expect(contactCompare).toContain('title: "Compare source cards"');
    expect(contactCompare).toContain('title: "Consolidate into one card"');
    expect(contactCompare).toContain('title: "Or link cards · optional"');
    expect(contactCompare).not.toContain("step: \"");
    expect(contactCompare).toContain("Reload cards from Mac");
    expect(contactCompare).toContain("Back to contact tasks");
    expect(contactCompare).toContain("DIFFERENCES ONLY");
    expect(contactCompare).toContain("sharedRowMap");
    expect(contactCompare).toContain("MERGED PREVIEW");
    expect(contactCompare).toContain("function displayFieldLabel(fieldType, value)");
    expect(contactCompare).toContain('detail.toLowerCase() === fieldType.toLowerCase()');
    expect(contactCompare).toContain("displayFieldLabel(group.name, item.label)");
    expect(contactCompare).toContain('displayFieldLabel("Address", address.label)');
    expect(contactCompare).toContain("Prepare link in Contacts…");
    expect(contactCompare).toContain("CONFIRM AN UPSTREAM CONTACTS CHANGE");
    expect(contactCompare).toContain("Checking makes no changes");
    expect(contactCompare).toContain("Edit in Blip…");
    expect(contactCompare).toContain("cardBox.modelData.sourceName");
    expect(identitySettings).toContain("sourceCard.modelData.sourceName");
    expect(contactCompare).toContain("Text.PlainText");
    expect(contactCompare).not.toContain("Array.isArray(card.phones)");
    expect(identities).toContain("function compareCards(handle, ownerToken, otherOwnerToken)");
    expect(identities).toContain("function prepareLink()");
    expect(identities).toContain("function linkCards()");
    expect(identities).toContain("linkPreview.ready");
    expect(identities).toContain("expectedAction: linkPreview.action");
  });

  test("the contact workspace edits, deletes, and consolidates only after preview", () => {
    expect(contactCompare).toContain("ContactCardEditor");
    expect(contactCompare).toContain("Merge into \" + modelData.sourceName");
    expect(panel).toContain('iconText: "⚙"');
    expect(panel).toContain('tooltipText: "Settings"\n            bordered: false');
    expect(panel).toContain('iconText: "＋"');
    expect(panel).toContain('tooltipText: "New message (n)"\n            bordered: false');
    expect(contactEditor).toContain("Review changes…");
    expect(contactEditor).toContain("Delete this source card…");
    expect(contactEditor).toContain("Review merged contact…");
    expect(contactEditor).toContain("REVIEW CONSOLIDATION");
    expect(contactEditor).toContain("This is a read-only preview. Nothing below has been saved to Contacts.");
    expect(contactEditor).toContain("MERGED CONTACT TO KEEP");
    expect(contactEditor).toContain("DELETE AFTER MERGE");
    expect(contactEditor).toContain("FINAL CONFIRMATION");
    expect(contactEditor).toContain("Back to edit");
    expect(contactEditor).toContain("Save to Mac Contacts");
    expect(contactEditor).toContain("Merge and delete source cards");
    expect(contactEditor).toContain("function cleanLabel(value)");
    expect(contactEditor).toContain("originalLabel: text(item.label)");
    expect(contactEditor).toContain('value === cleanLabel(original) ? original : value');
    expect(contactEditor.indexOf('label: valueList.emptyLabel')).toBeGreaterThan(
      contactEditor.indexOf('model: parent.model'),
    );
    expect(contactEditor.indexOf('label: "Add address"')).toBeGreaterThan(
      contactEditor.indexOf('model: root.previewOpen ? null : addresses'),
    );
    expect(contactEditor).toContain("Text.PlainText");
    expect(identities).toContain("function prepareCardEdit(card, draft)");
    expect(identities).toContain("function prepareCardDelete(card)");
    expect(identities).toContain("function prepareConsolidation(targetCard, draft)");
    expect(identities).toContain("function applyMutation()");
    expect(identities).toContain("mutationPreview.planHash");
  });

  test("app window routes n, slash, digits, and Esc through catch helpers", () => {
    expect(window).toContain("view.catchNavText(");
    expect(window).toContain("view.catchEscape()");
    expect(window).toContain("navCatcher.forceActiveFocus()");
    expect(window).toContain("win.navText(");
    const nav = window.slice(window.indexOf("function navText"), window.indexOf("function saveWinState"));
    expect(nav.indexOf("var typed = event.text")).toBeLessThan(nav.indexOf("Qt.Key_1"));
    expect(nav).toContain("Qt.ShiftModifier");
  });

  test("handleTextKey runs slash, n, and 1-9 before the inThread return", () => {
    const fn = handleTextKeySource();
    expect(fn.indexOf('text === "/"')).toBeLessThan(fn.indexOf("inThread"));
    expect(fn.indexOf('text === "n"')).toBeLessThan(fn.indexOf("inThread"));
    expect(fn.indexOf('text >= "1"')).toBeLessThan(fn.indexOf("inThread"));
    expect(fn).toContain("if (i < 0 || i >= navigationThreads.length) return false");
    expect(fn).toContain("openThread(navigationThreads[i])");
  });

  test("1-9 still jumps, with no digit drawn anywhere (Fred, 2.3.1)", () => {
    // The label was a hint, never the mechanism: handleTextKey indexes
    // threads[] directly. Drawing it also cost every conversation row a blank
    // left gutter, because a fixed-width column stayed reserved when the text
    // was empty — which it always is once nine pins own 1-9.
    expect(panel).not.toContain("threadHotkey");
    expect(panel).toContain('if (text >= "1" && text <= "9")');
    expect(panel).toContain("openThread(threads[i])");
    const catcher = panel.slice(panel.indexOf("function catchNavText"), panel.indexOf("function catchEscape"));
    expect(catcher).toContain('text >= "1" && text <= "9"');
    expect(catcher).toContain("root.draftPath");
    expect(catcher).toContain("return handleTextKey(text) === true");
    const fn = handleTextKeySource();
    expect(fn).toContain("if (searching || newMode) return false");
  });

  test("conversation search is scheduled from the field text, people first", () => {
    expect(panel).toContain("if (q !== searchQueryRan) searchSeq++");
    expect(panel).toContain("function scheduleSearch");
    expect(panel).toContain("function conversationHits");
    expect(panel).toContain("id: searchWatch");
    expect(panel).toContain("function threadIdentitiesJson");
    expect(panel).toContain("searchProc.write(threadIdentitiesJson())");
    expect(panel).toContain("onAccepted: root.acceptSearchField()");
  });

  test("new-message contact search is scheduled from the field text, not only Enter", () => {
    expect(panel).toContain("function scheduleContactSearch");
    expect(panel).toContain("function newFieldQuery");
    expect(panel).toContain("id: newSearchWatch");
    expect(panel).toContain("running: root.newMode");
    expect(panel).toContain("newSearchTimer.restart()");
    expect(panel).not.toContain("forceLayout");
    expect(panel.indexOf("onAccepted: root.acceptNewField()")).toBeGreaterThan(-1);
  });

  test("an old toast can still reopen its conversation (omarchy-exec-argv)", () => {
    // --action=default dies with the notify-send process after eight seconds.
    // The hint is what Omarchy persists, so a row in the notification center
    // is still clickable a week later. If this disappears, old iMessage
    // notifications go inert again and nothing else fails.
    expect(widget).toContain('"--hint=string:omarchy-exec-argv:"');
    expect(widget).toContain('root.moduleName, "goto", chatArg');
    // The chat id goes in as its own argv element, never inside a shell
    // string, and only when it is shaped like a handle.
    expect(widget).toContain("JSON.stringify(");
    expect(widget).toContain("/^[A-Za-z0-9._@:;$-]{1,256}$/.test(chatArg)");
    expect(widget).not.toContain('"bash", "-c"');
  });
});

describe("media renders at its intended scale", () => {
  test("attachment sizing honours the header pixel density from fetch.ts", () => {
    expect(panel).toContain("Number(chipRow.imageMetrics.pixelWidth) / pixelRatio");
    expect(panel).toContain("Math.min(maxW, naturalWidth)");
  });

  test("message links inherit the bubble's text color", () => {
    expect(panel).toContain("function richMessageHtml(html, linkColor)");
    expect(panel).toContain("root.richMessageHtml(");
  });

  test("tall link artwork keeps its aspect ratio", () => {
    expect(panel).toContain("Math.min(root.space(480)");
    expect(panel).toContain("fillMode: Image.PreserveAspectFit");
  });
});

// A merge conflict marker is valid TEXT, so every string-matching test in this
// file passes with one sitting in the middle of a QML file — while Quickshell
// refuses to load the type and BOTH surfaces render empty. That shipped in
// 2.3.2 (BlipView's compose block, PR #28 vs #30) and was invisible until the
// post-deploy log scan. Cheapest possible guard.
test("no source file carries a merge conflict marker", () => {
  for (const f of ["BlipView.qml", "BarWidget.qml", "Panel.qml", "BlipWindow.qml"]) {
    const src = readFileSync(new URL("./" + f, import.meta.url), "utf8");
    for (const line of src.split("\n")) {
      expect(
        /^(<{7}|={7}|>{7})(\s|$)/.test(line) ? f + ": " + line : "clean",
      ).toBe("clean");
    }
  }
});

// Pinned threads render ONLY in the grid (the list is unpinnedThreads), and
// 2.3.1 removed the count under each tile. That left a bold 11px caption as a
// pinned conversation's only unread signal — one unread in a pinned group
// showed badge 1 and "nothing new in the app". The tile carries the same blue
// dot the list rows do.
test("a pinned tile shows the unread dot", () => {
  expect(panel).toContain("id: pinnedUnreadDot");
  const dot = panel.slice(panel.indexOf("id: pinnedUnreadDot"), panel.indexOf("id: pinnedUnreadDot") + 700);
  expect(dot).toContain("visible: modelData.unread > 0");
  expect(dot).toContain("color: root.mineFill");
});

// The bar icon's unread dot is iMessage blue no matter the theme. It followed
// the theme accent, which on several Omarchy themes is red — a red dot on a
// messaging icon reads as an error, and red is reserved for alerts anyway.
test("the icon's unread dot is always iMessage blue", () => {
  expect(widget).toContain('readonly property color blipAccent: "#0a84ff"');
  expect(widget).not.toContain("blipAccent:\n    Color.accent");
});

// Bubbles are iMessage blue on every theme, white text on them, like Messages.
// They followed the theme accent until 2.3.3 — red on several Omarchy themes.
test("default outgoing bubbles stay iMessage blue with white text", () => {
  expect(panel).toContain('readonly property color accent: "#0a84ff"');
  expect(panel).toContain('readonly property color mineText: outgoingColorSetting === "theme" ? "#ffffff" : contrastText(mineFill)');
  expect(panel).not.toContain("themeHasAccent");
});

// The version shows in the header both surfaces share, read live from
// manifest.json by the host — one source, one place, never two numbers.
test("the header shows the version from manifest.json", () => {
  expect(widget).toContain('Qt.resolvedUrl("manifest.json")');
  expect(widget).toContain("root.version = String(JSON.parse(text()).version");
  expect(panel).toContain("trailingControl: Component");
  expect(panel).toContain("text: root.version");
});

// A release bumps three files. If one is missed the badge lies, or the
// changelog does — so CI refuses the drift instead of a reader finding it.
test("manifest, README badge and CHANGELOG agree on the released version", () => {
  const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8")).version as string;
  const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
  const changelog = readFileSync(new URL("./CHANGELOG.md", import.meta.url), "utf8");
  expect(manifest).toMatch(/^\d+\.\d+\.\d+$/);
  expect(readme).toContain(`badge/version-${manifest}-`);
  const released = /^## (\d+\.\d+\.\d+)\b/m.exec(changelog);
  expect(released?.[1]).toBe(manifest);
});

// Omarchy's daemon persists every DISPLAYED toast body to disk; the transient
// hint only governs DND-silenced ones (Service.qml, its own comment). So the
// digits never go in a body, and a message that carries a code gets no
// ordinary preview toast either.
test("a security code is never put in a notification body", () => {
  const note = widget.slice(widget.indexOf("function noteCode("), widget.indexOf("function noteCode(") + 1400);
  expect(note).not.toContain("pendingCode.code +");
  expect(note).toContain('"Click to copy');
  expect(widget).toContain("codeKeys[String(t.chat)");
});

// Clicking a toast copies the code THAT toast showed, not whatever arrived since.
test("the clicked toast copies its own code", () => {
  expect(widget).toContain("root.copyCode(notifyProc.toastCode)");
  expect(widget).toContain("copyValue = String(code || pendingCode.code)");
});

// A follower bar must never start a collector of its own.
test("follower bars forward right/middle clicks to the leader", () => {
  expect(widget).toContain('code === Qt.RightButton ? "read" : "refresh"');
});

// A URL out of a message is message content: stdin to the preview fetcher, never argv.
test("link preview URLs never ride argv", () => {
  expect(panel).toContain('["bun", root.previewScript, "--stdin"]');
  expect(panel).toContain("previewProc.write(previewProc.url)");
  expect(panel).not.toContain("root.previewScript, previewProc.url]");
});

// The consolidation draft's dedupe logic lives in ContactCardCompare.qml as
// plain-JS functions; extract and execute them so the collapse rules are
// tested for behaviour, not just presence. Brace-walking keeps the extraction
// honest when the functions change shape.
function extractQmlFunction(source: string, name: string): string {
  const marker = `  function ${name}(`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`function ${name} not found`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0)
      return source.slice(start, i + 1);
  }
  throw new Error(`function ${name} never closes`);
}

describe("consolidation draft dedupe (executed from QML source)", () => {
  const uniqueList: (cards: unknown[], property: string, address: boolean) => Record<string, string>[] =
    new Function(
      [
        extractQmlFunction(contactCompare, "addressFields"),
        extractQmlFunction(contactCompare, "addressField"),
        extractQmlFunction(contactCompare, "addressSubsumes"),
        extractQmlFunction(contactCompare, "uniqueList"),
        "return uniqueList;",
      ].join("\n"),
    )();

  const home = {
    label: "Home", street: "1234 Cherry Ln", city: "Springfield",
    state: "MN", postalCode: "55555", country: "United States",
  };

  test("an address differing only by an unset field collapses to the complete copy", () => {
    // The live case: countryCode "us" on one source card, unset on the other.
    const kept = uniqueList(
      [{ addresses: [{ ...home, countryCode: "us" }] }, { addresses: [{ ...home }] }],
      "addresses", true,
    );
    expect(kept.length).toBe(1);
    expect(kept[0].countryCode).toBe("us");
  });

  test("the more complete copy wins regardless of card order", () => {
    const kept = uniqueList(
      [{ addresses: [{ ...home }] }, { addresses: [{ ...home, countryCode: "us" }] }],
      "addresses", true,
    );
    expect(kept.length).toBe(1);
    expect(kept[0].countryCode).toBe("us");
  });

  test("addresses that disagree on a filled field both survive", () => {
    const kept = uniqueList(
      [{ addresses: [home] }, { addresses: [{ ...home, city: "Minneapolis" }] }],
      "addresses", true,
    );
    expect(kept.length).toBe(2);
  });

  test("an all-empty address never reaches the draft", () => {
    const kept = uniqueList(
      [{ addresses: [{ label: "Home", street: "", city: "" }] }, { addresses: [home] }],
      "addresses", true,
    );
    expect(kept.length).toBe(1);
    expect(kept[0].street).toBe("1234 Cherry Ln");
  });

  test("value-keyed lists keep exact-match semantics", () => {
    const kept = uniqueList(
      [
        { phones: [{ label: "Work", value: "(555) 010-4477" }] },
        { phones: [{ label: "Work", value: "(555) 010-4477" }, { label: "Mobile", value: "+15550104477" }] },
      ],
      "phones", false,
    );
    // Exact duplicates collapse; a differently formatted number is not our
    // call to merge.
    expect(kept.map((entry) => entry.value)).toEqual(["(555) 010-4477", "+15550104477"]);
  });
});
