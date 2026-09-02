#!/usr/bin/env bun
/**
 * Blip collector — turns the Mac's `imsg --json recent N` into the thread model
 * the QML bar widget and panel render.
 *
 * iMessage is macOS-only. chat.db and the AppleScript send path both live on
  * the Mac; this machine is a thin client over a multiplexed SSH socket (~47ms warm). This
 * script never touches SQLite itself — it shells out to ~/bin/imsg, which
 * proxies to the Mac.
 *
 * Output: one JSON object on stdout. Never throws — a failure is reported as
 * {ok:false, online:false} so the bar can grey out instead of crashing.
 *
 *   bun collector.ts            # poll: shallow window, badge + toasts
 *   bun collector.ts --deep     # panel open: wider window, full thread list
 *   bun collector.ts --mark-read        # clear every dot (right-click)
 *   bun collector.ts --read <chat>      # clear one thread's dot (opened it);
 *                                       # that chat is also skipped for toasts
 */

import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const HOME = process.env.HOME ?? homedir();

/** Watermark + toast dedupe. ~/.local/state is deliberate: never inside a repo. */
export const STATE_PATH = `${HOME}/.local/state/blip/state.json`;
/** Optional. When set, only these handles raise a desktop toast; empty/missing = every inbound. */
export const ALLOWLIST_PATH = `${HOME}/.config/blip/allowlist.json`;

/**
 * Shallow poll window for previews and toasts. An exact metadata-only unread
 * ledger survives rows leaving this window; catch-up polls expand adaptively
 * until they cover both new arrivals and the oldest outstanding unread row.
 */
export const POLL_WINDOW = 150;
/** Deep window, fetched when the panel opens and needs a real thread list. */
export const DEEP_WINDOW = 500;

/** One reaction folded onto its target message (imsg --rich). */
export interface Tapback { emoji: string; from_me: boolean; by: string | null }
/** Attachment metadata only — the file itself stays on the Mac until
 *  fetch.ts pulls it by `id` (attachment ROWID as a string: 64-bit safe). */
export interface AttachmentMeta { id?: string; name: string; mime: string | null; bytes: number | null }

export interface ImsgMessage {
  /** Stable chat.db message ROWID, supplied by bridges that expose it. */
  id?: number | string;
  /** Stable Messages GUID when available. */
  guid?: string;
  ts: string;          // "YYYY-MM-DD HH:MM:SS" — lexically sortable, which we rely on
  from_me: boolean;
  /** True only when the Mac bridge knows this is the configured self chat. */
  self_chat?: boolean;
  handle: string;
  name: string | null;
  service: string;
  chat: string;        // phone/email for DMs, opaque GUID for group chats
  text: string;
  /** APPLE-side read state (chat.db is_read, phone-synced via Messages in
   *  iCloud; imsg ≥1.9.0). Own messages are always true. Absent on older
   *  bridges → unread falls back to local marks only. */
  read?: boolean;
  /** True for tapback rows ("Loved …") — previews show them, badges don't
   *  (matches every Apple client). imsg ≥1.9.0. */
  tapback?: boolean;
  /** Delivery failure code on OWN messages (chat.db message.error; 0 = ok).
   *  AppleScript reports success for sends that die later — this is where
   *  the truth lands. imsg ≥1.10.0. */
  error?: number;
  // ---- imsg --rich extras (claude-on-mac ≥ 1.5.0); absent on plain fetches
  read_at?: string | null;
  tapbacks?: Tapback[] | null;
  attachments?: AttachmentMeta[] | null;
  reply_to?: { text: string; from_me: boolean } | null;
  edited?: boolean | null;
  retracted?: boolean | null;
  effect?: string | null;
  audio?: boolean | null;
  /** Rich-link card from a URL balloon (imsg ≥1.12): the preview image is a
   *  regular attachment id (a .pluginPayloadAttachment PNG). */
  link?: LinkCard | null;
}

export interface LinkCard { url: string; title: string; summary: string; image_id: string }

export interface Thread {
  chat: string;
  /** Full AppleScript chat GUID for groups (""), empty for DMs. Sending to a
   *  group means `imsg-send --chat-id <guid>`; never the bare id. */
  guid: string;
  name: string;
  handle: string;
  service: string;
  last_ts: string;
  last_text: string;
  last_from_me: boolean;
  count: number;       // messages for this chat inside the fetched window
  unread: number;      // inbound newer than the global/per-thread read mark
}

export interface Toast {
  chat: string;
  name: string;
  text: string;
  ts: string;
  /** Opaque digest persisted for dedupe; never contains message text. */
  key: string;
}

/**
 * Who gets a desktop notification.
 *
 *   all    — every new inbound (the default when allowlist.json is missing)
 *   allow  — only listed chats/handles; empty list = nobody
 *   off    — never interrupt (badge still counts)
 */
export type ToastMode = "all" | "allow" | "off";

export interface ToastPolicy {
  mode: ToastMode;
  allow: string[];
}

export const TOAST_ALL: ToastPolicy = { mode: "all", allow: [] };
export const TOAST_OFF: ToastPolicy = { mode: "off", allow: [] };

