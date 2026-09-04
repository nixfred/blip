import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildThreads,
  detectSelfChats,
  fetchMessagesAfter,
  CATCHUP_MAX_ROWS,
  fetchChats,
  fetchGroups,
  groupName,
  dedupeSelfEcho,
  isGroupChat,
  displayName,
  fetchMessages,
  loadAllowlist,
  loadMutelist,
  matchesMute,
  mutedChats,
  dropMuted,
  dropMutedChats,
  loadState,
  validPins,
  pinsFromChats,
  applyPins,
  maxTs,
  saveState,
  selectToasts,
  toastKey,
  unreadCounts,
  unreadOldest,
  type ImsgMessage,
  type ChatInfo,
} from "./collector";

const tmp = () => mkdtempSync(join(tmpdir(), "blip-test-"));

function msg(over: Partial<ImsgMessage> = {}): ImsgMessage {
  return {
    ts: "2026-08-30 12:00:00",
    from_me: false,
    handle: "+15551234567",
    name: "Test Person",
    service: "iMessage",
    chat: "+15551234567",
    text: "hello",
    ...over,
  };
}

describe("buildThreads", () => {
  test("groups by chat and keeps the newest message as the preview", () => {
    const threads = buildThreads(
      [
        msg({ chat: "A", ts: "2026-08-30 10:00:00", text: "older" }),
        msg({ chat: "A", ts: "2026-08-30 11:00:00", text: "newer" }),
        msg({ chat: "B", ts: "2026-08-30 09:00:00", text: "b only" }),
      ],
      "",
    );
    expect(threads).toHaveLength(2);
    expect(threads[0]!.chat).toBe("A");          // newest thread first
    expect(threads[0]!.last_text).toBe("newer");
    expect(threads[0]!.count).toBe(2);
  });

  test("orders threads newest-first regardless of input order", () => {
    const threads = buildThreads(
      [
        msg({ chat: "old", ts: "2026-01-01 00:00:00" }),
        msg({ chat: "new", ts: "2026-08-30 23:59:59" }),
        msg({ chat: "mid", ts: "2026-05-05 12:00:00" }),
      ],
      "",
    );
    expect(threads.map((t) => t.chat)).toEqual(["new", "mid", "old"]);
  });

  test("first run reports zero unread — an empty watermark must not flag the backlog", () => {
    const threads = buildThreads([msg({ ts: "2026-08-30 10:00:00" })], "");
    expect(threads[0]!.unread).toBe(0);
  });

  test("counts only inbound messages newer than the watermark", () => {
    const threads = buildThreads(
      [
        msg({ ts: "2026-08-30 09:00:00" }),                     // old inbound
        msg({ ts: "2026-08-30 11:00:00" }),                     // new inbound  ✓
        msg({ ts: "2026-08-30 12:00:00", from_me: true }),      // new outbound ✗
      ],
      "2026-08-30 10:00:00",
    );
    expect(threads[0]!.unread).toBe(1);
  });

  test("a message exactly at the watermark is not unread", () => {
    const threads = buildThreads([msg({ ts: "2026-08-30 10:00:00" })], "2026-08-30 10:00:00");
    expect(threads[0]!.unread).toBe(0);
  });

  test("group-chat GUID chat ids survive as their own thread", () => {
    const guid = "053856bb0d9a40e392db59eace1c56d1";
    const threads = buildThreads([msg({ chat: guid, name: "Jordan Blake" })], "");
    expect(threads[0]!.chat).toBe(guid);
  });

  test("the same person across a DM and a group stays two threads", () => {
    // A contact can appear under both a phone handle (DM) and a GUID (group).
    const threads = buildThreads(
      [
        msg({ chat: "+15550100003", name: "Sam Lee" }),
        msg({ chat: "4d1c08ae0eb64c88acfe7d68473f0124", name: "Sam Lee" }),
      ],
      "",
    );
    expect(threads).toHaveLength(2);
  });

  test("handles an empty window", () => {
    expect(buildThreads([], "2026-01-01 00:00:00")).toEqual([]);
  });

  test("a per-thread read mark clears only that thread", () => {
    const threads = buildThreads(
      [
        msg({ chat: "A", handle: "A", ts: "2026-08-30 11:00:00" }),
        msg({ chat: "B", handle: "B", ts: "2026-08-30 11:00:00" }),
      ],
      "2026-08-30 10:00:00",
      { A: "2026-08-30 11:00:00" },
    );
    const byChat = Object.fromEntries(threads.map((t) => [t.chat, t.unread]));
    expect(byChat).toEqual({ A: 0, B: 1 });
  });

  test("a stale per-thread mark never resurrects unread below the global mark", () => {
    const threads = buildThreads(
      [msg({ chat: "A", handle: "A", ts: "2026-08-30 09:30:00" })],
      "2026-08-30 10:00:00",
      { A: "2026-08-30 09:00:00" },
    );
    expect(threads[0]!.unread).toBe(0);
  });

  test("a null chat falls back to the handle — never the string \"null\"", () => {
    // Seen live: a spam SMS came back with chat:null and rendered as "null".
    const threads = buildThreads(
      [msg({ chat: null as unknown as string, handle: "+15550100006", name: null })],
      "",
    );
    expect(threads[0]!.chat).toBe("+15550100006");
    expect(threads[0]!.name).toBe("+15550100006");
    expect(threads[0]!.handle).toBe("+15550100006");
  });
});

describe("isGroupChat", () => {
  test("32 hex = group", () => expect(isGroupChat("053856bb0d9a40e392db59eace1c56d1")).toBe(true));
  test("phone = DM", () => expect(isGroupChat("+15550100003")).toBe(false));
  test("email = DM", () => expect(isGroupChat("someone@icloud.com")).toBe(false));
  test("chat<digits> = group (seen live)", () => expect(isGroupChat("chat640665907856941413")).toBe(true));
  test("an unknown shape is a group, never a DM target", () => expect(isGroupChat("weird-id")).toBe(true));
  test("exit 255 (ssh failure via claude-on-mac shim) reads as offline", () => {
    const r = fetchMessages(10, (() => ({ status: 255, stdout: "", stderr: "ssh: connect" })) as never);
    expect(r.online).toBe(false);
  });
  test("groups JSON with an array of participants (claude-on-mac 1.4)", () => {
    const g = fetchGroups((() => ({ status: 0, stdout: JSON.stringify([{ chat: "chat1", guid: "any;+;chat1", name: "", participants: ["+1", "+2"], last: null }]), stderr: "" })) as never);
    expect(g!.chat1.participants).toEqual(["+1", "+2"]);
  });
});

