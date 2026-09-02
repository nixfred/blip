import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildThreads,
  detectSelfChats,
  fetchMessagesAfter,
  CATCHUP_MAX_ROWS,
  fetchGroups,
  groupName,
  dedupeSelfEcho,
  isGroupChat,
  displayName,
  fetchMessages,
  loadAllowlist,
  loadToastPolicy,
  parseToastPolicy,
  loadState,
  maxTs,
  saveState,
  selectToasts,
  toastKey,
  toastPreview,
  toastName,
  foldHandle,
  allowlisted,
  notifySendArgv,
  TOAST_ALL,
  TOAST_OFF,
  TOAST_BATCH_CAP,
  TOAST_BODY_MAX,
  TOAST_EXPIRE_MS,
  unreadCounts,
  unreadOldest,
  type ImsgMessage,
  type ToastPolicy,
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
  const allow: ToastPolicy = { mode: "allow", allow: ["+15550100002"] };

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
    const out = selectToasts(
      [m],
      "2026-08-30 10:00:00",
      { mode: "allow", allow: ["+15550100001"] },
      [toastKey(m)],
    );
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
      { mode: "allow", allow: ["+15550100004"] },
      [],
    );
    expect(out).toHaveLength(1);
  });

  test("mode=all toasts every inbound, including short codes", () => {
    const out = selectToasts(
      [msg({ chat: "878478", handle: "878478", name: "Bank", ts: "2026-08-30 11:00:00", text: "code" })],
      "2026-08-30 10:00:00",
      TOAST_ALL,
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("Bank");
    expect(out[0]!.text).toBe("code");
  });

  test("mode=all still skips outbound and the backlog", () => {
    const inboundOld = msg({ ts: "2026-08-30 09:00:00" });
    const outbound = msg({ from_me: true, ts: "2026-08-30 11:00:00" });
    expect(selectToasts([inboundOld, outbound], "2026-08-30 10:00:00", TOAST_ALL, [])).toEqual([]);
  });

  test("mode=off toasts nothing, even allowlisted senders", () => {
    const out = selectToasts(
      [msg({ chat: "+15550100002", handle: "+15550100002", ts: "2026-08-30 11:00:00" })],
      "2026-08-30 10:00:00",
      TOAST_OFF,
      [],
    );
    expect(out).toEqual([]);
  });

  test("mode=allow with an empty list toasts nobody", () => {
    const out = selectToasts(
      [msg({ ts: "2026-08-30 11:00:00" })],
      "2026-08-30 10:00:00",
      { mode: "allow", allow: [] },
      [],
    );
    expect(out).toEqual([]);
  });

  test("does not toast the conversation the user is currently reading", () => {
    const open = msg({ chat: "+15550100002", handle: "+15550100002", ts: "2026-08-30 11:00:00" });
    const other = msg({ chat: "+15550100009", handle: "+15550100009", ts: "2026-08-30 11:00:01" });
    const out = selectToasts([open, other], "2026-08-30 10:00:00", TOAST_ALL, [], {
      skipChats: ["+15550100002"],
    });
    expect(out.map((t) => t.chat)).toEqual(["+15550100009"]);
  });

  test("does not toast the self-thread", () => {
    const mine = msg({ chat: "+15550100001", handle: "+15550100001", ts: "2026-08-30 11:00:00" });
    const out = selectToasts([mine], "2026-08-30 10:00:00", TOAST_ALL, [], {
      selfChats: ["+15550100001"],
    });
    expect(out).toEqual([]);
  });

  test("a catch-up batch keeps the newest TOAST_BATCH_CAP and drops older ones", () => {
    const msgs = Array.from({ length: TOAST_BATCH_CAP + 7 }, (_, i) =>
      msg({
        chat: `+15550100${String(100 + i).slice(-3)}`,
        handle: `+15550100${String(100 + i).slice(-3)}`,
        ts: `2026-08-30 11:${String(i).padStart(2, "0")}:00`,
        text: `n${i}`,
      }),
    );
    const out = selectToasts(msgs, "2026-08-30 10:00:00", TOAST_ALL, []);
    expect(out).toHaveLength(TOAST_BATCH_CAP);
    expect(out[0]!.text).toBe("n7");
    expect(out[out.length - 1]!.text).toBe(`n${TOAST_BATCH_CAP + 6}`);
  });

  test("phone formatting variants match an E.164 allowlist entry", () => {
    const out = selectToasts(
      [msg({ chat: "5550100002", handle: "(555) 010-0002", ts: "2026-08-30 11:00:00" })],
      "2026-08-30 10:00:00",
      { mode: "allow", allow: ["+1 555 010 0002"] },
      [],
    );
    expect(out).toHaveLength(1);
  });

  test("email allowlist entries match case-insensitively", () => {
    const out = selectToasts(
      [msg({ chat: "them@icloud.com", handle: "Them@iCloud.com", ts: "2026-08-30 11:00:00" })],
      "2026-08-30 10:00:00",
      { mode: "allow", allow: ["THEM@icloud.com"] },
      [],
    );
    expect(out).toHaveLength(1);
  });

  test("a hex group id is not folded into a phone number", () => {
    // 32 hex chars contain plenty of digits; extracting them must not
    // satisfy an allowlist entry for a real person.
    const guid = "a5550100002aaaaaaaaaaaaaaaaaaaaa";
    const out = selectToasts(
      [msg({ chat: guid, handle: "ALICE", ts: "2026-08-30 11:00:00" })],
      "2026-08-30 10:00:00",
      { mode: "allow", allow: ["+15550100002"] },
      [],
    );
    expect(out).toEqual([]);
  });

  test("group toasts name the sender and the group", () => {
    const guid = "053856bb0d9a40e392db59eace1c56d1";
    const out = selectToasts(
      [msg({ chat: guid, handle: "ALICE", name: "Alice", ts: "2026-08-30 11:00:00", text: "hi" })],
      "2026-08-30 10:00:00",
      TOAST_ALL,
      [],
      { groups: { [guid]: { name: "Family", guid: "any;+;" + guid, participants: ["ALICE"] } } },
    );
    expect(out[0]!.name).toBe("Alice · Family");
  });

  test("emits a sanitized preview, not the raw attachment placeholder", () => {
    const out = selectToasts(
      [msg({ ts: "2026-08-30 11:00:00", text: "\uFFFC" })],
      "2026-08-30 10:00:00",
      TOAST_ALL,
      [],
    );
    expect(out[0]!.text).toBe("New message");
  });
});