/** Newest toasts kept from one collector run; matches the QML queue cap. */
export const TOAST_BATCH_CAP = 20;
/** notify-send body cap, including the ellipsis. */
export const TOAST_BODY_MAX = 220;
/** How long the daemon should show a Blip toast, in milliseconds. */
export const TOAST_EXPIRE_MS = 15000;

/**
 * Two marks, deliberately. Collapsing them into one is a bug: the poll
 * watermark advances every tick, so an unread count measured against it would
 * flash to 1 and fall back to 0 on the next poll six seconds later.
 *
 *   watermark — highest ts the collector has *seen*. Drives toast eligibility.
 *   readMark  — highest ts the user has actually *looked at*. Drives the badge.
 *               Only moves on --mark-read (panel open, or middle-click).
 */
/** guid is what AppleScript's `chat id` wants ("any;+;<id>"); chat is the bare id. */
export interface GroupInfo { name: string; guid: string; participants: string[] }

export interface BlipState {
  watermark: string;
  readMark: string;
  /** Exact unread ledger, independent of the bounded preview window. */
  unreadCounts: Record<string, number>;
  /** Oldest outstanding unread timestamp per chat, used to reconcile deletes. */
  unreadOldest: Record<string, string>;
  /** True after the ledger has been seeded from every row after readMark. */
  unreadInitialized: boolean;
  /** Chats positively identified as the self-thread from its twin-row shape. */
  selfChats: string[];
  /** Group chat metadata from chat.db (display_name + members), refreshed on
   *  --deep. Cached so shallow polls can name groups without a second ssh. */
  groups: Record<string, GroupInfo>;
  /** Per-thread read marks — iMessage semantics: the blue dot stays on a
   *  thread until THAT conversation is opened, not until the list is viewed. */
  readMarks: Record<string, string>;
  toasted: string[];   // recent opaque sha256 keys; never message content
}

export interface BlipOutput {
  ok: boolean;
  online: boolean;
  error: string;
  ts: string;
  unread: number;
  threads: Thread[];
  toast: Toast[];
  /** Your own recent sends that died (chat.db error≠0); toasted once each. */
  failures: Toast[];
  /** False means models are fresh but state could not be committed. */
  persisted: boolean;
}

// ---------------------------------------------------------------- state I/O

export function loadState(path = STATE_PATH): BlipState {
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as Partial<BlipState>;
    const watermark = typeof s.watermark === "string" ? s.watermark : "";
    const unreadCounts = s.unreadCounts && typeof s.unreadCounts === "object"
      ? Object.fromEntries(
        Object.entries(s.unreadCounts).filter(([, n]) => typeof n === "number" && Number.isFinite(n) && n >= 0),
      )
      : {};
    const unreadOldest = s.unreadOldest && typeof s.unreadOldest === "object"
      ? Object.fromEntries(
        Object.entries(s.unreadOldest).filter(([, ts]) => typeof ts === "string" && ts !== ""),
      )
      : {};
    // A count-only ledger from an interrupted/experimental build cannot be
    // reconciled for deletions. Reseed it from readMark on the next poll.
    const ledgerComplete = Object.entries(unreadCounts)
      .every(([chat, count]) => count === 0 || unreadOldest[chat]);
    return {
      watermark,
      // Pre-two-mark state files have no readMark. Inheriting the watermark is
      // the safe migration: it reports zero unread rather than a fake backlog.
      readMark: typeof s.readMark === "string" ? s.readMark : watermark,
      unreadCounts,
      unreadOldest,
      unreadInitialized: s.unreadInitialized === true && ledgerComplete,
      selfChats: Array.isArray(s.selfChats)
        ? s.selfChats.filter((chat): chat is string => typeof chat === "string")
        : [],
      readMarks: s.readMarks && typeof s.readMarks === "object" ? { ...s.readMarks } : {},
      groups: s.groups && typeof s.groups === "object" ? { ...s.groups } : {},
      // Older releases stored ts|chat|text verbatim. Hash legacy entries while
      // loading so the next successful save scrubs message bodies from disk.
      toasted: Array.isArray(s.toasted)
        ? s.toasted.filter((k): k is string => typeof k === "string").slice(-200).map(normalizeToastKey)
        : [],
    };
  } catch {
    return {
      watermark: "", readMark: "", unreadCounts: {}, unreadOldest: {}, unreadInitialized: false,
      selfChats: [], readMarks: {}, groups: {}, toasted: [],
    };
  }
}

export function saveState(state: BlipState, path = STATE_PATH): boolean {
  const dir = dirname(path);
  const temp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    // Temp + rename prevents a killed collector from leaving truncated JSON.
    // 0600 is defense in depth even when the home directory is already 0700.
    writeFileSync(temp, JSON.stringify({ ...state, toasted: state.toasted.slice(-200) }), { mode: 0o600 });
    renameSync(temp, path);
    chmodSync(path, 0o600);
    return true;
  } catch {
    try { unlinkSync(temp); } catch { /* temp may not exist */ }
    return false;
  }
}

export function loadAllowlist(path = ALLOWLIST_PATH): string[] {
  return loadToastPolicy(path).allow;
}

function cleanAllow(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((h): h is string => typeof h === "string")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
}

