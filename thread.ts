#!/usr/bin/env bun
/**
 * Blip thread loader — fetches one conversation and decorates it for the
 * bubble view.
 *
 * The decoration (day separators, sender grouping, which bubble shows a
 * timestamp) is pure and lives here rather than in QML so it can be tested.
 * QML just renders what it is handed.
 *
 *   bun thread.ts <chat-id> [limit]
 */

import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  chatKey,
  dedupeSelfEcho,
  bridgeRun,
  isGroupChat,
  loadState,
  normalizeMsgStamps,
  type AttachmentMeta,
  type ImsgMessage,
  type LinkCard,
  type Tapback,
} from "./collector";
export { dedupeSelfEcho };

const HOME = process.env.HOME ?? homedir();

/** Only http(s) cards are shown; anything else is not clickable-safe. */
export function normalizeLink(l: ImsgMessage["link"]): LinkCard | null {
  if (!l || typeof l !== "object") return null;
  const url = String(l.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) return null;
  // "https://apple.com@evil.example/" — userinfo lets the card footer lie about the host.
  if (/^https?:\/\/[^/?#]*@/i.test(url)) return null;
  const image_id = String(l.image_id ?? "");
  return {
    url,
    title: String(l.title ?? "").trim(),
    summary: String(l.summary ?? "").trim(),
    image_id: /^[0-9]{1,18}$/.test(image_id) ? image_id : "",
  };
}

/** "omarchy.org" for a card's footer. */
export function linkHost(url: string): string {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url);
  return (m ? m[1] : url).replace(/^www\./, "").toLowerCase();
}

/** Messages closer together than this belong to the same visual cluster. */
export const GROUP_GAP_MINUTES = 15;

export interface Bubble {
  ts: string;
  from_me: boolean;
  name: string;
  text: string;
  /** Non-empty on the first message of a new calendar day: "Today", "Aug 28". */
  day: string;
  /** First bubble of a run by one sender — gets the rounded outer corner. */
  groupStart: boolean;
  /** Last bubble of a run — carries the timestamp, like iMessage. */
  groupEnd: boolean;
  /** "9:41 PM" (or whatever `timeFormat` says), shown only on groupEnd. */
  time: string;
  /** "Read 4:42 PM" — only on the NEWEST read from-me bubble, like iMessage. */
  receipt: string;
  /** Reactions folded onto this bubble; [] when none. */
  tapbacks: Tapback[];
  /** Attachment chips ("📷 IMG_4502.png"); metadata only, files stay on the Mac. */
  attachments: AttachmentMeta[];
  /** Inline-reply context: the quoted snippet, "" when not a reply. */
  replyText: string;
  replyMine: boolean;
  edited: boolean;
  /** Rich-link preview card, null when the message has none. */
  link: LinkCard | null;
  /** An unsent message renders as a tombstone, not a bubble. */
  retracted: boolean;
  /** Screen/bubble effect short name ("confetti"), "" when none. */
  effect: string;
  audio: boolean;
  /** Escaped rich text with clickable anchors; "" when the text has no URL
   *  (QML keeps the cheap PlainText path then). */
  html: string;
  /** A message of yours that Messages could not deliver (chat.db error≠0) —
   *  rendered as a red "Not Delivered" tag. */
  failed: boolean;
  /** Drawn the moment Enter was pressed, before the Mac has written the row;
   *  "Sending…" replaces the time. Absent on every real bubble. */
  pending?: boolean;
}

/** A send in flight: what was typed, where, and when Enter was pressed
 *  (the wire format, UTC — it is compared against real message stamps).
 *  Lives in BarWidget memory only. */
export interface PendingSend { chat: string; text: string; ts: string }

export interface ThreadOutput {
  ok: boolean;
  online: boolean;
  error: string;
  bubbles: Bubble[];
  /** Sends for this chat the Mac has not written yet (`--pending-stdin`). */
  pending?: PendingSend[];
}

// ---------------------------------------------------------------- formatting

/**
 * How times and dates read. Qt format strings, set on the widget's shell.json
 * entry exactly the way Omarchy's clock takes its `format` — the same string
 * drives Qt in QML and formatStamp() here, so the list and the bubbles agree.
 * Defaults are what Messages shows on a US Mac; BarWidget swaps the time for
 * "HH:mm" when the locale has no AM/PM.
 */
export interface Formats {
  time: string;
  date: string;
  dateWithYear: string;
}

export const DEFAULT_FORMATS: Formats = { time: "h:mm AP", date: "MMM d", dateWithYear: "MMM d, yyyy" };

/** `--time-format`, `--date-format`, `--date-format-with-year` from argv; unset keeps the default. */
export function formatsFromArgv(argv: readonly string[], defaults = DEFAULT_FORMATS): Formats {
  const flag = (name: string, fallback: string) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
  };
  return {
    time: flag("--time-format", defaults.time),
    date: flag("--date-format", defaults.date),
    dateWithYear: flag("--date-format-with-year", defaults.dateWithYear),
  };
}

