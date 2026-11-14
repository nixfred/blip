// Outgoing tapbacks: which bubbles offer them, which one is yours, and the
// argv for the Mac's imsg-react. Opt-in with `tapbacks=on` in bridge.conf
// (#69); the shim refuses the tool without it, so this is the menu's half of
// the same key, never the only gate.
//
// Pure, shared with the QML renderer. Rebuild the QML module:
//   bun build tapback-actions.ts --target browser --format esm --outfile TapbackActions.mjs
import { EMOJI_CATALOGUE } from "./emoji-catalogue";

export const EMOJI_GROUPS = ["All", "Smileys & Emotion", "People & Body", "Animals & Nature", "Food & Drink", "Travel & Places", "Activities", "Objects", "Symbols", "Flags"];
export interface ReactionChoice { emoji: string; name: string; kind: string }
const EMOJI_CHOICES: ReactionChoice[] = EMOJI_CATALOGUE.map((r) => ({ emoji: r[0], name: r[1], kind: "emoji:" + r[0] }));
const EMOJI_NAMES = new Map(EMOJI_CATALOGUE.map((r) => [r[0], r[1]]));

/** The grid is virtualized in QML; searching and category policy live here.
 *  Pasting a valid sequence always exposes that exact emoji as the first hit. */
export function searchReactionEmoji(query: string, group = "All"): ReactionChoice[] {
  const q = String(query || "").trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const choices = EMOJI_CHOICES.filter((r, i) => (group === "All" || EMOJI_CATALOGUE[i][2] === group)
    && (r.emoji === q || words.every((w) => r.name.toLowerCase().includes(w))));
  if (validReactionEmoji(q) && !choices.some((r) => r.emoji === q)) choices.unshift({ emoji: q, name: EMOJI_NAMES.get(q) || "Custom emoji", kind: "emoji:" + q });
  return choices;
}

/** The six classic tapbacks, in Messages' order: imsg-react's names and the
 *  emoji imsg reports for them on the read path. */
export const TAPBACKS: readonly { kind: string; emoji: string }[] = [
  { kind: "love", emoji: "❤️" },
  { kind: "like", emoji: "👍" },
  { kind: "dislike", emoji: "👎" },
  { kind: "laugh", emoji: "😂" },
  { kind: "emphasize", emoji: "‼️" },
  { kind: "question", emoji: "❓" },
];

/** The menu's number keys: "1" … "6" pick a tapback in the row's order,
 *  anything else is not one (and stays the menu's). */
export function tapbackForKey(text: string): string {
  const i = ["1", "2", "3", "4", "5", "6"].indexOf(String(text || ""));
  return i >= 0 ? TAPBACKS[i].kind : "";
}

/** Where the row's marker starts when the menu opens: on the tapback you
 *  have, so the arrows move from it; with none, on the first when the menu was
 *  opened from the keyboard (Enter picks at once), else nowhere (-1). */
export function initialTapbackCursor(current: string, keyboard: boolean): number {
  const i = TAPBACKS.findIndex((t) => t.kind === current);
  return i >= 0 ? i : keyboard ? 0 : -1;
}

/** Left/Right along the menu's row, round at the ends. From no selection
 *  (-1), Right lands on the first and Left on the last. */
export function moveTapbackCursor(cursor: number, dir: number, n = TAPBACKS.length): number {
  if (n <= 0) return -1;
  if (cursor < 0 || cursor >= n) return dir > 0 ? 0 : n - 1;
  return (cursor + (dir > 0 ? 1 : n - 1)) % n;
}

/** `tapbacks=` read the way blip-shim reads it, so the menu is offered
 *  exactly when the shim lets the tool through: comments and whitespace
 *  dropped, one pair of quotes stripped, the last line wins, on/yes/true/1 in
 *  any case. */
export function tapbacksOn(conf: string): boolean {
  return confOn(conf, "tapbacks");
}

