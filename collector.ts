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
 *   bun collector.ts --read <chat>      # clear one thread's dot (opened it)
 */

import { openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  identityNameFor,
  safeReadIdentityConfig,
  type IdentityConfig,
} from "./identities";

const HOME = process.env.HOME ?? homedir();

/** Watermark + toast dedupe. ~/.local/state is deliberate: never inside a repo. */
export const STATE_PATH = `${HOME}/.local/state/blip/state.json`;
/** Handles whose inbound messages are allowed to raise a desktop toast. */
export const ALLOWLIST_PATH = `${HOME}/.config/blip/allowlist.json`;
/** Handles and phrases whose conversations Blip does not show at all. */
export const MUTELIST_PATH = `${HOME}/.config/blip/mutelist.json`;

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
  /** Historical chat identifiers coalesced into this logical conversation. */
  aliases?: string[];
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
  /** Mirrored from Messages' pinning preferences; Blip never changes it. */
  pinned: boolean;
  /** Position in Messages' pinned section, when pinned. */
  pin_order: number | null;
  /** Messages-style short label from Contacts' unified-card view. */
  pin_name?: string;
  /** Other people in a group, for explicit per-person contact actions. */
  participants?: GroupParticipant[];
}

export interface GroupParticipant { handle: string; name: string }

export interface Toast {
  chat: string;
  name: string;
  text: string;
  ts: string;
  /** Opaque digest persisted for dedupe; never contains message text. */
  key: string;
}

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
export interface GroupInfo {
  name: string;
  guid: string;
  participants: string[];
  participantNames?: Record<string, string>;
}

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
  /** Older chat rows of a re-keyed group → the row Messages writes to now.
   *  Refreshed on --deep with the chat list; cached so a shallow poll folds
   *  the same way and a conversation never blinks into two. */
  chatAliases: Record<string, string>;
  /** Messages' pinned section: chat id → pin order (null when unknown).
   *  Refreshed with the chat list on deep runs; shallow polls apply it so
   *  pins never vanish between a deep run and the next (ids only). */
  pins: Record<string, number | null>;
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
  /** Links that just arrived — the surface opens the share sheet on the newest. */
  links: IncomingLink[];
  /** Security codes that just arrived — the widget holds the newest in memory
   *  for a few minutes, toasts it, and types or copies it on request. */
  codes: SecurityCode[];
  /** False means models are fresh but state could not be committed. */
  persisted: boolean;
  /** True when `threads` is the complete list (chat list fetched), not the
   *  poll window's rows — the widget overlays a shallow result onto its last
   *  deep one instead of replacing it. */
  deep: boolean;
}

// ---------------------------------------------------------------- state I/O