/**
 * Parse ~/.config/blip/allowlist.json.
 *
 *   missing file                         → all (new default: don't miss people)
 *   { "mode": "off" }                    → silence
 *   { "mode": "all" }                    → every inbound
 *   { "mode": "allow", "allow": [...] }  → those senders only (empty = nobody)
 *   { "allow": ["+1…"] } / ["+1…"]       → legacy populated list = allow
 *   { "allow": [] } / []                 → legacy empty list = off
 *   corrupt JSON                         → off (fail closed, don't spam)
 */
export function parseToastPolicy(raw: unknown): ToastPolicy {
  if (raw == null) return { ...TOAST_ALL };
  if (Array.isArray(raw)) {
    const allow = cleanAllow(raw);
    return allow.length > 0 ? { mode: "allow", allow } : { ...TOAST_OFF };
  }
  if (typeof raw !== "object") return { ...TOAST_ALL };
  const obj = raw as Record<string, unknown>;
  const allow = cleanAllow(obj.allow);
  const mode = typeof obj.mode === "string" ? obj.mode.trim().toLowerCase() : "";
  if (mode === "off") return { mode: "off", allow };
  if (mode === "all") return { mode: "all", allow };
  if (mode === "allow") return { mode: "allow", allow };
  if (Array.isArray(obj.allow)) {
    return allow.length > 0 ? { mode: "allow", allow } : { ...TOAST_OFF };
  }
  return { ...TOAST_ALL };
}

export function loadToastPolicy(path = ALLOWLIST_PATH): ToastPolicy {
  try {
    return parseToastPolicy(JSON.parse(readFileSync(path, "utf8")));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    // Missing = never configured → notify everyone. Anything else (corrupt,
    // EACCES) fails closed so a half-written file cannot spam or go silent-all.
    return code === "ENOENT" ? { ...TOAST_ALL } : { ...TOAST_OFF };
  }
}

// ---------------------------------------------------------------- transform

/** Display name for a chat, falling back to the raw handle for unknown numbers. */
export function displayName(msgs: ImsgMessage[]): string {
  for (const m of msgs) if (m.name) return m.name;
  return chatKey(msgs[0]);
}

/**
 * Group chat ids (chat.style=43) are either 32 hex chars or "chat<digits>";
 * DMs are a phone or email. Anything that is not a phone/email is treated as
 * a group so an unknown id shape can never be mistaken for a DM target.
 */
export function isGroupChat(chat: string): boolean {
  if (/^\+?[0-9]{5,}$/.test(chat) || chat.indexOf("@") > 0) return false;
  return /^[0-9a-f]{32}$/i.test(chat) || /^chat[0-9]+$/i.test(chat) || chat !== "";
}

/**
 * The self-thread logs every send twice: a from_me=true row and a from_me=false
 * twin carrying the same ts+text. Left alone, every message the user sends themself
 * counts as unread and re-lights the dot. Collapse the pair and attribute it
 * to me. Shared with thread.ts so the list and the bubbles agree.
 */
export function detectSelfChats(msgs: ImsgMessage[]): string[] {
  const contextKey = (m: ImsgMessage) => `${chatKey(m)}\u0000${m.handle || ""}\u0000${m.ts}`;
  const emptySent = new Set(msgs.filter((m) => m.from_me && m.text === "").map(contextKey));
  const chats = new Set(msgs.filter((m) => m.self_chat === true).map(chatKey));
  // imsg decodes attributedBody, so both twins usually CARRY the text: the
  // empty-outbound shape is the exception, not the rule. An outbound and an
  // inbound row with the same chat+handle+second+text is equally conclusive —
  // two group members echoing each other differ by handle and never match.
  const outboundText = new Set(
    msgs.filter((m) => m.from_me && m.text !== "").map((m) => `${contextKey(m)}\u0000${m.text}`),
  );
  for (const m of msgs) {
    if (m.from_me) {
      if (m.text === "") continue;
      continue;
    }
    if (emptySent.has(contextKey(m))) chats.add(chatKey(m));
    else if (m.text !== "" && outboundText.has(`${contextKey(m)}\u0000${m.text}`)) chats.add(chatKey(m));
  }
  return [...chats].filter(Boolean);
}

export function dedupeSelfEcho(msgs: ImsgMessage[], knownSelfChats: string[] = []): ImsgMessage[] {
  const contextKey = (m: ImsgMessage) => `${chatKey(m)}\u0000${m.handle || ""}\u0000${m.ts}`;
  const contentKey = (m: ImsgMessage) => `${contextKey(m)}\u0000${m.text}`;
  const selfChats = new Set([...knownSelfChats, ...detectSelfChats(msgs)]);
  const selfContexts = new Set(msgs.filter((m) => selfChats.has(chatKey(m))).map(contextKey));
  const emptySent = new Set(
    msgs.filter((m) => selfChats.has(chatKey(m)) && m.from_me && m.text === "").map(contextKey),
  );
  const selfText = new Map<string, number>();
  const seenIds = new Set<string>();
  const out: ImsgMessage[] = [];

  for (const m of msgs) {
    const id = m.id === undefined || m.id === null ? "" : String(m.id);
    if (id && seenIds.has(id)) continue;
    if (id) seenIds.add(id);

    const context = contextKey(m);
    // The empty outbound half of a known self echo is transport noise. Keep
    // empty inbound rows: they can represent an attachment and are unread.
    if (selfChats.has(chatKey(m)) && m.from_me && m.text === "") continue;

    if (selfContexts.has(context) && m.text !== "") {
      const key = contentKey(m);
      const idx = selfText.get(key);
      if (idx !== undefined && out[idx]!.from_me !== m.from_me) {
        if (m.from_me) out[idx] = { ...out[idx]!, from_me: true };
        continue;
      }
      selfText.set(key, out.length);
    }

    if (emptySent.has(context) && !m.from_me) {
      out.push({ ...m, from_me: true });
      continue;
    }
    out.push(m);
  }
  return out;
}

