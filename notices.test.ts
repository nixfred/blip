import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { activeNotices, CALM_MS, ERROR_MS, isCalm, noticeText } from "./notices";
import * as runtime from "./Notices.mjs";

test("tool output becomes one plain sentence", () => {
  expect(noticeText("tapback: Mac unreachable")).toBe("Couldn't reach your Mac.");
  expect(noticeText("tapback: Messages did not open its tapback picker; nothing was done"))
    .toBe("Messages didn't open the reaction picker. Try again.");
  expect(noticeText("tapback: 'Heart' was performed but no tapback row reached chat.db"))
    .toBe("Your Mac didn't confirm the reaction. Check it in Messages.");
  expect(noticeText("tapback: some new internal code 17")).toBe("Couldn't send that reaction.");
});

test("other notes pass through, bounded to one line", () => {
  expect(noticeText("not sent — Mac unreachable")).toBe("not sent — Mac unreachable");
  const long = noticeText("x".repeat(500));
  expect(long.length).toBe(120);
  expect(long.endsWith("…")).toBe(true);
});

test("failures linger, confirmations are brief, progress waits for its sender", () => {
  expect(activeNotices("send failed", [], {})[0]).toEqual({ kind: "note", text: "send failed", error: true, timeoutMs: ERROR_MS });
  expect(activeNotices("copied", [], {})[0]).toEqual({ kind: "note", text: "copied", error: false, timeoutMs: CALM_MS });
  expect(activeNotices("sending… (2 left)", [], {})[0]!.timeoutMs).toBe(0);
  expect(isCalm("save failed")).toBe(false);
});

test("a dismissed standing error stays away until its text changes", () => {
  const standing = [{ kind: "bridge", text: "Grant Full Disk Access" }];
  expect(activeNotices("", standing, {}).map((n) => n.kind)).toEqual(["bridge"]);
  expect(activeNotices("", standing, { bridge: "Grant Full Disk Access" })).toEqual([]);
  expect(activeNotices("", [{ kind: "bridge", text: "Other" }], { bridge: "Grant Full Disk Access" })).toHaveLength(1);
  expect(activeNotices("", [{ kind: "bridge", text: "" }], {})).toEqual([]);
});

test("the QML module matches its source and the view has no inline error rows", () => {
  expect(runtime.noticeText("tapback: Mac unreachable")).toBe(noticeText("tapback: Mac unreachable"));
  const view = readFileSync(new URL("./BlipView.qml", import.meta.url), "utf8");
  expect(view).toContain("Notices.activeNotices(");
  expect(view).not.toContain('"blipToastErrorThread"');
  expect(view).not.toContain('text: root.note\n');
});