/** Only chat ids mapped to an integer pin order or null survive a reload. */
export function validPins(raw: unknown): Record<string, number | null> {
  if (!raw || typeof raw !== "object") return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .filter(([chat, v]) => chat !== "" && (v === null || Number.isInteger(v)))
      .map(([chat, v]) => [chat, v === null ? null : Number(v)]),
  );
}

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
      chatAliases: s.chatAliases && typeof s.chatAliases === "object"
        ? Object.fromEntries(Object.entries(s.chatAliases).filter(([, v]) => typeof v === "string" && v !== ""))
        : {},
      pins: validPins(s.pins),
      // Older releases stored ts|chat|text verbatim. Hash legacy entries while
      // loading so the next successful save scrubs message bodies from disk.
      toasted: Array.isArray(s.toasted)
        ? s.toasted.filter((k): k is string => typeof k === "string").slice(-200).map(normalizeToastKey)
        : [],
    };
  } catch {
    return {
      watermark: "", readMark: "", unreadCounts: {}, unreadOldest: {}, unreadInitialized: false,
      selfChats: [], readMarks: {}, groups: {}, chatAliases: {}, pins: {}, toasted: [],
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
    // fsync before rename: a power cut must never leave an empty state.json
    // that silently resets every read mark.
    const fd = openSync(temp, "w", 0o600);
    try { writeSync(fd, JSON.stringify({ ...state, toasted: state.toasted.slice(-200) })); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    chmodSync(path, 0o600);
    return true;
  } catch {
    try { unlinkSync(temp); } catch { /* temp may not exist */ }
    return false;
  }
}

export function loadAllowlist(path = ALLOWLIST_PATH): string[] {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const list = Array.isArray(raw) ? raw : raw?.allow;
    return Array.isArray(list) ? list.filter((h: unknown) => typeof h === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The mute list: political fundraising blasts and their kin, gone.
 *
 * Same shape as the allowlist and read the same way — a bare array or
 * `{ "mute": [...] }`, re-read every poll, absent file means an empty list —
 * but the opposite polarity, and it silences the whole conversation rather
 * than just its toast. An entry matches either
 *   • a handle or chat id EXACTLY (`"+15551234567"`), like the allowlist, or
 *   • a phrase, case-insensitively, anywhere in an inbound message's text
 *     (`"ActBlue"`, `"Stop2End"`, `"Reply STOP2END"`).
 * Phrases are the useful half: the short codes these blasts arrive from
 * rotate every cycle, but the opt-out footer the law makes them carry does
 * not. Two characters minimum, so a stray `"a"` cannot mute the world.
 */
export function loadMutelist(path = MUTELIST_PATH): string[] {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const list = Array.isArray(raw) ? raw : raw?.mute;
    return Array.isArray(list) ? list.filter((h: unknown) => typeof h === "string" && h !== "") : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- transform

/** Display name for a chat, falling back to the raw handle for unknown numbers. */
export function displayName(msgs: ImsgMessage[]): string {
  for (const m of msgs) if (m.name) return m.name;
  return chatKey(msgs[0]);
}

/** Never expose Messages' U+FFFC attachment marker as a dotted OBJ glyph. */
export function messagePreview(
  text: unknown,
  attachment?: { name?: unknown; mime?: unknown } | null,
): string {
  const cleaned = String(text ?? "").replace(/\uFFFC/g, "").trim();
  if (cleaned) return cleaned;
  if (!attachment) return "";
  const mime = String(attachment.mime ?? "").toLowerCase();
  const name = String(attachment.name ?? "").toLowerCase();
  if (mime.startsWith("image/") || /\.(?:avif|gif|heic|heif|jpe?g|png|webp)$/.test(name)) return "Photo";
  if (mime.startsWith("video/") || /\.(?:m4v|mov|mp4|webm)$/.test(name)) return "Video";
  if (mime.startsWith("audio/") || /\.(?:aac|m4a|mp3|wav)$/.test(name)) return "Audio message";
  if (mime === "text/vcard" || /\.vcf$/.test(name)) return "Contact card";
  return "Attachment";
}

/** Apply a user's explicit resolution before any list, toast, or group label is built. */
export function applyIdentityOverrides(
  msgs: ImsgMessage[],
  config: IdentityConfig,
): ImsgMessage[] {
  return msgs.map((message) => {
    const name = identityNameFor(message.handle, config)
      || identityNameFor(chatKey(message), config);
    return name && name !== message.name ? { ...message, name } : message;
  });
}

/** Complete chat rows may have no message in the preview window, so name DMs again here. */
export function applyThreadIdentityOverrides(
  threads: Thread[],
  config: IdentityConfig,
): Thread[] {
  return threads.map((thread) => {
    if (isGroupChat(thread.chat)) return thread;
    const name = identityNameFor(thread.chat, config) || identityNameFor(thread.handle, config);
    return name && name !== thread.name ? { ...thread, name } : thread;
  });
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
/** minTwins=1 (default) is enough to dedupe a batch you are LOOKING at;
 *  collect() persists a chat as self only with minTwins=2 — a permanent
 *  promotion must not ride on one same-second coincidence (war room #6). */
export function detectSelfChats(msgs: ImsgMessage[], minTwins = 1): string[] {
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
  // One same-second twin can be a coincidence (both sides typing "ok");
  // promotion is permanent and silently breaks unread for that DM, so it
  // takes two twins at DIFFERENT seconds — the self-thread produces one per
  // message, a coincidence does not repeat (war room #6).
  const hits = new Map<string, Set<string>>();
  for (const m of msgs) {
    if (m.from_me) continue;
    const twin = emptySent.has(contextKey(m)) || (m.text !== "" && outboundText.has(`${contextKey(m)}\u0000${m.text}`));
    if (!twin) continue;
    const k = chatKey(m);
    if (!hits.has(k)) hits.set(k, new Set());
    hits.get(k)!.add(m.ts);
  }
  for (const [k, seconds] of hits) if (seconds.size >= minTwins) chats.add(k);
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
  const retractedSent = new Set(
    msgs.filter((m) => selfChats.has(chatKey(m)) && m.from_me && m.retracted === true).map(contextKey),
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
    // An unsend leaves the same shape with the opposite truth — the empty
    // outbound row IS the message (the tombstone) and the echo is what Undo
    // Send never reached — so there the echo goes and the row stays.
    if (retractedSent.has(context)) {
      if (!m.from_me) continue;
    } else if (selfChats.has(chatKey(m)) && m.from_me && m.text === "") continue;

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
 * A row with neither a chat nor a handle is a leftover of a conversation that
 * no longer exists: deleting a conversation removes the chat row and the join,
 * and Messages in iCloud keeps the message rows in sync regardless. Messages
 * shows such rows nowhere; grouped by their empty identity they became one
 * nameless, unopenable thread here. Rows WITH a handle stay — some SMS
 * senders only ever exist that way (see chatKey).
 */
export function hasIdentity(m: ImsgMessage): boolean {
  return chatKey(m) !== "";
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
  const members = groupParticipants(info, byHandle).map((member) => member.name);
  return members.length ? members.join(", ") : chat;
}

export type SendService = "iMessage" | "SMS" | "RCS";

/** Map a chat.db service string onto what `imsg-send --service` accepts. */
export function normalizeSendService(raw: string | undefined | null): SendService {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "sms") return "SMS";
  if (s === "rcs") return "RCS";
  return "iMessage";
}

/**
 * Which service a DM should send on. Originally @lukejmorrison's, in PR #4.
 *
 * The thread used to carry the LAST BUBBLE's service, which is wrong in both
 * directions. A failed iMessage to someone on SMS made the next send iMessage
 * again, so it failed again — the thread sticks. And a contact who left
 * iMessage keeps a green thread the client never notices.
 *
 * Order matters:
 *   1. the newest row is a FAILED iMessage of ours to a phone → they are not
 *      on iMessage; send SMS. (AppleScript does not fall back the way the
 *      Messages GUI does — the send just dies with error 22.)
 *   2. otherwise the last INBOUND service: that is what they actually reach
 *      us on, and a failed outbound must never override it.
 *   3. no inbound at all → the last outbound that SUCCEEDED.
 *   4. nothing to go on → iMessage, like a fresh conversation.
 * Groups send `--chat-id` and ignore all of this.
 */
export function sendServiceForMessages(msgs: ImsgMessage[]): SendService {
  if (!msgs.length) return "iMessage";
  const sorted = [...msgs].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const failed = (m: ImsgMessage) => typeof m.error === "number" && m.error !== 0;

  const newest = sorted[sorted.length - 1]!;
  const chat = chatKey(newest);
  if (newest.from_me && failed(newest)
      && normalizeSendService(newest.service) === "iMessage"
      && /^\+?[0-9]{5,}$/.test(chat)) {
    return "SMS";
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (!sorted[i]!.from_me) return normalizeSendService(sorted[i]!.service);
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (!failed(sorted[i]!)) return normalizeSendService(sorted[i]!.service);
  }
  return "iMessage";
}

/** Bounded, de-duplicated people for a group contact menu. */
export function groupParticipants(
  info: GroupInfo | undefined,
  byHandle: Map<string, string> = new Map(),
): GroupParticipant[] {
  const result: GroupParticipant[] = [];
  const seen = new Set<string>();
  for (const raw of info?.participants ?? []) {
    const handle = String(raw || "").trim().slice(0, 320);
    if (!handle || seen.has(handle) || result.length >= 64) continue;
    seen.add(handle);
    const resolved = info?.participantNames?.[handle] || byHandle.get(handle) || handle;
    result.push({ handle, name: String(resolved).trim().slice(0, 160) || handle });
  }
  return result;
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
      service: isGroupChat(chat) ? last.service : sendServiceForMessages(sorted),
      last_ts: last.ts,
      last_text: messagePreview(last.text, last.attachments?.[0]),
      last_from_me: last.from_me,
      count: sorted.length,
      unread,
      pinned: false,
      pin_order: null,
      ...(isGroupChat(chat) ? { participants: groupParticipants(groups[chat], byHandle) } : {}),
    });
  }

  threads.sort(compareThreads);
  return threads;
}

/** Messages keeps pinned conversations ahead of the activity-sorted list. */
export function compareThreads(a: Thread, b: Thread): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.pinned && b.pinned) {
    if (a.pin_order !== null && b.pin_order !== null && a.pin_order !== b.pin_order) {
      return a.pin_order - b.pin_order;
    }
    if (a.pin_order !== null && b.pin_order === null) return -1;
    if (a.pin_order === null && b.pin_order !== null) return 1;
  }
  return a.last_ts < b.last_ts ? 1 : a.last_ts > b.last_ts ? -1 : 0;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizeToastKey(value: string): string {
  // "fail:" (selectFailures), "link:" (selectIncomingLinks) and "code:"
  // (selectCodes) are key namespaces — keep them verbatim or their dedupe
  // rings reset every load.
  return /^(fail:|link:|code:)?sha256:[0-9a-f]{64}$/.test(value) ? value : digest(value);
}

/** Stable opaque key for one message, used to suppress repeat toasts. */
export function toastKey(m: ImsgMessage): string {
  // No text in the fallback identity: Messages can land the row before the
  // decoded body, so the same message polled twice must hash the same.
  const identity = m.id === undefined || m.id === null
    ? `${m.ts}|${chatKey(m)}|${m.handle}`
    : `chat.db:${m.id}`;
  return digest(identity);
}

/**
 * Pick the messages that earn a desktop notification.
 *
 * Gated three ways, because chat.db is mostly bank alerts and 2FA codes:
 *   1. inbound only, and strictly newer than the watermark
 *   2. sender (chat OR handle) is on the allowlist
 *   3. not already toasted — this is what stops the self-thread echo storm,
 *      where the user's own sent replies come back as from_me=false
 */
export function selectToasts(
  msgs: ImsgMessage[],
  watermark: string,
  allow: string[],
  toasted: string[],
): Toast[] {
  if (!watermark) return [];          // never toast the backlog on first run
  const allowed = new Set(allow);
  const seen = new Set(toasted);
  const out: Toast[] = [];

  for (const m of msgs) {
    if (m.from_me) continue;
    if (m.ts <= watermark) continue;
    if (!allowed.has(chatKey(m)) && !allowed.has(m.handle)) continue;
    const key = toastKey(m);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ chat: chatKey(m), name: m.name ?? m.handle, text: m.text, ts: m.ts, key });
  }
  return out;
}