const MONTHS = ["January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A wire stamp shaped like the bridge emits, or the pre-UTC stamp it used to. */
const STAMP = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?Z?)?$/;

/**
 * A wire stamp as epoch ms.
 *
 * The bridge emits UTC ("2026-09-07T18:33:12Z"). A stamp without the marker
 * is the pre-UTC naive format and is read as LOCAL, so a Mac still running an
 * old bridge degrades to the behaviour it always had rather than jumping by
 * the whole UTC offset. A bare date is local midnight — parsing it by the
 * ISO rule would make it UTC midnight, i.e. the day before, west of Greenwich.
 */
export function stampMs(ts: string): number {
  const s = String(ts ?? "");
  if (!STAMP.test(s)) return Number.NaN;
  if (s.length === 10) return Date.parse(`${s}T00:00:00`);
  return Date.parse(s.includes("T") ? s : s.replace(" ", "T"));
}

/** A wire stamp's fields in THIS machine's local time — the display side of UTC. */
function localFields(ts: string) {
  const ms = stampMs(ts);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return {
    year: p(d.getFullYear(), 4), month: p(d.getMonth() + 1), day: p(d.getDate()),
    hour: p(d.getHours()), minute: p(d.getMinutes()), second: p(d.getSeconds()),
    weekday: d.getDay(),
  };
}

/** The local calendar date a wire stamp falls on, "" when unparseable. */
export function localDay(ts: string): string {
  const f = localFields(ts);
  return f ? `${f.year}-${f.month}-${f.day}` : "";
}

/**
 * Qt's QDateTime::toString() for a wire stamp, the tokens Blip needs:
 * d dd ddd dddd · M MM MMM MMMM · yy yyyy · h hh H HH · m mm · s ss ·
 * AP ap A a, and 'quoted literals' with '' as an apostrophe. h/hh are 12-hour
 * when an AM/PM token is present, 24-hour otherwise, as in Qt. The stamp is
 * UTC on the wire and every label is LOCAL, so this converts first — a
 * message is shown at the time the reader's own clock said. Malformed input
 * formats to "".
 */
export function formatStamp(ts: string, pattern: string): string {
  const f = localFields(ts);
  if (!f) return "";
  const { year, month, day, hour, minute, second, weekday } = f;
  const h24 = Number(hour);
  const h12 = h24 % 12 || 12;                                   // 0 and 12 read as 12
  const ampm = h24 < 12 ? "am" : "pm";
  const twelveHour = /[Aa]/.test(pattern.replace(/'(?:[^']|'')*'/g, ""));

  const field = (v: string, n: number) => (n === 1 ? String(Number(v)) : v);          // "08" → "8" | "08"
  const clock = (h: number, n: number) => (n === 1 ? String(h) : String(h).padStart(2, "0"));
  const name = (names: string[], i: number, n: number) => (n === 3 ? names[i]!.slice(0, 3) : names[i]!);

  // One pass: '' · 'literal' · an unterminated quote runs to the end · AP/ap · a run of one letter.
  return pattern.replace(/''|'((?:[^']|'')*)'|'(.*)$|AP|ap|([A-Za-z])\3*/g, (tok, quoted, tail, letter) => {
    if (tok === "''") return "'";
    if (quoted !== undefined) return quoted.replace(/''/g, "'");
    if (tail !== undefined) return tail;
    if (tok === "AP" || tok === "A") return ampm.toUpperCase();
    if (tok === "ap" || tok === "a") return ampm;
    const n = tok.length;
    switch (letter) {
      case "y": return n >= 4 ? year : n === 2 ? year.slice(2) : tok;
      case "M": return n >= 3 ? name(MONTHS, Number(month) - 1, n) : field(month, n);
      case "d": return n >= 3 ? name(DAYS, weekday, n) : field(day, n);
      case "H": return clock(h24, n);
      case "h": return clock(twelveHour ? h12 : h24, n);
      case "m": return field(minute, n);
      case "s": return field(second, n);
      default: return tok;                                       // unknown letters pass through, as in Qt
    }
  });
}

