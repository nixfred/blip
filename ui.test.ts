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
    const mark = panel.indexOf("markThreadRead(root.threadRunningChat)");
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

  test("keys and wheel scroll the conversation through one stick-aware helper", () => {
    // Two writers of flick.contentY would drift on the bottom-stick, which
    // gates the deferred push reload; the wheel handler must go through it.
    expect(qmlFunction("scrollConversation")).toContain("flick.stick = flick.contentY >= max - 4");
    expect(panel).toContain("root.scrollConversation(-d)");
    expect(panel.split("flick.stick = flick.contentY >= max - 4").length - 1).toBe(1);
    const step = qmlFunction("conversationStep");
    // paging always; Home/End only when the field is empty (caret otherwise)
    expect(step.indexOf("Qt.Key_PageDown")).toBeLessThan(step.indexOf("if (!fieldEmpty) return 0"));
    expect(step.indexOf("if (!fieldEmpty) return 0")).toBeLessThan(step.indexOf("Qt.Key_Home"));
    expect(panel).toContain("root.conversationStep(event.key, empty)");
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
  });

  test("bubble actions reuse the click handlers and never steal a real send", () => {
    // Enter/Ctrl+C/Ctrl+R act on the selection only with an empty field and
    // no queued file — a queued file's Enter is a send, and must stay one.
    expect(panel).toContain('var b = empty && root.draftPath === "" ? root.selectedBubble() : null');
    const open = qmlFunction("openBubble");
    expect(open).toContain("openAttachment(b.attachments[0])");
    expect(open).toContain("openLink(u)");
    expect(panel).toContain("root.copyText(String(b.text || \"\"))");
    expect(qmlFunction("quoteBubble")).toContain("leaveBubbles()");
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