/** One mute entry against one message: an exact handle/chat id, or a phrase
 *  (two characters or more) anywhere in the text, case-insensitively. */
export function matchesMute(m: ImsgMessage, mute: string[]): boolean {
  if (mute.length === 0) return false;
  const chat = chatKey(m);
  const text = String(m.text ?? "").toLowerCase();
  for (const entry of mute) {
    if (entry === chat || entry === m.handle) return true;
    if (entry.length >= 2 && text !== "" && text.includes(entry.toLowerCase())) return true;
  }
  return false;
}

/**
 * Conversations the mute list silences — matched on INBOUND messages only, so
 * quoting "ActBlue" to a friend never mutes the friend.
 *
 * One match mutes the whole chat, not the single message: a fundraising blast
 * carries its opt-out footer on some messages and not others, and half a
 * conversation left in the sidebar is worse than none.
 */
export function mutedChats(msgs: ImsgMessage[], mute: string[]): string[] {
  if (mute.length === 0) return [];
  const out = new Set<string>();
  for (const m of msgs) if (!m.from_me && matchesMute(m, mute)) out.add(chatKey(m));
  return [...out];
}

/** Drop muted conversations before anything is counted. Filtering here rather
 *  than in the QML is the point: a muted blast never reaches the unread
 *  ledger, the thread list, or a toast, so it cannot badge the bar either. */
export function dropMuted(msgs: ImsgMessage[], muted: string[]): ImsgMessage[] {
  if (muted.length === 0) return msgs;
  const gone = new Set(muted);
  return msgs.filter((m) => !gone.has(chatKey(m)));
}

/**
 * The same cut on `imsg chats` rows. A deep run completes the sidebar from the
 * chat list, which reaches back further than the message window — without
 * this, a blast last seen a month ago would reappear the moment the panel
 * opened. Rows are matched on their id, their aliases, and their last preview
 * text, which is the only body a chat row carries.
 */