/** "2026-08-30 21:08:22" → "9:08 PM" by default; "21:08" with timeFormat "HH:mm". */
export function clockLabel(ts: string, time = DEFAULT_FORMATS.time): string {
  return formatStamp(ts, time);
}

/** "Today" / "Yesterday", else the date — with the year when it is not this year. */
export function dayLabel(ts: string, today: string, formats = DEFAULT_FORMATS): string {
  const date = localDay(ts);                       // the reader's day, not UTC's
  if (!date) return "";
  if (date === today) return "Today";

  const d = new Date(`${date}T00:00:00`);
  const t = new Date(`${today}T00:00:00`);
  const diffDays = Math.round((t.getTime() - d.getTime()) / 86400000);
  if (diffDays === 1) return "Yesterday";

  return formatStamp(ts, date.slice(0, 4) === today.slice(0, 4) ? formats.date : formats.dateWithYear);
}

/** Minutes between two wire stamps. */
export function minutesBetween(a: string, b: string): number {
  const pa = stampMs(a);
  const pb = stampMs(b);
  if (Number.isNaN(pa) || Number.isNaN(pb)) return Number.POSITIVE_INFINITY;
  return Math.abs(pb - pa) / 60000;
}

// ---------------------------------------------------------------- decoration

/**
 * Turn a chronological message list into bubbles.
 *
 * A new group starts when the sender changes, the day changes, or more than
 * GROUP_GAP_MINUTES have passed. Only the last bubble of a group shows its
 * timestamp — that is what keeps a long back-and-forth readable instead of
 * stamping every single line.
 */
