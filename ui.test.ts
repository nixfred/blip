import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { notifySendArgv } from "./collector";

// The renderer moved from Panel.qml into BlipView.qml in 1.8.0 (shared with the app window).
const panel = readFileSync(new URL("./BlipView.qml", import.meta.url), "utf8");
const widget = readFileSync(new URL("./BarWidget.qml", import.meta.url), "utf8");

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

  test("send completion owns immutable chat and draft context", () => {
    expect(panel).toContain("var completedChat = root.sendChat");
    expect(panel).toContain("if (composeField.text === completedText) composeField.text = \"\"");
  });

  test("message text leaves this machine on stdin, never in argv (audit #4)", () => {
    expect(panel).toContain('"--text-stdin"');
    expect(panel).toContain("sendProc.write(text)");
    expect(panel).not.toContain('["--yes", "--", text]');
  });

  test("read marks are queued and only applied after a successful load", () => {
    expect(widget).toContain("property var refreshQueue: []");
    expect(widget).not.toContain("property var queued: null");
    const success = panel.indexOf("if (d.ok === true)");
    const mark = panel.indexOf("markThreadRead(root.threadRunningChat)");
    expect(success).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(success);
  });

  test("notify-send is the system-notification path and matches the canonical argv", () => {
    // Logic lives in collector.notifySendArgv; QML must not drift off it.
    const argv = notifySendArgv({ chat: "+1555", name: "Ada", text: "hi" });
    for (const flag of argv) {
      if (flag === "notify-send" || flag === "--" || flag === "Ada" || flag === "hi") continue;
      expect(widget).toContain(flag);
    }
    expect(widget).toContain('"--"');
    expect(widget).toContain("notify-send");
  });
});