export function dropMutedChats(chats: ChatInfo[] | null, mute: string[], muted: string[]): ChatInfo[] | null {
  if (chats === null || (mute.length === 0 && muted.length === 0)) return chats;
  const gone = new Set(muted);
  const phrases = mute.filter((e) => e.length >= 2).map((e) => e.toLowerCase());
  return chats.filter((c) => {
    const ids = [c.id, ...c.aliases];
    if (ids.some((id) => gone.has(id) || mute.includes(id))) return false;
    if (c.last_from_me) return true;   // your own reply is not the blast
    const text = c.last_text.toLowerCase();
    return text === "" || !phrases.some((p) => text.includes(p));
  });
}

/** First http(s) URL in a message, or "". Trailing punctuation that a person
 *  would read as sentence-end is trimmed; a URL inside the text is fine. */
export function firstUrl(text: string | null | undefined): string {
  const m = /https?:\/\/[^\s<>"']+/i.exec(String(text ?? ""));
  if (!m) return "";
  return m[0].replace(/[.,;:!?)\]}'"]+$/, "");
}

export interface IncomingLink {
  chat: string;
  url: string;
  ts: string;
  key: string;
}

/**
 * Links that JUST arrived — Blip opens the share sheet on them (Fred, 2.3.0).
 *
 * Same gate as a toast, deliberately: inbound only, strictly newer than the
 * watermark (never the first-run backlog), never the self-thread, and each
 * message fires exactly once through the persisted `link:` ring. A batch
 * after sleep returns in order and the caller shows only the newest — the
 * ring still records every key, so yesterday's links never pop tomorrow.
 */
export function selectIncomingLinks(
  msgs: ImsgMessage[],
  watermark: string,
  toasted: string[],
  selfChats: string[] = [],
): IncomingLink[] {
  if (!watermark) return [];
  const seen = new Set(toasted);
  const self = new Set(selfChats);
  const out: IncomingLink[] = [];
  for (const m of msgs) {
    if (m.from_me) continue;
    if (m.ts <= watermark) continue;
    const chat = chatKey(m);
    if (self.has(chat)) continue;
    const url = firstUrl(m.text);
    if (!url) continue;
    const key = "link:" + toastKey(m);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ chat, url, ts: m.ts, key });
  }
  return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

// ------------------------------------------------------ security codes

export interface SecurityCode {
  chat: string;
  name: string;
  /** Digits only (a "123 456" or "123-456" code is normalised). */
  code: string;
  /** Origin-bound form (`@example.com #123456`): the site the code is for. */
  domain: string;
  ts: string;
  key: string;
}

/** Words a sender puts next to a one-time code. Deliberately broad: the
 *  token rules below do the narrowing. */
const CODE_TRIGGER = /(code|passcode|\bpin\b|\botp\b|one[- ]?time|verif|security|authenticat|\b2fa\b|two[- ]factor|token|confirm|\blog ?in\b|sign[- ]?in|access)/gi;
/** 4–8 digits, or two groups of three. Not part of a longer number, not money
 *  (a "$" before, a "%" or ".digit" after), not the tail of a phone number. */
const CODE_TOKEN = /(?<![\d$€£#(+.-])(?<!\d[-.])\b(\d{3}[ -]\d{3}|\d{4,8})\b(?![\d%])(?!\.\d)(?!-\d)/g;
/** WebOTP / "origin-bound" line: `@example.com #123456` (may follow other text). */
const CODE_BOUND = /(?:^|\s)@([a-z0-9-]+(?:\.[a-z0-9-]+)+)\s+#([a-z0-9-]{4,12})\b/i;
/** Google's "G-123456". */
const CODE_GOOGLE = /\bG-(\d{6,8})\b/;
/** A number the sender LABELLED as something else, right before the token:
 *  "for card 1234", "account ending 4821", "ref 20260904". Nearest-trigger
 *  otherwise picked the card digits in "Your security code for card 1234 is
 *  987654" — and typecode would have typed them (Astra #13). */
const CODE_LABELLED = /\b(?:card|account|acct|ending(?:\s+in)?|last|ref(?:erence)?|order|ticket|invoice|case|no\.?|number|#)\s*[:#]?\s*$/i;

/**
 * The one-time code in a message, or null. macOS's rule, roughly: a trigger
 * word and a digit token near it. Heuristic by design — a false positive is
 * a toast nobody clicks; a false negative is a code you read yourself.
 */
export function extractCode(text: string | null | undefined): { code: string; domain: string } | null {
  const raw = String(text ?? "");
  if (raw === "") return null;
  const bound = CODE_BOUND.exec(raw);
  if (bound) return { code: bound[2]!, domain: bound[1]!.toLowerCase() };
  // digits inside a URL are never the code
  const t = raw.replace(/https?:\/\/\S+/gi, " ");
  const google = CODE_GOOGLE.exec(t);
  if (google) return { code: google[1]!, domain: "" };
  const triggers: number[] = [];
  for (const m of t.matchAll(CODE_TRIGGER)) triggers.push(m.index ?? 0);
  if (triggers.length === 0) return null;
  let best: { code: string; dist: number } | null = null;
  for (const m of t.matchAll(CODE_TOKEN)) {
    const at = m.index ?? 0;
    if (CODE_LABELLED.test(t.slice(Math.max(0, at - 24), at))) continue;
    const code = m[1]!.replace(/[ -]/g, "");
    const dist = Math.min(...triggers.map((i) => Math.abs(i - at)));
    // nearest trigger wins; on a tie the longer token (6 beats 4)
    if (!best || dist < best.dist || (dist === best.dist && code.length > best.code.length)) best = { code, dist };
  }
  return best ? { code: best.code, domain: "" } : null;
}

/**
 * Codes that JUST arrived. Same gate as links: inbound, strictly newer than
 * the watermark, never the self-thread, once per message through the
 * persisted `code:` ring. Never a group — nobody's 2FA arrives in one, and a
 * friend quoting a code must not be typed into your login form.
 */
export function selectCodes(
  msgs: ImsgMessage[],
  watermark: string,
  toasted: string[],
  selfChats: string[] = [],
): SecurityCode[] {
  if (!watermark) return [];
  const seen = new Set(toasted);
  const self = new Set(selfChats);
  const out: SecurityCode[] = [];
  for (const m of msgs) {
    if (m.from_me || m.tapback === true) continue;
    if (m.ts <= watermark) continue;
    const chat = chatKey(m);
    if (self.has(chat) || isGroupChat(chat)) continue;
    const found = extractCode(m.text);
    if (!found) continue;
    const key = "code:" + toastKey(m);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ chat, name: m.name ?? m.handle, code: found.code, domain: found.domain, ts: m.ts, key });
  }
  return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

// ------------------------------------------------- pushing reads to the Mac

export const BRIDGE_CONF = `${HOME}/.config/blip/bridge.conf`;
/** off = never tell the Mac · all = only the explicit mark-all-read gesture
 *  · thread = also each conversation you open. */
export type PushRead = "off" | "all" | "thread";

/**
 * `push_read=` in bridge.conf (parsed, never sourced).
 *
 * Default `all`, and the reason is focus. `imsg-read --all` clicks Messages'
 * "Mark All as Read" without raising a window or changing the selection —
 * measured: the frontmost app on the Mac does not change. Aiming the menu at
 * ONE conversation means opening it, and opening it pulls Messages to the
 * front of whatever the Mac is doing. So per-thread pushing is opt-in.
 */
export function pushReadPolicy(path = BRIDGE_CONF): PushRead {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = /^\s*push_read\s*=\s*([A-Za-z]+)\s*$/.exec(line);
      if (!m) continue;
      const v = m[1]!.toLowerCase();
      if (v === "off" || v === "no" || v === "false") return "off";
      if (v === "thread" || v === "chat") return "thread";
      return "all";
    }
  } catch { /* no conf: the default */ }
  return "all";
}