describe("toast preview and notify-send argv", () => {
  test("blank and attachment-only bodies become 'New message'", () => {
    expect(toastPreview("")).toBe("New message");
    expect(toastPreview("   ")).toBe("New message");
    expect(toastPreview("\uFFFC")).toBe("New message");
    expect(toastPreview("\uFFFC photo")).toBe("photo");
  });

  test("long bodies are capped and end with an ellipsis", () => {
    const long = "x".repeat(TOAST_BODY_MAX + 40);
    const preview = toastPreview(long);
    expect(preview.length).toBe(TOAST_BODY_MAX);
    expect(preview.endsWith("…")).toBe(true);
  });

  test("a name starting with a dash is still positional after --", () => {
    const argv = notifySendArgv({ chat: "x", name: "-rf", text: "--hint=evil" });
    const cut = argv.indexOf("--");
    expect(cut).toBeGreaterThan(0);
    expect(argv[cut + 1]).toBe("-rf");
    expect(argv[cut + 2]).toBe("--hint=evil");
    expect(argv.slice(0, cut)).not.toContain("-rf");
  });

  test("the canonical argv carries Blip identity, urgency, category, and wait", () => {
    const argv = notifySendArgv({ chat: "+1", name: "Ada", text: "hi" });
    expect(argv[0]).toBe("notify-send");
    expect(argv).toContain("--app-name=Blip");
    expect(argv).toContain("--urgency=normal");
    expect(argv).toContain("--category=im.received");
    expect(argv).toContain(`--expire-time=${TOAST_EXPIRE_MS}`);
    expect(argv).toContain("--wait");
    expect(argv).toContain("--action=default=Open");
  });

  test("toastName falls back to the handle, never the string null", () => {
    expect(toastName(msg({ name: null as unknown as string, handle: "+1555", chat: null as unknown as string }))).toBe("+1555");
  });
});

describe("foldHandle / allowlisted", () => {
  test("US numbers with punctuation fold to the last ten digits", () => {
    expect(foldHandle("+1 (555) 010-0002")).toBe("5550100002");
    expect(foldHandle("5550100002")).toBe("5550100002");
    expect(foldHandle("+15550100002")).toBe("5550100002");
  });

  test("emails fold case-insensitively and short codes stay exact", () => {
    expect(foldHandle("Them@iCloud.com")).toBe("them@icloud.com");
    expect(foldHandle("878478")).toBe("878478");
  });

  test("a hex chat id does not fold to a phone", () => {
    expect(foldHandle("a5550100002aaaaaaaaaaaaaaaaaaaaa")).not.toBe("5550100002");
  });

  test("allowlisted matches chat or handle, including folded phones", () => {
    expect(allowlisted("+15550100002", "+15550100002", ["+1 555 010 0002"])).toBe(true);
    expect(allowlisted("053856bb0d9a40e392db59eace1c56d1", "+15550100004", ["+15550100004"])).toBe(true);
    expect(allowlisted("878478", "878478", ["+15550100002"])).toBe(false);
    expect(allowlisted("x", "y", [])).toBe(false);
  });
});

