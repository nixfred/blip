import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canTapback, initialTapbackCursor, moveTapbackCursor, myTapback, tapbackForKey, pendingAfterLoad, SETTLE_TRIES, pendingTapback, shownTapbacks, TAPBACKS, tapbackArgs, tapbackFailure, tapbackKind, TAPBACK_NOT_STARTED,
  tapbackSettled, tapbacksOn, validReactionEmoji, emojiKind, reactionEmoji, tapbackRequest, searchReactionEmoji,
} from "./tapback-actions";
import { EMOJI_CATALOGUE } from "./emoji-catalogue";

const text = { guid: "ABC-123", text: "see you at eight", attachments: [], link: null };

test("the six classic tapbacks, named as imsg-react names them", () => {
  expect(TAPBACKS.map((t) => t.kind)).toEqual(["love", "like", "dislike", "laugh", "emphasize", "question"]);
  const tool = Bun.file(new URL("./bridge/mac/imsg-react", import.meta.url));
  return tool.text().then((src) => {
    for (const { kind } of TAPBACKS) expect(src).toContain(`"${kind}": (`);
  });
});

test("the emoji imsg reports map back to a kind, with or without the variation selector", () => {
  expect(tapbackKind("❤️")).toBe("love");
  expect(tapbackKind("❤")).toBe("love");
  expect(tapbackKind("‼")).toBe("emphasize");
  expect(tapbackKind("😂")).toBe("laugh");
  expect(tapbackKind("🚀")).toBe("");
});

test("yours preserves classic/custom identity and ignores others", () => {
  expect(myTapback(null)).toBe("");
  expect(myTapback({ tapbacks: [{ emoji: "👍", from_me: false }] })).toBe("");
  expect(myTapback({ tapbacks: [{ emoji: "👍", from_me: false }, { emoji: "😂", from_me: true }] })).toBe("laugh");
  expect(myTapback({ tapbacks: [{ emoji: "🚀", from_me: true }] })).toBe("emoji:🚀");
  expect(myTapback({ tapbacks: [{ emoji: "👍", from_me: true, kind: "emoji" }] })).toBe("emoji:👍");
  expect(myTapback({ tapbacks: [{ emoji: "⭐", from_me: true, kind: "sticker" }] })).toBe("");
});

test("single-emoji grammar accepts the full catalogue and rejects prose/multiple emoji", () => {
  expect(EMOJI_CATALOGUE.length).toBeGreaterThan(3900);
  for (const [emoji] of EMOJI_CATALOGUE) expect(validReactionEmoji(emoji)).toBe(true);
  for (const value of ["", "hello", "日本語", "🚀🚀", "hello🚀", "🚀\n", "🇺", "🏽", "\u200d🚀", "🚀\u200d", "a".repeat(65)])
    expect(validReactionEmoji(value)).toBe(false);
  for (const emoji of ["👩🏽‍💻", "👨‍👩‍👧‍👦", "🇬🇧", "1️⃣", "❤️"])
    expect(reactionEmoji(emojiKind(emoji))).toBe(emoji);
});

test("custom emoji, including search metadata, travels only on stdin", () => {
  const request = tapbackRequest("G", "emoji:🚀", "emoji:🚀")!;
  expect(request.args).toEqual(["--guid", "G", "--emoji-stdin", "--remove", "--yes"]);
  expect(JSON.parse(request.stdin)).toEqual({ emoji: "🚀", name: "rocket" });
  expect(request.args.join(" ")).not.toContain("🚀");
  expect(tapbackRequest("G", "emoji:👍", "like")!.args).not.toContain("--remove");
  expect(tapbackRequest("G", "love", "love")).toEqual({args: ["--guid", "G", "love", "--remove", "--yes"], stdin: ""});
  expect(tapbackRequest("G;bad", "love", "")).toBeNull();
  expect(tapbackRequest("G", "emoji:hello", "")).toBeNull();
  expect(tapbackArgs("G", "emoji:🚀", "")).toEqual([]);
});

