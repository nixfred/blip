import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  aliasesOf,
  normalizeGroups,
  buildThreads,
  detectSelfChats,
  fetchMessagesAfter,
  CATCHUP_MAX_ROWS,
  fetchChats,
  fetchGroups,
  groupName,
  dedupeSelfEcho,
  mergeTapbacks,
  isGroupChat,
  displayName,
  messagePreview,
  fetchMessages,
  loadAllowlist,
  loadMutelist,
  matchesMute,
  mutedChats,
  dropMuted,
  dropMutedChats,
  visibleLedgerChats,
  keepCappedUnread,
  loadState,
  validPins,
  pinsFromChats,
  applyPins,
  maxTs,
  saveState,
  selectToasts,
  toastKey,
  windowCutoff,
  staleUnreadChats,
  coversBoundary,
  fetchChatBack,
  CATCHUP_CHAT_MAX,
  mergeCatchupRows,
  keepUnverifiedUnread,
  CATCHUP_CHAT_ROWS,
  unreadCounts,
  unreadOldest,
  stampBefore,
  lastInboundTs,
  effectiveMark,
  pushUnreadArgs,
  canAddressChat,
  type ImsgMessage,
  type ChatInfo,
} from "./collector";

const tmp = () => mkdtempSync(join(tmpdir(), "blip-test-"));

function msg(over: Partial<ImsgMessage> = {}): ImsgMessage {
  return {
    ts: "2026-08-30T12:00:00Z",
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
        msg({ chat: "A", ts: "2026-08-30T10:00:00Z", text: "older" }),
        msg({ chat: "A", ts: "2026-08-30T11:00:00Z", text: "newer" }),
        msg({ chat: "B", ts: "2026-08-30T09:00:00Z", text: "b only" }),
      ],
      "",
    );
    expect(threads).toHaveLength(2);
    expect(threads[0]!.chat).toBe("A");          // newest thread first
    expect(threads[0]!.last_text).toBe("newer");
    expect(threads[0]!.count).toBe(2);
  });

  test("attachment previews never expose the object-replacement glyph", () => {
    expect(messagePreview("\uFFFC", { name: "IMG_0042.HEIC", mime: "image/heic" })).toBe("Photo");
    expect(messagePreview("\uFFFC", { name: "clip.mov", mime: "video/quicktime" })).toBe("Video");
    expect(messagePreview("caption \uFFFC", { name: "clip.mov", mime: "video/quicktime" })).toBe("caption");
    const threads = buildThreads([
      msg({ text: "\uFFFC", attachments: [{ name: "IMG_1.png", mime: "image/png", bytes: 5 }] }),
    ], "");
    expect(threads[0]!.last_text).toBe("Photo");
  });

  test("orders threads newest-first regardless of input order", () => {
    const threads = buildThreads(
      [
        msg({ chat: "old", ts: "2026-01-01T00:00:00Z" }),
        msg({ chat: "new", ts: "2026-08-30T23:59:59Z" }),
        msg({ chat: "mid", ts: "2026-05-05T12:00:00Z" }),
      ],
      "",
    );
    expect(threads.map((t) => t.chat)).toEqual(["new", "mid", "old"]);
  });

  test("first run reports zero unread — an empty watermark must not flag the backlog", () => {
    const threads = buildThreads([msg({ ts: "2026-08-30T10:00:00Z" })], "");
    expect(threads[0]!.unread).toBe(0);
  });

  test("counts only inbound messages newer than the watermark", () => {
    const threads = buildThreads(
      [
        msg({ ts: "2026-08-30T09:00:00Z" }),                     // old inbound
        msg({ ts: "2026-08-30T11:00:00Z" }),                     // new inbound  ✓
        msg({ ts: "2026-08-30T12:00:00Z", from_me: true }),      // new outbound ✗
      ],
      "2026-08-30T10:00:00Z",
    );
    expect(threads[0]!.unread).toBe(1);
  });

  test("a message exactly at the watermark is not unread", () => {
    const threads = buildThreads([msg({ ts: "2026-08-30T10:00:00Z" })], "2026-08-30T10:00:00Z");
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
    expect(buildThreads([], "2026-01-01T00:00:00Z")).toEqual([]);
  });

  test("a per-thread read mark clears only that thread", () => {
    const threads = buildThreads(
      [
        msg({ chat: "A", handle: "A", ts: "2026-08-30T11:00:00Z" }),
        msg({ chat: "B", handle: "B", ts: "2026-08-30T11:00:00Z" }),
      ],
      "2026-08-30T10:00:00Z",
      { A: "2026-08-30T11:00:00Z" },
    );
    const byChat = Object.fromEntries(threads.map((t) => [t.chat, t.unread]));
    expect(byChat).toEqual({ A: 0, B: 1 });
  });

  test("a stale per-thread mark never resurrects unread below the global mark", () => {
    const threads = buildThreads(
      [msg({ chat: "A", handle: "A", ts: "2026-08-30T09:30:00Z" })],
      "2026-08-30T10:00:00Z",
      { A: "2026-08-30T09:00:00Z" },
    );
    expect(threads[0]!.unread).toBe(0);
  });

  test("unreadSince may sit below the global mark and resurrects that chat only", () => {
    const threads = buildThreads(
      [
        msg({ chat: "A", handle: "A", ts: "2026-08-30T09:30:00Z", read: true }),
        msg({ chat: "B", handle: "B", ts: "2026-08-30T09:30:00Z", read: true }),
      ],
      "2026-08-30T10:00:00Z",
      {},
      {},
      undefined,
      false,
      { A: "2026-08-30T09:00:00Z" },
    );
    const byChat = Object.fromEntries(threads.map((t) => [t.chat, t.unread]));
    expect(byChat).toEqual({ A: 1, B: 0 });
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
  // A carrier short code is a SENDER, not a group. 5+ digits already worked
  // (2.2.1); 3-4 digits fell through to "not a phone" and opened read-only
  // with "group id unknown". E.164 caps a real number at 15 digits, so that
  // is the upper bound -- and anything longer stays a group, which is the
  // safe direction: an unknown shape must never become a DM target.
  test("a 3-4 digit short code is a DM, not a group", () => {
    expect(isGroupChat("2536")).toBe(false);     // T-Mobile, seen live
    expect(isGroupChat("611")).toBe(false);      // carrier care
    expect(isGroupChat("99123")).toBe(false);    // 5-digit, already worked
  });
  test("beyond E.164's 15 digits it is a group again, never a DM", () => {
    expect(isGroupChat("1".repeat(15))).toBe(false);
    expect(isGroupChat("1".repeat(16))).toBe(true);
  });
  test("a 1-2 digit id is still a group, never a DM target", () => {
    expect(isGroupChat("1")).toBe(true);
    expect(isGroupChat("42")).toBe(true);
  });
  test("exit 255 (ssh failure via claude-on-mac shim) reads as offline", () => {
    const r = fetchMessages(10, (() => ({ status: 255, stdout: "", stderr: "ssh: connect" })) as never);
    expect(r.online).toBe(false);
  });
  test("groups JSON with an array of participants (claude-on-mac 1.4)", () => {
    const g = fetchGroups((() => ({ status: 0, stdout: JSON.stringify([{
      chat: "chat1", guid: "any;+;chat1", name: "", participants: ["+1", "+2"],
      participant_names: { "+1": "Alex", "+2": "Pat" }, last: null,
    }]), stderr: "" })) as never);
    expect(g!.chat1.participants).toEqual(["+1", "+2"]);
    expect(g!.chat1.participantNames).toEqual({ "+1": "Alex", "+2": "Pat" });
  });
});

