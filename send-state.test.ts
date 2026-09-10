import { expect, test } from "bun:test";
import { markSendFailed } from "./send-state";
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