/**
 * imsg returns chat:null for some rows (no chat join — typically one-off SMS
 * from short codes). Fall back to the handle so the row still has an identity
 * and never renders as the string "null".
 */
export function chatKey(m: ImsgMessage | undefined): string {
  if (!m) return "";
  return String(m.chat || m.handle || "");
}

/**
 * Group a flat message window into threads, newest-first.
 *
 * `unread` counts inbound messages strictly newer than the thread's read mark:
 * the per-thread mark if one exists, else the global one. Outbound is never
 * unread, and on an empty global mark (first ever run) nothing is unread —
 * otherwise the very first poll would claim 60 new messages.
 */
/**
 * Name a group the way Messages.app does: its display_name if it has one,
 * else the members' names. Member names are resolved from whoever has spoken
 * in the fetched window; a silent member falls back to their handle.
 */
export function groupName(chat: string, info: GroupInfo | undefined, byHandle: Map<string, string>): string {
  if (info?.name) return info.name;
  const members = (info?.participants ?? []).map((h) => byHandle.get(h) || h);
  return members.length ? members.join(", ") : chat;
}

export function buildThreads(
  msgs: ImsgMessage[],
  watermark: string,
  readMarks: Record<string, string> = {},
  groups: Record<string, GroupInfo> = {},
  unreadCounts?: Record<string, number>,
): Thread[] {
  const byHandle = new Map<string, string>();
  for (const m of msgs) if (m.name && m.handle && !byHandle.has(m.handle)) byHandle.set(m.handle, m.name);
  const byChat = new Map<string, ImsgMessage[]>();
  for (const m of msgs) {
    const key = chatKey(m);
    const list = byChat.get(key);
    if (list) list.push(m);
    else byChat.set(key, [m]);
  }

  const threads: Thread[] = [];
  for (const [chat, list] of byChat) {
    const sorted = [...list].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    const last = sorted[sorted.length - 1]!;
    const mark = readMarks[chat] && readMarks[chat]! > watermark ? readMarks[chat]! : watermark;
    const unread = unreadCounts
      ? unreadCounts[chat] ?? 0
      : watermark
        ? sorted.filter((m) => !m.from_me && m.ts > mark && m.read !== true).length
        : 0;
    threads.push({
      chat,
      guid: isGroupChat(chat) ? groups[chat]?.guid ?? "" : "",
      name: isGroupChat(chat) ? groupName(chat, groups[chat], byHandle) : displayName(sorted),
      handle: String(last.handle || chat),
      service: last.service,
      last_ts: last.ts,
      last_text: last.text,
      last_from_me: last.from_me,
      count: sorted.length,
      unread,
    });
  }

  threads.sort((a, b) => (a.last_ts < b.last_ts ? 1 : a.last_ts > b.last_ts ? -1 : 0));
  return threads;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizeToastKey(value: string): string {
  return /^sha256:[0-9a-f]{64}$/.test(value) ? value : digest(value);
}

/** Stable opaque key for one message, used to suppress repeat toasts. */
export function toastKey(m: ImsgMessage): string {
  const identity = m.id === undefined || m.id === null
    ? `${m.ts}|${chatKey(m)}|${m.handle}|${m.text}`
    : `chat.db:${m.id}`;
  return digest(identity);
}

/**
 * Fold a handle for allowlist comparison.
 *
 * Emails are case-insensitive. Phone-shaped values compare on the last
 * 10 digits so "+15551234567", "5551234567", and "(555) 123-4567" agree.
 * Group ids and short codes are exact (after trim/casefold) — extracting
 * digits from a hex GUID would false-match a phone (audit #8 territory).
 */
export function foldHandle(s: string): string {
  const t = String(s || "").trim();
  if (!t) return "";
  if (t.includes("@")) return t.toLowerCase();
  if (/^\+?[0-9\s().-]+$/.test(t)) {
    const digits = t.replace(/\D/g, "");
    if (digits.length >= 10) return digits.slice(-10);
    return digits;
  }
  return t.toLowerCase();
}

/** True when `chat` or `handle` is on the allowlist. */
export function allowlisted(chat: string, handle: string, allow: string[]): boolean {
  if (allow.length === 0) return false;
  const hay = [chat, handle].map((s) => String(s || "").trim()).filter((s) => s.length > 0);
  for (const entry of allow) {
    const e = entry.trim();
    if (!e) continue;
    const folded = foldHandle(e);
    for (const h of hay) {
      if (h === e) return true;
      if (folded !== "" && foldHandle(h) === folded) return true;
    }
  }
  return false;
}

/** Preview shown on the toast. Never empty; attachment-only rows say "New message". */
export function toastPreview(text: string | null | undefined): string {
  const raw = String(text ?? "").replace(/\uFFFC/g, "").replace(/\s+/g, " ").trim();
  if (!raw) return "New message";
  if (raw.length > TOAST_BODY_MAX) return raw.slice(0, TOAST_BODY_MAX - 1) + "…";
  return raw;
}

export function toastName(m: ImsgMessage, groups?: Record<string, GroupInfo>): string {
  const who = (m.name && String(m.name).trim()) || m.handle || chatKey(m) || "iMessage";
  const chat = chatKey(m);
  const group = groups && isGroupChat(chat) ? groups[chat] : undefined;
  if (group?.name) return `${who} · ${group.name}`;
  return who;
}

/**
 * Canonical notify-send argv. QML renders this same flag set; ui.test.ts
 * locks the two together. `--` is required: a name or body starting with
 * `-` is data, not a flag (CLAUDE.md invariant).
 */
export function notifySendArgv(t: Pick<Toast, "chat" | "name" | "text">): string[] {
  return [
    "notify-send",
    "--app-name=Blip",
    "--icon=mail-message-new",
    "--urgency=normal",
    "--category=im.received",
    `--expire-time=${TOAST_EXPIRE_MS}`,
    "--wait",
    "--action=default=Open",
    "--",
    t.name || t.chat || "iMessage",
    toastPreview(t.text),
  ];
}

export interface SelectToastsOpts {
  /** Conversation the user is looking at right now — they did not miss it. */
  skipChats?: Iterable<string>;
  /** Self-thread ids; the from_me=false twin must not raise a toast. */
  selfChats?: Iterable<string>;
  groups?: Record<string, GroupInfo>;
}

/**
 * Pick the messages that earn a desktop notification.
 *
 *   1. policy.mode is not off
 *   2. inbound only, strictly newer than the watermark (never the first-run backlog)
 *   3. not the open conversation, not the self-thread
 *   4. if mode=allow, sender (chat OR handle) matches the allowlist
 *   5. not already toasted — stops the self-thread echo storm
 *   6. newest TOAST_BATCH_CAP only — a catch-up after sleep must not dump 150 cards
 */
export function selectToasts(
  msgs: ImsgMessage[],
  watermark: string,
  policy: ToastPolicy,
  toasted: string[],
  opts: SelectToastsOpts = {},
): Toast[] {
  if (!watermark) return [];          // never toast the backlog on first run
  if (policy.mode === "off") return [];
  const skip = new Set(opts.skipChats ?? []);
  const self = new Set(opts.selfChats ?? []);
  const seen = new Set(toasted);
  const out: Toast[] = [];

  for (const m of msgs) {
    if (m.from_me) continue;
    if (m.ts <= watermark) continue;
    const chat = chatKey(m);
    if (skip.has(chat) || self.has(chat)) continue;
    if (policy.mode === "allow" && !allowlisted(chat, m.handle, policy.allow)) continue;
    const key = toastKey(m);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      chat,
      name: toastName(m, opts.groups),
      text: toastPreview(m.text),
      ts: m.ts,
      key,
    });
  }

  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return out.length > TOAST_BATCH_CAP ? out.slice(-TOAST_BATCH_CAP) : out;
}

