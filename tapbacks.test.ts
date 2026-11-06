import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// imsg-react performs Messages' own tapback actions, named in the Mac's
// language. It is opt-in: the shim refuses it before anything reaches the Mac
// unless bridge.conf says tapbacks=on. A fake ssh records what would be sent.
describe("blip-shim: tapbacks=on gates imsg-react", () => {
  const shim = new URL("./bridge/linux/blip-shim", import.meta.url).pathname;

  function run(tool: string, conf: string) {
    const dir = mkdtempSync(join(tmpdir(), "blip-tapbacks-"));
    copyFileSync(shim, join(dir, tool));
    chmodSync(join(dir, tool), 0o755);
    writeFileSync(join(dir, "ssh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${dir}/ssh.log"\n`);
    chmodSync(join(dir, "ssh"), 0o755);
    writeFileSync(join(dir, "bridge.conf"), `host=mac.example\nkey=${dir}/no-key\n${conf}`);
    const r = spawnSync(join(dir, tool), ["--guid", "ABC", "love"], {
      encoding: "utf8",
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, BLIP_BRIDGE_CONF: join(dir, "bridge.conf") },
    });
    const log = existsSync(join(dir, "ssh.log")) ? readFileSync(join(dir, "ssh.log"), "utf8") : "";
    rmSync(dir, { recursive: true, force: true });
    return { code: r.status, err: r.stderr, log };
  }

  test("off by default: refused with EX_CONFIG, the Mac is never contacted", () => {
    for (const conf of ["", "tapbacks=off\n", "tapbacks=\n", "tapbacks=maybe\n"]) {
      const r = run("imsg-react", conf);
      expect(r.code).toBe(78);
      expect(r.err).toContain("tapbacks=on");
      expect(r.log).toBe("");
    }
  });

  test("tapbacks=on passes it through like any bridge tool", () => {
    for (const conf of ["tapbacks=on\n", "tapbacks=ON\n", 'tapbacks="yes"\n', "tapbacks=1\n"]) {
      const r = run("imsg-react", conf);
      expect(r.code).toBe(0);
      expect(r.log).toContain("imsg-react '--guid' 'ABC' 'love'");
    }
  });

  test("the menu reads the key exactly as the shim does", () => {
    const { tapbacksOn } = require("./tapback-actions") as typeof import("./tapback-actions");
    for (const conf of [
      "tapbacks=on\n", "tapbacks = on # yes\n", "tapbacks='True'\n", "tapbacks=on\ntapbacks=off\n",
      "tapbacks=off\ntapbacks=1\n", "# tapbacks=on\n", "tapbacks=onward\n", "tapbacks=\n", "tap backs=on\n",
    ]) {
      expect({ conf, on: run("imsg-react", conf).code === 0 }).toEqual({ conf, on: tapbacksOn(conf) });
    }
  });

  test("the key gates nothing else", () => {
    const r = run("imsg", "");
    expect(r.code).toBe(0);
    expect(r.log).toContain("imsg '--guid' 'ABC' 'love'");
  });

  test("the confined key's dispatch knows the tool", () => {
    const dispatch = readFileSync(new URL("./bridge/mac/blip-dispatch", import.meta.url), "utf8");
    expect(dispatch).toMatch(/TOOLS = \{[^}]*"imsg-react"/);
    const install = readFileSync(new URL("./bridge/mac/install.sh", import.meta.url), "utf8");
    expect(install).toMatch(/for t in [^;]*\bimsg-react\b/);
  });
});

// The JXA half runs only on a Mac, but the label matcher is plain JS and
// decides which bubble gets touched: a loose match lands on a neighbour.
describe("imsg-react: bubble label matching", () => {
  const src = readFileSync(new URL("./bridge/mac/imsg-react", import.meta.url), "utf8");
  const fn = (name: string) => {
    const start = src.indexOf(`function ${name}(`);
    return src.slice(start, src.indexOf("\n}\n", start) + 2);
  };
  const norm = src.slice(src.indexOf("function norm("), src.indexOf("\n", src.indexOf("function norm(")));
  const { parseLabel, bodyIs } = new Function(`${norm}\n${fn("parseLabel")}\n${fn("bodyIs")}\nreturn { parseLabel, bodyIs };`)();
  const matches = (label: string, text: string) => {
    const L = parseLabel(label);
    return !!L && bodyIs(L.body, text);
  };

  test("the text alone, or followed by its tapback annotation", () => {
    expect(matches("Ann, ok, 18:03", "ok")).toBe(true);
    expect(matches("Ann, ok, 2 reactions, You laughed at this, 18:03", "ok")).toBe(true);
    expect(matches("Ann, ok, 1 reaction, Bo loved this, 6:03 PM", "ok")).toBe(true);
    expect(matches("Ann, a, b, 18:03", "a, b")).toBe(true);
  });

  test("never a longer text that starts the same way", () => {
    expect(matches("Ann, ok, see you, 18:03", "ok")).toBe(false);
    expect(matches("Ann, ok, I loved this, 18:03", "ok")).toBe(false);
    expect(matches("Ann, ok, 2 reactions, and more, 18:03", "ok")).toBe(false);
    expect(matches("Ann, okay, 18:03", "ok")).toBe(false);
  });

  test("12-hour clocks read as 24-hour", () => {
    expect(parseLabel("Ann, ok, 6:03 PM").time).toBe("18:03");
    expect(parseLabel("Ann, ok, 12:05 AM").time).toBe("00:05");
  });
});

// The menu half. QML has no unit tests; these pin the wiring the logic in
// tapback-actions.ts depends on.
describe("message menu: tapbacks", () => {
  const view = readFileSync(new URL("./BlipView.qml", import.meta.url), "utf8");
  const widget = readFileSync(new URL("./BarWidget.qml", import.meta.url), "utf8");
  const menu = readFileSync(new URL("./MessageMenu.qml", import.meta.url), "utf8");
  const picker = readFileSync(new URL("./ReactionPicker.qml", import.meta.url), "utf8");

  test("off by default, from the same parser as the tests above", () => {
    expect(widget).toContain("property bool tapbacks: false");
    expect(widget).toContain("root.tapbacks = TapbackActions.tapbacksOn(t)");
    expect(widget).toContain("root.tapbacks = false;");
    expect(view).toContain("readonly property bool tapbacksOn: hostWidget ? hostWidget.tapbacks === true : false");
  });

  test("offered only for a bubble the tool acts on, and one at a time until chat.db has answered", () => {
    expect(view).toContain("tapbacksShown: root.tapbacksOn && TapbackActions.canTapback(root.messageContext, root.activeIsGroup)");
    expect(view).toContain("readonly property bool tapbacksBusy: (hostWidget ? hostWidget.tapbackRunning === true : false) || pendingTapback !== null");
    expect(view).toContain("tapbacksBusy: root.tapbacksBusy");
    expect(view).toContain("if (root.tapbacksBusy || !root.tapbacksOn || !hostWidget || !TapbackActions.canTapback(message, root.activeIsGroup)) return");
    expect(widget).toContain("if (reactProc.running) return false");
    expect(menu).toContain("visible: menu.tapbacksShown");
    expect(menu).toContain("busy: menu.tapbacksBusy");
    expect(picker).toContain("enabled: !picker.busy");
  });

  test("spawned through the conversation's source, add or remove decided by tapback-actions.ts", () => {
    expect(view).toContain('SourceId.bridgeArgv(chat, "imsg-react", hostWidget.binDir)');
    // the pending pill and the tool are told the same thing
    expect(view).toContain("TapbackActions.pendingTapback(chat, String(message.guid), kind, current)");
    expect(view).toContain("TapbackActions.tapbackRequest(String(message.guid), kind, current)");
    expect(view).toContain('if (!request) { root.note = "That reaction is not supported"; return }');
    expect(view).toContain("hostWidget.runTapback(chat, argv, request.stdin)");
    expect(widget).toContain("if (body) reactProc.write(body)");
    expect(widget).toContain("reactProc.stdinEnabled = false");
  });

  test("keyboard: Ctrl+E on the selected bubble opens the menu, 1–6 in it pick a tapback", () => {
    expect(view).toContain("if (event.key === Qt.Key_E && (event.modifiers & Qt.ControlModifier)) { event.accepted = true; root.openMessageMenuAt(b, root.bubbleCursorItem); return }");
    // among the selected-bubble keys, so only with an empty draft and a bubble selected
    const keys = view.slice(view.indexOf("var b = empty && root.attachCount === 0 ? root.selectedBubble() : null"));
    expect(keys.indexOf("root.openMessageMenuAt(b")).toBeLessThan(keys.indexOf("root.send()"));
    expect(view).toContain("messageMenu.keyHints = true");
    expect(view).toContain("if (keyHints) composeField.forceActiveFocus()");
    // the row has the keys on open, and Menu's Up/Down reach it: Qt skips an
    // item without activeFocusOnTab and gives focus only to a MenuItem
    expect(menu).toContain("    if (menu.tapbacksShown) menu.currentIndex = 0");
    expect(menu).toContain("onCurrentIndexChanged: if (menu.currentIndex === 0 && menu.tapbacksShown) tapbackStrip.forceActiveFocus()");
    expect(menu).toContain("    activeFocusOnTab: menu.tapbacksShown");
    expect(menu.indexOf("id: tapbackStrip")).toBeLessThan(menu.indexOf("MenuItem {"));
    expect(picker).toContain("var kind = marked ? TapbackActions.TAPBACKS[cursor].kind : TapbackActions.tapbackForKey(event.text)");
    // the number keys go through the same signal and busy gate as a click
    const strip = picker.slice(picker.indexOf("Keys.onPressed"), picker.indexOf("contentItem: Column"));
    expect(strip).toContain("choose(kind)");
    expect(menu).toContain("onChosen: function(kind) { menu.pickTapback(kind) }");
    expect(picker).toContain("else picker.choose(entry.kind)");
    const pick = menu.slice(menu.indexOf("function pickTapback"), menu.indexOf("onOpened:"));
    expect(pick.indexOf("if (menu.tapbacksBusy) return")).toBeLessThan(pick.indexOf("menu.tapbackRequested(kind)"));
    // Left/Right mark one along the row, Enter/Space pick it; unmarked, Enter stays the menu's
    expect(strip).toContain("cursor = TapbackActions.moveTapbackCursor(cursor, event.key === Qt.Key_Right ? 1 : -1, 7)");
    expect(strip).toContain("var marked = cursor >= 0 && (event.key === Qt.Key_Return || event.key === Qt.Key_Enter || event.key === Qt.Key_Space)");
    expect(menu).toContain("tapbackStrip.reset(menu.keyHints)");
    expect(picker).toContain("cursor = TapbackActions.initialTapbackCursor(currentKind, keyboard)");
    expect(picker).toContain("picker.activeFocus && picker.cursor === classic.index");
  });

  test("an open menu survives a reload and follows its message (Ctrl+E while a tapback lands)", () => {
    // parented to the bubble's row, the menu closed when the Repeater rebuilt it
    const at = view.slice(view.indexOf("function openMessageMenuAt"), view.indexOf("readonly property bool tapbacksOn"));
    expect(at).toContain("messageMenu.popup(root, at.x, at.y)");
    expect(at).not.toContain("messageMenu.popup(item");
    const changed = view.slice(view.indexOf("onBubblesChanged: {"), view.indexOf("property bool pinToBottom"));
    expect(changed).toContain("var m = MessageActions.bubbleIndexByGuid(bubbles, menuGuid)");
    expect(changed).toContain("if (m >= 0) messageContext = bubbles[m]");
    expect(changed).toContain("else messageMenu.close()");
  });

  test("the selected bubble stays selected when its tapback lands (a reload)", () => {
    expect(view).toContain("var keep = bubbleCursorGuid");
    expect(view).toContain("if (keep !== \"\") Qt.callLater(root.restoreBubbleCursor, keep)");
    expect(view).toContain("var i = MessageActions.bubbleIndexByGuid(bubbles, guid)");
    expect(view).not.toContain("onBubblesChanged: clearBubbleCursor()");
  });

  test("drawn at once as pending; chat.db settles it, a failure takes it away", () => {
    // The run belongs to BarWidget: the popout and the window are destroyed on
    // close, and a run owned by the view died with it, failure unsaid.
    expect(view).not.toContain("id: reactProc");
    const proc = widget.slice(widget.indexOf("id: reactProc"), widget.indexOf("// ------------------------------------------------------------ toasts"));
    expect(proc).toContain("if (code === 0) root.tapbackExited(root.tapbackChat, true)");
    expect(proc).toContain("else root.tapbackFailed(root.tapbackChat, TapbackActions.tapbackFailure(code, reactProc.lastErr))");
    // a tool that never started emits no exited: caught the way the collector is
    expect(proc).toContain("reactProc.sawExit = true");
    expect(proc).toContain("if (!reactProc.sawExit && !reactProc.running) root.tapbackFailed(root.tapbackChat, TapbackActions.TAPBACK_NOT_STARTED)");
    // a failure waits per conversation until a view showing it takes it
    expect(widget).toContain("f[chat] = text");
    expect(widget).toContain("function takeTapbackFailure(chat)");
    const exited = view.slice(view.indexOf("function onTapbackExited"), view.indexOf("// Attachment fetcher"));
    expect(exited).toContain("Object.assign({}, root.pendingTapback, { done: true })");
    expect(exited).toContain("if (!root.inThread || String(root.active.chat) !== chat) root.pendingTapback = null");
    // the tool saw the row: the load starts at once, and after done, so it may settle the pill
    expect(exited.indexOf("{ done: true })")).toBeLessThan(exited.indexOf("root.requestThreadLoad(chat)"));
    const failed = exited.slice(exited.indexOf("} else {"));
    expect(failed).toContain("root.pendingTapback = null");
    expect(failed).toContain("if (root.active && String(root.active.chat) === chat) root.note = root.hostWidget.takeTapbackFailure(chat)");
    // opening the conversation later, in either surface, says it there
    const show = view.slice(view.indexOf("function showThread"), view.indexOf("clearAttachments()", view.indexOf("function showThread")));
    expect(show.indexOf('note = ""')).toBeLessThan(show.indexOf("hostWidget.takeTapbackFailure(String(t.chat))"));
    // a new tapback drops an older failure for the same conversation
    expect(view).toContain("hostWidget.takeTapbackFailure(chat)\n    root.pendingTapback = TapbackActions.pendingTapback(");
    // the dimmed pill is the only "on its way"; the status line speaks only for a failure
    expect(view).not.toContain('"tapback…"');
    expect(view).toContain('if (root.note.indexOf("tapback: ") === 0) root.note = ""');
    // every load settles against what it read, knowing whether it started after the tool's exit
    expect(view).toContain("root.threadTapbackDone = !!(root.pendingTapback && root.pendingTapback.done)");
    expect(view).toContain("root.pendingTapback = TapbackActions.pendingAfterLoad(root.pendingTapback, root.threadRunningChat, list, root.threadTapbackDone)");
    // a failed load settles too (as not showing the bubble), or the menu stays busy
    const loader = view.slice(view.indexOf("id: threadProc"), view.indexOf("id: sendProc"));
    expect(loader.split("TapbackActions.pendingAfterLoad(root.pendingTapback, root.threadRunningChat, [], root.threadTapbackDone)").length).toBe(3);
    expect(view).toContain("if (root.threadTapbackDone && root.pendingTapback && root.pendingTapback.chat === root.threadRunningChat) {");
    // the text bubble's pill and the room left for it both draw through shownTapbacks
    expect(view).toContain("readonly property var shownTapbacks: TapbackActions.shownTapbacks(modelData, root.pendingTapback)");
    expect(view).toContain("TapbackPill { mine: bubbleRow.mine; tapbacks: bubbleRow.shownTapbacks }");
    expect(view).toContain("+ (bubbleRow.shownTapbacks.length > 0 ? Style.space(12) : 0)");
    expect(view).toContain("opacity: (tapbacks || []).some(function(t) { return t.pending === true }) ? 0.45 : 1");
  });
});