/** What to hand `imsg-read`, or null when this run should tell the Mac nothing. */
export function pushReadArgs(
  policy: PushRead,
  opts: { markRead: boolean; readChat: string },
): string[] | null {
  if (policy === "off") return null;
  if (opts.markRead) return ["--all"];
  if (policy !== "thread") return null;
  const chat = String(opts.readChat || "");
  // Groups have no imessage:// form, so only a DM can be aimed at.
  if (!/^\+?[0-9]{3,15}$/.test(chat) && !/^[^@\s]+@[^@\s]+$/.test(chat)) return null;
  return ["--chat", chat];
}

/**
 * Tell the Mac, without making the caller wait. The click costs a second or
 * two of AppleScript; a poll must not stall behind it, and a failure must
 * never turn into a failed refresh — the local marks have already moved.
 */
export function pushRead(args: string[] | null, home = HOME): void {
  if (!args) return;
  try {
    const child = spawn("sh", pushReadCommand(`${home}/bin/imsg-read`, args, pushReadLogPath(home)),
      { detached: true, stdio: "ignore" });
    child.unref();
  } catch { /* no shim, no Mac, no matter */ }
}

/** Where a push's outcome is recorded. Timestamps, args and imsg-read's own
 *  status line only — no message content ever reaches this file. */
export function pushReadLogPath(home = HOME): string {
  return `${home}/.local/state/blip/push-read.log`;
}

/**
 * The detached push wrapped so its OUTCOME survives it. The collector exits
 * before imsg-read finishes and cannot collect the exit code itself; without
 * this a push that fails (Accessibility revoked, Messages without a window,
 * the Mac asleep) is indistinguishable from one that worked — the local marks
 * cleared, the phone kept its badge, and nothing anywhere said why. Found
 * 2026-09-04: one unread cleared in Blip, still unread on Apple's side, no
 * evidence in either direction. Keeps the last ~100 lines, 0600.
 */
export function pushReadCommand(bin: string, args: string[], log: string): string[] {
  const script = [
    'umask 077',
    'log="$1"; bin="$2"; shift 2',
    'out=$("$bin" "$@" 2>&1); rc=$?',
    'printf "%s %s exit=%s %s\\n" "$(date +%FT%T)" "$*" "$rc" "${out:0:200}" >> "$log"',
    '[ "$(wc -c < "$log")" -gt 65536 ] && { tail -n 100 "$log" > "$log.tmp" && mv "$log.tmp" "$log"; }',
    'exit $rc',
  ].join('; ');
  return ["-c", script, "sh", log, bin, ...args];
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
  /** Rows the bridge returned BEFORE hasIdentity filtering. Pagination must
   *  count these: one dropped orphan in a full page otherwise reads as
   *  "the bridge ran out", and catch-up stops short of older unread. */
  fetchedCount: number;
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
  const lines = (stderr || "").trim().split("\n").map((l) => l.trim()).filter(Boolean);
  // Python puts the actual error LAST; "Traceback (most recent call last):" is never the reason.
  const last = lines.length ? lines[lines.length - 1] : "";
  return last || `imsg exit ${status}`;
}