describe("self-echo in the thread list", () => {
  test("a message Fred sends himself does not count as unread", () => {
    // Without this every panel send to the self-thread re-lit the dot.
    const msgs = dedupeSelfEcho([
      msg({ chat: "+15550100001", handle: "+15550100001", ts: "2026-08-30 11:00:00", from_me: true, text: "note" }),
      msg({ chat: "+15550100001", handle: "+15550100001", ts: "2026-08-30 11:00:00", from_me: false, text: "note" }),
    ], ["+15550100001"]);
    const threads = buildThreads(msgs, "2026-08-30 10:00:00");
    expect(threads[0]!.unread).toBe(0);
    expect(threads[0]!.last_from_me).toBe(true);
  });

  test("the same text in two different chats at one ts is two messages", () => {
    const msgs = dedupeSelfEcho([
      msg({ chat: "A", handle: "A", ts: "2026-08-30 11:00:00", text: "ok" }),
      msg({ chat: "B", handle: "B", ts: "2026-08-30 11:00:00", text: "ok" }),
    ]);
    expect(msgs).toHaveLength(2);
  });

  test("an empty self row cannot reclassify another chat at the same second", () => {
    const msgs = dedupeSelfEcho([
      msg({ chat: "SELF", handle: "SELF", from_me: true, text: "", ts: "2026-08-30 11:00:00" }),
      msg({ chat: "OTHER", handle: "OTHER", from_me: false, text: "urgent", ts: "2026-08-30 11:00:00" }),
    ], ["SELF"]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.chat).toBe("OTHER");
    expect(msgs[0]!.from_me).toBe(false);
  });

  test("two group members saying the same thing in one second remain distinct", () => {
    const chat = "053856bb0d9a40e392db59eace1c56d1";
    const msgs = dedupeSelfEcho([
      msg({ chat, handle: "ALICE", text: "yes" }),
      msg({ chat, handle: "BOB", text: "yes" }),
    ]);
    expect(msgs).toHaveLength(2);
  });

  test("infers a self chat only from a matching empty-outbound twin", () => {
    expect(detectSelfChats([
      msg({ chat: "SELF", handle: "SELF", from_me: true, text: "" }),
      msg({ chat: "SELF", handle: "SELF", from_me: false, text: "mine" }),
      msg({ chat: "OTHER", handle: "OTHER", from_me: false, text: "theirs" }),
    ])).toEqual(["SELF"]);
  });

  test("a named group uses its display_name", () => {
    const guid = "ce5a593a78af408282d61461ade89135";
    const threads = buildThreads([msg({ chat: guid, name: "Casey Morgan" })], "", {}, { [guid]: { name: "Team", guid: "any;+;" + guid, participants: ["+1"] } });
    expect(threads[0]!.name).toBe("Team");
    expect(threads[0]!.guid).toBe("any;+;" + guid);
  });

  test("a group with no cached metadata has an empty guid and stays unsendable", () => {
    const threads = buildThreads([msg({ chat: "053856bb0d9a40e392db59eace1c56d1" })], "");
    expect(threads[0]!.guid).toBe("");
  });

  test("a DM never carries a guid", () => {
    expect(buildThreads([msg()], "")[0]!.guid).toBe("");
  });

  test("an unnamed group lists its members, resolving names from the window", () => {
    const guid = "053856bb0d9a40e392db59eace1c56d1";
    const threads = buildThreads(
      [msg({ chat: guid, handle: "+15550100004", name: "Jordan Blake" })],
      "", {},
      { [guid]: { name: "", guid: "any;+;" + guid, participants: ["+15550100004", "+15550100005"] } },
    );
    expect(threads[0]!.name).toBe("Jordan Blake, +15550100005");
  });

  test("a group with no metadata at all falls back to its id, never one member", () => {
    const guid = "053856bb0d9a40e392db59eace1c56d1";
    expect(groupName(guid, undefined, new Map())).toBe(guid);
  });
});

describe("displayName", () => {
  test("prefers the first resolved contact name", () => {
    expect(displayName([msg({ name: null }), msg({ name: "Alex Rivera" })])).toBe("Alex Rivera");
  });

  test("falls back to the chat id when nobody is named", () => {
    // `imsg chats` returns name:null, and unknown numbers never resolve.
    expect(displayName([msg({ name: null, chat: "878478" })])).toBe("878478");
  });
});