test("search supports categories, compound names, skin tones, and direct paste", () => {
  expect(searchReactionEmoji("rocket")[0].emoji).toBe("🚀");
  expect(searchReactionEmoji("rocket", "Animals & Nature")).toEqual([]);
  expect(searchReactionEmoji("woman technologist medium skin").some((r) => r.emoji === "👩🏽‍💻")).toBe(true);
  expect(searchReactionEmoji("👩🏽‍💻")[0].kind).toBe("emoji:👩🏽‍💻");
  expect(searchReactionEmoji("not-a-real-emoji-name")).toEqual([]);
});

test("custom pending state replaces yours and waits for the exact emoji", () => {
  const p = pendingTapback("chat", "ABC-123", "emoji:🚀", "emoji:🎉");
  const message = { ...text, tapbacks: [{emoji:"🎉",from_me:true,kind:"emoji"}] };
  expect(shownTapbacks(message, p)).toEqual([{emoji:"🚀",from_me:true,pending:true}]);
  expect(tapbackSettled(message, p)).toBe(false);
  expect(tapbackSettled({ ...text, tapbacks:[{emoji:"🚀",from_me:true,kind:"emoji"}] }, p)).toBe(true);
  const customLike = pendingTapback("chat", "ABC-123", "emoji:👍", "");
  expect(tapbackSettled({ ...text, tapbacks:[{emoji:"👍",from_me:true}] }, customLike)).toBe(false);
});

test("offered only where imsg-react acts: a delivered text bubble in a 1:1", () => {
  expect(canTapback(text, false)).toBe(true);
  expect(canTapback(text, true)).toBe(false);
  expect(canTapback(null, false)).toBe(false);
  for (const over of [
    { guid: "" }, { text: "  " }, { attachments: [{ name: "a.png" }] }, { link: { url: "https://example.com" } },
    { text: "look at https://example.com" }, { text: "www.example.com" }, { retracted: true }, { audio: true },
    { pending: true }, { failed: true }, { scheduled: true },
  ]) expect(canTapback({ ...text, ...over }, false)).toBe(false);
});

test("choosing the tapback you have removes it; any other adds (and replaces)", () => {
  expect(tapbackArgs("G", "love", "")).toEqual(["--guid", "G", "love", "--yes"]);
  expect(tapbackArgs("G", "love", "love")).toEqual(["--guid", "G", "love", "--remove", "--yes"]);
  expect(tapbackArgs("G", "laugh", "love")).toEqual(["--guid", "G", "laugh", "--yes"]);
});

test("a failure is one line: the tool's own reason, or why the Mac did not answer", () => {
  expect(tapbackFailure(69, "")).toBe("tapback: Mac unreachable");
  expect(tapbackFailure(255, "ssh: connect")).toBe("tapback: Mac unreachable");
  expect(tapbackFailure(1, "{…}\nimsg-react: the bubble does not offer 'Heart'; nothing was done\n"))
    .toBe("tapback: the bubble does not offer 'Heart'; nothing was done");
  expect(tapbackFailure(75, "")).toBe("tapback: imsg-react exit 75");
  // a stray did send, on another message: the prefix must not say otherwise
  expect(tapbackFailure(75, "imsg-react: a tapback of yours changed on another message; check it in Messages\n"))
    .toBe("tapback: a tapback of yours changed on another message; check it in Messages");
  // the tool never started: same prefix, so the next tapback clears it too
  expect(TAPBACK_NOT_STARTED.indexOf("tapback: ")).toBe(0);
});

