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
import {
  chatKey,
  applyIdentityOverrides,
  dedupeSelfEcho,
  isGroupChat,
  loadState,
  type AttachmentMeta,
  type ImsgMessage,
  type LinkCard,
  type Tapback,
} from "./collector";
import { safeReadIdentityConfig } from "./identities";
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
  /** Sender handle retained for contact actions; never rendered directly when a name exists. */
  handle: string;
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
  /** The body is only the shared URL already represented by `link`. */
  linkOnly: boolean;
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
}

export interface ThreadOutput {
  ok: boolean;
  online: boolean;
  error: string;
  bubbles: Bubble[];
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

/**
 * Qt's QDateTime::toString() for a "YYYY-MM-DD HH:MM:SS" stamp, the tokens
 * Blip needs: d dd ddd dddd · M MM MMM MMMM · yy yyyy · h hh H HH · m mm · s ss ·
 * AP ap A a, and 'quoted literals' with '' as an apostrophe. h/hh are 12-hour
 * when an AM/PM token is present, 24-hour otherwise, as in Qt. Works on the
 * string so a Mac-local stamp never meets the Linux time zone. Malformed
 * input formats to "".
 */
export function formatStamp(ts: string, pattern: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(ts);
  if (!m) return "";
  const [year, month, day, hour = "00", minute = "00", second = "00"] =
    m.slice(1) as [string, string, string, string?, string?, string?];
  const h24 = Number(hour);
  const h12 = h24 % 12 || 12;                                   // 0 and 12 read as 12
  const ampm = h24 < 12 ? "am" : "pm";
  const twelveHour = /[Aa]/.test(pattern.replace(/'(?:[^']|'')*'/g, ""));
  const weekday = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay();

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
  const date = ts.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
  if (date === today) return "Today";

  const d = new Date(`${date}T00:00:00`);
  const t = new Date(`${today}T00:00:00`);
  const diffDays = Math.round((t.getTime() - d.getTime()) / 86400000);
  if (diffDays === 1) return "Yesterday";

  return formatStamp(ts, date.slice(0, 4) === today.slice(0, 4) ? formats.date : formats.dateWithYear);
}

/** Minutes between two "YYYY-MM-DD HH:MM:SS" stamps. */
export function minutesBetween(a: string, b: string): number {
  const pa = Date.parse(a.replace(" ", "T"));
  const pb = Date.parse(b.replace(" ", "T"));
  if (Number.isNaN(pa) || Number.isNaN(pb)) return Number.POSITIVE_INFINITY;
  return Math.abs(pb - pa) / 60000;
}

/** Metadata often canonicalizes a shared URL by dropping tracking parameters. */
export function standaloneUrl(text: string): boolean {
  return /^(?:https?:\/\/|www\.)[^\s<>"']+$/i.test(String(text ?? "").trim());
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

    const newDay = !prev || prev.ts.slice(0, 10) !== m.ts.slice(0, 10);
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
      next.ts.slice(0, 10) !== m.ts.slice(0, 10) ||
      !sameSender(m, next) ||
      minutesBetween(m.ts, next.ts) > GROUP_GAP_MINUTES;
    const cleanText = (m.text ?? "").replace(/￼/g, "").trim();
    const link = normalizeLink(m.link);

    out.push({
      ts: m.ts,
      from_me: m.from_me,
      handle: m.handle ?? "",
      name: m.name ?? m.handle ?? "",
      // U+FFFC is the object-replacement placeholder Messages leaves where an
      // attachment sat; the chip row carries that information instead.
      text: cleanText,
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
      link,
      linkOnly: link !== null && standaloneUrl(cleanText),
      retracted: m.retracted === true,
      effect: m.effect ?? "",
      audio: m.audio === true,
      html: linkify(cleanText),
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
export function selectThread(
  raw: ImsgMessage[],
  chat: string,
  group: boolean,
  limit: number,
  selfChats: string[] = [],
  aliases: string[] = [],
): ImsgMessage[] {
  // Exact-filter DMs too: `imsg thread` matches the handle by SUBSTRING, so
  // +15551234567 can pull rows from +995551234567 into the wrong conversation
  // (Codex finding #3).
  const accepted = new Set([chat, ...aliases]);
  // A DM is scoped by CHAT, not by sender: the same handle's messages in a
  // group carry the group's chat id and must stay out of the 1:1 thread.
  let msgs = raw.filter((m) => accepted.has(chatKey(m)) ||
    (!group && m.handle === chat && !isGroupChat(chatKey(m))));
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
  aliases: string[] = [],
): ThreadOutput {
  // Groups load by EXACT chat id (imsg ≥1.8.0 `thread --chat`). The old
  // recent-window scan cost ~20× the rows and missed anything older than
  // the window — which made historical search hits open empty threads.
  // Both shapes load by EXACT chat id: `thread <handle>` matched the handle
  // by SUBSTRING and included that person's group posts, which then ate the
  // window (war room #14). A DM's chat_identifier IS the handle.
  const group = isGroupChat(chat);
  const args = ["--json", "--rich", "thread", "--chat", chat, String(limit)];
  const safeAliases = [...new Set(aliases)]
    .filter((alias) => alias !== chat && alias.length > 0 && alias.length <= 512 &&
      !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(alias))
    .slice(0, 15);
  const res = runner(`${HOME}/bin/imsg`, args, {
    encoding: "utf8",
    timeout: 15000, maxBuffer: 64 * 1024 * 1024,
  });

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
    const named = applyIdentityOverrides(parsed as ImsgMessage[], safeReadIdentityConfig());
    const msgs = selectThread(named, chat, group, limit, loadState().selfChats, safeAliases);
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
  const aliases: string[] = [];
  for (let i = 4; i < process.argv.length; i++) {
    const arg = process.argv[i] ?? "";
    if (arg.startsWith("--")) { i++; continue; }
    aliases.push(arg);
  }
  const today = localToday();
  try {
    console.log(JSON.stringify(loadThread(
      chat, limit, today, formatsFromArgv(process.argv), spawnSync, aliases)));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, online: false, error: String(e), bubbles: [] }));
  }
}