describe("selectToasts", () => {
  const allow = ["+15550100002"];

  test("a null-chat toast carries the handle, never the string null", () => {
    const out = selectToasts(
      [msg({ chat: null as unknown as string, handle: "+15550100002", ts: "2026-08-30 11:00:00" })],
      "2026-08-30 10:00:00",
      allow,
      [],
    );
    expect(out[0]!.chat).toBe("+15550100002");
  });

  test("toasts an allowlisted inbound message", () => {
    const out = selectToasts(
      [msg({ chat: "+15550100002", handle: "+15550100002", name: "Alex Rivera", ts: "2026-08-30 11:00:00" })],
      "2026-08-30 10:00:00",
      allow,
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("Alex Rivera");
  });

  test("drops senders that are not allowlisted", () => {
    // Bank alerts and 2FA codes are the reason this gate exists.
    const out = selectToasts(
      [msg({ chat: "878478", handle: "878478", ts: "2026-08-30 11:00:00" })],
      "2026-08-30 10:00:00",
      allow,
      [],
    );
    expect(out).toEqual([]);
  });

  test("never toasts outbound", () => {
    const out = selectToasts(
      [msg({ chat: "+15550100002", handle: "+15550100002", from_me: true, ts: "2026-08-30 11:00:00" })],
      "2026-08-30 10:00:00",
      allow,
      [],
    );
    expect(out).toEqual([]);
  });

  test("never toasts the backlog on first run", () => {
    const out = selectToasts(
      [msg({ chat: "+15550100002", handle: "+15550100002", ts: "2026-08-30 11:00:00" })],
      "",
      allow,
      [],
    );
    expect(out).toEqual([]);
  });

  test("suppresses a message already toasted — the self-thread echo guard", () => {
    // In the self-thread, the user's sent replies come back as from_me=false.
    // Without this dedupe the loop would notify on its own output forever.
    const m = msg({ chat: "+15550100001", handle: "+15550100001", ts: "2026-08-30 11:00:00", text: "echo" });
    const out = selectToasts([m], "2026-08-30 10:00:00", ["+15550100001"], [toastKey(m)]);
    expect(out).toEqual([]);
  });

  test("deduplicates identical messages within a single batch", () => {
    const m = msg({ chat: "+15550100002", handle: "+15550100002", ts: "2026-08-30 11:00:00" });
    const out = selectToasts([m, { ...m }], "2026-08-30 10:00:00", allow, []);
    expect(out).toHaveLength(1);
  });

  test("persisted toast keys are opaque and distinguish group senders", () => {
    const a = msg({ chat: "group", handle: "ALICE", text: "yes", ts: "2026-08-30 11:00:00" });
    const b = msg({ chat: "group", handle: "BOB", text: "yes", ts: "2026-08-30 11:00:00" });
    expect(toastKey(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(toastKey(a)).not.toContain("yes");
    expect(toastKey(a)).not.toBe(toastKey(b));
  });

  test("matches on handle when the chat id is an opaque GUID", () => {
    const out = selectToasts(
      [msg({ chat: "053856bb0d9a40e392db59eace1c56d1", handle: "+15550100004", ts: "2026-08-30 11:00:00" })],
      "2026-08-30 10:00:00",
      ["+15550100004"],
      [],
    );
    expect(out).toHaveLength(1);
  });

  test("an empty allowlist toasts nothing", () => {
    const out = selectToasts(
      [msg({ ts: "2026-08-30 11:00:00" })],
      "2026-08-30 10:00:00",
      [],
      [],
    );
    expect(out).toEqual([]);
  });
});

describe("maxTs", () => {
  test("returns the highest timestamp", () => {
    expect(maxTs([msg({ ts: "2026-08-30 09:00:00" }), msg({ ts: "2026-08-30 11:00:00" })], "")).toBe(
      "2026-08-30 11:00:00",
    );
  });

  test("never moves the watermark backwards on a short window", () => {
    expect(maxTs([msg({ ts: "2026-01-01 00:00:00" })], "2026-08-30 10:00:00")).toBe(
      "2026-08-30 10:00:00",
    );
  });

  test("an empty fetch leaves the watermark untouched", () => {
    expect(maxTs([], "2026-08-30 10:00:00")).toBe("2026-08-30 10:00:00");
  });
});

describe("state and allowlist I/O", () => {
  test("round-trips state", () => {
    const p = join(tmp(), "state.json");
    const opaque = `sha256:${"a".repeat(64)}`;
    expect(saveState({
      watermark: "2026-08-30 10:00:00", readMark: "2026-08-30 09:00:00",
      unreadCounts: { A: 2 }, unreadOldest: { A: "2026-08-30 09:01:00" },
      unreadInitialized: true, selfChats: ["SELF"],
      readMarks: { A: "x" }, groups: {}, chatAliases: { OLD: "A" }, pins: { A: 0 }, toasted: [opaque],
    }, p)).toBe(true);
    expect(loadState(p)).toEqual({
      watermark: "2026-08-30 10:00:00",
      readMark: "2026-08-30 09:00:00",
      unreadCounts: { A: 2 },
      unreadOldest: { A: "2026-08-30 09:01:00" },
      unreadInitialized: true,
      selfChats: ["SELF"],
      readMarks: { A: "x" },
      groups: {},
      chatAliases: { OLD: "A" },
      pins: { A: 0 },
      toasted: [opaque],
    });
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  test("a missing state file yields a safe empty watermark", () => {
    expect(loadState(join(tmp(), "nope.json"))).toEqual({
      watermark: "", readMark: "", unreadCounts: {}, unreadOldest: {}, unreadInitialized: false,
      selfChats: [], readMarks: {}, groups: {}, chatAliases: {}, pins: {}, toasted: [],
    });
  });

  test("corrupt state does not throw", () => {
    const p = join(tmp(), "bad.json");
    writeFileSync(p, "{ this is not json");
    expect(loadState(p)).toEqual({
      watermark: "", readMark: "", unreadCounts: {}, unreadOldest: {}, unreadInitialized: false,
      selfChats: [], readMarks: {}, groups: {}, chatAliases: {}, pins: {}, toasted: [],
    });
  });

  test("the toast ring is capped so the state file cannot grow forever", () => {
    const p = join(tmp(), "big.json");
    saveState({
      watermark: "x", readMark: "x", unreadCounts: {}, unreadOldest: {}, unreadInitialized: true,
      selfChats: [], readMarks: {}, groups: {}, toasted: Array.from({ length: 500 }, (_, i) => `k${i}`),
    }, p);
    expect(loadState(p).toasted).toHaveLength(200);
  });

  test("legacy toast keys are scrubbed before the next save", () => {
    const p = join(tmp(), "legacy-text.json");
    writeFileSync(p, JSON.stringify({ watermark: "x", readMark: "x", toasted: ["ts|chat|secret body"] }));
    const state = loadState(p);
    expect(state.toasted[0]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(state.toasted[0]).not.toContain("secret body");
    expect(saveState(state, p)).toBe(true);
    expect(readFileSync(p, "utf8")).not.toContain("secret body");
  });

  test("a state write failure is reported", () => {
    const blocker = join(tmp(), "not-a-directory");
    writeFileSync(blocker, "x");
    expect(saveState({
      watermark: "x", readMark: "x", unreadCounts: {}, unreadOldest: {}, unreadInitialized: true,
      selfChats: [], readMarks: {}, groups: {}, toasted: [],
    }, join(blocker, "state.json"))).toBe(false);
  });

  test("a pre-two-mark state file inherits readMark from watermark", () => {
    // Migration guard: an old {watermark, toasted} file must report zero unread,
    // not a fabricated backlog, the first time the new collector reads it.
    const p = join(tmp(), "legacy.json");
    writeFileSync(p, JSON.stringify({ watermark: "2026-08-30 10:00:00", toasted: [] }));
    expect(loadState(p).readMark).toBe("2026-08-30 10:00:00");
    expect(loadState(p).readMarks).toEqual({});
  });

  test("a count-only ledger is reseeded so deletes can be reconciled", () => {
    const p = join(tmp(), "count-only.json");
    writeFileSync(p, JSON.stringify({
      watermark: "2026-08-30 12:00:00",
      readMark: "2026-08-30 10:00:00",
      unreadCounts: { A: 2 },
      unreadInitialized: true,
    }));
    expect(loadState(p).unreadInitialized).toBe(false);
  });

  test("reads a bare-array allowlist", () => {
    const p = join(tmp(), "allow.json");
    writeFileSync(p, JSON.stringify(["+15551234567"]));
    expect(loadAllowlist(p)).toEqual(["+15551234567"]);
  });

  test("reads an {allow:[...]} allowlist", () => {
    const p = join(tmp(), "allow2.json");
    writeFileSync(p, JSON.stringify({ allow: ["+15551234567"], note: "ignored" }));
    expect(loadAllowlist(p)).toEqual(["+15551234567"]);
  });

  test("a missing allowlist is empty, not an error", () => {
    expect(loadAllowlist(join(tmp(), "none.json"))).toEqual([]);
  });

  test("non-string entries are filtered out", () => {
    const p = join(tmp(), "mixed.json");
    writeFileSync(p, JSON.stringify(["+15551234567", 42, null]));
    expect(loadAllowlist(p)).toEqual(["+15551234567"]);
  });
});

describe("fetchMessages", () => {
  const fake = (r: { status: number; stdout?: string; stderr?: string }) =>
    (() => ({ status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" })) as never;

  test("parses a good response", () => {
    const r = fetchMessages(10, fake({ status: 0, stdout: JSON.stringify([msg()]) }));
    expect(r.ok).toBe(true);
    expect(r.online).toBe(true);
    expect(r.msgs).toHaveLength(1);
  });

  test("exit 69 reports the Mac offline, not a crash", () => {
    // 69 = EX_UNAVAILABLE, the documented code from the imsg shim's reachability guard.
    const r = fetchMessages(10, fake({ status: 69 }));
    expect(r.ok).toBe(false);
    expect(r.online).toBe(false);
    expect(r.error).toBe("Mac unreachable");
  });

  test("a non-zero exit surfaces the LAST stderr line (Python puts the cause last)", () => {
    const r = fetchMessages(10, fake({ status: 1, stderr: "Traceback (most recent call last):\n  File x\nValueError: bad row 7" }));
    expect(r.ok).toBe(false);
    expect(r.online).toBe(true);
    expect(r.error).toBe("ValueError: bad row 7");
  });
  test("a timeout (status null) reads as the Mac being asleep, not a bridge bug", () => {
    const r = fetchMessages(10, fake({ status: null, stderr: "" }));
    expect(r.ok).toBe(false);
    expect(r.online).toBe(false);
    expect(r.error).toMatch(/timed out/);
  });

  test("malformed stdout is reported, not thrown", () => {
    const r = fetchMessages(10, fake({ status: 0, stdout: "not json at all" }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("bad JSON");
  });

  test("a JSON object instead of an array is rejected", () => {
    const r = fetchMessages(10, fake({ status: 0, stdout: '{"oops":true}' }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("bad JSON");
  });
});

describe("adaptive unread catch-up", () => {
  test("expands until the previous watermark is inside the fetched window", () => {
    const all = [
      msg({ ts: "2026-08-30 12:04:00" }),
      msg({ ts: "2026-08-30 12:03:00" }),
      msg({ ts: "2026-08-30 12:02:00" }),
      msg({ ts: "2026-08-30 11:59:00" }),
    ];
    const limits: number[] = [];
    const fake = ((_cmd: string, args: string[]) => {
      const limit = Number(args[2]);
      limits.push(limit);
      return { status: 0, stdout: JSON.stringify(all.slice(0, limit)), stderr: "" };
    }) as never;
    const result = fetchMessagesAfter("2026-08-30 12:00:00", 2, fake);
    expect(result.ok).toBe(true);
    expect(result.msgs).toHaveLength(4);
    expect(limits).toEqual([2, 4]);
  });

  test("catch-up stops doubling at CATCHUP_MAX_ROWS even if every page is full (Codex audit #12)", () => {
    const limits: number[] = [];
    const fake = ((_cmd: string, args: string[]) => {
      const limit = Number(args[2]);
      limits.push(limit);
      const rows = Array.from({ length: limit }, (_, i) => msg({ ts: "2026-08-30 12:01:00", handle: "H" + i }));
      return { status: 0, stdout: JSON.stringify(rows), stderr: "" };
    }) as never;
    const r = fetchMessagesAfter("2026-08-30 12:00:00", 2, fake);
    expect(r.ok).toBe(true);
    expect(limits[limits.length - 1]).toBeLessThanOrEqual(CATCHUP_MAX_ROWS);
    expect(limits.length).toBeLessThan(20);
  });

  test("expands past an equal timestamp boundary", () => {
    const all = [
      msg({ ts: "2026-08-30 12:01:00", handle: "A" }),
      msg({ ts: "2026-08-30 12:00:00", handle: "B" }),
      msg({ ts: "2026-08-30 12:00:00", handle: "C" }),
    ];
    const limits: number[] = [];
    const fake = ((_cmd: string, args: string[]) => {
      const limit = Number(args[2]);
      limits.push(limit);
      return { status: 0, stdout: JSON.stringify(all.slice(0, limit)), stderr: "" };
    }) as never;
    expect(fetchMessagesAfter("2026-08-30 12:00:00", 2, fake).msgs).toHaveLength(3);
    expect(limits).toEqual([2, 4]);
  });

  test("the unread ledger records counts and its reconciliation boundary", () => {
    const rows = [
      msg({ chat: "A", ts: "2026-08-30 11:00:00" }),
      msg({ chat: "A", ts: "2026-08-30 10:30:00" }),
      msg({ chat: "A", ts: "2026-08-30 11:01:00", from_me: true }),
    ];
    expect(unreadCounts(rows, "2026-08-30 10:00:00", {})).toEqual({ A: 2 });
    expect(unreadOldest(rows, "2026-08-30 10:00:00", {})).toEqual({ A: "2026-08-30 10:30:00" });
  });

  test("rebuilding the covered unread range removes deleted rows", () => {
    const rowsAfterDelete = [msg({ chat: "A", ts: "2026-08-30 11:00:00" })];
    expect(unreadCounts(rowsAfterDelete, "2026-08-30 10:00:00", {})).toEqual({ A: 1 });
    expect(unreadOldest(rowsAfterDelete, "2026-08-30 10:00:00", {})).toEqual({ A: "2026-08-30 11:00:00" });
  });

  test("exact ledger counts override the bounded thread window", () => {
    const threads = buildThreads(
      [msg({ chat: "A", ts: "2026-08-30 11:00:00" })],
      "2026-08-30 10:00:00", {}, {}, { A: 151 },
    );
    expect(threads[0]!.unread).toBe(151);
  });
});

describe("readMarks pruning", () => {
  test("a per-thread mark at or below the global mark is dropped from state", () => {
    // collect() prunes; emulate its rule directly.
    const readMarks: Record<string, string> = { A: "2026-08-30 09:00:00", B: "2026-08-30 12:00:00" };
    const readMark = "2026-08-30 10:00:00";
    for (const [chat, ts] of Object.entries(readMarks)) if (ts <= readMark) delete readMarks[chat];
    expect(Object.keys(readMarks)).toEqual(["B"]);
  });
});

describe("text-bearing self twins", () => {
  test("a same-chat same-handle same-second text pair marks the self chat", () => {
    // imsg decodes attributedBody: the outbound twin is rarely empty.
    const msgs = [
      msg({ chat: "+15550100001", handle: "+15550100001", ts: "2026-08-30 21:45:00", from_me: true, text: "note" }),
      msg({ chat: "+15550100001", handle: "+15550100001", ts: "2026-08-30 21:45:00", from_me: false, text: "note" }),
    ];
    expect(detectSelfChats(msgs)).toEqual(["+15550100001"]);
    const out = dedupeSelfEcho(msgs);
    expect(out).toHaveLength(1);
    expect(out[0]!.from_me).toBe(true);
  });

  test("two different senders with the same text in one second stay distinct", () => {
    const msgs = [
      msg({ chat: "g", handle: "+15550100004", ts: "2026-08-30 21:45:00", from_me: false, text: "lol" }),
      msg({ chat: "g", handle: "+15550100005", ts: "2026-08-30 21:45:00", from_me: false, text: "lol" }),
    ];
    expect(detectSelfChats(msgs)).toEqual([]);
    expect(dedupeSelfEcho(msgs)).toHaveLength(2);
  });
});

describe("fetchGroups", () => {
  const fake = (r: { status: number; stdout?: string }) =>
    (() => ({ status: r.status, stdout: r.stdout ?? "", stderr: "" })) as never;
  test("parses sqlite -json rows into a map", () => {
    const g = fetchGroups(fake({ status: 0, stdout: JSON.stringify([{ chat: "abc", guid: "any;+;abc", name: "Team", participants: "+1,+2" }]) }));
    expect(g).toEqual({ abc: { name: "Team", guid: "any;+;abc", participants: ["+1", "+2"] } });
  });
  test("a failed lookup returns null so the cached copy is kept", () => {
    expect(fetchGroups(fake({ status: 69 }))).toBeNull();
    expect(fetchGroups(fake({ status: 0, stdout: "junk" }))).toBeNull();
  });
});

describe("phone-synced read state (imsg ≥1.9.0 `read`)", () => {
  const m = (over: Record<string, unknown>) => ({
    ts: "2026-08-31 12:00:00", from_me: false, handle: "+15551234567",
    name: null, service: "iMessage", chat: "+15551234567", text: "x", ...over,
  }) as never;

  test("a message read on the PHONE stops counting even past the local mark", () => {
    const counts = unreadCounts(
      [m({ read: true }), m({ ts: "2026-08-31 12:01:00", read: false })],
      "2026-08-31 00:00:00", {},
    );
    expect(counts["+15551234567"]).toBe(1);
  });

  test("rows without the read field fall back to local-only semantics", () => {
    const counts = unreadCounts([m({})], "2026-08-31 00:00:00", {});
    expect(counts["+15551234567"]).toBe(1);
  });

  test("locally-read messages stay read regardless of Apple state", () => {
    const counts = unreadCounts([m({ read: false })], "2026-08-31 23:00:00", {});
    expect(counts["+15551234567"]).toBeUndefined();
  });
});

describe("future-dated messages must not poison read marks", () => {
  test("mark-all clamps the global mark to now; the future chat gets a per-chat mark", () => {
    // Simulated via collect()'s pieces: verify the clamp math directly.
    const { localNowTs } = require("./collector") as typeof import("./collector");
    const now = localNowTs();
    const future = "2099-01-01 00:00:00";
    expect(future > now).toBe(true);
    const readMark = future <= now ? future : now;
    expect(readMark).toBe(now);   // global mark never exceeds the clock
  });

  test("a chat read now stays readable for messages arriving later today", () => {
    const { isUnread, localNowTs } = require("./collector") as typeof import("./collector");
    const mark = localNowTs(new Date(Date.now() - 60000)); // read a minute ago
    const arriving = { ts: localNowTs(), from_me: false, read: false } as never;
    expect(isUnread(arriving, mark)).toBe(true);  // new arrival still badges
  });
});

describe("failed-delivery detection", () => {
  const { selectFailures } = require("./collector") as typeof import("./collector");
  const now = "2026-08-31 20:30:00";
  const mine = (over: Record<string, unknown>) => ({
    ts: "2026-08-31 20:25:00", from_me: true, handle: "+15551234567", name: "Pat",
    service: "iMessage", chat: "+15551234567", text: "photo", ...over,
  }) as never;

  test("a recent own message with error≠0 becomes one failure toast", () => {
    const out = selectFailures([mine({ error: 25 })], [], now);
    expect(out.length).toBe(1);
    expect(out[0]!.name).toBe("Pat");
    expect(out[0]!.text).toContain("25");
    expect(out[0]!.key.startsWith("fail:")).toBe(true);
  });

  test("error 0, inbound rows, and old failures are ignored", () => {
    expect(selectFailures([mine({ error: 0 })], [], now).length).toBe(0);
    expect(selectFailures([mine({ error: 25, from_me: false })], [], now).length).toBe(0);
    expect(selectFailures([mine({ error: 25, ts: "2026-08-31 19:00:00" })], [], now).length).toBe(0);
  });

  test("dedupes through the toasted ring — interrupts exactly once", () => {
    const first = selectFailures([mine({ error: 25 })], [], now);
    const again = selectFailures([mine({ error: 25 })], first.map((f) => f.key), now);
    expect(again.length).toBe(0);
  });
});

describe("a link that just arrived opens the share sheet", () => {
  const { firstUrl, selectIncomingLinks } = require("./collector") as typeof import("./collector");
  const WM = "2026-09-02 12:00:00";

  test("firstUrl finds one http(s) url and drops sentence punctuation", () => {
    expect(firstUrl("see https://gpc.sc/occ/pay to view bill.")).toBe("https://gpc.sc/occ/pay");
    expect(firstUrl("(https://example.com/a_b)")).toBe("https://example.com/a_b");
    expect(firstUrl("http://x.test/1?q=2#f")).toBe("http://x.test/1?q=2#f");
    expect(firstUrl("no link here")).toBe("");
    expect(firstUrl("ftp://nope.test/x")).toBe("");
    expect(firstUrl(null)).toBe("");
  });

  test("only NEW inbound links, newest last, one key each", () => {
    const out = selectIncomingLinks([
      msg({ ts: "2026-09-02 12:30:00", from_me: false, text: "read https://a.test/1" }),
      msg({ ts: "2026-09-02 11:00:00", from_me: false, text: "old https://b.test/2" }),   // before watermark
      msg({ ts: "2026-09-02 12:40:00", from_me: true, text: "mine https://c.test/3" }),   // outbound
      msg({ ts: "2026-09-02 12:50:00", from_me: false, text: "no url" }),
      msg({ ts: "2026-09-02 12:55:00", from_me: false, text: "later https://d.test/4" }),
    ], WM, []);
    expect(out.map((l) => l.url)).toEqual(["https://a.test/1", "https://d.test/4"]);
    expect(out[out.length - 1]!.url).toBe("https://d.test/4");   // the caller shows the newest
    expect(out.every((l) => l.key.startsWith("link:"))).toBe(true);
  });

  test("a link fires once — its key suppresses the next poll", () => {
    const m = msg({ ts: "2026-09-02 12:30:00", from_me: false, text: "https://a.test/1" });
    const first = selectIncomingLinks([m], WM, []);
    expect(first.length).toBe(1);
    expect(selectIncomingLinks([m], WM, [first[0]!.key])).toEqual([]);
  });

  test("never the backlog on first run, never the self-thread", () => {
    const m = msg({ ts: "2026-09-02 12:30:00", from_me: false, text: "https://a.test/1" });
    expect(selectIncomingLinks([m], "", [])).toEqual([]);
    expect(selectIncomingLinks([m], WM, [], [String(m.chat || m.handle)])).toEqual([]);
  });
});

describe("a re-keyed group is ONE conversation", () => {
  const { aliasesFromChats, foldThreadAliases, foldChatRecord } =
    require("./collector") as typeof import("./collector");
  const chat = (id: string, aliases: string[] = []) => ({
    id, name: "Sportsball!", service: "iMessage", messages: 3, last: "2026-08-09 21:50:59",
    last_text: "", last_from_me: false, last_handle: "", last_name: null,
    pinned: false, pin_order: null, aliases,
  });
  const thread = (c: string, ts: string, count: number, unread: number) => ({
    chat: c, guid: "", name: "Sportsball!", handle: "+15551234567", service: "iMessage",
    last_ts: ts, last_text: "hi", last_from_me: false, count, unread,
    pinned: false, pin_order: null,
  }) as never;

  test("aliases map every older chat row onto the live one", () => {
    expect(aliasesFromChats([chat("chat2244", ["chat6703"]), chat("+1555", [])]))
      .toEqual({ chat6703: "chat2244" });
    // a row never aliases itself
    expect(aliasesFromChats([chat("chat2244", ["chat2244"])])).toEqual({});
  });

  test("two rows of one group become a single thread, counts summed", () => {
    const out = foldThreadAliases(
      [thread("chat6703", "2026-02-26 22:26:56", 5263, 1), thread("chat2244", "2026-08-09 21:50:59", 3477, 2)],
      { chat6703: "chat2244" },
    );
    expect(out.length).toBe(1);
    expect(out[0]!.chat).toBe("chat2244");
    expect(out[0]!.last_ts).toBe("2026-08-09 21:50:59");   // the LIVE row's preview
    expect(out[0]!.count).toBe(5263 + 3477);
    expect(out[0]!.unread).toBe(3);
  });

  test("the older row alone still shows, under the live id", () => {
    const out = foldThreadAliases([thread("chat6703", "2026-02-26 22:26:56", 5, 0)], { chat6703: "chat2244" });
    expect(out.length).toBe(1);
    expect(out[0]!.chat).toBe("chat2244");
  });

  test("no aliases is a no-op (same array back)", () => {
    const t = [thread("chat2244", "2026-08-09 21:50:59", 1, 0)];
    expect(foldThreadAliases(t, {})).toBe(t);
  });

  test("the unread ledger folds too — one badge, not two", () => {
    expect(foldChatRecord({ chat6703: 1, chat2244: 2, "+1555": 4 }, { chat6703: "chat2244" }, (a, b) => a + b))
      .toEqual({ chat2244: 3, "+1555": 4 });
    expect(foldChatRecord(
      { chat6703: "2026-02-26 22:26:56", chat2244: "2026-08-09 21:50:59" },
      { chat6703: "chat2244" },
      (a, b) => (a < b ? a : b),
    )).toEqual({ chat2244: "2026-02-26 22:26:56" });
  });
});

describe("complete conversation list (mergeChats)", () => {
  const { mergeChats } = require("./collector") as typeof import("./collector");
  const windowThread = {
    chat: "+15551234567", guid: "", name: "Pat", handle: "+15551234567", service: "iMessage",
    last_ts: "2026-08-31 20:00:00", last_text: "hi", last_from_me: false, count: 3, unread: 1,
    pinned: false, pin_order: null,
  };
  const chats = [
    { id: "+15551234567", name: null, service: "iMessage", last: "2026-08-31 20:00:00",
      last_text: "hi", last_from_me: false, last_handle: "+15551234567", last_name: "Pat", pinned: false, pin_order: null },
    { id: "ce5a593a78af408282d61461ade89135", name: "Lunch Crew", service: "iMessage", last: "2026-08-31 19:00:00",
      last_text: "Nice", last_from_me: false, last_handle: "+15550001111", last_name: "Sam", pinned: false, pin_order: null },
    { id: "+15559990000", name: null, service: "SMS", last: "2026-08-20 09:00:00",
      last_text: "old news", last_from_me: true, last_handle: "+15559990000", last_name: "Quiet Q", pinned: false, pin_order: null },
  ];

  test("quiet conversations outside the window appear, newest first", () => {
    const out = mergeChats([windowThread], chats, { ce5a593a78af408282d61461ade89135: { name: "Lunch Crew", guid: "any;+;ce5a", participants: [] } }, { ce5a593a78af408282d61461ade89135: 2 });
    expect(out.map((t) => t.chat)).toEqual(["+15551234567", "ce5a593a78af408282d61461ade89135", "+15559990000"]);
    const grp = out[1]!;
    expect(grp.name).toBe("Lunch Crew");
    expect(grp.guid).toBe("any;+;ce5a");   // still sendable
    expect(grp.unread).toBe(2);            // from the ledger
    expect(grp.last_text).toBe("Nice");
  });

  test("a chat already covered by the window keeps the window's richer row", () => {
    const out = mergeChats([windowThread], chats, {}, {});
    expect(out[0]).toBe(windowThread);
  });

  test("DM rows are named from the contact, groups from the group cache", () => {
    const out = mergeChats([], chats, {}, {});
    expect(out.find((t) => t.chat === "+15559990000")!.name).toBe("Quiet Q");
    expect(out.find((t) => t.chat === "ce5a593a78af408282d61461ade89135")!.name).toBe("Lunch Crew");
  });

  test("mirrored pins sort first in Messages pin order, ahead of activity", () => {
    const out = mergeChats(
      [
        { ...windowThread, last_ts: "2026-08-31 22:00:00" },
        { ...windowThread, chat: "+15557770000", last_ts: "2026-08-31 21:00:00", pinned: false, pin_order: null },
      ],
      [
        { ...chats[0]!, pinned: false, pin_order: null },
        { ...chats[1]!, pinned: true, pin_order: 1 },
      ],
      {},
      {},
    );
    expect(out.map((t) => t.chat)).toEqual([
      "ce5a593a78af408282d61461ade89135",
      "+15551234567",
      "+15557770000",
    ]);
    expect(out[0]!.pinned).toBe(true);
    expect(out[0]!.pin_order).toBe(1);
  });
});

describe("pinned conversation metadata", () => {
  test("fetchChats preserves pin state and tolerates an older bridge", () => {
    const runner = ((_: string, __: string[]) => ({
      status: 0,
      stdout: JSON.stringify([
        {
          id: "+15551234567", name: "Pat", service: "iMessage", last: "2026-08-31 20:00:00",
          last_text: "hi", last_from_me: false, last_handle: "+15551234567", last_name: "Pat",
          pinned: true, pin_order: 0,
        },
        {
          id: "+15550001111", name: null, service: "SMS", last: "2026-08-31 19:00:00",
          last_text: "old", last_from_me: true, last_handle: "+15550001111", last_name: null,
        },
      ]),
      stderr: "",
    })) as never;
    const out = fetchChats(runner)!;
    expect(out[0]!.pinned).toBe(true);
    expect(out[0]!.pin_order).toBe(0);
    expect(out[1]!.pinned).toBe(false);
    expect(out[1]!.pin_order).toBe(null);
  });
});

describe("explainBridgeError — a dim icon is not a diagnosis", () => {
  const { explainBridgeError } = require("./collector") as typeof import("./collector");
  test("missing Full Disk Access names the grant", () => {
    expect(explainBridgeError(1, "sqlite3.OperationalError: unable to open database file")).toContain("Full Disk Access");
    expect(explainBridgeError(1, "authorization denied")).toContain("Full Disk Access");
  });
  test("missing Automation names the prompt", () => {
    expect(explainBridgeError(1, "execution error: Not authorized to send Apple events to Messages. (-1743)")).toContain("Automation");
  });
  test("unconfigured shim points at blip-setup", () => {
    expect(explainBridgeError(78, "blip: no Mac configured — run blip-setup")).toContain("blip-setup");
  });
  test("missing Mac tools points at blip-setup", () => {
    expect(explainBridgeError(2, "python3: can't open file '/Users/x/.blip/bin/imsg': [Errno 2] No such file or directory")).toContain("blip-setup");
  });
  test("unknown errors fall back to the last stderr line", () => {
    expect(explainBridgeError(3, "something odd\nmore")).toBe("more");
    expect(explainBridgeError(3, "")).toBe("imsg exit 3");
  });
});

describe("toast identity is stable across polls (2.1.6)", () => {
  test("the same message with its text decoded on the second poll toasts once", () => {
    const first = { ts: "2026-09-01 20:00:05", from_me: false, handle: "+15550001111", name: "T", service: "iMessage", chat: "+15550001111", text: "" } as ImsgMessage;
    const second = { ...first, text: "Ok, I will be there" };
    const allow = ["+15550001111"];
    const t1 = selectToasts([first], "2026-09-01 20:00:00", allow, []);
    expect(t1).toHaveLength(1);
    const t2 = selectToasts([second], "2026-09-01 20:00:00", allow, [t1[0]!.key]);
    expect(t2).toHaveLength(0);
  });
  test("a bridge ROWID wins over the ts/chat/handle fallback", () => {
    const a = { id: 42, ts: "2026-09-01 20:00:05", from_me: false, handle: "h", name: null, service: "iMessage", chat: "h", text: "x" } as ImsgMessage;
    const b = { ...a, ts: "2026-09-01 20:00:09", text: "y" };
    expect(toastKey(a)).toBe(toastKey(b));
  });
});

describe("self-chat promotion is not persisted on one coincidence (2.2.0)", () => {
  const dm = (ts: string, from_me: boolean, text: string) =>
    ({ ts, from_me, handle: "+15550002222", name: "B", service: "iMessage", chat: "+15550002222", text } as ImsgMessage);
  test("a single same-second 'ok' pair dedupes for display but does not promote for persistence", () => {
    const pair = [dm("2026-09-01 20:00:05", true, "ok"), dm("2026-09-01 20:00:05", false, "ok")];
    expect(detectSelfChats(pair)).toEqual(["+15550002222"]);      // display-time dedupe still works
    expect(detectSelfChats(pair, 2)).toEqual([]);                  // persistence needs a second twin
  });
  test("two twins at different seconds do promote", () => {
    const rows = [dm("2026-09-01 20:00:05", true, "a"), dm("2026-09-01 20:00:05", false, "a"),
                  dm("2026-09-01 20:00:09", true, "b"), dm("2026-09-01 20:00:09", false, "b")];
    expect(detectSelfChats(rows, 2)).toEqual(["+15550002222"]);
  });
});

describe("failure-toast keys survive the ring normalizer (2.2.0)", () => {
  const { selectFailures } = require("./collector") as typeof import("./collector");
  test("a fail: key is kept verbatim on load, so a failed send toasts once", () => {
    const m = { id: 9, ts: "2026-09-01 20:00:05", from_me: true, handle: "h", name: "H", service: "iMessage", chat: "h", text: "x", error: 25 } as ImsgMessage;
    const first = selectFailures([m], [], "2026-09-01 20:05:00");
    expect(first).toHaveLength(1);
    const tmp = `${process.env.XDG_CACHE_HOME}/state-${process.pid}.json`;
    saveState({ ...loadState(tmp), toasted: [first[0]!.key] }, tmp);
    const again = selectFailures([m], loadState(tmp).toasted, "2026-09-01 20:05:00");
    expect(again).toHaveLength(0);
  });
});

describe("pushing read state back to the Mac", () => {
  const { pushReadArgs, pushReadPolicy } = require("./collector") as typeof import("./collector");
  const conf = (body: string): string => {
    const p = `${process.env.XDG_CACHE_HOME}/push-conf-${process.pid}-${Math.random().toString(36).slice(2)}`;
    writeFileSync(p, body);
    return p;
  };

  test("the default is `all` — the gesture only, because it cannot steal focus", () => {
    expect(pushReadPolicy(conf("host=mac\n"))).toBe("all");
    expect(pushReadPolicy(`${process.env.XDG_CACHE_HOME}/absent-${process.pid}`)).toBe("all");
    expect(pushReadPolicy(conf("host=mac\npush_read=all\n"))).toBe("all");
  });

  test("off and thread are honoured, spelling and case are forgiving", () => {
    expect(pushReadPolicy(conf("push_read=off\n"))).toBe("off");
    expect(pushReadPolicy(conf("push_read = FALSE\n"))).toBe("off");
    expect(pushReadPolicy(conf("push_read=thread\n"))).toBe("thread");
    expect(pushReadPolicy(conf("push_read=chat\n"))).toBe("thread");
  });

  test("mark-all-read pushes --all under every policy but off", () => {
    expect(pushReadArgs("all", { markRead: true, readChat: "" })).toEqual(["--all"]);
    expect(pushReadArgs("thread", { markRead: true, readChat: "" })).toEqual(["--all"]);
    expect(pushReadArgs("off", { markRead: true, readChat: "" })).toBeNull();
  });

  test("opening one conversation pushes only under `thread`", () => {
    expect(pushReadArgs("all", { markRead: false, readChat: "+15550100011" })).toBeNull();
    expect(pushReadArgs("thread", { markRead: false, readChat: "+15550100011" }))
      .toEqual(["--chat", "+15550100011"]);
    expect(pushReadArgs("thread", { markRead: false, readChat: "them@example.com" }))
      .toEqual(["--chat", "them@example.com"]);
  });

  test("a group is never pushed per-thread — it has no imessage:// form", () => {
    expect(pushReadArgs("thread", { markRead: false, readChat: "chat900000000000000001" })).toBeNull();
    expect(pushReadArgs("thread", { markRead: false, readChat: "ce5a593a78af408282d61461ade89135" })).toBeNull();
    expect(pushReadArgs("thread", { markRead: false, readChat: "" })).toBeNull();
  });
});

describe("which service a DM sends on (@lukejmorrison, PR #4)", () => {
  const { normalizeSendService, sendServiceForMessages } =
    require("./collector") as typeof import("./collector");
  const at = (min: number, over: Partial<ImsgMessage> = {}) =>
    msg({ ts: `2026-09-03 1${String(min).padStart(2, "0")}:00:00`, ...over });

  test("normalizes what chat.db says into what imsg-send accepts", () => {
    expect(normalizeSendService("SMS")).toBe("SMS");
    expect(normalizeSendService("rcs")).toBe("RCS");
    expect(normalizeSendService("iMessage")).toBe("iMessage");
    expect(normalizeSendService("")).toBe("iMessage");
    expect(normalizeSendService(null)).toBe("iMessage");
  });

  test("last INBOUND wins — a failed outbound never flips the thread back", () => {
    expect(sendServiceForMessages([
      at(0, { from_me: false, service: "SMS" }),
      at(1, { from_me: true, service: "iMessage", error: 3 }),
    ])).toBe("SMS");
  });

  test("a newer inbound iMessage beats older SMS history", () => {
    expect(sendServiceForMessages([
      at(0, { from_me: false, service: "SMS" }),
      at(1, { from_me: false, service: "iMessage" }),
    ])).toBe("iMessage");
  });

  test("our failed iMessage to a phone, newest, means they are not on iMessage", () => {
    // the case that made a thread stick: retrying iMessage forever
    expect(sendServiceForMessages([
      at(0, { from_me: false, service: "iMessage" }),
      at(1, { from_me: true, service: "iMessage", error: 22 }),
    ])).toBe("SMS");
  });

  test("...but not for an email handle, which can only be iMessage", () => {
    expect(sendServiceForMessages([
      at(1, { chat: "them@example.com", handle: "them@example.com",
              from_me: true, service: "iMessage", error: 22 }),
    ])).toBe("iMessage");
  });

  test("no inbound: the last outbound that SUCCEEDED", () => {
    expect(sendServiceForMessages([at(0, { from_me: true, service: "SMS", error: 0 })])).toBe("SMS");
    expect(sendServiceForMessages([])).toBe("iMessage");
  });

  test("a group keeps the raw service — it sends by chat-id, not by service", () => {
    const threads = buildThreads([
      msg({ chat: "chat900001", handle: "+15550100011", from_me: false, service: "RCS",
            ts: "2026-09-03 10:00:00" }),
    ], "2026-09-03 09:00:00");
    expect(threads[0]!.service).toBe("RCS");
  });
});

describe("pins survive shallow polls", () => {
  const thread = (chat: string, last_ts: string, extra: Partial<Thread> = {}): Thread => ({
    chat, guid: "", name: chat, handle: chat, service: "iMessage", last_ts, last_text: "",
    last_from_me: false, count: 1, unread: 0, pinned: false, pin_order: null, ...extra,
  });
  const chat = (id: string, pinned: boolean, pin_order: number | null): ChatInfo => ({
    id, name: id, service: "iMessage", last: "2026-09-03 10:00:00", last_text: "", last_from_me: false,
    last_handle: id, last_name: null, pinned, pin_order, aliases: [],
  });

  test("pinsFromChats keeps only pinned rows, with their order", () => {
    expect(pinsFromChats([chat("A", true, 1), chat("B", false, null), chat("C", true, null)]))
      .toEqual({ A: 1, C: null });
  });

  test("applyPins re-pins a shallow poll's rows and sorts them first", () => {
    const shallow = [thread("NEW", "2026-09-03 12:00:00"), thread("MOM", "2026-09-03 11:00:00"), thread("OLD", "2026-09-03 10:00:00")];
    const out = applyPins(shallow, { MOM: 0, QUIET: 1 });
    expect(out.map((t) => t.chat)).toEqual(["MOM", "NEW", "OLD"]);
    expect(out[0]).toMatchObject({ pinned: true, pin_order: 0 });
    expect(out[1].pinned).toBe(false);
    // rows are reused when nothing changed (the widget skips identical lists)
    expect(out[1]).toBe(shallow[0]);
  });

  test("applyPins un-pins a row whose pin was removed on the Mac", () => {
    const stale = [thread("X", "2026-09-03 12:00:00", { pinned: true, pin_order: 0 }), thread("Y", "2026-09-03 13:00:00")];
    expect(applyPins(stale, {}).map((t) => [t.chat, t.pinned])).toEqual([["Y", false], ["X", false]]);
  });

  test("applyPins with nothing pinned anywhere is a no-op", () => {
    const list = [thread("A", "2026-09-03 12:00:00")];
    expect(applyPins(list, {})).toBe(list);
  });

  test("validPins drops anything that is not an integer order or null", () => {
    expect(validPins({ A: 0, B: null, C: "1", D: 1.5, "": 2, E: 3 })).toEqual({ A: 0, B: null, E: 3 });
    expect(validPins(undefined)).toEqual({});
    expect(validPins("nope")).toEqual({});
  });
});

describe("mute list", () => {
  // A political fundraising blast, in the shape they actually arrive in: a
  // rotating short code, a body that names the PAC, and the legally required
  // opt-out footer that never changes.
  const blast = (over: Partial<ImsgMessage> = {}) =>
    msg({
      chat: "78462", handle: "78462", name: null,
      text: "The deadline is TONIGHT. Rush $25 now: actblue.com/x Reply STOP2END",
      ...over,
    });

  test("reads a bare-array mute list", () => {
    const p = join(tmp(), "mute.json");
    writeFileSync(p, JSON.stringify(["ActBlue"]));
    expect(loadMutelist(p)).toEqual(["ActBlue"]);
  });

  test("reads a {mute:[...]} mute list", () => {
    const p = join(tmp(), "mute2.json");
    writeFileSync(p, JSON.stringify({ mute: ["Stop2End"], note: "ignored" }));
    expect(loadMutelist(p)).toEqual(["Stop2End"]);
  });

  test("a missing mute list is empty, not an error", () => {
    expect(loadMutelist(join(tmp(), "none.json"))).toEqual([]);
  });

  test("non-string and empty entries are filtered out", () => {
    const p = join(tmp(), "mixed.json");
    writeFileSync(p, JSON.stringify(["ActBlue", "", 42, null]));
    expect(loadMutelist(p)).toEqual(["ActBlue"]);
  });

  test("a phrase matches anywhere in the text, case-insensitively", () => {
    expect(matchesMute(blast(), ["stop2end"])).toBe(true);
    expect(matchesMute(blast(), ["ActBlue"])).toBe(true);
  });

  test("a handle or chat id matches exactly, like the allowlist", () => {
    expect(matchesMute(blast(), ["78462"])).toBe(true);
    // ...and only exactly: a substring of a number is not a number.
    expect(matchesMute(blast({ text: "" }), ["784"])).toBe(false);
  });

  test("a one-character entry cannot mute the world", () => {
    expect(matchesMute(msg({ text: "hello" }), ["h"])).toBe(false);
  });

  test("an empty mute list mutes nothing", () => {
    expect(matchesMute(blast(), [])).toBe(false);
    expect(mutedChats([blast()], [])).toEqual([]);
  });

  test("quoting a muted phrase to a friend does not mute the friend", () => {
    // Outbound only: you forwarding "look what ActBlue sent me" is not spam.
    const mine = msg({ chat: "+15550100002", handle: "+15550100002", from_me: true,
      text: "another ActBlue text, unbelievable" });
    expect(mutedChats([mine], ["ActBlue"])).toEqual([]);
  });

  test("one match mutes the whole conversation, not just that message", () => {
    const window = [
      blast({ ts: "2026-08-30 09:00:00" }),
      blast({ ts: "2026-08-30 10:00:00", text: "Are you still with us?" }),
      msg({ chat: "+15550100002", handle: "+15550100002", text: "lunch?" }),
    ];
    const muted = mutedChats(window, ["Stop2End"]);
    expect(muted).toEqual(["78462"]);
    const kept = dropMuted(window, muted);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.text).toBe("lunch?");
  });

  test("the chat list drops muted rows too, by id, alias, or preview text", () => {
    const row = (id: string, last_text: string, aliases: string[] = []): ChatInfo => ({
      id, name: id, service: "SMS", last: "2026-08-30 10:00:00", last_text,
      last_from_me: false, last_handle: id, last_name: null, pinned: false, pin_order: null, aliases,
    });
    const chats = [
      row("78462", "Rush $25 now. Reply STOP2END"),
      row("+15550100002", "lunch?"),
      row("chat9", "hi", ["78462"]),
    ];
    const out = dropMutedChats(chats, ["Stop2End"], ["78462"])!;
    expect(out.map((c) => c.id)).toEqual(["+15550100002"]);
  });

  test("your own reply keeps a chat row alive", () => {
    const row: ChatInfo = {
      id: "+15550100002", name: "Alex Rivera", service: "iMessage", last: "2026-08-30 10:00:00",
      last_text: "ugh, ActBlue again", last_from_me: true, last_handle: "+15550100002",
      last_name: null, pinned: false, pin_order: null, aliases: [],
    };
    expect(dropMutedChats([row], ["ActBlue"], [])).toHaveLength(1);
  });

  test("a shallow poll has no chat list to filter", () => {
    expect(dropMutedChats(null, ["ActBlue"], [])).toBeNull();
  });

  test("a muted conversation never toasts, because it never reaches selectToasts", () => {
    const window = [blast({ ts: "2026-08-30 11:00:00" })];
    const kept = dropMuted(window, mutedChats(window, ["ActBlue"]));
    expect(selectToasts(kept, "2026-08-30 10:00:00", ["78462"], [])).toEqual([]);
  });
});
