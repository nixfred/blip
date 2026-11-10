import { expect, test } from "bun:test";
import { markSendFailed, friendlySendError } from "./send-state";
import { pendingBubble, withPendingSends, DEFAULT_FORMATS } from "./thread";

test("failure targets one of two sends in the same second and keeps the original immutable", () => {
  const sends = ["1", "2"].map(localId => ({localId, chat: "+15551234567", text: "hello", ts: "2026-09-09 12:00:00"}));
  const result = markSendFailed(sends, "1", "Mac unreachable");
  expect(result[0]).toMatchObject({failed: true, failureReason: "Mac unreachable"});
  expect(result[1]).toBe(sends[1]);
  expect(sends[0]).not.toHaveProperty("failed");
  const bubble = pendingBubble(undefined, result[0]!, "2026-09-09").bubble;
  expect(bubble).toMatchObject({localId: "1", failed: true, pending: true, failureReason: "Mac unreachable"});
  const reloaded = withPendingSends([], result, "2026-09-09", DEFAULT_FORMATS, Date.parse("2026-09-09T12:10:00"));
  expect(reloaded.pending).toEqual([result[0]!]);
  expect(reloaded.bubbles[0]?.failed).toBe(true);
});

test("an older identical sent message cannot hide a rejected attempt", () => {
  const send = {localId: "1", chat: "+15551234567", text: "hello", ts: "2026-09-09 12:00:00", failed: true};
  const real = {...pendingBubble(undefined, send, "2026-09-09").bubble, pending: false, failed: false};
  const result = withPendingSends([real], [send], "2026-09-09", DEFAULT_FORMATS, Date.parse("2026-09-09T12:00:05"));
  expect(result.bubbles).toHaveLength(2);
  expect(result.pending).toEqual([send]);
});

test("failure reasons are bounded plain display text", () => {
  const result = markSendFailed([{localId: "1"}], "1", "bad\n\u202e" + "x".repeat(1000));
  expect(result[0]).toMatchObject({failureReason: "bad  " + "x".repeat(235)});
});


test("the deployed QML module agrees with the TypeScript state reducer", async () => {
  const runtime = await import("./SendState.mjs");
  const items = [{localId: "1"}, {localId: "2"}];
  expect(runtime.markSendFailed(items, "2", "Mac unreachable"))
    .toEqual(markSendFailed(items, "2", "Mac unreachable"));
});


test("a late transport failure is retained even if a fetched row already resolved the local placeholder", () => {
  const send = {localId:"1", text:"hello", ts:"2026-09-09 12:00:00", chat:"+15551234567"};
  const result = markSendFailed([], "1", "Mac unreachable", send);
  expect(result).toEqual([{...send, failed:true, failureReason:"Mac unreachable"}]);
  expect(markSendFailed(result, "1", "Mac unreachable", send)).toHaveLength(1);
});

// 2026-11-10: the gateway Mac lost its whole GUI session (WindowServer died, loginwindow logged the
// user out) and every send showed Messages' launch failure as raw osascript text.
test("a Messages launch failure (-10810) says nobody is logged in on the Mac", () => {
  const raw = "osascript error: 59:213: execution error: An error of type -10810 has occurred. (-10810)";
  const plain = friendlySendError(raw);
  expect(plain).toBe("Messages can't start on the Mac: nobody is logged in there. Log in on the Mac, then send again.");
  expect(plain).not.toContain("10810");
  expect(plain.length).toBeLessThan(240);
  expect(markSendFailed([{localId: "1"}], "1", plain)[0]).toMatchObject({failureReason: plain});
});

test("every other send error text passes through untouched", () => {
  for (const raw of [
    "osascript error: 59:213: execution error: Messages got an error: Can't get participant. (-1728)",
    "message too long", "not authorized", "send failed (exit 1)", "",
    "code 1081012 and -108100 are not it", "error -108101",
  ]) expect(friendlySendError(raw)).toBe(raw);
});
