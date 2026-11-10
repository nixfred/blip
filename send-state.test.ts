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

// 2026-11-10: a send failed (the gateway Mac had no login session), the user logged the Mac in and sent the
// same words again, and the retry was delivered. The failed attempt stayed on screen as a red "Not Delivered"
// ghost under a message that DID go out, until the shell restarted.
function sentRow(text: string, ts: string, extra: Record<string, unknown> = {}) {
  return {...pendingBubble(undefined, {chat: "+15551234567", text, ts}, "2026-11-10").bubble, pending: false, failed: false, ...extra};
}
const failedSend = (localId: string, text: string, ts: string) =>
  ({localId, chat: "+15551234567", text, ts, failed: true, failureReason: "Messages can't start on the Mac"});

test("a delivered retry of the same words clears the failed attempt", () => {
  const out = withPendingSends([sentRow("Applying.....Awesome!", "2026-11-10 12:49:52")],
    [failedSend("1", "Applying.....Awesome!", "2026-11-10 12:40:00")], "2026-11-10", DEFAULT_FORMATS, Date.parse("2026-11-10T12:50:00"));
  expect(out.pending).toEqual([]);
  expect(out.bubbles).toHaveLength(1);
  expect(out.bubbles[0]?.failed).toBe(false);
});

test("every failed attempt of the same words clears when one newer copy is delivered", () => {
  const out = withPendingSends([sentRow("hello", "2026-11-10 12:49:52")],
    [failedSend("1", "hello", "2026-11-10 12:40:00"), failedSend("2", "hello", "2026-11-10 12:41:00")],
    "2026-11-10", DEFAULT_FORMATS, Date.parse("2026-11-10T12:50:00"));
  expect(out.pending).toEqual([]);
  expect(out.bubbles).toHaveLength(1);
});

test("a failed attempt stays when nothing newer with the same words was delivered", () => {
  const failed = failedSend("1", "hello", "2026-11-10 12:40:00");
  const cases = [
    [sentRow("something else", "2026-11-10 12:49:52")],            // different words
    [sentRow("hello", "2026-11-10 12:39:00")],                       // older copy
    [sentRow("hello", "2026-11-10 12:40:00")],                       // same second: not provably a retry
    [sentRow("hello", "2026-11-10 12:49:52", {failed: true})],       // newer, but Apple marked it failed too
    [sentRow("hello", "2026-11-10 12:49:52", {retracted: true})],    // newer, but unsent
    [],
  ];
  for (const rows of cases) {
    const out = withPendingSends(rows as any, [failed], "2026-11-10", DEFAULT_FORMATS, Date.parse("2026-11-10T12:50:00"));
    expect(out.pending).toEqual([failed]);
    expect(out.bubbles.at(-1)).toMatchObject({failed: true, pending: true});
  }
});

test("a failed attempt of OTHER words is untouched by a delivered retry of different ones", () => {
  const keep = failedSend("2", "other words", "2026-11-10 12:41:00");
  const out = withPendingSends([sentRow("hello", "2026-11-10 12:49:52")],
    [failedSend("1", "hello", "2026-11-10 12:40:00"), keep], "2026-11-10", DEFAULT_FORMATS, Date.parse("2026-11-10T12:50:00"));
  expect(out.pending).toEqual([keep]);
});