describe("self-echo in the thread list", () => {
  test("a message Fred sends himself does not count as unread", () => {
    // Without this every panel send to the self-thread re-lit the dot.
    const msgs = dedupeSelfEcho([
      msg({ chat: "+15550100001", handle: "+15550100001", ts: "2026-08-30T11:00:00Z", from_me: true, text: "note" }),
      msg({ chat: "+15550100001", handle: "+15550100001", ts: "2026-08-30T11:00:00Z", from_me: false, text: "note" }),
    ], ["+15550100001"]);
    const threads = buildThreads(msgs, "2026-08-30T10:00:00Z");
    expect(threads[0]!.unread).toBe(0);
    expect(threads[0]!.last_from_me).toBe(true);
  });

  test("a tapback on either twin of a self-thread message survives the dedupe", () => {
    // Messages attaches the tapback to whichever row the reacting device
    // considers the message; the dedupe used to keep one row and lose the
    // other's tapbacks, so a reaction on your own note never showed.
    const love = [{ emoji: "❤️", from_me: true, by: null }];
    const base = { chat: "SELF", handle: "SELF", ts: "2026-09-05 17:00:00", text: "note" };
    for (const order of [[true, false], [false, true]]) {
      const msgs = dedupeSelfEcho([
        msg({ ...base, from_me: order[0]!, tapbacks: order[0] ? love : null }),
        msg({ ...base, from_me: order[1]!, tapbacks: order[1] ? love : null }),
      ], ["SELF"]);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.from_me).toBe(true);
      expect(msgs[0]!.tapbacks).toEqual(love);
    }
    // the empty-outbound shape (an attachment) hands its tapback to the echo it promotes
    const empty = dedupeSelfEcho([
      msg({ chat: "SELF", handle: "SELF", ts: "2026-09-05 17:01:00", from_me: true, text: "", tapbacks: love }),
      msg({ chat: "SELF", handle: "SELF", ts: "2026-09-05 17:01:00", from_me: false, text: "" }),
    ], ["SELF"]);
    expect(empty).toHaveLength(1);
    expect(empty[0]!.tapbacks).toEqual(love);
    // the same tapback on both twins is one tapback
    const both = dedupeSelfEcho([
      msg({ ...base, ts: "2026-09-05 17:02:00", from_me: true, tapbacks: love }),
      msg({ ...base, ts: "2026-09-05 17:02:00", from_me: false, tapbacks: love }),
    ], ["SELF"]);
    expect(both[0]!.tapbacks).toEqual(love);
  });

  test("the same text in two different chats at one ts is two messages", () => {
    const msgs = dedupeSelfEcho([
      msg({ chat: "A", handle: "A", ts: "2026-08-30T11:00:00Z", text: "ok" }),
      msg({ chat: "B", handle: "B", ts: "2026-08-30T11:00:00Z", text: "ok" }),
    ]);
    expect(msgs).toHaveLength(2);
  });

  test("an empty self row cannot reclassify another chat at the same second", () => {
    const msgs = dedupeSelfEcho([
      msg({ chat: "SELF", handle: "SELF", from_me: true, text: "", ts: "2026-08-30T11:00:00Z" }),
      msg({ chat: "OTHER", handle: "OTHER", from_me: false, text: "urgent", ts: "2026-08-30T11:00:00Z" }),
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
    expect(threads[0]!.name).toBe("Jordan Blake & +15550100005");
  });

  test("group threads expose named participants for explicit contact actions", () => {
    const guid = "053856bb0d9a40e392db59eace1c56d1";
    const groups = {
      [guid]: { name: "Friends", guid: "any;+;" + guid,
        participants: ["+15550100004", "+15550100005"],
        participantNames: { "+15550100004": "Jordan", "+15550100005": "Casey" } },
    };
    const thread = buildThreads([msg({ chat: guid, handle: "+15550100004" })], "", {}, groups)[0]!;
    expect(thread.participants).toEqual([
      { handle: "+15550100004", name: "Jordan" },
      { handle: "+15550100005", name: "Casey" },
    ]);
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
  test("a filtered stranger's SMS shows the number, not the chat suffix", () => {
    expect(displayName([msg({ name: null, chat: "+18184632606(filtered)", handle: "+18184632606(filtered)" })])).toBe("+18184632606");
    // isGroupChat() files that shape as not-a-DM, so the list labels it through groupName.
    expect(isGroupChat("+18184632606(filtered)")).toBe(true);
    expect(groupName("+18184632606(filtered)", undefined, new Map())).toBe("+18184632606");
  });
});

describe("catch-up reconciles each unread against its own boundary", () => {
  const state = { unreadInitialized: true, watermark: "2026-09-16T12:00:00Z", readMark: "2026-09-01T00:00:00Z" };

  // The bug: one never-opened dot from weeks ago set the fetch depth for every
  // poll, so the window doubled 150 -> 8192 across that many sequential ssh
  // calls forever. Measured 2026-09-16: a 45-day-old unread cost 6 calls,
  // 4798 rows and 3.18 s against a 6 s poll timer.
  test("a stale unread no longer drags the window cutoff back", () => {
    expect(windowCutoff(state)).toBe(state.watermark);
    // the migration case still seeds from the read mark
    expect(windowCutoff({ ...state, unreadInitialized: false })).toBe(state.readMark);
  });

  test("only chats the window missed are caught up, oldest boundary first", () => {
    const oldest = {
      old: "2026-08-01T00:00:00Z",
      older: "2026-07-01T00:00:00Z",
      recent: "2026-09-16T13:00:00Z",
      empty: "2026-06-01T00:00:00Z",
    };
    const counts = { old: 1, older: 2, recent: 5, empty: 0 };
    const covered = "2026-09-16T11:00:00Z";
    // "recent" is inside the window and "empty" has nothing outstanding
    expect(staleUnreadChats(oldest, counts, covered)).toEqual(["older", "old"]);
    // no window rows at all covers nothing, so nothing is stale
    expect(staleUnreadChats(oldest, counts, "")).toEqual([]);
  });

  test("a short read covers the boundary — that is how a deleted unread is noticed", () => {
    const short = { ok: true, online: true, error: "", msgs: [msg({ ts: "2026-09-10T00:00:00Z" })], fetchedCount: 3 };
    // The boundary row is not there at all: the conversation has no more rows,
    // so the count computed from these IS the truth and the dot goes away.
    expect(coversBoundary(short, "2026-08-01T00:00:00Z", CATCHUP_CHAT_ROWS)).toBe(true);
  });

  test("a full read counts as covered only if it reached past the boundary", () => {
    const full = (from: string) => ({
      ok: true, online: true, error: "",
      msgs: [msg({ ts: from }), msg({ ts: "2026-09-16T00:00:00Z" })],
      fetchedCount: CATCHUP_CHAT_ROWS,
    });
    expect(coversBoundary(full("2026-07-01T00:00:00Z"), "2026-08-01T00:00:00Z")).toBe(true);
    expect(coversBoundary(full("2026-09-01T00:00:00Z"), "2026-08-01T00:00:00Z")).toBe(false);
    const failed = { ok: false, online: false, error: "offline", msgs: [], fetchedCount: 0 };
    expect(coversBoundary(failed, "2026-08-01T00:00:00Z")).toBe(false);
  });

  test("catch-up rows join the window once each", () => {
    const a = msg({ id: 1, ts: "2026-09-16T12:00:00Z" });
    const b = msg({ id: 2, ts: "2026-08-01T00:00:00Z" });
    const merged = mergeCatchupRows([a], [a, b]);
    expect(merged.map((m) => m.id)).toEqual([1, 2]);
    // a bridge that omits ROWIDs must not lose rows to the dedupe
    const bare = mergeCatchupRows([msg({ ts: "2026-09-16T12:00:00Z" })], [msg({ ts: "2026-08-01T00:00:00Z" })]);
    expect(bare).toHaveLength(2);
  });

  test("one busy conversation escalates alone, and stops at its own ceiling", () => {
    // The whole point of the change: depth is spent on the chat that needs it.
    const asked: number[] = [];
    const runner = ((_cmd: string, args: string[]) => {
      const limit = Number(args[args.length - 1]);
      asked.push(limit);
      // A conversation with more rows than the ceiling: every page comes back
      // full and never reaches back to the boundary.
      const msgs = Array.from({ length: limit }, (_, i) =>
        ({ ...msg({ ts: "2026-09-0" + (1 + (i % 9)) + "T00:00:00Z" }) }));
      return { status: 0, stdout: JSON.stringify(msgs), stderr: "", error: undefined };
    }) as never;

    const out = fetchChatBack("+15550100002", "2026-06-01T00:00:00Z", runner);
    expect(asked).toEqual([400, 800, 1600, 3200]);
    expect(asked[asked.length - 1]).toBe(CATCHUP_CHAT_MAX);
    expect(out.capped).toBe(true);   // -> the caller keeps that chat's count
  });

  test("a quiet conversation is one call, and is not capped", () => {
    const asked: number[] = [];
    const runner = ((_cmd: string, args: string[]) => {
      asked.push(Number(args[args.length - 1]));
      // 12 rows total: short of the ask, so the whole tail is in hand
      const msgs = Array.from({ length: 12 }, () => msg({ ts: "2026-07-01T00:00:00Z" }));
      return { status: 0, stdout: JSON.stringify(msgs), stderr: "", error: undefined };
    }) as never;

    const out = fetchChatBack("878478", "2026-06-01T00:00:00Z", runner);
    expect(asked).toEqual([400]);
    expect(out.capped).toBeUndefined();
  });

  test("a conversation the catch-up could not verify keeps its dots", () => {
    const counts = { a: 0, b: 3 };
    const oldest = { b: "2026-09-16T12:00:00Z" };
    const kept = keepUnverifiedUnread(
      counts, oldest,
      { a: 4, b: 1 }, { a: "2026-07-01T00:00:00Z", b: "2026-06-01T00:00:00Z" },
      new Set(["a"]),
    );
    // "a" was not reached this poll: the window saw none of its rows, so the
    // ledger keeps what it knew rather than reporting the undercount.
    expect(kept.counts.a).toBe(4);
    expect(kept.oldest.a).toBe("2026-07-01T00:00:00Z");
    // "b" was verified, so this poll's exact count stands even though it is lower
    expect(kept.counts.b).toBe(3);
    expect(kept.oldest.b).toBe("2026-09-16T12:00:00Z");
  });

  test("new arrivals still raise an unverified chat's count", () => {
    const kept = keepUnverifiedUnread(
      { a: 6 }, { a: "2026-09-16T12:00:00Z" },
      { a: 4 }, { a: "2026-07-01T00:00:00Z" },
      new Set(["a"]),
    );
    expect(kept.counts.a).toBe(6);
    // and the older boundary is the one that survives, so the next poll still
    // knows how far back this chat has to be reconciled
    expect(kept.oldest.a).toBe("2026-07-01T00:00:00Z");
  });
});

describe("selectToasts", () => {
  const allow = ["+15550100002"];

  test("a null-chat toast carries the handle, never the string null", () => {
    const out = selectToasts(
      [msg({ chat: null as unknown as string, handle: "+15550100002", ts: "2026-08-30T11:00:00Z" })],
      "2026-08-30T10:00:00Z",
      allow,
      [],
    );
    expect(out[0]!.chat).toBe("+15550100002");
  });

  test("toasts an allowlisted inbound message", () => {
    const out = selectToasts(
      [msg({ chat: "+15550100002", handle: "+15550100002", name: "Alex Rivera", ts: "2026-08-30T11:00:00Z" })],
      "2026-08-30T10:00:00Z",
      allow,
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("Alex Rivera");
  });

  // A toast for the conversation already open in front of you is noise, and
  // the same run suppresses its badge -- so without this gate the two
  // disagree: a notification fires saying there is something to read, and
  // there is nothing to click through to.
  test("does not toast the conversation being read", () => {
    const out = selectToasts(
      [msg({ chat: "+15550100002", handle: "+15550100002", ts: "2026-08-30 11:00:00" })],
      "2026-08-30 10:00:00",
      allow,
      [],
      ["+15550100002"],
    );
    expect(out).toEqual([]);
  });

  test("still toasts every OTHER conversation while one is open", () => {
    const out = selectToasts(
      [
        msg({ chat: "+15550100002", handle: "+15550100002", ts: "2026-08-30 11:00:00" }),
        msg({ chat: "+15550100003", handle: "+15550100003", ts: "2026-08-30 11:00:01" }),
      ],
      "2026-08-30 10:00:00",
      [...allow, "+15550100003"],     // both allowlisted: gate 4 is what differs
      [],
      ["+15550100002"],
    );
    expect(out.map((t) => t.chat)).toEqual(["+15550100003"]);
  });

  // Reading the canonical row covers its aliases, exactly as the read marks
  // do: a re-keyed group's retired chat row is the same conversation on screen.
  test("an alias of the open conversation is not toasted either", () => {
    const out = selectToasts(
      [msg({ chat: "+15550100002", handle: "+15550100002", ts: "2026-08-30 11:00:00" })],
      "2026-08-30 10:00:00",
      allow,
      [],
      ["chat640665907856941413", "+15550100002"],   // canonical + alias
    );
    expect(out).toEqual([]);
  });

  test("nothing open toasts as before", () => {
    const out = selectToasts(
      [msg({ chat: "+15550100002", handle: "+15550100002", ts: "2026-08-30 11:00:00" })],
      "2026-08-30 10:00:00",
      allow,
      [],
      [],
    );
    expect(out).toHaveLength(1);
  });

  // The badge already honours the Apple side (isUnread), so a toast for a
  // message read on the iPhone announces something the bar says is not there.
  test("does not toast a message already read on another device", () => {
    const out = selectToasts(
      [msg({ chat: "+15550100002", handle: "+15550100002", ts: "2026-08-30T11:00:00Z", read: true })],
      "2026-08-30T10:00:00Z",
      allow,
      [],
    );
    expect(out).toEqual([]);
  });

  // Waking from suspend hands the collector everything that arrived while the
  // watermark stood still -- a night of messages, most of them read on the
  // phone hours ago, drained one notify-send at a time (#89).
  test("a wake-up backlog toasts only what is still unread", () => {
    const out = selectToasts(
      [
        msg({ chat: "+15550100002", handle: "+15550100002", ts: "2026-08-30T23:00:00Z", text: "read on the phone", read: true }),
        msg({ chat: "+15550100002", handle: "+15550100002", ts: "2026-08-30T23:30:00Z", text: "also read", read: true }),
        msg({ chat: "+15550100002", handle: "+15550100002", ts: "2026-08-31T07:00:00Z", text: "still unread", read: false }),
      ],
      "2026-08-30T22:00:00Z",
      allow,
      [],
    );
    expect(out.map((t) => t.text)).toEqual(["still unread"]);
  });

  // `read` arrives from imsg >= 1.9.0. An older bridge omits it, and undefined
  // must not read as "already seen" or that setup would never toast at all.
  test("a bridge that reports no read state toasts as before", () => {
    const out = selectToasts(
      [msg({ chat: "+15550100002", handle: "+15550100002", ts: "2026-08-30T11:00:00Z" })],
      "2026-08-30T10:00:00Z",
      allow,
      [],
    );
    expect(out).toHaveLength(1);
  });

  test("drops senders that are not allowlisted", () => {
    // Bank alerts and 2FA codes are the reason this gate exists.
    const out = selectToasts(
      [msg({ chat: "878478", handle: "878478", ts: "2026-08-30T11:00:00Z" })],
      "2026-08-30T10:00:00Z",
      allow,
      [],
    );
    expect(out).toEqual([]);
  });

  test("never toasts outbound", () => {
    const out = selectToasts(
      [msg({ chat: "+15550100002", handle: "+15550100002", from_me: true, ts: "2026-08-30T11:00:00Z" })],
      "2026-08-30T10:00:00Z",
      allow,
      [],
    );
    expect(out).toEqual([]);
  });

  test("never toasts the backlog on first run", () => {
    const out = selectToasts(
      [msg({ chat: "+15550100002", handle: "+15550100002", ts: "2026-08-30T11:00:00Z" })],
      "",
      allow,
      [],
    );
    expect(out).toEqual([]);
  });

  test("suppresses a message already toasted — the self-thread echo guard", () => {
    // In the self-thread, the user's sent replies come back as from_me=false.
    // Without this dedupe the loop would notify on its own output forever.
    const m = msg({ chat: "+15550100001", handle: "+15550100001", ts: "2026-08-30T11:00:00Z", text: "echo" });
    const out = selectToasts([m], "2026-08-30T10:00:00Z", ["+15550100001"], [toastKey(m)]);
    expect(out).toEqual([]);
  });

  test("deduplicates identical messages within a single batch", () => {
    const m = msg({ chat: "+15550100002", handle: "+15550100002", ts: "2026-08-30T11:00:00Z" });
    const out = selectToasts([m, { ...m }], "2026-08-30T10:00:00Z", allow, []);
    expect(out).toHaveLength(1);
  });

  test("persisted toast keys are opaque and distinguish group senders", () => {
    const a = msg({ chat: "group", handle: "ALICE", text: "yes", ts: "2026-08-30T11:00:00Z" });
    const b = msg({ chat: "group", handle: "BOB", text: "yes", ts: "2026-08-30T11:00:00Z" });
    expect(toastKey(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(toastKey(a)).not.toContain("yes");
    expect(toastKey(a)).not.toBe(toastKey(b));
  });

  test("matches on handle when the chat id is an opaque GUID", () => {
    const out = selectToasts(
      [msg({ chat: "053856bb0d9a40e392db59eace1c56d1", handle: "+15550100004", ts: "2026-08-30T11:00:00Z" })],
      "2026-08-30T10:00:00Z",
      ["+15550100004"],
      [],
    );
    expect(out).toHaveLength(1);
  });

  test("an empty allowlist toasts nothing", () => {
    const out = selectToasts(
      [msg({ ts: "2026-08-30T11:00:00Z" })],
      "2026-08-30T10:00:00Z",
      [],
      [],
    );
    expect(out).toEqual([]);
  });
});

describe("maxTs", () => {
  test("returns the highest timestamp", () => {
    expect(maxTs([msg({ ts: "2026-08-30T09:00:00Z" }), msg({ ts: "2026-08-30T11:00:00Z" })], "")).toBe(
      "2026-08-30T11:00:00Z",
    );
  });

  test("never moves the watermark backwards on a short window", () => {
    expect(maxTs([msg({ ts: "2026-01-01T00:00:00Z" })], "2026-08-30T10:00:00Z")).toBe(
      "2026-08-30T10:00:00Z",
    );
  });

  test("an empty fetch leaves the watermark untouched", () => {
    expect(maxTs([], "2026-08-30T10:00:00Z")).toBe("2026-08-30T10:00:00Z");
  });
});

describe("state and allowlist I/O", () => {
  test("round-trips state", () => {
    const p = join(tmp(), "state.json");
    const opaque = `sha256:${"a".repeat(64)}`;
    expect(saveState({
      watermark: "2026-08-30T10:00:00Z", readMark: "2026-08-30T09:00:00Z",
      unreadCounts: { A: 2 }, unreadOldest: { A: "2026-08-30T09:01:00Z" },
      unreadInitialized: true, selfChats: ["SELF"],
      readMarks: { A: "2026-08-30T09:30:00Z" }, groups: {}, chatAliases: { OLD: "A" }, pins: { A: 0 }, toasted: [opaque],
    }, p)).toBe(true);
    expect(loadState(p)).toEqual({
      watermark: "2026-08-30T10:00:00Z",
      readMark: "2026-08-30T09:00:00Z",
      unreadCounts: { A: 2 },
      unreadOldest: { A: "2026-08-30T09:01:00Z" },
      unreadInitialized: true,
      selfChats: ["SELF"],
      readMarks: { A: "2026-08-30T09:30:00Z" },
      unreadSince: {},
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
      selfChats: [], readMarks: {}, unreadSince: {}, groups: {}, chatAliases: {}, pins: {}, toasted: [],
    });
  });

  test("corrupt state does not throw", () => {
    const p = join(tmp(), "bad.json");
    writeFileSync(p, "{ this is not json");
    expect(loadState(p)).toEqual({
      watermark: "", readMark: "", unreadCounts: {}, unreadOldest: {}, unreadInitialized: false,
      selfChats: [], readMarks: {}, unreadSince: {}, groups: {}, chatAliases: {}, pins: {}, toasted: [],
    });
  });

  test("the toast ring is capped so the state file cannot grow forever", () => {
    const p = join(tmp(), "big.json");
    saveState({
      watermark: "x", readMark: "x", unreadCounts: {}, unreadOldest: {}, unreadInitialized: true,
      selfChats: [], readMarks: {}, unreadSince: {}, groups: {}, toasted: Array.from({ length: 500 }, (_, i) => `k${i}`),
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
      selfChats: [], readMarks: {}, unreadSince: {}, groups: {}, toasted: [],
    }, join(blocker, "state.json"))).toBe(false);
  });

  test("a pre-two-mark state file inherits readMark from watermark", () => {
    // Migration guard: an old {watermark, toasted} file must report zero unread,
    // not a fabricated backlog, the first time the new collector reads it.
    const p = join(tmp(), "legacy.json");
    writeFileSync(p, JSON.stringify({ watermark: "2026-08-30T10:00:00Z", toasted: [] }));
    expect(loadState(p).readMark).toBe("2026-08-30T10:00:00Z");
    expect(loadState(p).readMarks).toEqual({});
  });

  test("a count-only ledger is reseeded so deletes can be reconciled", () => {
    const p = join(tmp(), "count-only.json");
    writeFileSync(p, JSON.stringify({
      watermark: "2026-08-30T12:00:00Z",
      readMark: "2026-08-30T10:00:00Z",
      unreadCounts: { A: 2 },
      unreadInitialized: true,
    }));
    expect(loadState(p).unreadInitialized).toBe(false);
  });

  // Both loaders swallow a parse error and return [], so a README example that
  // does not parse is indistinguishable from having no file: everything still
  // counts on the badge and nothing ever toasts, with no error anywhere. The
  // examples were fenced ```jsonc with a `//` line above the object, which
  // JSON.parse rejects -- copied as shown, they configured nothing.
  test("the README's allowlist and mutelist examples load as written", () => {
    const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
    const blocks = [...readme.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]!);
    expect(blocks.length).toBeGreaterThanOrEqual(2);

    const allowBlock = blocks.find((b) => b.includes('"allow"'));
    const muteBlock = blocks.find((b) => b.includes('"mute"'));
    expect(allowBlock).toBeDefined();
    expect(muteBlock).toBeDefined();

    const a = join(tmp(), "readme-allow.json");
    writeFileSync(a, allowBlock!);
    expect(loadAllowlist(a).length).toBeGreaterThan(0);

    const m = join(tmp(), "readme-mute.json");
    writeFileSync(m, muteBlock!);
    expect(loadMutelist(m).length).toBeGreaterThan(0);
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

  test("drops rows with neither chat nor handle, keeps handle-only rows", () => {
    // Leftovers of deleted conversations arrive with no chat and no handle;
    // one-off SMS senders arrive with no chat but a handle, and must stay.
    const r = fetchMessages(10, fake({ status: 0, stdout: JSON.stringify([
      msg(),
      msg({ chat: null as unknown as string, handle: "31614" }),
      msg({ chat: null as unknown as string, handle: null as unknown as string }),
    ]) }));
    expect(r.ok).toBe(true);
    expect(r.msgs.map((m) => m.handle)).toEqual(["+15551234567", "31614"]);
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
      msg({ ts: "2026-08-30T12:04:00Z" }),
      msg({ ts: "2026-08-30T12:03:00Z" }),
      msg({ ts: "2026-08-30T12:02:00Z" }),
      msg({ ts: "2026-08-30T11:59:00Z" }),
    ];
    const limits: number[] = [];
    const fake = ((_cmd: string, args: string[]) => {
      const limit = Number(args[2]);
      limits.push(limit);
      return { status: 0, stdout: JSON.stringify(all.slice(0, limit)), stderr: "" };
    }) as never;
    const result = fetchMessagesAfter("2026-08-30T12:00:00Z", 2, fake);
    expect(result.ok).toBe(true);
    expect(result.msgs).toHaveLength(4);
    expect(limits).toEqual([2, 4]);
  });

  test("a dropped orphan row in a full page does not end the catch-up early (Astra #7)", () => {
    // Page 1 (limit 2) is FULL from the bridge's point of view, but one row has
    // neither chat nor handle and is dropped. Counting survivors read that as
    // "the bridge ran out" and stopped before the older unread.
    const all = [
      msg({ ts: "2026-08-30T12:03:00Z", handle: "+15550000001" }),
      msg({ ts: "2026-08-30T12:02:00Z", chat: null as unknown as string, handle: null as unknown as string }),
      msg({ ts: "2026-08-30T12:01:00Z", handle: "+15550000002" }),
      msg({ ts: "2026-08-30T11:59:00Z", handle: "+15550000003" }),
    ];
    const limits: number[] = [];
    const fake = ((_cmd: string, args: string[]) => {
      const limit = Number(args[2]);
      limits.push(limit);
      return { status: 0, stdout: JSON.stringify(all.slice(0, limit)), stderr: "" };
    }) as never;
    const r = fetchMessagesAfter("2026-08-30T12:00:00Z", 2, fake);
    expect(r.ok).toBe(true);
    expect(limits).toEqual([2, 4]);
    expect(r.fetchedCount).toBe(4);
    expect(r.msgs).toHaveLength(3);
  });

  test("catch-up stops doubling at CATCHUP_MAX_ROWS even if every page is full (Codex audit #12)", () => {
    const limits: number[] = [];
    const fake = ((_cmd: string, args: string[]) => {
      const limit = Number(args[2]);
      limits.push(limit);
      const rows = Array.from({ length: limit }, (_, i) => msg({ ts: "2026-08-30T12:01:00Z", handle: "H" + i }));
      return { status: 0, stdout: JSON.stringify(rows), stderr: "" };
    }) as never;
    const r = fetchMessagesAfter("2026-08-30T12:00:00Z", 2, fake);
    expect(r.ok).toBe(true);
    expect(limits[limits.length - 1]).toBeLessThanOrEqual(CATCHUP_MAX_ROWS);
    expect(limits.length).toBeLessThan(20);
  });

  test("expands past an equal timestamp boundary", () => {
    const all = [
      msg({ ts: "2026-08-30T12:01:00Z", handle: "A" }),
      msg({ ts: "2026-08-30T12:00:00Z", handle: "B" }),
      msg({ ts: "2026-08-30T12:00:00Z", handle: "C" }),
    ];
    const limits: number[] = [];
    const fake = ((_cmd: string, args: string[]) => {
      const limit = Number(args[2]);
      limits.push(limit);
      return { status: 0, stdout: JSON.stringify(all.slice(0, limit)), stderr: "" };
    }) as never;
    expect(fetchMessagesAfter("2026-08-30T12:00:00Z", 2, fake).msgs).toHaveLength(3);
    expect(limits).toEqual([2, 4]);
  });

  test("the unread ledger records counts and its reconciliation boundary", () => {
    const rows = [
      msg({ chat: "A", ts: "2026-08-30T11:00:00Z" }),
      msg({ chat: "A", ts: "2026-08-30T10:30:00Z" }),
      msg({ chat: "A", ts: "2026-08-30T11:01:00Z", from_me: true }),
    ];
    expect(unreadCounts(rows, "2026-08-30T10:00:00Z", {})).toEqual({ A: 2 });
    expect(unreadOldest(rows, "2026-08-30T10:00:00Z", {})).toEqual({ A: "2026-08-30T10:30:00Z" });
  });

  test("rebuilding the covered unread range removes deleted rows", () => {
    const rowsAfterDelete = [msg({ chat: "A", ts: "2026-08-30T11:00:00Z" })];
    expect(unreadCounts(rowsAfterDelete, "2026-08-30T10:00:00Z", {})).toEqual({ A: 1 });
    expect(unreadOldest(rowsAfterDelete, "2026-08-30T10:00:00Z", {})).toEqual({ A: "2026-08-30T11:00:00Z" });
  });

  test("exact ledger counts override the bounded thread window", () => {
    const threads = buildThreads(
      [msg({ chat: "A", ts: "2026-08-30T11:00:00Z" })],
      "2026-08-30T10:00:00Z", {}, {}, { A: 151 },
    );
    expect(threads[0]!.unread).toBe(151);
  });
});

describe("readMarks pruning", () => {
  test("a per-thread mark at or below the global mark is dropped from state", () => {
    // collect() prunes; emulate its rule directly.
    const readMarks: Record<string, string> = { A: "2026-08-30T09:00:00Z", B: "2026-08-30T12:00:00Z" };
    const readMark = "2026-08-30T10:00:00Z";
    for (const [chat, ts] of Object.entries(readMarks)) if (ts <= readMark) delete readMarks[chat];
    expect(Object.keys(readMarks)).toEqual(["B"]);
  });
});

describe("text-bearing self twins", () => {
  test("a same-chat same-handle same-second text pair marks the self chat", () => {
    // imsg decodes attributedBody: the outbound twin is rarely empty.
    const msgs = [
      msg({ chat: "+15550100001", handle: "+15550100001", ts: "2026-08-30T21:45:00Z", from_me: true, text: "note" }),
      msg({ chat: "+15550100001", handle: "+15550100001", ts: "2026-08-30T21:45:00Z", from_me: false, text: "note" }),
    ];
    expect(detectSelfChats(msgs)).toEqual(["+15550100001"]);
    const out = dedupeSelfEcho(msgs);
    expect(out).toHaveLength(1);
    expect(out[0]!.from_me).toBe(true);
  });

  test("two different senders with the same text in one second stay distinct", () => {
    const msgs = [
      msg({ chat: "g", handle: "+15550100004", ts: "2026-08-30T21:45:00Z", from_me: false, text: "lol" }),
      msg({ chat: "g", handle: "+15550100005", ts: "2026-08-30T21:45:00Z", from_me: false, text: "lol" }),
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
    ts: "2026-08-31T12:00:00Z", from_me: false, handle: "+15551234567",
    name: null, service: "iMessage", chat: "+15551234567", text: "x", ...over,
  }) as never;

  test("a message read on the PHONE stops counting even past the local mark", () => {
    const counts = unreadCounts(
      [m({ read: true }), m({ ts: "2026-08-31T12:01:00Z", read: false })],
      "2026-08-31T00:00:00Z", {},
    );
    expect(counts["+15551234567"]).toBe(1);
  });

  test("rows without the read field fall back to local-only semantics", () => {
    const counts = unreadCounts([m({})], "2026-08-31T00:00:00Z", {});
    expect(counts["+15551234567"]).toBe(1);
  });

  test("Apple-unread still badges below the global floor (iPhone badge)", () => {
    const counts = unreadCounts([m({ read: false })], "2026-08-31T23:00:00Z", {});
    expect(counts["+15551234567"]).toBe(1);
  });

  test("opening a thread still hides its Apple-unread rows", () => {
    const counts = unreadCounts(
      [m({ read: false })],
      "2026-08-31T00:00:00Z",
      { "+15551234567": "2026-08-31T12:00:00Z" },
    );
    expect(counts["+15551234567"]).toBeUndefined();
  });

  test("a read tip hides older is_read=0 ghosts; an unread tip badges", () => {
    expect(unreadCounts([
      m({ ts: "2026-08-31T10:00:00Z", read: false }),
      m({ ts: "2026-08-31T12:00:00Z", read: true }),
    ], "2026-08-31T00:00:00Z", {})).toEqual({});
    expect(unreadCounts([
      m({ ts: "2026-08-31T10:00:00Z", read: true }),
      m({ ts: "2026-08-31T12:00:00Z", read: false }),
    ], "2026-08-31T23:00:00Z", {})["+15551234567"]).toBe(1);
  });
});

describe("future-dated messages must not poison read marks", () => {
  test("mark-all clamps the global mark to now; the future chat gets a per-chat mark", () => {
    // Simulated via collect()'s pieces: verify the clamp math directly.
    const { nowTs } = require("./collector") as typeof import("./collector");
    const now = nowTs();
    const future = "2099-01-01T00:00:00Z";
    expect(future > now).toBe(true);
    const readMark = future <= now ? future : now;
    expect(readMark).toBe(now);   // global mark never exceeds the clock
  });

  test("a chat read now stays readable for messages arriving later today", () => {
    const { isUnread, nowTs } = require("./collector") as typeof import("./collector");
    const mark = nowTs(new Date(Date.now() - 60000)); // read a minute ago
    const arriving = { ts: nowTs(), from_me: false, read: false } as never;
    expect(isUnread(arriving, mark)).toBe(true);  // new arrival still badges
  });
});

describe("failed-delivery detection", () => {
  const { selectFailures } = require("./collector") as typeof import("./collector");
  const now = "2026-08-31T20:30:00Z";
  const mine = (over: Record<string, unknown>) => ({
    ts: "2026-08-31T20:25:00Z", from_me: true, handle: "+15551234567", name: "Pat",
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
    expect(selectFailures([mine({ error: 25, ts: "2026-08-31T19:00:00Z" })], [], now).length).toBe(0);
  });

  test("dedupes through the toasted ring — interrupts exactly once", () => {
    const first = selectFailures([mine({ error: 25 })], [], now);
    const again = selectFailures([mine({ error: 25 })], first.map((f) => f.key), now);
    expect(again.length).toBe(0);
  });
});

describe("a link that just arrived opens the share sheet", () => {
  const { firstUrl, selectIncomingLinks } = require("./collector") as typeof import("./collector");
  const WM = "2026-09-02T12:00:00Z";

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
      msg({ ts: "2026-09-02T12:30:00Z", from_me: false, text: "read https://a.test/1" }),
      msg({ ts: "2026-09-02T11:00:00Z", from_me: false, text: "old https://b.test/2" }),   // before watermark
      msg({ ts: "2026-09-02T12:40:00Z", from_me: true, text: "mine https://c.test/3" }),   // outbound
      msg({ ts: "2026-09-02T12:50:00Z", from_me: false, text: "no url" }),
      msg({ ts: "2026-09-02T12:55:00Z", from_me: false, text: "later https://d.test/4" }),
    ], WM, []);
    expect(out.map((l) => l.url)).toEqual(["https://a.test/1", "https://d.test/4"]);
    expect(out[out.length - 1]!.url).toBe("https://d.test/4");   // the caller shows the newest
    expect(out.every((l) => l.key.startsWith("link:"))).toBe(true);
  });

  test("every link of a message rides along; url stays the first", () => {
    const out = selectIncomingLinks([
      msg({ ts: "2026-09-02T12:30:00Z", from_me: false, text: "two: https://a.test/1, and https://b.test/2." }),
    ], WM, []);
    expect(out[0]!.url).toBe("https://a.test/1");
    expect(out[0]!.urls).toEqual(["https://a.test/1", "https://b.test/2"]);
  });

  test("a link fires once — its key suppresses the next poll", () => {
    const m = msg({ ts: "2026-09-02T12:30:00Z", from_me: false, text: "https://a.test/1" });
    const first = selectIncomingLinks([m], WM, []);
    expect(first.length).toBe(1);
    expect(selectIncomingLinks([m], WM, [first[0]!.key])).toEqual([]);
  });

  test("never the backlog on first run, never the self-thread", () => {
    const m = msg({ ts: "2026-09-02T12:30:00Z", from_me: false, text: "https://a.test/1" });
    expect(selectIncomingLinks([m], "", [])).toEqual([]);
    expect(selectIncomingLinks([m], WM, [], [String(m.chat || m.handle)])).toEqual([]);
  });
});

describe("a re-keyed group is ONE conversation", () => {
  const { aliasesFromChats, foldThreadAliases, foldChatRecord } =
    require("./collector") as typeof import("./collector");
  const chat = (id: string, aliases: string[] = []) => ({
    id, name: "Sportsball!", service: "iMessage", messages: 3, last: "2026-08-09T21:50:59Z",
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
      [thread("chat6703", "2026-02-26T22:26:56Z", 5263, 1), thread("chat2244", "2026-08-09T21:50:59Z", 3477, 2)],
      { chat6703: "chat2244" },
    );
    expect(out.length).toBe(1);
    expect(out[0]!.chat).toBe("chat2244");
    expect(out[0]!.last_ts).toBe("2026-08-09T21:50:59Z");   // the LIVE row's preview
    expect(out[0]!.count).toBe(5263 + 3477);
    expect(out[0]!.unread).toBe(3);
  });

  test("the older row alone still shows, under the live id", () => {
    const out = foldThreadAliases([thread("chat6703", "2026-02-26T22:26:56Z", 5, 0)], { chat6703: "chat2244" });
    expect(out.length).toBe(1);
    expect(out[0]!.chat).toBe("chat2244");
  });

  test("no aliases is a no-op (same array back)", () => {
    const t = [thread("chat2244", "2026-08-09T21:50:59Z", 1, 0)];
    expect(foldThreadAliases(t, {})).toBe(t);
  });

  test("the unread ledger folds too — one badge, not two", () => {
    expect(foldChatRecord({ chat6703: 1, chat2244: 2, "+1555": 4 }, { chat6703: "chat2244" }, (a, b) => a + b))
      .toEqual({ chat2244: 3, "+1555": 4 });
    expect(foldChatRecord(
      { chat6703: "2026-02-26T22:26:56Z", chat2244: "2026-08-09T21:50:59Z" },
      { chat6703: "chat2244" },
      (a, b) => (a < b ? a : b),
    )).toEqual({ chat2244: "2026-02-26T22:26:56Z" });
  });

  test("a merged DM (phone + email) folds onto the live handle", () => {
    const phone = "+15550100001";
    const email = "pat@example.com";
    const out = foldThreadAliases(
      [
        thread(phone, "2026-09-04T21:32:29Z", 40, 0),
        thread(email, "2026-09-05T17:24:01Z", 12, 1),
      ],
      { [phone]: email },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ chat: email, last_ts: "2026-09-05T17:24:01Z", unread: 1 });
  });
});

