import { expect, test } from "bun:test";
import { finishReadJob } from "./read-worker";
import { queueReadIntent, queueMenuIntent } from "./read-sync";

test("stale completion cannot clear a superseding gesture, even with the same desired state", () => {
  const chat = "+15551234567";
  const first = queueReadIntent({}, chat, false, "2026-09-01T10:00:00Z");
  const latest = queueReadIntent(queueReadIntent(first, chat, true), chat, false, "2026-09-01T10:00:00Z");
  const job = { id: "job-1", chat, intentId: first[chat]!.id!, args: [] };
  expect(finishReadJob(latest, job, { id: job.id, ok: true, error: "" })).toEqual(latest);
  expect(finishReadJob(first, job, { id: "other", ok: true, error: "" })).toEqual(first);
  expect(finishReadJob(first, job, { id: job.id, ok: true, error: "" })).toEqual({});
});

test("a failure acknowledgement is applied at most once", () => {
  const chat = "+15551234567";
  const pending = queueReadIntent({}, chat, true);
  const job = { id: "job-1", chat, intentId: pending[chat]!.id!, args: [] };
  const result = { id: job.id, ok: false, error: "unavailable" };
  const once = finishReadJob(pending, job, result);
  expect(once[chat]!.attempts).toBe(1);
  expect(finishReadJob(once, job, result)).toEqual(once);
});

test("pin, alert and read intentions do not replace each other", () => {
  const chat = "+15551234567";
  const pending = queueMenuIntent(queueMenuIntent(queueReadIntent({}, chat, true), chat, "pin"), chat, "mute");
  expect(Object.keys(pending)).toHaveLength(3);
  const next = queueMenuIntent(pending, chat, "unpin");
  expect(next[`pin|${chat}`]!.action).toBe("unpin");
  expect(next[`mute|${chat}`]!.action).toBe("mute");
  expect(next[chat]!.unread).toBe(true);
});

test("the Mac can cancel a stale global request without scheduling another retry", () => {
  const pending = queueReadIntent({}, "*", false, "2026-09-01T10:00:00Z", 1);
  const job = { id: "global", chat: "*", intentId: pending["*"]!.id!, args: [] };
  expect(finishReadJob(pending, job, { id: job.id, ok: false, cancelled: true, error: "newer inbound" })).toEqual({});
});

test("mark-all preserves pending pin/alert edits and accepts a newer row boundary", () => {
  const chat = "+15551234567";
  const pending = queueMenuIntent({}, chat, "pin");
  const first = queueReadIntent(pending, "*", false, "2026-09-01T10:00:00Z", 1);
  const latest = queueReadIntent(first, "*", false, "2026-09-01T10:00:00Z", 2);
  expect(latest[`pin|${chat}`]).toEqual(pending[`pin|${chat}`]);
  expect(latest["*"]!.throughRow).toBe(2);
  expect(latest["*"]!.id).not.toBe(first["*"]!.id);
});