export function fetchMessages(limit: number, runner = spawnSync): FetchResult {
  const res = runner(`${HOME}/bin/imsg`, ["--json", "recent", String(limit)], {
    encoding: "utf8",
    timeout: 15000, maxBuffer: 64 * 1024 * 1024,
  });

  if (res.error) {
    // spawn itself failed: ~/bin/imsg missing (run blip-setup) or not executable
    return { ok: false, online: false, error: `cannot run ~/bin/imsg: ${(res.error as Error).message}`, msgs: [] };
  }
  if (res.status === null) {
    // killed by our timeout — a Mac asleep behind a live ControlMaster looks exactly like this
    return { ok: false, online: false, error: "imsg timed out (Mac asleep?)", msgs: [], fetchedCount: 0 };
  }
  if (res.status === 69 || res.status === 255) {
    return { ok: false, online: false, error: "Mac unreachable", msgs: [], fetchedCount: 0 };
  }
  if (res.status !== 0) {
    const err = explainBridgeError(res.status, (res.stderr || "").toString());
    return { ok: false, online: true, error: err, msgs: [], fetchedCount: 0 };
  }
  try {
    const parsed = JSON.parse(res.stdout as string);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return { ok: true, online: true, error: "", msgs: (parsed as ImsgMessage[]).filter(hasIdentity), fetchedCount: parsed.length };
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
    if (!fetched.ok || !cutoff || fetched.fetchedCount < limit || limit >= CATCHUP_MAX_ROWS) return fetched;
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
/** One row of `imsg --json chats`: a conversation with preview + pin metadata. */
export interface ChatInfo {
  id: string;
  /** Canonical id followed by historical ids for this conversation. */
  aliases: string[];
  name: string | null;
  service: string;
  last: string;
  last_text: string;
  last_from_me: boolean;
  last_handle: string;
  last_name: string | null;
  /** Mirrored from Messages' pinning preferences; absent on old bridges. */
  pinned: boolean;
  pin_order: number | null;
  last_attachment?: { name: string; mime: string } | null;
  pin_name: string | null;
}

/** How many conversations the sidebar lists (chat.db has hundreds). */
export const CHAT_LIST_LIMIT = 300;

/**
 * The COMPLETE conversation list (imsg ≥1.11.0 `chats` with previews and pin
 * metadata). The message window only ever covers the busiest few days —
 * deriving the list from it lost every quiet conversation ("where is my quiet
 * group?").
 * Fetched on deep runs only; the shallow poll keeps the last list in the
 * widget's memory. Previews are never persisted (no content on disk).
 */
export function fetchChats(runner = spawnSync): ChatInfo[] | null {
  const res = runner(`${HOME}/bin/imsg`, ["--json", "chats", String(CHAT_LIST_LIMIT)], {
    encoding: "utf8",
    timeout: 20000, maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) return null;
  try {
    const rows = JSON.parse(res.stdout as string);
    if (!Array.isArray(rows)) return null;
    return rows
      .filter((r) => r && typeof r.id === "string" && r.id.length > 0 && r.id.length <= 512 &&
        !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(r.id))
      .map((r) => {
        const id = String(r.id);
        const aliases = [...new Set([
          id,
          ...(Array.isArray(r.aliases) ? r.aliases : []),
        ].filter((value): value is string =>
          typeof value === "string" && value.length > 0 && value.length <= 512 &&
          !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value),
        ))].slice(0, 16);
        const legacyPinOrder = Number.isInteger(r.pinned_order) ? Number(r.pinned_order) : null;
        const pinOrder = Number.isInteger(r.pin_order) ? Number(r.pin_order) : legacyPinOrder;
        const boundedPinOrder = pinOrder !== null && pinOrder >= 0 && pinOrder < 16 ? pinOrder : null;
        const rawPinName = typeof r.pin_name === "string" ? r.pin_name : r.pinned_name;
        return {
          id,
          aliases,
          name: typeof r.name === "string" ? r.name : null,
          service: String(r.service ?? ""),
          last: String(r.last ?? ""),
          last_text: messagePreview(
            r.last_text,
            r.last_attachment && typeof r.last_attachment === "object"
              ? { name: r.last_attachment.name, mime: r.last_attachment.mime }
              : null,
          ),
          last_from_me: r.last_from_me === true,
          last_handle: String(r.last_handle ?? ""),
          last_name: typeof r.last_name === "string" ? r.last_name : null,
          last_attachment: r.last_attachment && typeof r.last_attachment === "object"
            ? { name: String(r.last_attachment.name ?? ""), mime: String(r.last_attachment.mime ?? "") }
            : null,
          pinned: r.pinned === true || boundedPinOrder !== null,
          pin_order: boundedPinOrder,
          pin_name: typeof rawPinName === "string" && rawPinName.trim() !== ""
            ? rawPinName.trim().slice(0, 160) : null,
        };
      });
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
/**
 * alias chat id → the id it should appear under.
 *
 * Messages re-keys a group (re-invite, iCloud re-sync, service move) by
 * writing a NEW chat row with the same name and members. The bridge marks the
 * older rows as `aliases` of the live one; without this fold the same
 * conversation is listed twice ("2x Sportsball!").
 */
export function aliasesFromChats(chats: ChatInfo[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of chats) for (const a of c.aliases) if (a !== c.id) out[a] = c.id;
  return out;
}

/** Pin metadata from the chat list: chat id → pin order. */
export function pinsFromChats(chats: ChatInfo[]): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const c of chats) if (c.pinned) out[c.id] = c.pin_order;
  return out;
}

/** Re-apply cached pins to a shallow poll's threads and re-sort. buildThreads
 *  knows nothing about pins, so without this every shallow poll returned
 *  Messages' pinned conversations as ordinary rows and the panel opened onto
 *  an unpinned list that re-pinned itself a deep run later. */
export function applyPins(threads: Thread[], pins: Record<string, number | null>): Thread[] {
  if (Object.keys(pins).length === 0 && !threads.some((t) => t.pinned)) return threads;
  return threads
    .map((t) => {
      const pinned = Object.prototype.hasOwnProperty.call(pins, t.chat);
      const pin_order = pinned ? pins[t.chat] : null;
      return t.pinned === pinned && t.pin_order === pin_order ? t : { ...t, pinned, pin_order };
    })
    .sort(compareThreads);
}

/** Fold threads carrying an alias id into the canonical thread. */
export function foldThreadAliases(threads: Thread[], aliases: Record<string, string>): Thread[] {
  if (Object.keys(aliases).length === 0) return threads;
  const out: Thread[] = [];
  const at = new Map<string, number>();
  for (const t of threads) {
    const canon = aliases[t.chat] ?? t.chat;
    const seen = at.get(canon);
    if (seen === undefined) {
      at.set(canon, out.length);
      out.push(canon === t.chat ? t : { ...t, chat: canon });
      continue;
    }
    const prev = out[seen]!;
    const newer = t.last_ts > prev.last_ts ? t : prev;
    out[seen] = {
      ...newer,
      chat: canon,
      guid: prev.guid || t.guid,
      count: prev.count + t.count,
      unread: prev.unread + t.unread,
    };
  }
  return out;
}

/** Same fold for a per-chat ledger (unread counts, oldest-unread stamps). */
/**
 * The alias rows folded into one canonical conversation. The unread ledger
 * counts on ORIGINAL chat keys and the fold happens afterwards, so a read of
 * the canonical must also mark every alias, or an alias's unread survives the
 * read and reappears under the conversation the user just finished (Astra #9).
 */
export function aliasesOf(chatAliases: Record<string, string>, canonical: string): string[] {
  return Object.entries(chatAliases).filter(([, c]) => c === canonical).map(([a]) => a);
}

export function foldChatRecord<T>(
  rec: Record<string, T>,
  aliases: Record<string, string>,
  merge: (a: T, b: T) => T,
): Record<string, T> {
  if (Object.keys(aliases).length === 0) return rec;
  const out: Record<string, T> = {};
  for (const [chat, v] of Object.entries(rec)) {
    const canon = aliases[chat] ?? chat;
    const prev = out[canon];
    out[canon] = prev === undefined ? v : merge(prev, v);
  }
  return out;
}

export function mergeChats(
  threads: Thread[],
  chats: ChatInfo[],
  groups: Record<string, GroupInfo>,
  unreadCounts: Record<string, number>,
): Thread[] {
  const infoByChat = new Map(chats.map((c) => [c.id, c]));
  const applyPin = (thread: Thread): Thread => {
    const info = infoByChat.get(thread.chat);
    if (!info) return thread;
    const aliases = info.aliases ?? [info.id];
    const pinned = info.pinned === true;
    const pin_order = Number.isInteger(info.pin_order) ? Number(info.pin_order) : null;
    const group = isGroupChat(thread.chat);
    const groupInfo = groups[thread.chat]
      ?? aliases.map((alias) => groups[alias]).find((value) => value !== undefined);
    const knownParticipantNames = new Map<string, string>(
      (thread.participants ?? []).map((person) => [person.handle, person.name]),
    );
    return {
      ...thread,
      aliases,
      guid: group ? groupInfo?.guid ?? thread.guid : "",
      name: group
        ? (groupInfo?.name || info.name || thread.name || thread.chat)
        : (info.last_name || info.name || thread.name || thread.chat),
      service: info.service || thread.service,
      last_text: info.last === thread.last_ts ? info.last_text : messagePreview(thread.last_text),
      pinned,
      pin_order,
      ...(info.pin_name ? { pin_name: info.pin_name } : {}),
      ...(group ? {
        participants: groupInfo
          ? groupParticipants(groupInfo, knownParticipantNames)
          : thread.participants ?? [],
      } : {}),
    };
  };
  const have = new Set(threads.map((t) => t.chat));
  const out = threads.map(applyPin);
  for (const c of chats) {
    if (have.has(c.id)) continue;
    have.add(c.id);
    const group = isGroupChat(c.id);
    const aliases = c.aliases ?? [c.id];
    const groupInfo = groups[c.id]
      ?? aliases.map((alias) => groups[alias]).find((value) => value !== undefined);
    const name = group
      ? (groupInfo?.name || c.name || c.id)
      : (c.last_name || c.name || c.id);
    out.push({
      chat: c.id,
      aliases,
      guid: group ? groupInfo?.guid ?? "" : "",
      name,
      handle: group ? c.last_handle || c.id : c.id,
      service: c.service,
      last_ts: c.last,
      last_text: c.last_text,
      last_from_me: c.last_from_me,
      count: 0,
      unread: aliases.reduce((sum, alias) => sum + (unreadCounts[alias] ?? 0), 0),
      pinned: c.pinned === true,
      pin_order: Number.isInteger(c.pin_order) ? Number(c.pin_order) : null,
      ...(c.pin_name ? { pin_name: c.pin_name } : {}),
      ...(group ? { participants: groupParticipants(groupInfo) } : {}),
    });
  }
  return out.sort(compareThreads);
}

export function fetchGroups(runner = spawnSync): Record<string, GroupInfo> | null {
  const res = runner(`${HOME}/bin/imsg`, ["--json", "groups"], { encoding: "utf8", timeout: 15000, maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) return null;
  try {
    const rows = JSON.parse(res.stdout as string);
    if (!Array.isArray(rows)) return null;
    const out: Record<string, GroupInfo> = {};
    for (const r of rows) {
      if (!r || typeof r.chat !== "string") continue;
      const participantNames = r.participant_names && typeof r.participant_names === "object"
        && !Array.isArray(r.participant_names)
        ? Object.fromEntries(Object.entries(r.participant_names)
          .filter(([handle, name]) => typeof handle === "string" && handle.length <= 320
            && typeof name === "string" && name.length <= 160)
          .slice(0, 64)) as Record<string, string>
        : {};
      out[r.chat] = {
        name: typeof r.name === "string" ? r.name : "",
        guid: typeof r.guid === "string" ? r.guid : "",
        participants: Array.isArray(r.participants)
          ? r.participants.filter((h: unknown) => typeof h === "string")
          : typeof r.participants === "string" ? r.participants.split(",").filter(Boolean) : [],
        ...(Object.keys(participantNames).length ? { participantNames } : {}),
      };
    }
    return out;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- main

export function collect(
  deep: boolean,
  markRead = false,
  readChat = "",
  seenTs = "",
  readAliases: string[] = [],
): BlipOutput {
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
      links: [],
      persisted: true,
    };
  }

  const identityConfig = safeReadIdentityConfig();
  const resolvedMessages = applyIdentityOverrides(fetched.msgs, identityConfig);
  const highest = maxTs(resolvedMessages, state.watermark);
  // A message can carry a FUTURE timestamp (timezone skew — a "Sep 1
  // 08:53" birthday text arrived Aug 31 morning). A read mark taken from
  // the GLOBAL max therefore poisoned unrelated threads: anything arriving
  // before that future instant could never badge. So the global mark is
  // clamped to the local clock, and each chat that reaches past it gets a
  // PER-CHAT mark at its own max — every visible message is covered,
  // nothing beyond now leaks onto other threads.
  const nowTs = localNowTs();
  const chatMax: Record<string, string> = {};
  for (const m of resolvedMessages) {
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
  const readTargets = [...new Set([readChat, ...readAliases])]
    .filter((chat) => chat !== "" && chat.length <= 512 &&
      !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(chat))
    .slice(0, 16);
  if (readChat) {
    // Mark through what the user actually SAW (the panel passes the newest
    // bubble ts as --seen; it includes a future-dated row when the chat has
    // one on screen). A message arriving between the click and this run has
    // ts > seen and stays unread. Fallback without --seen: through now, or
    // the chat's own future row.
    for (const target of readTargets) {
      const own = chatMax[target] ?? "";
      readMarks[target] = seenTs !== "" ? seenTs : (own > nowTs ? own : nowTs);
    }
  }
  const readSeen = readChat ? readMarks[readChat]! : "";
  // Group metadata is ~1000 rows; refresh it only on a deep (panel) fetch and
  // keep the last good copy if the lookup fails.
  const groups = (deep ? fetchGroups() : null) ?? state.groups;
  // persist only on two independent twins; one may be a coincidence (#6)
  const selfChats = [...new Set([...state.selfChats, ...detectSelfChats(resolvedMessages, 2)])];
  // The mute list cuts here, upstream of every count: a muted conversation is
  // absent from the ledger, the thread list and the toasts alike, exactly as
  // if the Mac had never received it. Read fresh each poll, like the allowlist.
  // It sees the identity-resolved messages, so a mute phrase that names a
  // person catches them under whichever handle the address book resolved.
  const mute = loadMutelist();
  const deduped = dedupeSelfEcho(resolvedMessages, selfChats);
  const muted = mutedChats(deduped, mute);
  const msgs = dropMuted(deduped, muted);
  let exactCounts = unreadCounts(msgs, state.readMark, state.readMarks, selfChats);
  let exactOldest = unreadOldest(msgs, state.readMark, state.readMarks, selfChats);
  if (markRead) {
    exactCounts = {};
    exactOldest = {};
  } else if (readChat) {
    for (const target of readTargets) {
      delete exactCounts[target];
      delete exactOldest[target];
    }
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
  const chats = deep ? dropMutedChats(fetchChats(), mute, muted) : null;
  // One entry per CONVERSATION. A re-keyed group has several chat rows; the
  // bridge names the older ones as aliases of the live row, and the map is
  // cached so shallow polls fold identically (a conversation must never
  // blink into two between a deep run and the next poll).
  const chatAliases = chats ? aliasesFromChats(chats) : state.chatAliases;
  const pins = chats ? pinsFromChats(chats) : state.pins;
  if (readChat) {
    for (const a of aliasesOf(chatAliases, readChat)) {
      if (readSeen > readMark) readMarks[a] = readSeen;   // same prune rule as the canonical
      delete exactCounts[a];
      delete exactOldest[a];
    }
  }
  exactCounts = foldChatRecord(exactCounts, chatAliases, (a, b) => a + b);
  exactOldest = foldChatRecord(exactOldest, chatAliases, (a, b) => (a < b ? a : b));
  const foldedWindow = foldThreadAliases(windowThreads, chatAliases);
  const threads = applyThreadIdentityOverrides(
    chats ? mergeChats(foldedWindow, chats, groups, exactCounts) : applyPins(foldedWindow, pins),
    identityConfig,
  );
  const toast = selectToasts(msgs, state.watermark, loadAllowlist(), state.toasted);
  const failures = selectFailures(resolvedMessages, state.toasted, nowTs);
  const links = selectIncomingLinks(msgs, state.watermark, state.toasted, selfChats);
  const codes = selectCodes(msgs, state.watermark, state.toasted, selfChats);
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
    chatAliases,
    pins,
    toasted: [...state.toasted, ...toast.map((t) => t.key), ...failures.map((f) => f.key),
      ...links.map((l) => l.key), ...codes.map((c) => c.key)],
  });

  // Only after the local state is committed: if the write failed the user
  // will be asked to read these again, and the Mac must agree.
  if (persisted) pushRead(pushReadArgs(pushReadPolicy(), { markRead, readChat }));

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
    links: persisted ? links : [],
    codes: persisted ? codes : [],
    persisted,
    deep: chats !== null,
  };
}

if (import.meta.main) {
  const deep = process.argv.includes("--deep");
  const markRead = process.argv.includes("--mark-read");
  const ri = process.argv.indexOf("--read");
  const readChat = ri >= 0 ? String(process.argv[ri + 1] ?? "") : "";
  const readAliases: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === "--read-alias") readAliases.push(String(process.argv[i + 1] ?? ""));
  }
  const si = process.argv.indexOf("--seen");
  const seenTs = si >= 0 ? String(process.argv[si + 1] ?? "") : "";
  try {
    console.log(JSON.stringify(collect(deep, markRead, readChat, seenTs, readAliases)));
  } catch (e) {
    console.log(
      JSON.stringify({
        ok: false, online: false, error: String(e), ts: new Date().toISOString(),
        unread: 0, threads: [], toast: [], failures: [], persisted: false,
      }),
    );
  }
}