/** How far back a delivery failure is still worth interrupting for. */
export const FAILURE_TOAST_WINDOW_MS = 15 * 60 * 1000;

/**
 * Your own recent messages that Messages could not deliver. AppleScript
 * reports success for sends that die later; chat.db's `error` is the only
 * truth. Not allowlist-gated — it is YOUR message. Deduped through the same
 * opaque-key ring as toasts, so a failure interrupts exactly once.
 */
export function selectFailures(
  msgs: ImsgMessage[],
  toasted: string[],
  nowTs = localNowTs(),
): Toast[] {
  const seen = new Set(toasted);
  const out: Toast[] = [];
  const cutoff = localNowTs(new Date(Date.parse(nowTs.replace(" ", "T")) - FAILURE_TOAST_WINDOW_MS));
  for (const m of msgs) {
    if (!m.from_me || typeof m.error !== "number" || m.error === 0) continue;
    if (m.ts < cutoff) continue;
    const key = "fail:" + toastKey(m);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ chat: chatKey(m), name: m.name ?? m.handle ?? chatKey(m),
               text: `Not delivered (error ${m.error})`, ts: m.ts, key });
  }
  return out;
}

export function maxTs(msgs: ImsgMessage[], fallback: string): string {
  let hi = fallback;
  for (const m of msgs) if (m.ts > hi) hi = m.ts;
  return hi;
}

export function minTs(msgs: ImsgMessage[], fallback: string): string {
  let low = fallback;
  for (const m of msgs) if (!low || m.ts < low) low = m.ts;
  return low;
}

// ---------------------------------------------------------------- transport

export interface FetchResult {
  ok: boolean;
  online: boolean;
  error: string;
  msgs: ImsgMessage[];
}

/**
 * Call the imsg shim. Offline is exit 69 (our guard shim) or 255 (a bare ssh
 * failure through claude-on-mac's remote shim, which has no guard of its own).
 */
