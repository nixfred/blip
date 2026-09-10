import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseUiFontSize, scaleFontPx } from "./ui-font";

// The renderer moved from Panel.qml into BlipView.qml in 1.8.0 (shared with the app window).
const panel = readFileSync(new URL("./BlipView.qml", import.meta.url), "utf8");
const widget = readFileSync(new URL("./BarWidget.qml", import.meta.url), "utf8");
const window = readFileSync(new URL("./BlipWindow.qml", import.meta.url), "utf8");

function handleTextKeySource() {
  const start = panel.indexOf("function handleTextKey");
  const end = panel.indexOf("function unwind");
  return panel.slice(start, end);
}

/** Body of a root-level BlipView function, up to its own closing brace. */
function qmlFunction(name: string) {
  const start = panel.indexOf(`function ${name}(`);
  return panel.slice(start, panel.indexOf("\n  }\n", start));
}

describe("QML safety invariants", () => {
  test("group sends use the cached AppleScript GUID", () => {
    expect(panel).toContain('["--chat-id", String(root.active.guid)]');
    expect(panel).toContain('["--to", chat]');
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
    // The width must come from the LAYOUT, never from the text: a bare
    // TextArea's implicitWidth is the unwrapped line, so the RowLayout would
    // grow with what you type and the caret would scroll sideways. It used to
    // be anchors.fill on the slot; it is now the flickable's width, which is
    // the slot's, which is the layout's.
    const start = panel.indexOf("id: composeField");
    expect(start).toBeGreaterThan(-1);
    const compose = panel.slice(Math.max(0, start - 80), start + 2800);
    expect(compose).toContain("TextArea {");
    expect(compose).toContain("wrapMode: TextEdit.Wrap");
    expect(compose).toContain("width: composeFlick.width");
    expect(compose).not.toContain("implicitWidth:");
  });

  test("a long draft scrolls to the caret instead of growing past the panel", () => {
    // The slot caps at five lines and clips. A TextArea scrolls to its caret
    // ONLY inside a Flickable — anchored to fill the clipped slot it did not,
    // so past the fifth line the text was laid out below the visible area and
    // you typed blind (Fred, 2026-09-07).
    expect(panel).toContain("id: composeFlick");
    expect(panel).toContain("onCursorRectangleChanged: composeFlick.showCaret()");
    const show = qmlFunction("showCaret");
    expect(show).toContain("var c = composeField.cursorRectangle");
    expect(show).toContain("if (c.y < contentY) contentY = Math.max(0, c.y)");
    expect(show).toContain("contentY = Math.min(max, c.y + c.height - height)");
    // a drag in the field is text selection, exactly as in the conversation
    const flick = panel.slice(panel.indexOf("id: composeFlick"), panel.indexOf("id: composeField"));
    expect(flick).toContain("interactive: false");
    // the border is the slot's: inside the flickable it would scroll away
    expect(panel).toContain("borderSpec: composeField._composeBorder");
    expect(panel).toContain("background: null");
  });

  test("send completion owns immutable chat and draft context", () => {
    expect(panel).toContain("var completedChat = root.sendChat");
    expect(panel).toContain("var completedStamp = root.sendStamp");
    // the field clears as Enter is pressed; a failure puts the words back
    // only when nothing newer has been typed
    expect(panel).toContain("if (composeField.text === \"\") composeField.text = completedText");
  });

  test("a send shows its bubble at once and reloads carry the in-flight ledger on stdin", () => {
    expect(panel).toContain("root.bubbles = root.appendPendingBubble(root.bubbles, text, stamp, localId)");
    expect(panel).toContain("root.pendingSends = root.pendingSends.concat([{ chat: chat, text: text, ts: stamp, localId: localId }])");
    expect(panel).toContain('"--pending-stdin"');
    expect(panel).toContain("threadProc.write(JSON.stringify(pending))");
    expect(panel).toContain("root.failPending(completedChat, completedId, reason, completedText, completedStamp)");
    expect(panel).toContain('modelData.pending === true ? "Sending…"');
    // the read watermark never takes a pending bubble's local-clock stamp
    expect(panel).toContain("if (list[k].pending === true) continue");
  });

  test("message text leaves this machine on stdin, never in argv (audit #4)", () => {
    expect(panel).toContain('"--text-stdin"');
    expect(panel).toContain("sendProc.write(job.text)");
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
    expect(widget).toContain("link.urls.map(String) : [String(link.url)]");   // all of that message's links
    expect(widget).toContain("p.opened === true");                    // panel must already be open
    expect(widget).toContain("root.windowVisible");                   // or the app window
  });

  test("a link you SEND opens the sheet too, and the app button asks the host", () => {
    expect(panel).toContain("var sentUrls = root.allUrls(completedText)");   // every link of the message
    expect(panel).toContain("root.openShare(sentUrls, true)");
    expect(panel).toContain("function openApp()");
    expect(panel).toContain('hostWidget.showApp()');
    // the popout gets out of the way, and closes BEFORE the window is shown —
    // inside showApp(), so double-click, ⇱ and IPC `app` (SUPER+M) all agree
    const showApp = widget.slice(widget.indexOf("function showApp()"), widget.indexOf("function anySurfaceOpen"));
    expect(showApp.indexOf("root.close()")).toBeLessThan(showApp.indexOf("ensureWindow()"));
    expect(showApp.indexOf("root.close()")).toBeGreaterThan(-1);
    // The tooltip names the action, not a key: SUPER+M is an optional
    // binding from the README, and Omarchy's own tooltips name no keys.
    expect(panel).toContain('tooltipText: "Open the app window"');
    expect(panel).not.toContain("SUPER+M)");
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
    expect(panel).toContain("function openShare(u, auto)");
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

  test("status names the read-push policy, and does not call the watcher a push", () => {
    // `push=` was the message WATCHER; read-pushing had no status surface at
    // all, so "reads are not reaching my phone" could not be told apart from a
    // policy that was never going to push (Fred, 2026-09-08). The default,
    // "all", pushes only on the mark-all gesture.
    expect(widget).toContain('+ " watch=" + root.watchAlive');
    expect(widget).toContain('+ " read_push=" + (root.readPush !== "" ? root.readPush : "?")');
    expect(widget).not.toContain('" push=" + root.watchAlive');
    expect(widget).toContain('if (typeof d.readPush === "string") root.readPush = d.readPush');
  });

  test("IPC window reports what it did, not a property that has not settled", () => {
    // ensureWindow() defers `visible = true` to a callLater, so reading
    // windowVisible straight after showing still says hidden: `window` answered
    // "window hidden" on BOTH paths and could never report a window it had just
    // shown. Found by driving the live IPC surface, 2026-09-07.
    expect(widget).toContain('return root.toggleWindow() ? "window shown" : "window hidden"');
    expect(widget).toContain("if (root.windowVisible) { hideWindow(); return false }");
    expect(widget).not.toContain('root.toggleWindow(); return root.windowVisible');
  });

  test("navigating away dismisses the share sheet", () => {
    // The sheet auto-opens on an ARRIVING link. Without this it survived into
    // the next conversation, and resetToList() (which the host runs on every
    // open) brought a stale sheet back over the list. Found live, 2026-09-07.
    // resetToList() and back() empty the pane through clearThread(), which
    // closes the sheet; openThread() closes it itself before showing the next.
    expect(qmlFunction("clearThread")).toContain("closeShare()");
    for (const fn of ["resetToList", "back"]) expect(qmlFunction(fn)).toContain("clearThread()");
    expect(qmlFunction("openThread")).toContain("closeShare()");
    // Esc still closes the sheet BEFORE it unwinds the view (Astra A#7)
    expect(panel).toContain('if (root.shareUrl !== "") root.closeShare(); else if (root.bubbleCursor >= 0)');
  });

  test("IPC goto refuses an id that is not one, instead of opening a blank thread", () => {
    // `goto ""` opened a nameless thread with no header that nothing could
    // send to — a script with an unset variable is how you get there. Found by
    // driving the live IPC surface, 2026-09-07. An id that merely LOOKS like a
    // handle but is unknown still opens, on purpose (start a new conversation).
    expect(widget).toContain('if (raw === "" || !/^[A-Za-z0-9._@:;$-]{1,256}$/.test(raw)) return false');
    expect(widget).toContain('return root.show(chat) ? "shown" : "not a conversation id"');
    // show() must report failure rather than the handler assuming success
    expect(widget).toContain("if (!panelLoader.item) return false");
  });

  test("read marks are queued and only applied after a successful load", () => {
    expect(widget).toContain("property var refreshQueue: []");
    expect(widget).not.toContain("property var queued: null");
    const success = panel.indexOf("if (d.ok === true)");
    const mark = panel.indexOf("markRead(root.threadRunningChat, seen)");
    expect(success).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(success);
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
    expect(fn).toContain("if (i < 0 || i >= threads.length) return false");
    expect(fn).toContain("openThread(threads[i])");
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
    expect(panel).toContain("searchProc.write(JSON.stringify({ query: q, threads: JSON.parse(threadIdentitiesJson()) }))");
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

  test("every cursor move keeps its row in view and stops at the ends", () => {
    // The list is a multi-section Column, so there is no ListView to do this;
    // each move function ends by scrolling its row into the viewport. A modulo
    // here would bring the wrap-around back.
    for (const name of ["moveCursor", "moveSearchCursor", "moveNewCursor"]) {
      const fn = qmlFunction(name);
      expect(fn).toContain("Math.max(0, Math.min(");
      expect(fn).not.toContain("%");
      expect(fn).toContain("scrollCursorIntoView()");
    }
    const scroll = qmlFunction("scrollCursorIntoView");
    expect(scroll).toContain("row.mapToItem(threadFlick.contentItem, 0, 0)");
    expect(scroll).toContain("Math.min(maxY, bottom + margin - threadFlick.height)");
  });

  test("rows register themselves as the cursor row instead of scanning threads", () => {
    // threadIndex() walked every thread per row per keypress; cursorChat is one
    // string compare, and the row that matches hands itself to cursorRow so
    // the move functions never translate indexes between the four models.
    expect(panel).not.toContain("threadIndex(");
    expect(panel.split("root.cursorChat === String(modelData.chat)").length - 1).toBe(2);
    // the highlight hides while the search field has focus; the cursor itself stays
    expect(panel).toContain("readonly property bool cursorShown: !searchField.activeFocus");
    expect(panel.split("(hasCursor && root.cursorShown)").length - 1).toBe(2);
    expect(panel.split("onHasCursorChanged: if (hasCursor) root.cursorRow = ").length - 1).toBe(4);
  });

  test("leaving a field or a conversation brings the cursor row back", () => {
    // startSearch/startNew scroll to the top (the field sits above the rows)
    // and back() parks a mouse user there; the keyboard cursor is restored
    // after the rows have been rebuilt, hence the deferral.
    expect(qmlFunction("startSearch")).toContain("threadFlick.contentY = 0");
    expect(qmlFunction("startNew")).toContain("threadFlick.contentY = 0");
    expect(qmlFunction("exitSearch")).toContain("Qt.callLater(scrollCursorIntoView)");
    expect(qmlFunction("exitNew")).toContain("Qt.callLater(scrollCursorIntoView)");
    const back = qmlFunction("back");
    expect(back).toContain("threadFlick.contentY = 0");
    expect(back.indexOf("threadFlick.contentY = 0")).toBeLessThan(back.indexOf("scrollCursorIntoView()"));
    // Down in an empty field starts from the first row; Esc keeps the old cursor.
    expect(panel.split('if (text === "") root.listFromTop()').length - 1).toBe(2);
    expect(qmlFunction("listFromTop")).toContain("cursor = 0");
  });

  test("app window walks the list with Up/Down/Enter only while no editor has focus", () => {
    expect(window).toContain("view.catchNavKey(event.key)");
    const fn = qmlFunction("catchNavKey");
    expect(fn.indexOf("if (editorActive) return false")).toBeLessThan(fn.indexOf("Qt.Key_Down"));
    expect(fn).toContain("moveCursor(1)");
    expect(fn).toContain("moveCursor(-1)");
    expect(fn).toContain("activateCursor()");
    // Right steps into the compose field (committing a peek); Left in an
    // empty compose field steps back, with text it stays a caret move.
    expect(fn).toContain("if (key === Qt.Key_Right && inThread) { composeField.forceActiveFocus(); return true }");
    expect(panel).toContain('if (root.splitView && cursorPosition === 0 && root.shareUrl === "") root.navigationFocusRequested()');
  });

  test("Omarchy's shell toggle can find the panel", () => {
    // Bar.findPanelWidget wants open(), close() and `opened` on the widget
    // item; drop `opened` and every SUPER+CTRL panel hotkey silently skips Blip.
    expect(widget).toContain("readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false");
    expect(widget).toContain("function open() {");
    expect(widget).toContain("function close() {");
  });

  test("keys and wheel scroll the conversation through one stick-aware helper", () => {
    // Two writers of flick.contentY would drift on the bottom-stick, which
    // gates the deferred push reload; the wheel handler must go through it.
    expect(qmlFunction("scrollConversation")).toContain("flick.stick = flick.contentY >= max - 4");
    expect(panel).toContain("root.scrollConversation(-d)");
    expect(panel.split("flick.stick = flick.contentY >= max - 4").length - 1).toBe(1);
    // Home/End select the ends only from an empty field (caret otherwise)
    expect(panel).toContain("(event.key === Qt.Key_Home && atLineStart) || (event.key === Qt.Key_End && atLineEnd)");
    expect(panel).toContain("var atLineStart = empty || cursorPosition === 0");
    expect(panel).toContain("root.bubbleCursor = event.key === Qt.Key_Home ? 0 : root.bubbles.length - 1");
    expect(panel).not.toContain("conversationStep");
    // PgUp/PgDn select the edge bubble regardless of text, and page when already there
    expect(panel).toContain("if (event.modifiers & Qt.ShiftModifier) root.moveBubbleCursor(dir)");
    expect(panel).toContain("else root.pageBubbles(dir)");
    const page = qmlFunction("pageBubbles");
    expect(page.indexOf("if (edge === bubbleCursor && bubbleCursorItem)")).toBeLessThan(page.indexOf("scrollConversation(dy < 0 ?"));
    // only a WHOLLY visible row counts as the edge, else a sliver of the row above turns paging into single steps
    expect(qmlFunction("edgeVisibleBubble")).toContain("it.y >= top - 1 : it.y + it.height <= bottom + 1");
    expect(page).toContain("leaveBubbles()");
  });

  test("arrows in an empty compose field select bubbles, and the selection clears cleanly", () => {
    // The selection is a target for actions; it must never outlive the rows
    // it indexes (a reload renumbers them) and Esc must drop it before leaving.
    expect(panel).toContain("onBubblesChanged: clearBubbleCursor()");
    // the band takes the theme's hover-cursor colour/alpha, like Omarchy's own rows
    expect(panel).toContain("color: Style.hoverFillFor(root.foreground, root.accent)");
    expect(panel).toContain("onHasCursorChanged: if (hasCursor) root.bubbleCursorItem = bubbleRow");
    expect(panel).toContain("if (root.bubbleCursor >= 0) root.leaveBubbles(); else root.back()");
    const move = qmlFunction("moveBubbleCursor");
    expect(move).toContain("bubbleCursor = n - 1");            // Up from nothing = newest
    expect(move).toContain("leaveBubbles()");                  // Down past newest = same exit as Esc
    expect(qmlFunction("leaveBubbles")).toContain("scrollConversation(flick.contentHeight)");
    expect(panel).toContain("root.moveBubbleCursor(event.key === Qt.Key_Up ? -1 : 1)");
    // the edge rule: Up leaves a draft only from its first line, Down only from
    // its last and only while a bubble is selected (otherwise the caret keeps it)
    expect(panel).toContain("var onFirstLine = empty || caret.y < topPadding + caret.height * 0.5");
    expect(panel).toContain("(event.key === Qt.Key_Down && onLastLine && root.bubbleCursor >= 0)");
  });

  test("bubble actions reuse the click handlers and never steal a real send", () => {
    // Enter/Ctrl+C/Ctrl+R act on the selection only with an empty field and
    // no queued file — a queued file's Enter is a send, and must stay one.
    expect(panel).toContain('var b = empty && root.draftPath === "" ? root.selectedBubble() : null');
    const open = qmlFunction("openBubble");
    expect(open).toContain("openAttachment(b.attachments[0])");
    expect(open).toContain("openShare(urls, false)");   // a link goes to the sheet, never straight to the browser
    expect(panel).toContain("root.copyBubble(b)");
    const copy = qmlFunction("copyBubble");
    expect(copy.indexOf("copyText(t)")).toBeLessThan(copy.indexOf("copyAttachment("));  // text wins
    // the image reaches wl-copy as an argument, never interpolated into the shell script
    expect(panel).toContain(`'wl-copy --type "$1" < "$2"', "sh", mime, String(d.path || "")`);
    // HEIC arrives as JPEG (fetch.ts wantsJpeg): the clipboard type must say so
    expect(panel).toContain('root.fetchJobMime === "image/heic" || root.fetchJobMime === "image/heif" ? "image/jpeg"');
    // the inline preview stays put while the original is fetched for the clipboard
    expect(panel).toContain('var keepInline = root.fetchJobAction === "copy" && !!root.attFiles[id]');
    expect(panel).not.toContain("fetchJobOpen");
    expect(qmlFunction("quoteBubble")).toContain("leaveBubbles()");
    // Empty status does not reserve a row; only failures are red.
    expect(panel).toContain('visible: root.note !== ""');
    expect(panel).toContain("color: calm ? root.dim : root.urgent");
  });

  test("a peeked thread is not read until the reader commits", () => {
    // Three read paths, all gated on `peeking`: the two post-load marks in
    // BlipView and readingSurface() in BarWidget (what the collector is told
    // is being read). Focus entering the compose field is the commit.
    expect(qmlFunction("markRead")).toContain("if (hostWidget && readActive && !peeking) hostWidget.markThreadRead(chat, seen)");
    expect(panel.split("root.markRead(root.threadRunningChat, seen)").length - 1).toBe(2);
    expect(panel).not.toContain("root.hostWidget.markThreadRead(");
    expect(panel).toContain("onActiveFocusChanged: if (activeFocus) root.commitPeek()");
    expect(qmlFunction("commitPeek")).toContain("if (!loading) markRead(String(active.chat), seenTs)");
    expect(window).toContain("readonly property bool peeking: view.peeking");
    expect(widget).toContain("w.inThread === true && w.peeking !== true");
  });

  test("peeking is split-view only, debounced, and cleared on the way out", () => {
    expect(panel).toContain("Timer { id: peekTimer;");
    // Leaving the list for a field ends a peek; an opened thread stays.
    expect(qmlFunction("startSearch")).toContain("endPeek()");
    expect(qmlFunction("startNew")).toContain("endPeek()");
    expect(qmlFunction("endPeek")).toContain("if (peeking) clearThread()");
    expect(qmlFunction("peekCursor")).toContain("!cursorShown");
    // The sidebar's spacing must not follow inThread in split view (8px shift).
    expect(panel).toContain("spacing: root.splitView ? Style.space(10) : (root.inThread ? Style.space(2) : Style.space(6))");
    expect(qmlFunction("moveCursor")).toContain("if (splitView) peekTimer.restart()");
    // one place empties the pane; back() and resetToList() go through it
    expect(qmlFunction("clearThread")).toContain("peekTimer.stop()");
    expect(qmlFunction("clearThread")).toContain("peeking = false");
    for (const name of ["back", "resetToList"]) expect(qmlFunction(name)).toContain("clearThread()");
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
    expect(panel).toContain("Math.min(Style.space(480)");
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
test("outgoing bubbles are always iMessage blue with white text", () => {
  expect(panel).toContain('readonly property color accent: "#0a84ff"');
  expect(panel).toContain('readonly property color mineText: "#ffffff"');
  expect(panel).not.toContain("themeHasAccent");
});

// The version shows in the header both surfaces share, read live from
// manifest.json by the host — one source, one place, never two numbers.
test("the header shows the version from manifest.json", () => {
  expect(widget).toContain('Qt.resolvedUrl("manifest.json")');
  expect(widget).toContain("root.version = String(JSON.parse(text()).version");
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

// A conversation is read only after a snapshot RENDERED, and only through
// the newest ts in that snapshot — never the sidebar's (Astra A#2, A#3).
test("reads require a rendered snapshot and carry its own timestamp", () => {
  expect(panel).toContain("property bool rendered: false");
  expect(panel).toContain("root.markRead(root.threadRunningChat, seen)");   // through the peek gate, same `seen`
  expect(widget).toContain("s.rendered === true");
  expect(widget).toContain('return s ? String(s.seenTs || "") : ""');
  expect(widget).toContain("function markThreadRead(chat, seen)");
  for (const host of ["./Panel.qml", "./BlipWindow.qml"]) {
    const src = readFileSync(new URL(host, import.meta.url), "utf8");
    expect(src).toContain("readonly property bool rendered: view.rendered");
    expect(src).toContain("readonly property string seenTs: view.seenTs");
  }
});

// The app window counts as focused only when the active toplevel IS it.
test("window focus is an exact title match, not a prefix", () => {
  const win = readFileSync(new URL("./BlipWindow.qml", import.meta.url), "utf8");
  expect(win).toContain('String(Hyprland.activeToplevel.title || "") === win.title');
  expect(win).not.toContain('.indexOf("Blip") === 0');
});

// Esc over the share sheet closes the sheet; a stale search never stays clickable;
// a long sender name never widens the delegate.
test("share-sheet Escape, search generations, bounded sender labels", () => {
  // Astra A#7: the share sheet must close before back() (which would clear the
  // draft under it). #39 adds the bubble selection as a middle step.
  expect(panel).toContain('Keys.onEscapePressed: if (root.shareUrl !== "") root.closeShare(); else if (root.bubbleCursor >= 0) root.leaveBubbles(); else root.back()');
  expect(panel).toContain("if (q !== newQueryRan) { newResults = []; newCursor = 0 }");
  expect(panel.split("Layout.maximumWidth: Math.max(1, bubbleRow.width - Style.space(40))").length - 1).toBe(2);
  expect(widget).toContain('return "code expired"');
});

// A search query is message text the moment a sentence is pasted in.
test("search queries never ride argv", () => {
  expect(panel).toContain('["bun", root.searchScript, "--stdin", "40"]');
  expect(panel).toContain("searchProc.write(JSON.stringify({ query: q, threads:");
});

// The pinned avatar sits in a ColumnLayout, which sizes it from Layout hints;
// a width: binding there is overridden by the layout's first measurement.
test("pinned avatars size through Layout hints, not width bindings", () => {
  const start = panel.indexOf("id: pinnedAvatar");
  expect(start).toBeGreaterThan(-1);
  const avatar = panel.slice(start, panel.indexOf("radius: width / 2", start));
  expect(avatar).toContain("readonly property real avatarSize: Math.min(88, Math.max(56,");
  expect(avatar).toContain("implicitWidth: avatarSize");
  expect(avatar).toContain("implicitHeight: avatarSize");
  expect(avatar).toContain("Layout.preferredWidth: avatarSize");
  expect(avatar).not.toContain("pinnedGrid.width");
  expect(avatar).toContain("Layout.preferredHeight: avatarSize");
  expect(avatar).not.toContain(" width: Math.min(88");
});

// Drafts: text typed but not sent is kept per conversation across a thread
// switch, shared by the panel and the app window, in memory only — never on
// disk (the "message text never lands on disk" invariant).
describe("per-conversation drafts", () => {
  test("the host owns one draft map for both surfaces", () => {
    expect(widget).toContain("property var draftCache: ({})");
    expect(panel).toContain("readonly property var drafts: hostWidget ? hostWidget.draftCache : ({})");
  });

  test("every edit is kept under the open chat and restored on open", () => {
    expect(panel).toContain("onTextChanged: if (root.active) root.drafts[String(root.active.chat)] = text");
    expect(panel).toContain('composeField.text = drafts[String(t.chat)] || ""');
  });

  test("drafts never touch disk", () => {
    expect(panel).not.toContain("drafts.json");
    expect(widget).not.toContain("drafts.json");
  });
  });

// Enter on a selected link bubble opens the share sheet, never the browser
// directly; the sheet takes the keyboard, and its keys run before send().
test("a selected link opens the share sheet, and the sheet has keys", () => {
  expect(qmlFunction("openBubble")).not.toContain("openLink(u)");
  expect(qmlFunction("shareKey")).toContain("var acts = [shareOpen, shareCopy, shareSend]");
  expect(qmlFunction("shareKey")).toContain("if (key === Qt.Key_Return || key === Qt.Key_Enter) { acts[shareCursor](); return true }");
  // A sheet that opened by itself (sent / arrived / IPC) keeps Enter and digits
  // with the draft for a short grace: a link landing as Enter is pressed to
  // send must not be opened by that Enter.
  expect(qmlFunction("shareKey")).toContain("if (Date.now() < shareKeysFrom) return false");
  expect(qmlFunction("openShare")).toContain("shareKeysFrom = Date.now() + (auto === true ? 700 : 0)");
  expect(panel).toContain("root.openShare(sentUrls, true)");
  expect(qmlFunction("shareLink")).toContain("openShare(u, true)");
  const compose = panel.slice(panel.indexOf("id: composeField"));
  expect(compose.indexOf("if (root.shareKey(event.key)) { event.accepted = true; return }")).toBeLessThan(compose.indexOf("root.send()"));
  expect(compose).toContain('Keys.onEscapePressed: if (root.shareUrl !== "") root.closeShare(); else if (root.bubbleCursor >= 0)');
});

// A message with several links: Enter offers them all in the sheet, ←/→ step,
// and the keyboard finds exactly the links linkify() anchors for the mouse.
test("the share sheet steps through a message's links", () => {
  expect(qmlFunction("openBubble")).toContain("var urls = allUrls(b.text)");
  expect(qmlFunction("openBubble")).toContain("openShare(urls, false)");
  expect(qmlFunction("allUrls")).toContain('if (/^www\\./i.test(u)) u = "https://" + u');
  expect(qmlFunction("shareKey")).toContain("if ((key === Qt.Key_Left || key === Qt.Key_Right) && shareUrls.length > 1) { shareStep(key === Qt.Key_Right ? 1 : -1); return true }");
  expect(panel).toContain('" of " + root.shareUrls.length');
  // The sheet's taps stop in the sheet: an exclusive grab on press, or the
  // row, bubble or link underneath would act on the same click.
  const sheet = panel.slice(panel.indexOf("id: shareSheet"), panel.indexOf("id: shareSheet") + 6000);
  expect(sheet).toContain("TapHandler { gesturePolicy: TapHandler.ReleaseWithinBounds; onTapped: root.closeShare() }");
  expect(sheet).not.toMatch(/TapHandler \{ onTapped:/);
  // The QR box keeps its place while a code is being made, so stepping links
  // swaps the image instead of collapsing and re-growing the card.
  expect(sheet).toContain('visible: root.shareQr !== "" || qrProc.running');
  expect(qmlFunction("showShareUrl")).not.toContain('shareQr = ""');
});


test("a thread response taken before a local send or failure cannot replace bubbles", () => {
  const start = panel.indexOf("onStreamFinished: {", panel.indexOf("id: threadProc"));
  const brace = panel.indexOf("{", start);
  let depth = 1, end = brace + 1;
  for (; depth && end < panel.length; end++) {
    if (panel[end] === "{") depth++;
    if (panel[end] === "}") depth--;
  }
  const bubbles = [{text: "new local send"}];
  const requested: string[] = [];
  const root = {surfaceOpen:true, inThread:true, active:{chat:"+15551234567"},
    threadRunningChat:"+15551234567", threadPendingRevision:1, pendingRevision:2,
    bubbles, loading:true, requestThreadLoad:(chat:string) => requested.push(chat)};
  new Function("root", panel.slice(brace + 1, end - 1))(root);
  expect(root.bubbles).toBe(bubbles);
  expect(requested).toEqual(["+15551234567"]);
});
 test("Ctrl+number shortcuts use pin order and remain available in editors", () => {
   const source = readFileSync(new URL("./PinnedShortcuts.qml", import.meta.url), "utf8");
   expect(source).toContain('sequence: "Ctrl+" + (index + 1)');
   expect(source).toContain('context: Qt.WindowShortcut');
   expect(source).toContain('model: 9');
   expect(source).toContain('if (thread) root.chosen(thread)');
   expect(panel).toContain('pins: root.pinnedThreads');
   expect(panel).toContain('active: root.surfaceOpen && !root.contactsOpen && root.shareUrl === ""');
   expect(panel).toContain('String(root.active.chat) === String(thread.chat)) root.focusDefault()');
 });
// A picture-only message has no text bubble, so its tapback pill must live on
// the picture (or file chip) itself, through the one shared TapbackPill.
test("tapbacks on picture-only messages get a pill on the picture", () => {
  expect(panel).toContain("component TapbackPill: Rectangle {");
  expect(panel.split("TapbackPill {").length - 1).toBe(3);   // text bubble, picture, file chip
  expect(panel).toContain('readonly property bool pillHere: index === 0 && String(bubbleRow.modelData.text || "") === ""');
  expect(panel).toContain("+ (pillHere ? Style.space(12) : 0)");
});