test("a 69 from imsg-react itself says its reason, not 'Mac unreachable'", () => {
  // the locked-gateway report (2026-11-09): the Mac answered ssh; the tool
  // exited 69 saying the screen was locked, and the status line claimed the
  // Mac was unreachable while sends through the same bridge worked.
  expect(tapbackFailure(69, '{ok:false}\nimsg-react: the Mac\'s screen is locked, so System Events can reach no window; unlock it\n'))
    .toBe("tapback: the Mac's screen is locked, so System Events can reach no window; unlock it");
  expect(tapbackFailure(69, "imsg-react: Messages has no accessible window; log in and open Messages on the Mac\n"))
    .toBe("tapback: Messages has no accessible window; log in and open Messages on the Mac");
  // 69 WITH the shim's own translation marker stays a transport failure —
  // the marker line itself starts "imsg-react:", so the reason rule must not
  // read it as the tool's, and must not echo the host either.
  expect(tapbackFailure(69, "ssh: connect to host timed out\nimsg-react: you@your-mac unreachable — the iMessage bridge is offline.\n"))
    .toBe("tapback: Mac unreachable");
});

test("tapbacks= is off unless it says on/yes/true/1", () => {
  expect(tapbacksOn("")).toBe(false);
  expect(tapbacksOn("host=mac\n")).toBe(false);
  expect(tapbacksOn("tapbacks=on")).toBe(true);
  expect(tapbacksOn("tapbacks = 'YES'  # enabled\n")).toBe(true);
  expect(tapbacksOn("tapbacks=onward")).toBe(false);
  expect(tapbacksOn("tapbacks=on\ntapbacks=off\n")).toBe(false);
  expect(tapbacksOn("# tapbacks=on\n")).toBe(false);
});

test("the deployed QML module agrees with tapback-actions.ts", async () => {
  const runtime = await import("./TapbackActions.mjs");
  expect(runtime.TAPBACKS).toEqual(TAPBACKS);
  for (const conf of ["tapbacks=on", "tapbacks=off", "tapbacks=\"1\" # x"]) expect(runtime.tapbacksOn(conf)).toBe(tapbacksOn(conf));
  expect(runtime.canTapback(text, false)).toBe(true);
  expect(runtime.tapbackArgs("G", "love", "love")).toEqual(tapbackArgs("G", "love", "love"));
  expect(runtime.myTapback({ tapbacks: [{ emoji: "❤", from_me: true }] })).toBe("love");
  expect(runtime.tapbackFailure(1, "imsg-react: x")).toBe(tapbackFailure(1, "imsg-react: x"));
  expect(runtime.TAPBACK_NOT_STARTED).toBe(TAPBACK_NOT_STARTED);
});

describe("a tapback on its way", () => {
  const theirs = { emoji: "👍", from_me: false };
  const bubble = (tapbacks: { emoji: string; from_me: boolean }[]) => ({ ...text, tapbacks });

  test("an add is drawn at once, pending, in place of yours; theirs stay", () => {
    const p = pendingTapback("chat", "ABC-123", "laugh", "love");
    expect(p).toEqual({ chat: "chat", guid: "ABC-123", kind: "laugh", remove: false, done: false, tries: 0 });
    expect(shownTapbacks(bubble([theirs, { emoji: "❤️", from_me: true }]), p))
      .toEqual([theirs, { emoji: "😂", from_me: true, pending: true }]);
  });

  test("a removal keeps yours, pending, until chat.db has it gone", () => {
    const p = pendingTapback("chat", "ABC-123", "love", "love");
    expect(p.remove).toBe(true);
    expect(shownTapbacks(bubble([{ emoji: "❤️", from_me: true }]), p)).toEqual([{ emoji: "❤️", from_me: true, pending: true }]);
    expect(shownTapbacks(bubble([theirs]), p)).toEqual([theirs]);
  });

  test("other bubbles, and a bubble that already shows the answer, draw as chat.db has them", () => {
    const p = pendingTapback("chat", "ABC-123", "love", "");
    const settled = bubble([{ emoji: "❤️", from_me: true }]);
    expect(tapbackSettled(settled, p)).toBe(true);
    expect(shownTapbacks(settled, p)).toBe(settled.tapbacks);
    expect(shownTapbacks({ ...text, guid: "OTHER", tapbacks: [theirs] }, p)).toEqual([theirs]);
    expect(shownTapbacks(bubble([theirs]), null)).toEqual([theirs]);
  });

  test("a load settles it when the answer shows", () => {
    const p = pendingTapback("chat", "ABC-123", "love", "");
    expect(pendingAfterLoad(p, "chat", [bubble([])], false)).toBe(p);
    expect(pendingAfterLoad(p, "chat", [bubble([{ emoji: "❤️", from_me: true }])], false)).toBeNull();
    expect(pendingAfterLoad(p, "chat", [bubble([{ emoji: "❤️", from_me: true }])], true)).toBeNull();
    expect(pendingAfterLoad(p, "other", [bubble([])], true)).toBe(p);
    expect(pendingAfterLoad(null, "chat", [], true)).toBeNull();
  });

  test("after the tool is done, a lagging chat.db is given a few loads, then the last word", () => {
    // a self-thread removal: your row is gone, the echo from your own address not yet
    const p = { ...pendingTapback("chat", "ABC-123", "love", "love"), done: true };
    const lagging = [bubble([{ emoji: "❤️", from_me: true }])];
    let q: typeof p | null = p;
    for (let i = 1; i < SETTLE_TRIES; i++) {
      q = pendingAfterLoad(q, "chat", lagging, true);
      expect(q?.tries).toBe(i);
    }
    expect(pendingAfterLoad(q, "chat", lagging, true)).toBeNull();
    expect(pendingAfterLoad(p, "chat", [bubble([])], true)).toBeNull();
    // gone from the load altogether: nothing left to wait on
    expect(pendingAfterLoad(p, "chat", [], true)).toBeNull();
  });
});