/**
 * Turn the bridge's failure output into the ONE sentence that fixes it. A
 * dim icon is not a diagnosis: a stranger's first hour dies on "Full Disk
 * Access" or a missing Automation grant, and both have exact remedies.
 */
export function explainBridgeError(status: number | null, stderr: string): string {
  const s = (stderr || "").toLowerCase();
  if (status === 78 || s.includes("no mac configured")) {
    return "Blip is not set up yet — run scripts/blip-setup <your-mac>";
  }
  if (s.includes("unable to open database") || s.includes("authorization denied") ||
      s.includes("operation not permitted") || s.includes("chat.db not found")) {
    return "The Mac denies chat.db: grant Full Disk Access to /usr/libexec/sshd-keygen-wrapper "
         + "(System Settings → Privacy & Security), then reconnect";
  }
  if (s.includes("-1743") || s.includes("not authorized to send apple events") || s.includes("not permitted to")) {
    return "Messages automation not granted: click Allow on the Mac (System Settings → Privacy & Security → "
         + "Automation → sshd-keygen-wrapper → Messages)";
  }
  if (s.includes("python") && (s.includes("no such file") || s.includes("not found"))) {
    return "Mac tools missing: re-run scripts/blip-setup (installs ~/.blip/bin on the Mac)";
  }
  if (s.includes("permission denied (publickey") || s.includes("host key verification failed")) {
    return "ssh to the Mac needs key auth: ssh-copy-id <your-mac>, then re-run blip-setup";
  }
  const first = (stderr || "").trim().split("\n")[0];
  return first || `imsg exit ${status}`;
}

export function fetchMessages(limit: number, runner = spawnSync): FetchResult {
  const res = runner(`${HOME}/bin/imsg`, ["--json", "recent", String(limit)], {
    encoding: "utf8",
    timeout: 15000,
  });

  if (res.status === 69 || res.status === 255) {
    return { ok: false, online: false, error: "Mac unreachable", msgs: [] };
  }
  if (res.status !== 0) {
    const err = explainBridgeError(res.status, (res.stderr || "").toString());
    return { ok: false, online: true, error: err, msgs: [] };
  }
  try {
    const parsed = JSON.parse(res.stdout as string);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return { ok: true, online: true, error: "", msgs: parsed as ImsgMessage[] };
  } catch (e) {
    return { ok: false, online: true, error: `bad JSON from imsg: ${e}`, msgs: [] };
  }
}

/**
 * Fetch a preview window, expanding only while every returned row is at or
 * newer than the cutoff. This catches bursts/outages larger than POLL_WINDOW
 * and covers the unread reconciliation boundary without transferring the full
 * history during ordinary six-second polls.
 */
export const CATCHUP_MAX_ROWS = 8192;

export function fetchMessagesAfter(
  cutoff: string,
  minimum: number,
  runner = spawnSync,
): FetchResult {
  let limit = minimum;
  while (true) {
    const fetched = fetchMessages(limit, runner);
    // A bridge that keeps returning "full" pages must not grow this forever.
    if (!fetched.ok || !cutoff || fetched.msgs.length < limit || limit >= CATCHUP_MAX_ROWS) return fetched;
    // Fetch beyond the boundary, not merely to it: several rows can share a
    // one-second timestamp and otherwise straddle the window edge.
    if (minTs(fetched.msgs, "") < cutoff) return fetched;
    limit *= 2;
  }
}

/**
 * A message is unread iff BOTH sides say so:
 *   - Apple side: chat.db `is_read` = 0 (imsg ≥1.9.0 emits `read`; it syncs
 *     from the iPhone via Messages in iCloud) — reading on the PHONE clears
 *     Blip within a poll.
 *   - Local side: newer than the effective read mark — reading in BLIP
 *     clears it here (the phone keeps its own badge; write-back is
 *     impossible).
 * A row without the `read` field (older imsg) falls back to local-only.
 */
/** Local wall clock as a chat.db-style "YYYY-MM-DD HH:MM:SS" stamp. */
export function localNowTs(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ` +
         `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
}

export function isUnread(m: ImsgMessage, mark: string): boolean {
  // Tapbacks preview but never badge — matches every Apple client.
  return !m.from_me && m.ts > mark && m.read !== true && m.tapback !== true;
}

export function unreadCounts(
  msgs: ImsgMessage[],
  readMark: string,
  readMarks: Record<string, string>,
  selfChats: string[] = [],
): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!readMark) return counts;
  const self = new Set(selfChats);
  for (const m of msgs) {
    const chat = chatKey(m);
    if (self.has(chat)) continue; // your own echoes never badge (phone parity)
    const mark = readMarks[chat] && readMarks[chat]! > readMark ? readMarks[chat]! : readMark;
    if (isUnread(m, mark)) counts[chat] = (counts[chat] ?? 0) + 1;
  }
  return counts;
}

export function unreadOldest(
  msgs: ImsgMessage[],
  readMark: string,
  readMarks: Record<string, string>,
  selfChats: string[] = [],
): Record<string, string> {
  const oldest: Record<string, string> = {};
  if (!readMark) return oldest;
  const self = new Set(selfChats);
  for (const m of msgs) {
    const chat = chatKey(m);
    if (self.has(chat)) continue;
    const mark = readMarks[chat] && readMarks[chat]! > readMark ? readMarks[chat]! : readMark;
    if (isUnread(m, mark) && (!oldest[chat] || m.ts < oldest[chat]!)) oldest[chat] = m.ts;
  }
  return oldest;
}