export function decorate(msgs: ImsgMessage[], today: string, formats = DEFAULT_FORMATS): Bubble[] {
  const out: Bubble[] = [];

  // iMessage shows "Read" under only the newest read message you sent.
  let receiptIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.from_me && msgs[i]!.read_at) { receiptIdx = i; break; }
  }

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    const prev = i > 0 ? msgs[i - 1]! : null;
    const next = i < msgs.length - 1 ? msgs[i + 1]! : null;

    // Day dividers fall on the READER's midnight: the stamps are UTC, so
    // slicing the date off the string would break the day in the wrong place
    // for anyone not on UTC.
    const newDay = !prev || localDay(prev.ts) !== localDay(m.ts);
    // In a group, two members' messages must not merge into one run under
    // the first name — so a run breaks on sender (handle) change, not only
    // on the from_me flip.
    const sameSender = (a: ImsgMessage, b: ImsgMessage) =>
      a.from_me === b.from_me && (a.from_me || a.handle === b.handle);
    const groupStart =
      !prev ||
      newDay ||
      !sameSender(prev, m) ||
      minutesBetween(prev.ts, m.ts) > GROUP_GAP_MINUTES;
    const groupEnd =
      !next ||
      localDay(next.ts) !== localDay(m.ts) ||
      !sameSender(m, next) ||
      minutesBetween(m.ts, next.ts) > GROUP_GAP_MINUTES;

    out.push({
      ts: m.ts,
      from_me: m.from_me,
      name: m.name ?? m.handle ?? "",
      // U+FFFC is the object-replacement placeholder Messages leaves where an
      // attachment sat; the chip row carries that information instead.
      text: (m.text ?? "").replace(/￼/g, "").trim(),
      day: newDay ? dayLabel(m.ts, today, formats) : "",
      groupStart,
      groupEnd,
      time: groupEnd ? clockLabel(m.ts, formats.time) : "",
      receipt: i === receiptIdx ? receiptLabel(m.read_at!, today, formats) : "",
      tapbacks: m.tapbacks ?? [],
      // Belt to imsg 1.5.1's suspenders: link-preview payloads are not files.
      attachments: (m.attachments ?? []).filter(
        (a) => !String(a.name || "").endsWith(".pluginPayloadAttachment"),
      ),
      replyText: m.reply_to?.text ?? "",
      replyMine: m.reply_to?.from_me ?? false,
      edited: m.edited === true,
      link: normalizeLink(m.link),
      retracted: m.retracted === true,
      effect: m.effect ?? "",
      audio: m.audio === true,
      html: linkify((m.text ?? "").replace(/￼/g, "").trim()),
      failed: m.from_me && typeof m.error === "number" && m.error !== 0,
    });
  }

  return out;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+|\bwww\.[^\s<>"']+\.[^\s<>"']+/g;

/**
 * Message text → rich text with clickable anchors. The text is UNTRUSTED
 * (anyone can send "<img src=x>"), so non-URL segments are HTML-escaped and
 * URLs are matched on the RAW string, then escaped separately for href and
 * display — nothing a sender types is ever interpreted as markup.
 * Returns "" when the text holds no URL, so plain messages keep the cheap
 * PlainText render path.
 */
export function linkify(text: string): string {
  const t = String(text ?? "");
  URL_RE.lastIndex = 0;
  if (!URL_RE.test(t)) return "";
  URL_RE.lastIndex = 0;
  let out = "";
  let pos = 0;
  for (let m = URL_RE.exec(t); m !== null; m = URL_RE.exec(t)) {
    out += escapeHtml(t.slice(pos, m.index));
    // Trailing punctuation reads as prose, not URL: "see https://x.com."
    let url = m[0].replace(/[.,;:!?\]]+$/, "");
    // A ")" that closes a "(" inside the URL belongs to it (Wikipedia_(band)).
    while (url.endsWith(")") && (url.split("(").length) < (url.split(")").length)) url = url.slice(0, -1);
    url = url.replace(/[.,;:!?\]]+$/, "");
    const href = url.startsWith("www.") ? "https://" + url : url;
    out += `<a href="${escapeHtml(href)}">${escapeHtml(url)}</a>`;
    pos = m.index + url.length;
  }
  out += escapeHtml(t.slice(pos));
  return out.replace(/\n/g, "<br>");
}

// ------------------------------------------------------------ pending sends
//
// A send used to be: osascript on the Mac, a 1.5 s "beat" for Messages to
// write the row, a thread reload — three seconds of "sending…" under an
// unchanged compose field. Now the view draws the bubble as Enter is pressed
// and hands every reload the list of sends still in flight; this is where a
// provisional bubble is kept until its real row appears, or resolved by it.

/** A send older than this without a row is given up on (never marked failed:
 *  imsg-send exited 0, so it most likely went; the next real reload shows it). */
export const PENDING_MAX_AGE_MS = 2 * 60 * 1000;
/** A real row may carry a Mac timestamp a little BEHIND the Linux clock. */
const PENDING_SKEW_MS = 5 * 60 * 1000;

/** The bubble for a send in flight, decorated against the bubble before it
 *  the way decorate() would: same run when it follows one of yours within
 *  the gap (that bubble then loses its time), a day divider when it starts one. */
export function pendingBubble(prev: Bubble | undefined, send: PendingSend, today: string, formats = DEFAULT_FORMATS): { bubble: Bubble; prev: Bubble | undefined } {
  const ts = send.ts;
  const newDay = !prev || localDay(prev.ts) !== localDay(ts);
  const groupStart = !prev || newDay || !prev.from_me || minutesBetween(prev.ts, ts) > GROUP_GAP_MINUTES;
  const bubble: Bubble = {
    ts,
    from_me: true,
    name: "",
    text: send.text.trim(),
    day: newDay ? dayLabel(ts, today, formats) : "",
    groupStart,
    groupEnd: true,
    time: clockLabel(ts, formats.time),
    receipt: "",
    tapbacks: [],
    attachments: [],
    replyText: "",
    replyMine: false,
    edited: false,
    link: null,
    retracted: false,
    effect: "",
    audio: false,
    html: linkify(send.text.trim()),
    failed: false,
    pending: true,
  };
  return { bubble, prev: prev && !groupStart ? { ...prev, groupEnd: false, time: "" } : prev };
}