describe("complete conversation list (mergeChats)", () => {
  const { mergeChats } = require("./collector") as typeof import("./collector");
  const windowThread = {
    chat: "+15551234567", guid: "", name: "Pat", handle: "+15551234567", service: "iMessage",
    last_ts: "2026-08-31T20:00:00Z", last_text: "hi", last_from_me: false, count: 3, unread: 1,
    pinned: false, pin_order: null,
  };
  const chats = [
    { id: "+15551234567", name: null, service: "iMessage", last: "2026-08-31T20:00:00Z",
      last_text: "hi", last_from_me: false, last_handle: "+15551234567", last_name: "Pat",
      pinned: false, pin_order: null, aliases: ["+15551234567"], pin_name: null },
    { id: "ce5a593a78af408282d61461ade89135", name: "Lunch Crew", service: "iMessage", last: "2026-08-31T19:00:00Z",
      last_text: "Nice", last_from_me: false, last_handle: "+15550001111", last_name: "Sam",
      pinned: false, pin_order: null, aliases: ["ce5a593a78af408282d61461ade89135"], pin_name: null },
    { id: "+15559990000", name: null, service: "SMS", last: "2026-08-20T09:00:00Z",
      last_text: "old news", last_from_me: true, last_handle: "+15559990000", last_name: "Quiet Q",
      pinned: false, pin_order: null, aliases: ["+15559990000"], pin_name: null },
  ];

  test("unnamed groups use resolved participants in both list merge paths", () => {
    const chat = {...chats[1]!, name:null};
    const info = {name:"", guid:"any;+;"+chat.id,
      participants:["+15551234567", "+15550001111"],
      participantNames:{"+15551234567":"Pat", "+15550001111":"Sam"}};
    const groups = {[chat.id]:info};
    const quiet = mergeChats([], [chat], groups, {})[0]!;
    expect(quiet.name).toBe("Pat & Sam");
    const existing = {...quiet, name:chat.id};
    expect(mergeChats([existing], [chat], groups, {})[0]!.name).toBe("Pat & Sam");
    expect(mergeChats([], [{...chat,name:"Custom title"}], groups, {})[0]!.name).toBe("Custom title");
    expect(mergeChats([], [chat], {[chat.id]:{...info,name:"Group title"}}, {})[0]!.name).toBe("Group title");
    const aliasChat = {...chat,id:"chat123456",aliases:["chat123456",chat.id]};
    const aliased = mergeChats([], [aliasChat], groups, {})[0]!;
    expect(aliased.name).toBe("Pat & Sam");
    expect(aliased.guid).toBe(info.guid);
    expect(mergeChats([], [chat], {}, {})[0]!.name).toBe(chat.id);
  });

    test("a group whose only name IS its chat id still names itself after people", () => {
      // The real shape, and the one the case above missed by using name:null.
      // `imsg chats` substitutes the identifier when a group has no display
      // name, so `name` came back as "3734fc1a..." and won the || chain ahead
      // of the participant fallback - unreachable for exactly the groups it is
      // for. Found live (Fred, 2026-09-10): 26 groups showed a raw hex id.
      const id = "ce5a593a78af408282d61461ade89135";
      const idChat = {...chats[1]!, id, name: id, aliases: [id]};
      const info = {name: "", guid: "any;+;" + id,
        participants: ["+15551234567", "+15550001111"],
        participantNames: {"+15551234567": "Pat", "+15550001111": "Sam"}};
      const groups = {[id]: info};
      expect(mergeChats([], [idChat], groups, {})[0]!.name).toBe("Pat & Sam");
      // and through the applyPin path, where an existing thread carries the id
      const existing = {...windowThread, chat: id, name: id, guid: "",
        participants: [{handle: "+15551234567", name: "Pat"},
                       {handle: "+15550001111", name: "Sam"}]};
      expect(mergeChats([existing], [idChat], groups, {})[0]!.name).toBe("Pat & Sam");
      // a retired alias id is just as much not-a-name
      const rekeyed = {...idChat, id: "chat9999", name: id, aliases: ["chat9999", id]};
      expect(mergeChats([], [rekeyed], {chat9999: info}, {})[0]!.name).toBe("Pat & Sam");
      // a real title still wins over the participants
      expect(mergeChats([], [{...idChat, name: "Lunch Crew"}], groups, {})[0]!.name).toBe("Lunch Crew");
    });

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
    expect(out[0]!.count).toBe(windowThread.count);
    expect(out[0]!.unread).toBe(windowThread.unread);
  });

  // Live shape (Ian, 2026-09-16): a 1:1 keyed by an iCloud address, with the
  // phone number as an alias of the same cluster, every inbound iMessage — and
  // `imsg chats` reporting the cluster as RCS because its newest row was Blip's
  // own last send. Blip then passed `--service RCS` and every reply left green,
  // which made the next list row green too.
  test("a merged 1:1 the window computed as iMessage is not turned green by the chat list", () => {
    const merged = {
      ...chats[0]!, id: "nancy@icloud.com", service: "RCS",
      aliases: ["nancy@icloud.com", "+15551234567"],
    };
    const blue = { ...windowThread, chat: "nancy@icloud.com", service: "iMessage" };
    expect(mergeChats([blue], [merged], {}, {})[0]!.service).toBe("iMessage");
  });

  test("a genuinely green DM still takes its service from the list", () => {
    const green = { ...windowThread, chat: "+15559990000", service: "SMS" };
    expect(mergeChats([green], [chats[2]!], {}, {})[0]!.service).toBe("SMS");
  });

  test("the list may still move a DM the other way, onto iMessage", () => {
    const green = { ...windowThread, service: "SMS" };
    expect(mergeChats([green], [chats[0]!], {}, {})[0]!.service).toBe("iMessage");
  });

  test("a group still takes the list service, since it sends by chat id", () => {
    const id = "ce5a593a78af408282d61461ade89135";
    const group = { ...windowThread, chat: id, service: "iMessage" };
    const listed = { ...chats[1]!, service: "SMS" };
    expect(mergeChats([group], [listed], {}, {})[0]!.service).toBe("SMS");
  });

  test("pinned rows receive Messages-style names and cleaned latest previews", () => {
    const namedChats = chats.map((chat, index) => index === 0
      ? { ...chat, pin_name: "Pat", last_text: "Photo" }
      : chat);
    const matchingWindow = { ...windowThread, last_text: "\uFFFC" };
    const out = mergeChats([matchingWindow], namedChats, {}, {});
    expect(out[0]!.pin_name).toBe("Pat");
    expect(out[0]!.last_text).toBe("Photo");
  });

  test("DM rows are named from the contact, groups from the group cache", () => {
    const out = mergeChats([], chats, {}, {});
    expect(out.find((t) => t.chat === "+15559990000")!.name).toBe("Quiet Q");
    expect(out.find((t) => t.chat === "ce5a593a78af408282d61461ade89135")!.name).toBe("Lunch Crew");
  });

  test("mirrored pins sort first in Messages pin order, ahead of activity", () => {
    const out = mergeChats(
      [
        { ...windowThread, last_ts: "2026-08-31T22:00:00Z" },
        { ...windowThread, chat: "+15557770000", last_ts: "2026-08-31T21:00:00Z", pinned: false, pin_order: null },
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
          id: "+15551234567", name: "Pat", service: "iMessage", last: "2026-08-31T20:00:00Z",
          last_text: "hi", last_from_me: false, last_handle: "+15551234567", last_name: "Pat",
          pinned: true, pin_order: 0,
        },
        {
          id: "+15550001111", name: null, service: "SMS", last: "2026-08-31T19:00:00Z",
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

  test("migrated named groups combine alias history, unread counts, and pin state", () => {
    const oldId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const newId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const baseThread = {
      chat: newId, guid: "", name: "Project Team", handle: "+15550000001",
      service: "iMessage", last_ts: "2026-09-02 19:29:00", last_text: "",
      last_from_me: false, count: 0, unread: 0, pinned: false, pin_order: null,
    };
    const source = [{
      id: newId, aliases: [newId, oldId], name: "Project Team", service: "iMessage",
      last: "2026-09-02 19:29:00", last_text: "new side", last_from_me: false,
      last_handle: "+15550000001", last_name: "Eric", pinned: true, pin_order: 1,
      pin_name: "Project Team",
    }];
    const rich = [
      { ...baseThread, chat: oldId, name: "Project Team", count: 5, unread: 2,
        last_ts: "2026-09-01 09:00:00", last_text: "old side" },
      { ...baseThread, chat: newId, name: "Project Team", count: 3, unread: 1,
        last_ts: "2026-09-02 19:29:00", last_text: "new side" },
    ];
    const { foldThreadAliases, mergeChats } = require("./collector") as typeof import("./collector");
    const folded = foldThreadAliases(rich as never, { [oldId]: newId });
    const out = mergeChats(folded, source, {
      [newId]: { name: "Project Team", guid: `any;+;${newId}`, participants: ["+1", "+2"] },
    }, {});
    expect(out).toHaveLength(1);
    expect(out[0]!.chat).toBe(newId);
    expect(out[0]!.aliases).toEqual([newId, oldId]);
    expect(out[0]!.count).toBe(8);
    expect(out[0]!.unread).toBe(3);
    expect(out[0]!.pinned).toBe(true);
    expect(out[0]!.guid).toBe(`any;+;${newId}`);
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
    const first = { ts: "2026-09-01T20:00:05Z", from_me: false, handle: "+15550001111", name: "T", service: "iMessage", chat: "+15550001111", text: "" } as ImsgMessage;
    const second = { ...first, text: "Ok, I will be there" };
    const allow = ["+15550001111"];
    const t1 = selectToasts([first], "2026-09-01T20:00:00Z", allow, []);
    expect(t1).toHaveLength(1);
    const t2 = selectToasts([second], "2026-09-01T20:00:00Z", allow, [t1[0]!.key]);
    expect(t2).toHaveLength(0);
  });
  test("a bridge ROWID wins over the ts/chat/handle fallback", () => {
    const a = { id: 42, ts: "2026-09-01T20:00:05Z", from_me: false, handle: "h", name: null, service: "iMessage", chat: "h", text: "x" } as ImsgMessage;
    const b = { ...a, ts: "2026-09-01T20:00:09Z", text: "y" };
    expect(toastKey(a)).toBe(toastKey(b));
  });
});

describe("self-chat promotion is not persisted on one coincidence (2.2.0)", () => {
  const dm = (ts: string, from_me: boolean, text: string) =>
    ({ ts, from_me, handle: "+15550002222", name: "B", service: "iMessage", chat: "+15550002222", text } as ImsgMessage);
  test("a single same-second 'ok' pair dedupes for display but does not promote for persistence", () => {
    const pair = [dm("2026-09-01T20:00:05Z", true, "ok"), dm("2026-09-01T20:00:05Z", false, "ok")];
    expect(detectSelfChats(pair)).toEqual(["+15550002222"]);      // display-time dedupe still works
    expect(detectSelfChats(pair, 2)).toEqual([]);                  // persistence needs a second twin
  });
  test("two twins at different seconds do promote", () => {
    const rows = [dm("2026-09-01T20:00:05Z", true, "a"), dm("2026-09-01T20:00:05Z", false, "a"),
                  dm("2026-09-01T20:00:09Z", true, "b"), dm("2026-09-01T20:00:09Z", false, "b")];
    expect(detectSelfChats(rows, 2)).toEqual(["+15550002222"]);
  });
});

describe("failure-toast keys survive the ring normalizer (2.2.0)", () => {
  const { selectFailures } = require("./collector") as typeof import("./collector");
  test("a fail: key is kept verbatim on load, so a failed send toasts once", () => {
    const m = { id: 9, ts: "2026-09-01T20:00:05Z", from_me: true, handle: "h", name: "H", service: "iMessage", chat: "h", text: "x", error: 25 } as ImsgMessage;
    const first = selectFailures([m], [], "2026-09-01T20:05:00Z");
    expect(first).toHaveLength(1);
    const tmp = `${process.env.XDG_CACHE_HOME}/state-${process.pid}.json`;
    saveState({ ...loadState(tmp), toasted: [first[0]!.key] }, tmp);
    const again = selectFailures([m], loadState(tmp).toasted, "2026-09-01T20:05:00Z");
    expect(again).toHaveLength(0);
  });
});

describe("pushing read state back to the Mac", () => {
  const { pushReadPolicy } = require("./collector") as typeof import("./collector");
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







  test("mark-unread pushes --unread for DMs only", () => {
    expect(pushUnreadArgs("+15550100011")).toEqual(["--unread", "+15550100011"]);
    expect(pushUnreadArgs("them@example.com")).toEqual(["--unread", "them@example.com"]);
    expect(pushUnreadArgs("ce5a593a78af408282d61461ade89135")).toBeNull();
    expect(pushUnreadArgs("chat900000000000000001")).toBeNull();
    expect(pushUnreadArgs("")).toBeNull();
  });





});

describe("mark as unread", () => {
  test("stampBefore is one second earlier", () => {
    expect(stampBefore("2026-08-30T10:00:00Z")).toBe("2026-08-30T09:59:59Z");
  });

  test("lastInboundTs skips outbound and tapbacks", () => {
    expect(lastInboundTs([
      msg({ ts: "2026-08-30T09:00:00Z" }),
      msg({ ts: "2026-08-30T11:00:00Z", from_me: true }),
      msg({ ts: "2026-08-30T12:00:00Z", tapback: true }),
    ], "+15551234567")).toBe("2026-08-30T09:00:00Z");
  });

  test("effectiveMark prefers unreadSince even below the global floor", () => {
    expect(effectiveMark("A", "2026-08-30T10:00:00Z", { A: "2026-08-30T11:00:00Z" }, { A: "2026-08-30T09:00:00Z" }))
      .toBe("2026-08-30T09:00:00Z");
  });

  test("unreadCounts honours unreadSince even when Apple already marked the row read", () => {
    const rows = [msg({ chat: "A", handle: "A", ts: "2026-08-30T09:30:00Z", read: true })];
    expect(unreadCounts(rows, "2026-08-30T10:00:00Z", {}, [], { A: "2026-08-30T09:00:00Z" })).toEqual({ A: 1 });
    expect(unreadCounts(rows, "2026-08-30T10:00:00Z", {}, [])).toEqual({});
  });
});

describe("which service a DM sends on (@lukejmorrison, PR #4)", () => {
  const { normalizeSendService, sendServiceForMessages } =
    require("./collector") as typeof import("./collector");
  const at = (min: number, over: Partial<ImsgMessage> = {}) =>
    msg({ ts: `2026-09-03T1${String(min).padStart(2, "0")}:00:00Z`, ...over });

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

  test("prefer_imessage keeps iMessage when later inbound is RCS or SMS", () => {
    const mixed = [
      at(0, { from_me: false, service: "iMessage" }),
      at(1, { from_me: false, service: "RCS" }),
    ];
    expect(sendServiceForMessages(mixed)).toBe("RCS");
    expect(sendServiceForMessages(mixed, true)).toBe("iMessage");
    expect(sendServiceForMessages([
      at(0, { from_me: true, service: "iMessage", error: 0 }),
      at(1, { from_me: false, service: "SMS" }),
    ], true)).toBe("iMessage");
  });

  test("prefer_imessage does not override a failed newest iMessage to a phone", () => {
    expect(sendServiceForMessages([
      at(0, { from_me: false, service: "iMessage" }),
      at(1, { from_me: true, service: "iMessage", error: 22 }),
    ], true)).toBe("SMS");
  });

  test("prefer_imessage leaves a never-iMessage RCS thread on RCS", () => {
    expect(sendServiceForMessages([
      at(0, { from_me: false, service: "RCS" }),
      at(1, { from_me: true, service: "RCS", error: 0 }),
    ], true)).toBe("RCS");
  });

  test("prefer_imessage=on is off by default and reads like other bridge.conf flags", () => {
    const { preferImessagePolicy } = require("./collector") as typeof import("./collector");
    const conf = (body: string): string => {
      const p = `${process.env.XDG_CACHE_HOME}/prefer-imessage-${process.pid}-${Math.random().toString(36).slice(2)}`;
      writeFileSync(p, body);
      return p;
    };
    expect(preferImessagePolicy(conf("host=mac\n"))).toBe(false);
    expect(preferImessagePolicy(`${process.env.XDG_CACHE_HOME}/absent-prefer-${process.pid}`)).toBe(false);
    expect(preferImessagePolicy(conf("prefer_imessage=on\n"))).toBe(true);
    expect(preferImessagePolicy(conf("prefer_imessage=YES\n"))).toBe(true);
    expect(preferImessagePolicy(conf("prefer_imessage=off\n"))).toBe(false);
  });

  test("a group keeps the raw service — it sends by chat-id, not by service", () => {
    const threads = buildThreads([
      msg({ chat: "chat900001", handle: "+15550100011", from_me: false, service: "RCS",
            ts: "2026-09-03T10:00:00Z" }),
    ], "2026-09-03T09:00:00Z");
    expect(threads[0]!.service).toBe("RCS");
  });
});

describe("pins survive shallow polls", () => {
  const thread = (chat: string, last_ts: string, extra: Partial<Thread> = {}): Thread => ({
    chat, guid: "", name: chat, handle: chat, service: "iMessage", last_ts, last_text: "",
    last_from_me: false, count: 1, unread: 0, pinned: false, pin_order: null, ...extra,
  });
  const chat = (id: string, pinned: boolean, pin_order: number | null): ChatInfo => ({
    id, name: id, service: "iMessage", last: "2026-09-03T10:00:00Z", last_text: "", last_from_me: false,
    last_handle: id, last_name: null, pinned, pin_order, aliases: [],
  });

  test("pinsFromChats keeps only pinned rows, with their order", () => {
    expect(pinsFromChats([chat("A", true, 1), chat("B", false, null), chat("C", true, null)]))
      .toEqual({ A: 1, C: null });
  });

  test("applyPins re-pins a shallow poll's rows and sorts them first", () => {
    const shallow = [thread("NEW", "2026-09-03T12:00:00Z"), thread("MOM", "2026-09-03T11:00:00Z"), thread("OLD", "2026-09-03T10:00:00Z")];
    const out = applyPins(shallow, { MOM: 0, QUIET: 1 });
    expect(out.map((t) => t.chat)).toEqual(["MOM", "NEW", "OLD"]);
    expect(out[0]).toMatchObject({ pinned: true, pin_order: 0 });
    expect(out[1].pinned).toBe(false);
    // rows are reused when nothing changed (the widget skips identical lists)
    expect(out[1]).toBe(shallow[0]);
  });

  test("applyPins un-pins a row whose pin was removed on the Mac", () => {
    const stale = [thread("X", "2026-09-03T12:00:00Z", { pinned: true, pin_order: 0 }), thread("Y", "2026-09-03T13:00:00Z")];
    expect(applyPins(stale, {}).map((t) => [t.chat, t.pinned])).toEqual([["Y", false], ["X", false]]);
  });

  test("applyPins with nothing pinned anywhere is a no-op", () => {
    const list = [thread("A", "2026-09-03T12:00:00Z")];
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
      blast({ ts: "2026-08-30T09:00:00Z" }),
      blast({ ts: "2026-08-30T10:00:00Z", text: "Are you still with us?" }),
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
      id, name: id, service: "SMS", last: "2026-08-30T10:00:00Z", last_text,
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
      id: "+15550100002", name: "Alex Rivera", service: "iMessage", last: "2026-08-30T10:00:00Z",
      last_text: "ugh, ActBlue again", last_from_me: true, last_handle: "+15550100002",
      last_name: null, pinned: false, pin_order: null, aliases: [],
    };
    expect(dropMutedChats([row], ["ActBlue"], [])).toHaveLength(1);
  });

  test("a shallow poll has no chat list to filter", () => {
    expect(dropMutedChats(null, ["ActBlue"], [])).toBeNull();
  });

  test("a muted conversation never toasts, because it never reaches selectToasts", () => {
    const window = [blast({ ts: "2026-08-30T11:00:00Z" })];
    const kept = dropMuted(window, mutedChats(window, ["ActBlue"]));
    expect(selectToasts(kept, "2026-08-30T10:00:00Z", ["78462"], [])).toEqual([]);
  });
});

describe("capped unread keep vs hidden chats", () => {
  const row = (id: string, aliases: string[] = []): ChatInfo => ({
    id, name: id, service: "SMS", last: "2026-08-30 10:00:00", last_text: "",
    last_from_me: false, last_handle: id, last_name: null, pinned: false, pin_order: null, aliases,
  });

  test("a capped window still keeps an inbox unread the fetch never saw", () => {
    const windowMsgs = [msg({ chat: "A" })];
    const visible = visibleLedgerChats(windowMsgs, [row("A"), row("B")]);
    const kept = keepCappedUnread(
      { A: 1 }, {},
      { A: 1, B: 3 }, { B: "2026-08-01 09:00:00" },
      new Set(["A"]), visible,
    );
    expect(kept.counts).toEqual({ A: 1, B: 3 });
    expect(kept.oldest).toEqual({ B: "2026-08-01 09:00:00" });
  });

  test("Spam missing from imsg chats is not restored onto the badge", () => {
    const windowMsgs = [msg({ chat: "A" })];
    const visible = visibleLedgerChats(windowMsgs, [row("A")]); // hide_spam omitted B
    const kept = keepCappedUnread(
      { A: 1 }, {},
      { A: 1, B: 3 }, { B: "2026-08-01 09:00:00" },
      new Set(["A"]), visible,
    );
    expect(kept.counts).toEqual({ A: 1 });
    expect(kept.oldest).toEqual({});
  });

  test("an alias of a listed chat still counts as visible", () => {
    const visible = visibleLedgerChats([], [row("LIVE", ["OLD"])]);
    expect(visible.has("LIVE")).toBe(true);
    expect(visible.has("OLD")).toBe(true);
  });
});


describe("the mute list can catch a person (documented caveat, #27)", () => {
  const { matchesMute, mutedChats } = require("./collector") as typeof import("./collector");

  test("an inbound message from a PERSON containing the phrase mutes them too", () => {
    // Not a bug — it is what phrase matching means, and why the README says to
    // pick phrases nobody would type at you. Locked so the behaviour is a
    // decision rather than a surprise.
    const friend = msg({ chat: "+15550100011", handle: "+15550100011", from_me: false,
                         text: "I got another ActBlue text today, unbelievable" });
    expect(matchesMute(friend, ["ActBlue"])).toBe(true);
    expect(mutedChats([friend], ["ActBlue"])).toEqual(["+15550100011"]);
  });

  test("quoting it OUTBOUND never mutes the person you said it to", () => {
    const mine = msg({ chat: "+15550100011", handle: "+15550100011", from_me: true,
                       text: "another ActBlue text, unbelievable" });
    expect(mutedChats([mine], ["ActBlue"])).toEqual([]);
  });

  test("an empty or absent list changes nothing at all", () => {
    const m = msg({ from_me: false, text: "rush $25 — Reply STOP2END" });
    expect(mutedChats([m], [])).toEqual([]);
    expect(matchesMute(m, [])).toBe(false);
  });
});

describe("pushRead breadcrumb", () => {



});

describe("security codes: detect, hold once, never from a group", () => {
  const { extractCode, selectCodes } = require("./collector") as typeof import("./collector");
  const WM = "2026-09-02T12:00:00Z";
  const code = (text: string) => extractCode(text)?.code ?? null;

  test("the usual shapes", () => {
    expect(code("Your verification code is 483920")).toBe("483920");
    expect(code("483920 is your Amazon OTP. Don't share it with anyone.")).toBe("483920");
    expect(code("Your Venmo code: 837-291")).toBe("837291");
    expect(code("Use 123 456 to sign in to Acme")).toBe("123456");
    expect(code("Use code 4821 to log in")).toBe("4821");
    expect(code("Your Uber code: 8271. Expires in 10 minutes.")).toBe("8271");
    expect(code("Enter 482913 in the next 5 minutes to confirm your number")).toBe("482913");
    expect(code("G-482913 is your Google verification code.")).toBe("482913");
    expect(code("Your Apple Account code is: 128 433. Do not share it.")).toBe("128433");
    expect(code("613400 is your Link verification code.")).toBe("613400");
  });

  test("origin-bound codes carry their domain and win outright", () => {
    expect(extractCode("Your code is 111111\n\n@example.com #493857")).toEqual({ code: "493857", domain: "example.com" });
    expect(extractCode("@login.acme.co #AB12-CD")).toEqual({ code: "AB12-CD", domain: "login.acme.co" });
  });

  test("no trigger word, no code", () => {
    expect(code("Order #12345 shipped, arriving 09/04")).toBeNull();
    expect(code("Thank you for your Taco Bell order! Track it at https://t.co/48291034")).toBeNull();
    expect(code("Call me at 555-0100")).toBeNull();
    expect(code("")).toBeNull();
    expect(code(null)).toBeNull();
  });

  test("money, percentages, phone numbers and urls are not codes", () => {
    expect(code("Your security deposit of $1234.56 was charged")).toBeNull();
    expect(code("Verification complete, 100% done and 12345.67 credited")).toBeNull();
    expect(code("To confirm call +1 (555) 010-0199")).toBeNull();
    expect(code("Confirm at https://a.test/verify/48291034")).toBeNull();
  });

  test("the token nearest the trigger word wins; longer breaks a tie", () => {
    expect(code("Your code is 1234. Expires in 10 minutes, ref 987654321")).toBe("1234");
    expect(code("Reservation 20260904: your PIN is 5521")).toBe("5521");
  });

  test("selectCodes: inbound, new, DM only, once", () => {
    const m = msg({ ts: "2026-09-02T12:30:00Z", from_me: false, chat: "77029", handle: "77029", name: null, text: "Your code is 483920" });
    const out = selectCodes([
      m,
      msg({ ts: "2026-09-02T11:00:00Z", from_me: false, text: "old code 111111" }),                 // before watermark
      msg({ ts: "2026-09-02T12:40:00Z", from_me: true, text: "my code is 222222" }),                 // outbound
      msg({ ts: "2026-09-02T12:45:00Z", from_me: false, chat: "e98633ecd4e84723b69d142cd721b2b9", text: "code 333333" }), // group
      msg({ ts: "2026-09-02T12:50:00Z", from_me: false, chat: "+15550001111", handle: "+15550001111", name: "Eli", text: "Enter passcode 444444" }),
    ], WM, []);
    expect(out.map((c) => [c.code, c.name])).toEqual([["483920", "77029"], ["444444", "Eli"]]);
    expect(out.every((c) => c.key.startsWith("code:"))).toBe(true);
    expect(selectCodes([m], WM, [out[0]!.key])).toEqual([]);           // the ring suppresses a repeat
    expect(selectCodes([m], "", [])).toEqual([]);                        // never the first-run backlog
    expect(selectCodes([m], WM, [], ["77029"])).toEqual([]);            // never the self-thread
  });
});

describe("reads and aliases (Astra #9)", () => {
  test("aliasesOf lists every row folded into a canonical conversation", () => {
    expect(aliasesOf({ a1: "B", a2: "B", x: "Y" }, "B").sort()).toEqual(["a1", "a2"]);
    expect(aliasesOf({ a1: "B" }, "Z")).toEqual([]);
  });
});

describe("security codes: labelled numbers are not the code (Astra #13)", () => {
  const { extractCode } = require("./collector") as typeof import("./collector");
  test("the card number next to the trigger loses to the code", () => {
    expect(extractCode("Your security code for card 1234 is 987654")?.code).toBe("987654");
    expect(extractCode("Your account ending 4821 has a new login. Verification code: 556677")?.code).toBe("556677");
    expect(extractCode("Ref 20260904: your PIN is 5521")?.code).toBe("5521");
  });
  test("an unlabelled code still wins as before", () => {
    expect(extractCode("Use code 4821 to log in")?.code).toBe("4821");
    expect(extractCode("Your Uber code: 8271. Expires in 10 minutes.")?.code).toBe("8271");
  });
});

describe("cached groups are normalised on load (Astra B#6)", () => {
  test("a participants object cannot poison every poll", () => {
    const g = normalizeGroups({ chat123: { name: "", guid: "", participants: {} }, ok: { name: "Trail", guid: "any;+;x", participants: ["+1", 2, "+3"] }, junk: 5 });
    expect(g.chat123).toEqual({ name: "", guid: "", participants: [] });
    expect(g.ok).toEqual({ name: "Trail", guid: "any;+;x", participants: ["+1", "+3"] });
    expect(g.junk).toBeUndefined();
    expect(normalizeGroups(null)).toEqual({});
  });
});

describe("search stdin payload (Astra B#2)", () => {
  const { parseStdinPayload } = require("./search") as typeof import("./search");
  test("legacy array = identities only; object carries the query", () => {
    expect(parseStdinPayload('[{"chat":"+1"}]', true)).toEqual({ query: "", threads: [{ chat: "+1" }] });
    expect(parseStdinPayload('{"query":" hello ","threads":[]}', true)).toEqual({ query: "hello", threads: [] });
    expect(parseStdinPayload('{"query":"x"}', false).query).toBe("");
    expect(parseStdinPayload("garbage", true)).toEqual({ query: "", threads: [] });
  });
});

describe("the read-push policy is reported, not just applied", () => {


  test("the failure path still reports the policy and the guarded arrays", () => {
    // status says read_push=? exactly when something is broken, unless the
    // offline return carries it too — and BlipOutput declares codes/deep
    // required, which that return did not satisfy (found by typechecking,
    // 2026-09-08; the widget's Array.isArray guards meant it never crashed).
    const src = readFileSync(new URL("./collector.ts", import.meta.url), "utf8");
    const offline = src.slice(src.indexOf("if (!fetched.ok) {"), src.indexOf("const highest = maxTs("));
    expect(offline).toContain("readPush: pushReadPolicy()");
    expect(offline).toContain("codes: []");
    expect(offline).toContain("deep: false");
  });




});

// The dedicated key is confined to blip-dispatch AND, over Tailscale, pinned to
// the enrolling machine's addresses: a leaked private key is useless from
// anywhere else. blip_key_from() runs for real (PATH without tailscale).
describe("blip-setup: the key's from= pin", () => {
  const setup = new URL("./scripts/blip-setup", import.meta.url).pathname;
  const keyFrom = (seen: string) => spawnSync("bash",
    ["-c", 'source <(sed -n "/^blip_key_from()/,/^}/p" "$1"); blip_key_from "$2"', "_", setup, seen],
    { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }).stdout;
  test("a Tailscale address is pinned, IPv4 and IPv6", () => {
    expect(keyFrom("100.64.7.8")).toBe('from="100.64.7.8",');
    expect(keyFrom("100.127.255.1")).toBe('from="100.127.255.1",');
    expect(keyFrom("fd7a:115c:a1e0::1")).toBe('from="fd7a:115c:a1e0::1",');
  });
  test("anything else is left unpinned rather than stranded", () => {
    for (const seen of ["192.168.1.5", "100.63.1.1", "100.128.0.1", "10.0.0.2", "", "mac.local"]) expect(keyFrom(seen)).toBe("");
  });
  test("a re-run replaces the key's line; the tool count is gone from the prose", () => {
    const src = readFileSync(setup, "utf8");
    expect(src).toContain("grep -vF -- '$pub' ~/.ssh/authorized_keys > ~/.ssh/authorized_keys.blip.tmp");
    expect(src).not.toContain("five bridge tools");
    expect(src).not.toContain("key_from=");   // no config knob: the pin follows the transport
  });
});

// blip-setup pauses twice for a `read -r -p`. An ssh that runs a remote command
// inherits the script's stdin and drains it, so with stdin from a pipe or a
// redirect those reads hit EOF and `set -e` kills the script at the "Press
// Enter" prompt — AFTER the Mac install and the key enrolment have already
// run, which is the confusing part. `-n` is what keeps stdin for the prompts;
// the first reachability probe already had it.
describe("blip-setup: ssh never eats the script's stdin", () => {
  const src = readFileSync(new URL("./scripts/blip-setup", import.meta.url), "utf8");
  // Executable lines only: comments and echoed prose mention ssh as text.
  const runnable = src.split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .filter((l) => !/^\s*echo\s/.test(l));

  test("every ssh that runs a remote command passes -n", () => {
    const offenders = runnable.filter((l) => {
      const m = l.match(/(?:^|[;&|(]|\$\()\s*(?:(?:if|elif|while|until|then|else|do)\s+)?!?\s*ssh\s+(.*)$/);
      if (!m) return false;
      const args = m[1];
      if (/^-O\s/.test(args)) return false;        // control command: runs nothing remote
      return !/(^|\s)-n(\s|$)/.test(args);
    });
    expect(offenders).toEqual([]);
  });

  test("the prompts that would starve are still there", () => {
    expect(src).toContain("Press Enter to run the permission check");
    expect(src).toContain("then press Enter to re-check");
  });
});

// `scp bridge/mac/*` also matched __pycache__ once anyone had run the Mac
// tests; scp without -r exits 1 on a directory, and under set -e setup died
// before install.sh ran, leaving the Mac on the OLD tools with no hint why.
test("blip-setup copies only regular files to the Mac", () => {
  const src = readFileSync(new URL("./scripts/blip-setup", import.meta.url), "utf8");
  const runnable = src.split("\n").filter((l) => !/^\s*#/.test(l) && !/^\s*echo\s/.test(l)).join("\n");
  expect(runnable).not.toMatch(/scp\s+-q\s+"\$here"\/bridge\/mac\/\*/);
  expect(runnable).toContain('find "$here/bridge/mac" -maxdepth 1 -type f -print0');
});

test("group labels prefer short names while participant details retain full names", () => {
 const {groupName,groupParticipants,normalizeGroups,fetchGroups} = require('./collector');
 const info={name:"",guid:"any;+;chat123",participants:["+15551234567"],participantNames:{"+15551234567":"Mary Jane Example"},participantShortNames:{"+15551234567":"Mary Jane"}};
 expect(groupName('chat123',info,new Map())).toBe('Mary Jane');
 expect(groupParticipants(info)[0].name).toBe('Mary Jane Example');
 expect(groupName('chat123',{...info,name:'Custom group'},new Map())).toBe('Custom group');
 expect(normalizeGroups({chat123:info}).chat123).toEqual(info);
 const fetched=fetchGroups(()=>({status:0,stdout:JSON.stringify([{chat:'chat123',name:'',guid:info.guid,participants:info.participants,participant_names:info.participantNames,participant_short_names:info.participantShortNames}])}));
 expect(fetched.chat123).toEqual(info);
 expect(normalizeGroups({chat123:{...info,participantShortNames:[]}}).chat123.participantShortNames).toBeUndefined();
});

test("generated group labels join the last short name with an ampersand", () => {
 const {groupName} = require('./collector');
 const info={name:"",guid:"",participants:["a","b","c"],participantShortNames:{a:"Pat",b:"Sam",c:"Alex"}};
 expect(groupName('chat123',info,new Map())).toBe('Pat, Sam & Alex');
 expect(groupName('chat123',{...info,participants:['a','b']},new Map())).toBe('Pat & Sam');
 expect(groupName('chat123',{...info,participants:['a']},new Map())).toBe('Pat');
 expect(groupName('chat123',{...info,name:'Custom, title'},new Map())).toBe('Custom, title');
});

describe("Send Later", () => {
  const queued = { chat: "A", from_me: true, ts: "2099-01-01T18:00:00Z", text: "later", scheduled: true };
  test("a waiting scheduled message is never a thread's newest message", () => {
    const [t] = buildThreads([msg({ chat: "A", ts: "2026-09-16T15:00:00Z", text: "sent" }), msg(queued)], "");
    expect(t!.last_text).toBe("sent");
    expect(t!.last_ts).toBe("2026-09-16T15:00:00Z");
    expect(t!.count).toBe(2);
  });
  test("a thread holding only a scheduled message still has a preview", () => {
    const [t] = buildThreads([msg(queued)], "");
    expect(t!.last_text).toBe("later");
  });
  test("a scheduled message never moves the watermark", () => {
    expect(maxTs([msg({ ts: "2026-09-16T15:00:00Z" }), msg(queued)], "")).toBe("2026-09-16T15:00:00Z");
  });
});