/** `imsg --json groups` — claude-on-mac ≥ 1.4.0. */
/** One row of `imsg --json chats`: a conversation with its latest preview. */
export interface ChatInfo {
  id: string;
  name: string | null;
  service: string;
  last: string;
  last_text: string;
  last_from_me: boolean;
  last_handle: string;
  last_name: string | null;
}

/** How many conversations the sidebar lists (chat.db has hundreds). */
export const CHAT_LIST_LIMIT = 300;

/**
 * The COMPLETE conversation list (imsg ≥1.11.0 `chats` with previews). The
 * message window only ever covers the busiest few days — deriving the list
 * from it lost every quiet conversation ("where is the group LMT?").
 * Fetched on deep runs only; the shallow poll keeps the last list in the
 * widget's memory. Previews are never persisted (no content on disk).
 */
export function fetchChats(runner = spawnSync): ChatInfo[] | null {
  const res = runner(`${HOME}/bin/imsg`, ["--json", "chats", String(CHAT_LIST_LIMIT)], {
    encoding: "utf8",
    timeout: 20000,
  });
  if (res.status !== 0) return null;
  try {
    const rows = JSON.parse(res.stdout as string);
    if (!Array.isArray(rows)) return null;
    return rows
      .filter((r) => r && typeof r.id === "string" && r.id !== "")
      .map((r) => ({
        id: String(r.id),
        name: typeof r.name === "string" ? r.name : null,
        service: String(r.service ?? ""),
        last: String(r.last ?? ""),
        last_text: String(r.last_text ?? ""),
        last_from_me: r.last_from_me === true,
        last_handle: String(r.last_handle ?? ""),
        last_name: typeof r.last_name === "string" ? r.last_name : null,
      }));
  } catch {
    return null;
  }
}

/**
 * Window-derived threads (rich: accurate previews, counts) + every other
 * conversation from the chat list, newest first. A chat already covered by
 * the window keeps the window's row; the rest get a row built from the
 * chat list's preview, with unread from the ledger.
 */
export function mergeChats(
  threads: Thread[],
  chats: ChatInfo[],
  groups: Record<string, GroupInfo>,
  unreadCounts: Record<string, number>,
): Thread[] {
  const have = new Set(threads.map((t) => t.chat));
  const out = [...threads];
  for (const c of chats) {
    if (have.has(c.id)) continue;
    have.add(c.id);
    const group = isGroupChat(c.id);
    const name = group
      ? (groups[c.id]?.name || c.name || c.id)
      : (c.last_name || c.name || c.id);
    out.push({
      chat: c.id,
      guid: group ? groups[c.id]?.guid ?? "" : "",
      name,
      handle: group ? c.last_handle || c.id : c.id,
      service: c.service,
      last_ts: c.last,
      last_text: c.last_text,
      last_from_me: c.last_from_me,
      count: 0,
      unread: unreadCounts[c.id] ?? 0,
    });
  }
  return out.sort((a, b) => (a.last_ts < b.last_ts ? 1 : a.last_ts > b.last_ts ? -1 : 0));
}