/**
 * Fold sends in flight into a freshly loaded thread. A pending send is
 * RESOLVED by a real bubble of yours with the same text that is not older
 * than the send (minus clock skew) — each real bubble resolves one send, so
 * "ok" twice waits for two rows. Unresolved sends are appended as pending
 * bubbles, oldest first; ones older than PENDING_MAX_AGE_MS are dropped.
 * Returns the merged list and what is still outstanding.
 */
export function withPendingSends(bubbles: Bubble[], pending: PendingSend[], today: string, formats = DEFAULT_FORMATS, now = Date.now()): { bubbles: Bubble[]; pending: PendingSend[] } {
  const live = pending
    .filter((p) => Number.isFinite(stampMs(p.ts)) && now - stampMs(p.ts) <= PENDING_MAX_AGE_MS)
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  if (live.length === 0) return { bubbles, pending: [] };
  const taken = new Set<number>();
  const open: PendingSend[] = [];
  for (const p of live) {
    const want = p.text.trim();
    let hit = -1;
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i]!;
      if (taken.has(i) || !b.from_me || b.retracted || b.pending) continue;
      if (b.text !== want || stampMs(b.ts) < stampMs(p.ts) - PENDING_SKEW_MS) continue;
      hit = i; break;
    }
    if (hit >= 0) taken.add(hit); else open.push(p);
  }
  const out = bubbles.slice();
  for (const p of open) {
    const { bubble, prev } = pendingBubble(out[out.length - 1], p, today, formats);
    if (prev && out.length) out[out.length - 1] = prev;
    out.push(bubble);
  }
  return { bubbles: out, pending: open };
}

/** `--pending-stdin`: the view's in-flight sends, JSON on stdin (message
 *  text never rides argv). Anything malformed reads as "none". */
export function parsePendingSends(raw: string): PendingSend[] {
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((p) => p && typeof p.chat === "string" && typeof p.text === "string" && typeof p.ts === "string");
  } catch { return []; }
}

/** "Read 4:42 PM" today, "Read Yesterday 9:03 AM" otherwise. */
export function receiptLabel(readAt: string, today: string, formats = DEFAULT_FORMATS): string {
  const clock = clockLabel(readAt, formats.time);
  if (!clock) return "Read";
  const day = dayLabel(readAt, today, formats);
  return day === "Today" ? `Read ${clock}` : `Read ${day} ${clock}`;
}

