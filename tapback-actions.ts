// Outgoing tapbacks: which bubbles offer them, which one is yours, and the
// argv for the Mac's imsg-react. Opt-in with `tapbacks=on` in bridge.conf
// (#69); the shim refuses the tool without it, so this is the menu's half of
// the same key, never the only gate.
//
// Pure, shared with the QML renderer. Rebuild the QML module:
//   bun build tapback-actions.ts --target browser --format esm --outfile TapbackActions.mjs

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
  let v = "";
  for (const raw of String(conf || "").split("\n")) {
    const line = raw.replace(/#.*/, "").replace(/\s+/g, "");
    const eq = line.indexOf("=");
    if (eq < 0 || line.slice(0, eq) !== "tapbacks") continue;
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
  tapbacks?: { emoji: string; from_me: boolean }[] | null;
}

/** "love" for "❤️" (with or without the emoji variation selector); "" for
 *  anything that is not one of the six, e.g. a custom-emoji tapback. */
export function tapbackKind(emoji: string): string {
  const bare = (s: string) => String(s || "").replace(/️/g, "");
  const hit = TAPBACKS.find((t) => bare(t.emoji) === bare(emoji));
  return hit ? hit.kind : "";
}

/** The classic tapback you have on the bubble now, or "". */
export function myTapback(message: TapbackTarget | null): string {
  for (const t of message?.tapbacks ?? []) {
    if (t.from_me) {
      const kind = tapbackKind(t.emoji);
      if (kind) return kind;
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
  return ["--guid", guid, kind, ...(current === kind ? ["--remove"] : []), "--yes"];
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
  const hit = TAPBACKS.find((t) => t.kind === p.kind);
  if (!hit) return list;
  const others = list.filter((t) => !(t.from_me && tapbackKind(t.emoji)));
  return [...others, { emoji: hit.emoji, from_me: true, pending: true }];
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