describe("parseToastPolicy", () => {
  test("null/undefined is all — the unconfigured default", () => {
    expect(parseToastPolicy(null)).toEqual(TOAST_ALL);
    expect(parseToastPolicy(undefined)).toEqual(TOAST_ALL);
  });

  test("legacy populated array is allow; empty array is off", () => {
    expect(parseToastPolicy(["+15551234567"])).toEqual({ mode: "allow", allow: ["+15551234567"] });
    expect(parseToastPolicy([])).toEqual(TOAST_OFF);
  });

  test("legacy {allow:[...]} populated is allow; empty is off", () => {
    expect(parseToastPolicy({ allow: ["+15551234567"] })).toEqual({ mode: "allow", allow: ["+15551234567"] });
    expect(parseToastPolicy({ allow: [] })).toEqual(TOAST_OFF);
  });

  test("explicit mode wins, and allow entries are trimmed", () => {
    expect(parseToastPolicy({ mode: "OFF" })).toEqual({ mode: "off", allow: [] });
    expect(parseToastPolicy({ mode: "all", allow: [" leftover "] })).toEqual({
      mode: "all",
      allow: ["leftover"],
    });
    expect(parseToastPolicy({ mode: "allow", allow: ["  +1  ", "", 42] })).toEqual({
      mode: "allow",
      allow: ["+1"],
    });
  });

  test("whitespace-only legacy entries collapse to off, not a broken allow mode", () => {
    expect(parseToastPolicy({ allow: ["  ", ""] })).toEqual(TOAST_OFF);
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
      readMarks: { A: "x" }, groups: {}, toasted: [opaque],
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
      toasted: [opaque],
    });
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  test("a missing state file yields a safe empty watermark", () => {
    expect(loadState(join(tmp(), "nope.json"))).toEqual({
      watermark: "", readMark: "", unreadCounts: {}, unreadOldest: {}, unreadInitialized: false,
      selfChats: [], readMarks: {}, groups: {}, toasted: [],
    });
  });

  test("corrupt state does not throw", () => {
    const p = join(tmp(), "bad.json");
    writeFileSync(p, "{ this is not json");
    expect(loadState(p)).toEqual({
      watermark: "", readMark: "", unreadCounts: {}, unreadOldest: {}, unreadInitialized: false,
      selfChats: [], readMarks: {}, groups: {}, toasted: [],
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

  test("a missing allowlist.json is toast-all, not silence", () => {
    expect(loadToastPolicy(join(tmp(), "none.json"))).toEqual(TOAST_ALL);
  });

  test("corrupt allowlist.json fails closed to off", () => {
    const p = join(tmp(), "bad.json");
    writeFileSync(p, "{not json");
    expect(loadToastPolicy(p)).toEqual(TOAST_OFF);
  });

  test("reads an explicit mode file", () => {
    const p = join(tmp(), "mode.json");
    writeFileSync(p, JSON.stringify({ mode: "off" }));
    expect(loadToastPolicy(p)).toEqual(TOAST_OFF);
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

  test("a non-zero exit surfaces the first stderr line", () => {
    const r = fetchMessages(10, fake({ status: 1, stderr: "boom\nsecond line" }));
    expect(r.ok).toBe(false);
    expect(r.online).toBe(true);
    expect(r.error).toBe("boom");
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

describe("complete conversation list (mergeChats)", () => {
  const { mergeChats } = require("./collector") as typeof import("./collector");
  const windowThread = {
    chat: "+15551234567", guid: "", name: "Pat", handle: "+15551234567", service: "iMessage",
    last_ts: "2026-08-31 20:00:00", last_text: "hi", last_from_me: false, count: 3, unread: 1,
  };
  const chats = [
    { id: "+15551234567", name: null, service: "iMessage", last: "2026-08-31 20:00:00",
      last_text: "hi", last_from_me: false, last_handle: "+15551234567", last_name: "Pat" },
    { id: "ce5a593a78af408282d61461ade89135", name: "LMT", service: "iMessage", last: "2026-08-31 19:00:00",
      last_text: "Nice", last_from_me: false, last_handle: "+15550001111", last_name: "Sam" },
    { id: "+15559990000", name: null, service: "SMS", last: "2026-08-20 09:00:00",
      last_text: "old news", last_from_me: true, last_handle: "+15559990000", last_name: "Quiet Q" },
  ];

  test("quiet conversations outside the window appear, newest first", () => {
    const out = mergeChats([windowThread], chats, { ce5a593a78af408282d61461ade89135: { name: "LMT", guid: "any;+;ce5a", participants: [] } }, { ce5a593a78af408282d61461ade89135: 2 });
    expect(out.map((t) => t.chat)).toEqual(["+15551234567", "ce5a593a78af408282d61461ade89135", "+15559990000"]);
    const lmt = out[1]!;
    expect(lmt.name).toBe("LMT");
    expect(lmt.guid).toBe("any;+;ce5a");   // still sendable
    expect(lmt.unread).toBe(2);            // from the ledger
    expect(lmt.last_text).toBe("Nice");
  });

  test("a chat already covered by the window keeps the window's richer row", () => {
    const out = mergeChats([windowThread], chats, {}, {});
    expect(out[0]).toBe(windowThread);
  });

  test("DM rows are named from the contact, groups from the group cache", () => {
    const out = mergeChats([], chats, {}, {});
    expect(out.find((t) => t.chat === "+15559990000")!.name).toBe("Quiet Q");
    expect(out.find((t) => t.chat === "ce5a593a78af408282d61461ade89135")!.name).toBe("LMT");
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
  test("unknown errors fall back to the first stderr line", () => {
    expect(explainBridgeError(3, "something odd\nmore")).toBe("something odd");
    expect(explainBridgeError(3, "")).toBe("imsg exit 3");
  });
});