/** Local calendar date — toISOString() is UTC and flips "Today" at 8pm EDT. */
export function localToday(now = new Date()): string {
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

/** How far back to scan `recent` for a group's messages. */
export const GROUP_SCAN_WINDOW = 1500;

/**
 * Normalise a fetched window into this thread's chronological messages.
 * `recent` is newest-first and mixed across chats; `thread` is already
 * oldest-first and single-chat. Both end up oldest-first, last `limit` only.
 */
/** Chat ids that belong to one Messages conversation (re-keyed group or
 *  merged DM). `chat` itself is always included so a missing alias map
 *  still loads that row. */
export function chatsForThread(chat: string, aliases: Record<string, string> = {}): string[] {
  const canon = aliases[chat] ?? chat;
  const ids = new Set<string>([chat, canon]);
  for (const [alias, target] of Object.entries(aliases)) {
    if (target === canon) ids.add(alias);
  }
  return [...ids];
}

export function selectThread(
  raw: ImsgMessage[],
  chat: string,
  group: boolean,
  limit: number,
  selfChats: string[] = [],
  aliases: Record<string, string> = {},
): ImsgMessage[] {
  // Exact-filter DMs too: `imsg thread` matches the handle by SUBSTRING, so
  // +15551234567 can pull rows from +995551234567 into the wrong conversation
  // (Codex finding #3).
  // A DM is scoped by CHAT, not by sender: the same handle's messages in a
  // group carry the group's chat id and must stay out of the 1:1 thread.
  // A group request: the bridge already scoped `thread --chat` to the whole
  // re-key cluster and every row keeps its ORIGINAL chat id, so filtering on
  // the requested id threw the alias rows' history away (9 rows from the Mac,
  // 6 bubbles here — Astra #8). Trust the cluster; keep every group row.
  // A merged DM (phone + email) is the same shape: keep every alias id.
  const ids = new Set(chatsForThread(chat, aliases));
  let msgs = group
    ? raw.filter((m) => isGroupChat(chatKey(m)))
    : raw.filter((m) => ids.has(chatKey(m)) || (m.handle === chat && !isGroupChat(chatKey(m))));
  msgs = [...msgs].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  msgs = dedupeSelfEcho(msgs, selfChats);
  return msgs.length > limit ? msgs.slice(msgs.length - limit) : msgs;
}

// ---------------------------------------------------------------- transport

export function loadThread(
  chat: string,
  limit: number,
  today: string,
  formats = DEFAULT_FORMATS,
  runner = spawnSync,
): ThreadOutput {
  // Groups load by EXACT chat id (imsg ≥1.8.0 `thread --chat`). The old
  // recent-window scan cost ~20× the rows and missed anything older than
  // the window — which made historical search hits open empty threads.
  // Both shapes load by EXACT chat id: `thread <handle>` matched the handle
  // by SUBSTRING and included that person's group posts, which then ate the
  // window (war room #14). A DM's chat_identifier IS the handle.
  const group = isGroupChat(chat);
  const args = ["--json", "--rich", "thread", "--chat", chat, String(limit)];
  const res = bridgeRun(args, runner);

  if (res.status === 69 || res.status === 255) {
    return { ok: false, online: false, error: "Mac unreachable", bubbles: [] };
  }
  if (res.status !== 0) {
    const err = (res.stderr || "").toString().trim().split("\n")[0] || `imsg exit ${res.status}`;
    return { ok: false, online: true, error: err, bubbles: [] };
  }
  try {
    const parsed = JSON.parse(res.stdout as string);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    const state = loadState();
    // Same door rule as the collector: stamps become the wire format on the
    // way in, so a Mac on the pre-UTC bridge cannot mix formats downstream.
    const rows = (parsed as ImsgMessage[]).map(normalizeMsgStamps);
    const msgs = selectThread(
      rows, chat, group, limit, state.selfChats, state.chatAliases,
    );
    return { ok: true, online: true, error: "", bubbles: decorate(msgs, today, formats) };
  } catch (e) {
    return { ok: false, online: true, error: `bad JSON from imsg: ${e}`, bubbles: [] };
  }
}

/**
 * CLI convenience: `qs ipc call … goto 15550100001` cannot carry a leading
 * "+", so a bare FULL number (10+ digits) is E.164-ified here. Short codes
 * are 3–8 digits and are their own chat_identifier in chat.db ("99123");
 * "+"-prefixing those made every short-code SMS thread load EMPTY (2.2.1).
 * BlipView passes the exact chat id, which must always go through verbatim.
 */
export function cliChatArg(raw: string): string {
  const s = String(raw ?? "").trim();
  return /^[0-9]{10,}$/.test(s) ? "+" + s : s;
}

if (import.meta.main) {
  const chat = cliChatArg(process.argv[2] ?? "");
  const limit = Number(process.argv[3] ?? 80) || 80;
  const today = localToday();
  try {
    const formats = formatsFromArgv(process.argv);
    const result = loadThread(chat, limit, today, formats);
    if (process.argv.includes("--pending-stdin")) {
      const mine = parsePendingSends(readFileSync(0, "utf8")).filter((p) => p.chat === chat);
      if (result.ok) {
        const merged = withPendingSends(result.bubbles, mine, today, formats);
        result.bubbles = merged.bubbles;
        result.pending = merged.pending;
      } else {
        result.pending = mine;
      }
    }
    console.log(JSON.stringify(result));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, online: false, error: String(e), bubbles: [] }));
  }
}