/** `replies=` read the same way: the menu's half of the shim's gate on imsg-reply. */
export function repliesOn(conf: string): boolean {
  return confOn(conf, "replies");
}

function confOn(conf: string, key: string): boolean {
  let v = "";
  for (const raw of String(conf || "").split("\n")) {
    const line = raw.replace(/#.*/, "").replace(/\s+/g, "");
    const eq = line.indexOf("=");
    if (eq < 0 || line.slice(0, eq) !== key) continue;
    v = line.slice(eq + 1).replace(/^"/, "").replace(/"$/, "").replace(/^'/, "").replace(/'$/, "");
  }
  return ["on", "yes", "true", "1"].includes(v.toLowerCase());
}

/** Same rule as imsg-react's LINK: a link turns the bubble into a preview
 *  card, which the tool refuses. */
const LINK = /:\/\/|\bwww\./i;

export interface TapbackTarget {
  guid?: string;
  text?: string;
  attachments?: unknown[] | null;
  link?: unknown;
  retracted?: boolean;
  audio?: boolean;
  pending?: boolean;
  failed?: boolean;
  scheduled?: boolean;
  tapbacks?: { emoji: string; from_me: boolean; kind?: string }[] | null;
}

/** "love" for "❤️" (with or without the emoji variation selector); "" for
 *  anything that is not one of the six, e.g. a custom-emoji tapback. */
export function tapbackKind(emoji: string): string {
  const bare = (s: string) => String(s || "").replace(/️/g, "");
  const hit = TAPBACKS.find((t) => bare(t.emoji) === bare(emoji));
  return hit ? hit.kind : "";
}

/** Preserve custom-emoji identity even when its glyph is one of the classics.
 *  Apple stores those as different types (2006 versus 2000…2005). */
export function myTapback(message: TapbackTarget | null): string {
  for (const t of message?.tapbacks ?? []) {
    if (t.from_me && t.kind !== "sticker") {
      if (t.kind === "emoji") return emojiKind(t.emoji);
      const kind = tapbackKind(t.emoji);
      if (kind) return kind;
      return emojiKind(t.emoji);
    }
  }
  return "";
}

/** True when imsg-react would act on the bubble: a delivered text message in
 *  a 1:1, with no attachment, link or card. Everything else it refuses on the
 *  Mac, so the menu does not offer it. */
export function canTapback(message: TapbackTarget | null, group: boolean): boolean {
  if (!message || group) return false;
  if (!String(message.guid || "")) return false;
  if (message.retracted || message.audio || message.pending || message.failed || message.scheduled) return false;
  if ((message.attachments ?? []).length > 0 || message.link) return false;
  const text = String(message.text || "").trim();
  return text !== "" && !LINK.test(text);
}

/** The arguments after the tool name. Choosing the tapback you already have
 *  removes it, as on the phone; any other replaces it (one per person). The
 *  tool re-reads chat.db and does nothing when the menu's view was stale. */
export function tapbackArgs(guid: string, kind: string, current: string): string[] {
  if (!TAPBACKS.some((t) => t.kind === kind)) return [];
  return ["--guid", guid, kind, ...(current === kind ? ["--remove"] : []), "--yes"];
}

/** Bounded emoji syntax shared with QML: one emoji sequence, never prose.
 *  Accepts ZWJ families/professions, skin tones, flag pairs and keycaps.
 *  Mac validation is independent; an unsupported glyph is never substituted. */
export function validReactionEmoji(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  // QML's Array.from(string) walks UTF-16 units on supported Qt builds;
  // explicitly advance over surrogate pairs instead of relying on it.
  const points: number[] = [];
  for (let i = 0; i < value.length;) {
    const point = value.codePointAt(i)!;
    points.push(point);
    i += point > 0xffff ? 2 : 1;
  }
  if (points.length === 2 && points.every((n) => n >= 0x1f1e6 && n <= 0x1f1ff)) return true;
  if (/^[0-9#*]\uFE0F?\u20E3$/.test(value)) return true;
  const base = (n: number) => (n >= 0x1f000 && n <= 0x1faff && !(n >= 0x1f1e6 && n <= 0x1f1ff)) || (n >= 0x2600 && n <= 0x27bf)
    || [0xa9, 0xae, 0x203c, 0x2049, 0x2122, 0x2139, 0x2194, 0x2195, 0x2196, 0x2197, 0x2198, 0x2199,
      0x21a9, 0x21aa, 0x231a, 0x231b, 0x2328, 0x23cf, 0x23e9, 0x23ea, 0x23eb, 0x23ec, 0x23ed,
      0x23ee, 0x23ef, 0x23f0, 0x23f1, 0x23f2, 0x23f3, 0x23f8, 0x23f9, 0x23fa, 0x24c2,
      0x25aa, 0x25ab, 0x25b6, 0x25c0, 0x25fb, 0x25fc, 0x25fd, 0x25fe, 0x2934, 0x2935,
      0x2b05, 0x2b06, 0x2b07, 0x2b1b, 0x2b1c, 0x2b50, 0x2b55, 0x3030, 0x303d, 0x3297, 0x3299].includes(n);
  let at = 0;
  for (;;) {
    const n = points[at++];
    if (!base(n) || (n >= 0x1f3fb && n <= 0x1f3ff)) return false;
    if (points[at] === 0xfe0f || points[at] === 0xfe0e) at++;
    if (points[at] >= 0x1f3fb && points[at] <= 0x1f3ff) at++;
    // Unicode subdivision flags, e.g. England, finish with CANCEL TAG.
    if (n === 0x1f3f4 && points[at] >= 0xe0020 && points[at] <= 0xe007e) {
      while (points[at] >= 0xe0020 && points[at] <= 0xe007e) at++;
      if (points[at++] !== 0xe007f) return false;
    }
    if (at === points.length) return true;
    if (points[at++] !== 0x200d || at === points.length) return false;
  }
}

export function emojiKind(emoji: string): string {
  return validReactionEmoji(emoji) ? "emoji:" + emoji : "";
}

export function reactionEmoji(kind: string): string {
  const classic = TAPBACKS.find((t) => t.kind === kind);
  if (classic) return classic.emoji;
  return kind.startsWith("emoji:") && validReactionEmoji(kind.slice(6)) ? kind.slice(6) : "";
}

/** Custom content travels only on stdin, including the Mac→osascript hop. */
export function tapbackRequest(guid: string, kind: string, current: string): { args: string[]; stdin: string } | null {
  if (!/^[A-Za-z0-9:/_-]{1,128}$/.test(guid) || !reactionEmoji(kind)) return null;
  if (!kind.startsWith("emoji:")) return { args: tapbackArgs(guid, kind, current), stdin: "" };
  return { args: ["--guid", guid, "--emoji-stdin", ...(current === kind ? ["--remove"] : []), "--yes"],
    stdin: JSON.stringify({ emoji: kind.slice(6), name: EMOJI_NAMES.get(kind.slice(6)) || "" }) };
}

/** A tapback on its way: drawn at once, dimmed, until chat.db has the
 *  answer. `remove` takes back the one you have; `done` is set when
 *  imsg-react exits 0, and `tries` counts the loads since then that did not
 *  show the answer yet. */
export interface PendingTapback { chat: string; guid: string; kind: string; remove: boolean; done: boolean; tries: number }

/** Loads after imsg-react exited 0 before chat.db has the last word anyway.
 *  In a self-thread Messages writes a second copy of each tapback, an echo
 *  from your own address, a moment after the first; until it lands the old
 *  state still shows. At the view's 600 ms reload, about five seconds. */
export const SETTLE_TRIES = 8;

export function pendingTapback(chat: string, guid: string, kind: string, current: string): PendingTapback {
  return { chat, guid, kind, remove: current === kind, done: false, tries: 0 };
}

/** chat.db already shows what was asked for. */
export function tapbackSettled(message: TapbackTarget | null, p: PendingTapback | null): boolean {
  return !!p && myTapback(message) === (p.remove ? "" : p.kind);
}

/** The bubble's tapbacks as the pill should draw them. While one is on its
 *  way, yours is replaced by it, marked `pending` (a removal keeps the old one,
 *  pending, until it is gone). Everyone else's stay as chat.db has them. */
export function shownTapbacks(
  message: TapbackTarget | null,
  p: PendingTapback | null,
): { emoji: string; from_me: boolean; pending?: boolean }[] {
  const list = message?.tapbacks ?? [];
  if (!message || !p || String(message.guid || "") !== p.guid || tapbackSettled(message, p)) return list;
  const emoji = reactionEmoji(p.kind);
  if (!emoji) return list;
  const others = list.filter((t) => !t.from_me || t.kind === "sticker");
  return [...others, { emoji, from_me: true, pending: true }];
}

/** What is left of a pending tapback once a thread load lands: nothing when
 *  that chat's bubble already shows the answer. A load started after
 *  imsg-react exited 0 that does not show it yet counts a try, and the view
 *  loads again; after SETTLE_TRIES, or when the bubble is not in the load at
 *  all, chat.db has the last word, whatever it says. */
export function pendingAfterLoad(
  p: PendingTapback | null,
  chat: string,
  bubbles: TapbackTarget[],
  startedAfterDone: boolean,
): PendingTapback | null {
  if (!p || p.chat !== chat) return p;
  const target = bubbles.find((b) => String(b.guid || "") === p.guid) ?? null;
  if (target && tapbackSettled(target, p)) return null;
  if (!startedAfterDone) return p;
  if (!target || p.tries + 1 >= SETTLE_TRIES) return null;
  // Object.assign, not object spread: bun leaves `{ ...p }` in the bundle and
  // QML's JS engine cannot parse it, which takes the whole plugin down.
  return Object.assign({}, p, { tries: p.tries + 1 });
}

/** The status line when imsg-react could not be started at all: the shim is
 *  missing from binDir, which blip-setup installs. */
export const TAPBACK_NOT_STARTED = "tapback: imsg-react did not start; re-run blip-setup";

/** What the shim writes when it turns an ssh failure into 69 (blip-shim,
 *  the 255 branch). The whole point of checking it: 69 is TWO exit codes.
 *  The shim's is a transport failure, and imsg-react's own EX_UNAVAILABLE
 *  is a Mac-local one that names its reason on stderr — a screen locked,
 *  Messages that would not start, no window to drive. Treating every 69 as
 *  transport told people their reachable Mac was unreachable (2026-11-09,
 *  a locked gateway and "tapback: Mac unreachable" while sends worked:
 *  imsg-react had exited 69 saying "the Mac's screen is locked" and the
 *  status line swallowed it). So 69 is only the bridge being down when the
 *  shim itself said so, or when nothing on stderr contradicts it. */
const SHIM_UNREACHABLE = "unreachable — the iMessage bridge is offline";

/** One status line for a run that did not end in the tapback asked for.
 *  imsg-react says why on stderr ("imsg-react: …"), and each reason says
 *  itself what happened: nothing done, done but unconfirmed, or landed on
 *  another message ("stray"). So the prefix claims nothing. The shim says
 *  so for tapbacks=off. */
export function tapbackFailure(code: number, stderr: string): string {
  const err = String(stderr || "");
  const line = err.split("\n").map((l) => l.trim()).filter((l) => l !== "").pop() || "";
  // 255 is ssh, always. 69 is the shim's 255 translation — the marker says
  // so — and any 69 with no imsg-react line in sight (the tool never ran).
  if (code === 255 || (code === 69 && (err.includes(SHIM_UNREACHABLE) || !/^imsg-react:/m.test(err))))
    return "tapback: Mac unreachable";
  const why = line.replace(/^imsg-react:\s*/, "").slice(0, 200);
  return "tapback: " + (why || "imsg-react exit " + code);
}