// bun build --target browser leaves object spread and rest in the bundle, and
// QML's JS engine cannot parse them: one `{ ...p }` in a module the widget
// imports takes the whole plugin down at load. Array spread is fine.
test("no QML module uses object spread or rest", () => {
  const dir = new URL(".", import.meta.url).pathname;
  const offenders: string[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".mjs"))) {
    const src = readFileSync(join(dir, name), "utf8");
    for (let at = src.indexOf("..."); at >= 0; at = src.indexOf("...", at + 3)) {
      let depth = 0;
      for (let i = at - 1; i >= 0; i--) {
        const c = src[i];
        if (c === ")" || c === "]" || c === "}") depth++;
        else if (c === "(" || c === "[" || c === "{") {
          if (depth > 0) { depth--; continue; }
          if (c === "{") offenders.push(`${name}:${src.slice(0, at).split("\n").length}`);
          break;
        }
      }
    }
  }
  expect(offenders).toEqual([]);
});

test("1–6 pick the tapbacks in the row's order; nothing else is one", () => {
  expect(["1", "2", "3", "4", "5", "6"].map(tapbackForKey)).toEqual(TAPBACKS.map((t) => t.kind));
  for (const k of ["", "0", "7", "12", "a", " ", "\r"]) expect(tapbackForKey(k)).toBe("");
});

test("Left/Right go round the row; from no selection, Right is the first and Left the last", () => {
  expect(moveTapbackCursor(-1, 1)).toBe(0);
  expect(moveTapbackCursor(-1, -1)).toBe(5);
  expect(moveTapbackCursor(0, 1)).toBe(1);
  expect(moveTapbackCursor(5, 1)).toBe(0);
  expect(moveTapbackCursor(0, -1)).toBe(5);
  expect(moveTapbackCursor(3, -1)).toBe(2);
  expect(moveTapbackCursor(9, 1)).toBe(0);
  expect(moveTapbackCursor(0, 1, 0)).toBe(-1);
});

test("the marker starts on yours; with none, on the first from the keyboard, nowhere from the mouse", () => {
  expect(initialTapbackCursor("laugh", true)).toBe(3);
  expect(initialTapbackCursor("laugh", false)).toBe(3);
  expect(initialTapbackCursor("", true)).toBe(0);
  expect(initialTapbackCursor("", false)).toBe(-1);
});