export function fetchGroups(runner = spawnSync): Record<string, GroupInfo> | null {
  const res = runner(`${HOME}/bin/imsg`, ["--json", "groups"], { encoding: "utf8", timeout: 15000 });
  if (res.status !== 0) return null;
  try {
    const rows = JSON.parse(res.stdout as string);
    if (!Array.isArray(rows)) return null;
    const out: Record<string, GroupInfo> = {};
    for (const r of rows) {
      if (!r || typeof r.chat !== "string") continue;
      out[r.chat] = {
        name: typeof r.name === "string" ? r.name : "",
        guid: typeof r.guid === "string" ? r.guid : "",
        participants: Array.isArray(r.participants)
          ? r.participants.filter((h: unknown) => typeof h === "string")
          : typeof r.participants === "string" ? r.participants.split(",").filter(Boolean) : [],
      };
    }
    return out;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- main

export function collect(deep: boolean, markRead = false, readChat = "", seenTs = ""): BlipOutput {
  const now = new Date().toISOString();
  const state = loadState();
  // On migration, seed the ledger all the way back to what the user last read.
  // Thereafter cover both new arrivals and every outstanding unread row. That
  // makes the ledger exact even if an unread message is deleted on the Mac.
  const oldestUnread = Object.values(state.unreadOldest).reduce(
    (oldest, ts) => !oldest || ts < oldest ? ts : oldest,
    "",
  );
  const cutoff = state.unreadInitialized
    ? oldestUnread && oldestUnread < state.watermark ? oldestUnread : state.watermark
    : state.readMark;
  const fetched = fetchMessagesAfter(cutoff, deep ? DEEP_WINDOW : POLL_WINDOW);

  if (!fetched.ok) {
    return {
      ok: false,
      online: fetched.online,
      error: fetched.error,
      ts: now,
      unread: 0,
      threads: [],
      toast: [],
      failures: [],
      persisted: true,
    };
  }

  const highest = maxTs(fetched.msgs, state.watermark);
  // A message can carry a FUTURE timestamp (timezone skew — a "Sep 1
  // 08:53" birthday text arrived Aug 31 morning). A read mark taken from
  // the GLOBAL max therefore poisoned unrelated threads: anything arriving
  // before that future instant could never badge. So the global mark is
  // clamped to the local clock, and each chat that reaches past it gets a
  // PER-CHAT mark at its own max — every visible message is covered,
  // nothing beyond now leaks onto other threads.
  const nowTs = localNowTs();
  const chatMax: Record<string, string> = {};
  for (const m of fetched.msgs) {
    const c = chatKey(m);
    if (!chatMax[c] || m.ts > chatMax[c]!) chatMax[c] = m.ts;
  }
  // Badge counts against readMark (what the user has seen); toasts fire against
  // watermark (what the collector has seen). See BlipState.
  const readMark = markRead ? (highest <= nowTs ? highest : nowTs) : state.readMark;
  // Opening one conversation clears only that thread's dot — marked with
  // THAT chat's newest ts, never the global max.
  const readMarks = { ...state.readMarks };
  if (markRead) {
    for (const [c, ts] of Object.entries(chatMax)) {
      if (ts > readMark) readMarks[c] = ts;
    }
  }
  if (readChat) {
    // Mark through what the user actually SAW (the panel passes the newest
    // bubble ts as --seen; it includes a future-dated row when the chat has
    // one on screen). A message arriving between the click and this run has
    // ts > seen and stays unread. Fallback without --seen: through now, or
    // the chat's own future row.
    const own = chatMax[readChat] ?? "";
    readMarks[readChat] = seenTs !== "" ? seenTs : (own > nowTs ? own : nowTs);
  }
  // Group metadata is ~1000 rows; refresh it only on a deep (panel) fetch and
  // keep the last good copy if the lookup fails.
  const groups = (deep ? fetchGroups() : null) ?? state.groups;
  const selfChats = [...new Set([...state.selfChats, ...detectSelfChats(fetched.msgs)])];
  const msgs = dedupeSelfEcho(fetched.msgs, selfChats);
  let exactCounts = unreadCounts(msgs, state.readMark, state.readMarks, selfChats);
  let exactOldest = unreadOldest(msgs, state.readMark, state.readMarks, selfChats);
  if (markRead) {
    exactCounts = {};
    exactOldest = {};
  } else if (readChat) {
    delete exactCounts[readChat];
    delete exactOldest[readChat];
  }
  // Prune per-thread marks the global mark has overtaken (Codex finding #13):
  // they no longer affect any count and would otherwise accumulate forever.
  for (const [chat, ts] of Object.entries(readMarks)) {
    if (ts <= readMark) delete readMarks[chat];
  }
  const windowThreads = buildThreads(msgs, readMark, readMarks, groups, exactCounts);
  // Deep runs (a surface is open) complete the list from `imsg chats`; a
  // shallow poll returns the window's rows and the widget keeps its last
  // complete list in memory (it skips identical assignments anyway).
  const chats = deep ? fetchChats() : null;
  const threads = chats ? mergeChats(windowThreads, chats, groups, exactCounts) : windowThreads;
  const toast = selectToasts(msgs, state.watermark, loadToastPolicy(), state.toasted, {
    skipChats: readChat ? [readChat] : [],
    selfChats,
    groups,
  });
  const failures = selectFailures(fetched.msgs, state.toasted, nowTs);
  const unread = Object.values(exactCounts).reduce((n, count) => n + count, 0);

  // Both marks advance only on a good fetch, so an outage cannot silently
  // swallow the messages that arrived during it.
  const persisted = saveState({
    watermark: highest,
    // First ever run: adopt the current high-water rather than reporting the
    // whole preview window as unread the moment the plugin is installed.
    readMark: state.readMark === "" ? highest : readMark,
    unreadCounts: exactCounts,
    unreadOldest: exactOldest,
    unreadInitialized: true,
    selfChats,
    readMarks,
    groups,
    toasted: [...state.toasted, ...toast.map((t) => t.key), ...failures.map((f) => f.key)],
  });

  const warning = !persisted
    ? "state write failed; notifications paused"
    : "";
  return {
    ok: true,
    online: true,
    error: warning,
    ts: now,
    unread,
    threads,
    // Never emit notifications that could not be committed to the dedupe ring.
    toast: persisted ? toast : [],
    failures: persisted ? failures : [],
    persisted,
  };
}

if (import.meta.main) {
  const deep = process.argv.includes("--deep");
  const markRead = process.argv.includes("--mark-read");
  const ri = process.argv.indexOf("--read");
  const readChat = ri >= 0 ? String(process.argv[ri + 1] ?? "") : "";
  const si = process.argv.indexOf("--seen");
  const seenTs = si >= 0 ? String(process.argv[si + 1] ?? "") : "";
  try {
    console.log(JSON.stringify(collect(deep, markRead, readChat, seenTs)));
  } catch (e) {
    console.log(
      JSON.stringify({
        ok: false, online: false, error: String(e), ts: new Date().toISOString(),
        unread: 0, threads: [], toast: [], failures: [], persisted: false,
      }),
    );
  }
}
