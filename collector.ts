#!/usr/bin/env bun
/**
 * Blip collector — turns the Mac's `imsg --json recent N` into the thread model
 * the QML bar widget and panel render.
 *
 * iMessage is macOS-only. chat.db and the AppleScript send path both live on
  * the Mac; this machine is a thin client over a multiplexed SSH socket (~47ms warm). This
 * script never touches SQLite itself — it shells out to the imsg shim (~/bin/imsg by default, bin_dir=), which
 * proxies to the Mac.
 *
 * Output: one JSON object on stdout. Never throws — a failure is reported as
 * {ok:false, online:false} so the bar can grey out instead of crashing.
 *
 *   bun collector.ts            # poll: shallow window, badge + toasts
 *   bun collector.ts --deep     # panel open: wider window, full thread list
 *   bun collector.ts --mark-read        # clear every dot (right-click)
 *   bun collector.ts --read <chat>      # clear one thread's dot (opened it)
 *   bun collector.ts --mark-unread <chat>  # blue-dot that thread again
 */

import { readWorkerState, scheduleReadJob } from "./read-worker";
import { shimPath } from "./shim-path";
import { openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseReadSnapshot, parseReadIntents, queueReadIntent, queueMenuIntent, reconcileReadIntents,
  type ReadSnapshot, type ReadIntents } from "./read-sync";

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
  // UTC, ISO-8601, to the second: "2026-09-07T18:33:12Z". Fixed width, so
  // lexical order IS chronological order — which every ledger, watermark and
  // sort in this file relies on. Local time is a DISPLAY concern (thread.ts).
  ts: string;
  /** Newest reaction activity folded onto this message by the rich bridge. */
  activity_ts?: string;
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
  /** A Send Later message still waiting on the Mac (imsg: schedule_type 2,
   *  state 2). Its ts is the FUTURE send time, so it never becomes a
   *  thread's newest message and never moves a watermark or read mark. */
  scheduled?: boolean | null;
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
  /** Messages Hide Alerts (ignoreAlertsFlag). */
  muted?: boolean;
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
  participantShortNames?: Record<string, string>;
}

export interface BlipState {
  pendingReads?: ReadIntents;
  readRowId?: number;
  readAllRowId?: number;
  alertMuted?: string[];
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
  /** Per-thread marks that MAY sit below the global readMark. "Mark as
   *  Unread" cannot lower the global floor (that would resurrect every other
   *  thread); it stores an override here so only this chat badges again. */
  unreadSince: Record<string, string>;
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
  unreadCounts?: Record<string, number>;
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
  /** Which reads are pushed to the Mac: "off", "all" (the mark-all gesture
   *  only — the default) or "thread" (also each conversation you open). */
  readPush: PushRead;
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

export function nameMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).slice(0, 64).filter(([handle, name]) =>
    handle.length <= 320 && typeof name === "string" && name.length <= 160 && name.trim() !== ""));
}

export function normalizeGroups(raw: unknown): Record<string, GroupInfo> {
  const out: Record<string, GroupInfo> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [chat, g] of Object.entries(raw as Record<string, unknown>)) {
    if (!g || typeof g !== "object") continue;
    const r = g as Record<string, unknown>;
    out[chat] = {
      name: typeof r.name === "string" ? r.name : "",
      guid: typeof r.guid === "string" ? r.guid : "",
      participants: Array.isArray(r.participants) ? r.participants.filter((h): h is string => typeof h === "string") : [],
      ...(Object.keys(nameMap(r.participantNames)).length ? {participantNames:nameMap(r.participantNames)} : {}),
      ...(Object.keys(nameMap(r.participantShortNames)).length ? {participantShortNames:nameMap(r.participantShortNames)} : {}),
    };
  }
  return out;
}

export function loadState(path = STATE_PATH): BlipState {
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as Partial<BlipState>;
    // Every persisted stamp predating the UTC wire format is naive Mac-local
    // wall clock. Left alone it would sort BELOW every new stamp on the same
    // day (" " < "T"), so the whole preview window would read as newer than
    // the mark. toUtcStamp() re-anchors it; see there for the exactness.
    const watermark = toUtcStamp(typeof s.watermark === "string" ? s.watermark : "");
    const unreadCounts = s.unreadCounts && typeof s.unreadCounts === "object"
      ? Object.fromEntries(
        Object.entries(s.unreadCounts).filter(([, n]) => typeof n === "number" && Number.isFinite(n) && n >= 0),
      )
      : {};
    const unreadOldest = s.unreadOldest && typeof s.unreadOldest === "object"
      ? Object.fromEntries(
        Object.entries(s.unreadOldest)
          .filter(([, ts]) => typeof ts === "string" && ts !== "")
          .map(([chat, ts]) => [chat, toUtcStamp(ts as string)]),
      )
      : {};
    // A count-only ledger from an interrupted/experimental build cannot be
    // reconciled for deletions. Reseed it from readMark on the next poll.
    const ledgerComplete = Object.entries(unreadCounts)
      .every(([chat, count]) => count === 0 || unreadOldest[chat]);
    return {
      ...(Array.isArray(s.alertMuted) ? { alertMuted: s.alertMuted.filter((x): x is string => typeof x === "string") } : {}),
      ...(Number.isSafeInteger(s.readAllRowId) && s.readAllRowId! >= 0 ? { readAllRowId: s.readAllRowId } : {}),
      ...(Number.isSafeInteger(s.readRowId) && s.readRowId! >= 0 ? { readRowId: s.readRowId } : {}),
      ...(s.pendingReads ? { pendingReads: parseReadIntents(s.pendingReads) } : {}),
      watermark,
      // Pre-two-mark state files have no readMark. Inheriting the watermark is
      // the safe migration: it reports zero unread rather than a fake backlog.
      readMark: toUtcStamp(typeof s.readMark === "string" ? s.readMark : watermark),
      unreadCounts,
      unreadOldest,
      unreadInitialized: s.unreadInitialized === true && ledgerComplete,
      selfChats: Array.isArray(s.selfChats)
        ? s.selfChats.filter((chat): chat is string => typeof chat === "string")
        : [],
      readMarks: s.readMarks && typeof s.readMarks === "object"
        ? Object.fromEntries(
          Object.entries(s.readMarks)
            .filter(([, ts]) => typeof ts === "string" && ts !== "")
            .map(([chat, ts]) => [chat, toUtcStamp(ts as string)]),
        )
        : {},
      unreadSince: s.unreadSince && typeof s.unreadSince === "object"
        ? Object.fromEntries(
          Object.entries(s.unreadSince)
            .filter(([, ts]) => typeof ts === "string" && ts !== "")
            .map(([chat, ts]) => [chat, toUtcStamp(ts as string)]),
        )
        : {},
      // Every cached group goes through the same shape fetchGroups() enforces:
      // a participants OBJECT in state.json threw inside groupName() on every
      // poll until the next deep refresh (Astra B#6).
      groups: normalizeGroups(s.groups),
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
      selfChats: [], readMarks: {}, unreadSince: {}, groups: {}, chatAliases: {}, pins: {}, toasted: [],
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
  return prettyHandle(chatKey(msgs[0]));
}

/** Messages' "Filter Unknown Senders" files a stranger's SMS under a chat whose
 *  id is the number with "(filtered)" appended (`any;-;+1818…(filtered)`). The
 *  id stays the key — sending and reading need it — but the person is the
 *  number, so the list shows that. */
export function prettyHandle(id: string): string {
  return id.replace(/\(filtered\)$/i, "");
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

/**
 * Group chat ids (chat.style=43) are either 32 hex chars or "chat<digits>";
 * DMs are a phone or email. Anything that is not a phone/email is treated as
 * a group so an unknown id shape can never be mistaken for a DM target.
 */
export function isGroupChat(chat: string): boolean {
  if (/^\+?[0-9]{3,15}$/.test(chat) || chat.indexOf("@") > 0) return false;
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

/** The union of two tapback lists (one entry per emoji + sender); undefined when both are empty. */
export function mergeTapbacks(a?: Tapback[] | null, b?: Tapback[] | null): Tapback[] | undefined {
  const all = [...(a ?? []), ...(b ?? [])];
  if (all.length === 0) return undefined;
  const seen = new Set<string>();
  return all.filter((t) => {
    const k = `${t.emoji}\u0000${t.from_me}\u0000${t.by ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function dedupeSelfEcho(msgs: ImsgMessage[], knownSelfChats: string[] = []): ImsgMessage[] {
  const contextKey = (m: ImsgMessage) => `${chatKey(m)}\u0000${m.handle || ""}\u0000${m.ts}`;
  const contentKey = (m: ImsgMessage) => `${contextKey(m)}\u0000${m.text}`;
  const selfChats = new Set([...knownSelfChats, ...detectSelfChats(msgs)]);
  const selfContexts = new Set(msgs.filter((m) => selfChats.has(chatKey(m))).map(contextKey));
  const emptySent = new Set(
    msgs.filter((m) => selfChats.has(chatKey(m)) && m.from_me && m.text === "").map(contextKey),
  );
  // Messages attaches a tapback to ONE of the two rows of a self-thread
  // message — whichever the reacting device considers the message. Whatever
  // is dropped below hands its tapbacks to the row that stays, so a reaction
  // on your own note is seen no matter which twin carried it.
  const emptySentTapbacks = new Map<string, Tapback[] | undefined>();
  for (const m of msgs) {
    if (selfChats.has(chatKey(m)) && m.from_me && m.text === "") {
      const k = contextKey(m);
      emptySentTapbacks.set(k, mergeTapbacks(emptySentTapbacks.get(k), m.tapbacks));
    }
  }
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
        const kept = out[idx]!;
        out[idx] = { ...kept, from_me: kept.from_me || m.from_me, tapbacks: mergeTapbacks(kept.tapbacks, m.tapbacks) };
        continue;
      }
      selfText.set(key, out.length);
    }

    if (emptySent.has(context) && !m.from_me) {
      out.push({ ...m, from_me: true, tapbacks: mergeTapbacks(m.tapbacks, emptySentTapbacks.get(context)) });
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
/**
 * A group "name" that is merely the chat id is NOT a name. `imsg chats`
 * substitutes the identifier when a group has no display name, so the raw
 * `3734fc1a…` came back as the name and won every `||` chain ahead of the
 * participant fallback - the fallback was unreachable for exactly the groups
 * it exists for (Fred, 2026-09-10). Aliases count too: a re-keyed group's
 * retired id is just as much not-a-name.
 */
export function namedGroup(name: unknown, chat: string, aliases: string[] = []): string {
  const value = String(name ?? "").trim();
  if (!value || value === chat || aliases.includes(value)) return "";
  return value;
}

export function groupName(chat: string, info: GroupInfo | undefined, byHandle: Map<string, string>): string {
  if (info?.name) return info.name;
  const members = groupParticipants(info, byHandle).map((member) =>
    info?.participantShortNames?.[member.handle] || member.name);
  // A "(filtered)" stranger is not a phone/email shape, so it lands here (the
  // never-a-DM-target rule stands: nothing sends to it); its label is the number.
  if (members.length === 0) return prettyHandle(chat);
  if (members.length === 1) return members[0]!;
  return members.slice(0, -1).join(", ") + " & " + members[members.length - 1];
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
 *   2. `prefer_imessage=on` in bridge.conf: a successful iMessage anywhere in
 *      the loaded window (in or out) → iMessage. Last-inbound RCS/SMS in a
 *      mixed 1:1 otherwise makes the next send green, and the Mac records SMS
 *      error 4 while the iPhone still delivers. Off by default.
 *   3. otherwise the last INBOUND service: that is what they actually reach
 *      us on, and a failed outbound must never override it.
 *   4. no inbound at all → the last outbound that SUCCEEDED.
 *   5. nothing to go on → iMessage, like a fresh conversation.
 * Groups send `--chat-id` and ignore all of this.
 */
export function sendServiceForMessages(msgs: ImsgMessage[], preferImessage = false): SendService {
  if (!msgs.length) return "iMessage";
  const sorted = [...msgs].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const failed = (m: ImsgMessage) => typeof m.error === "number" && m.error !== 0;

  const newest = sorted[sorted.length - 1]!;
  const chat = chatKey(newest);
  if (newest.from_me && failed(newest)
      && normalizeSendService(newest.service) === "iMessage"
      && /^\+?[0-9]{3,15}$/.test(chat)) {
    return "SMS";
  }
  if (preferImessage) {
    for (const m of sorted) {
      if (!failed(m) && normalizeSendService(m.service) === "iMessage") return "iMessage";
    }
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
  preferImessage = false,
  unreadSince: Record<string, string> = {},
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
    const sent = sorted.filter((m) => m.scheduled !== true);
    const last = sent.length ? sent[sent.length - 1]! : sorted[sorted.length - 1]!;
    const unread = unreadCounts
      ? unreadCounts[chat] ?? 0
      : sorted.filter((m) => {
        const mark = unreadMark(chat, m, watermark, readMarks, unreadSince);
        if (!mark && m.read !== false && !unreadSince[chat]) return false;
        return isUnread(m, mark, Boolean(unreadSince[chat]));
      }).length;
    threads.push({
      chat,
      guid: isGroupChat(chat) ? groups[chat]?.guid ?? "" : "",
      name: isGroupChat(chat) ? groupName(chat, groups[chat], byHandle) : displayName(sorted),
      handle: String(last.handle || chat),
      service: isGroupChat(chat) ? last.service : sendServiceForMessages(sorted, preferImessage),
      last_ts: last.ts,
      last_text: messagePreview(last.text, last.attachments?.[0]),
      last_from_me: last.from_me,
      count: sorted.length,
      unread,
      pinned: false,
      pin_order: null,
      muted: false,
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
 * Gated four ways, because chat.db is mostly bank alerts and 2FA codes:
 *   1. inbound only, and strictly newer than the watermark
 *   2. sender (chat OR handle) is on the allowlist
 *   3. not already toasted — this is what stops the self-thread echo storm,
 *      where the user's own sent replies come back as from_me=false
 *   4. not the conversation being READ right now. A toast for the thread
 *      already open in front of you is noise, and the badge is suppressed
 *      for it in the same run, so the two would otherwise disagree: nothing
 *      to click, and a notification saying there is.
 *
 * `reading` is the canonical chat being read PLUS its aliases, or empty. The
 * caller decides what "being read" means — BarWidget.activeReadChat() already
 * refuses a thread that is still loading, one whose load failed, and one
 * merely peeked from the sidebar cursor — so an id arriving here has cleared
 * all of that and needs no second opinion.
 */
export function selectToasts(
  msgs: ImsgMessage[],
  watermark: string,
  allow: string[],
  toasted: string[],
  reading: string[] = [],
): Toast[] {
  if (!watermark) return [];          // never toast the backlog on first run
  const allowed = new Set(allow);
  const seen = new Set(toasted);
  const open = new Set(reading);
  const out: Toast[] = [];

  for (const m of msgs) {
    if (m.from_me) continue;
    if (m.ts <= watermark) continue;
    // Already read on the iPhone. The badge ignores these (isUnread), so a
    // toast would announce something with nothing behind it to click -- and
    // after a suspend the watermark is hours old, so it is a whole night of
    // them at once on wake (#89). An older bridge omits `read`; undefined
    // keeps the pre-1.9.0 behaviour of trusting the watermark alone.
    if (m.read === true) continue;
    if (open.has(chatKey(m))) continue;
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

/** Chat ids the unread ledger may still name: the current window, plus every
 *  conversation `imsg chats` still lists. hide_spam / mute omit a chat from
 *  that list; a missing chats fetch leaves only the window. */
export function visibleLedgerChats(msgs: ImsgMessage[], chats: ChatInfo[] | null): Set<string> {
  const ids = new Set<string>();
  for (const m of msgs) {
    const c = chatKey(m);
    if (c) ids.add(c);
  }
  if (chats) {
    for (const c of chats) {
      ids.add(c.id);
      for (const a of c.aliases) ids.add(a);
    }
  }
  return ids;
}

/** Astra B#3: a capped window must not zero an unread it never saw. Only
 *  restore chats that are still visible — otherwise Spam we hid in SQL
 *  pins catch-up (oldestUnread never appears) and keeps the bar badge. */
export function keepCappedUnread(
  exactCounts: Record<string, number>,
  exactOldest: Record<string, string>,
  priorCounts: Record<string, number>,
  priorOldest: Record<string, string>,
  inWindow: Set<string>,
  visible: Set<string>,
): { counts: Record<string, number>; oldest: Record<string, string> } {
  const counts = { ...exactCounts };
  const oldest = { ...exactOldest };
  for (const [c, n] of Object.entries(priorCounts)) {
    if (n > 0 && !inWindow.has(c) && !(c in counts) && visible.has(c)) {
      counts[c] = n;
      if (priorOldest[c]) oldest[c] = priorOldest[c]!;
    }
  }
  return { counts, oldest };
}


/** First http(s) URL in a message, or "". Trailing punctuation that a person
 *  would read as sentence-end is trimmed; a URL inside the text is fine. */
export function firstUrl(text: string | null | undefined): string {
  const m = /https?:\/\/[^\s<>"']+/i.exec(String(text ?? ""));
  if (!m) return "";
  return m[0].replace(/[.,;:!?)\]}'"]+$/, "");
}

/** Every http(s) URL in a text, in order, trailing punctuation dropped like firstUrl(). */
export function allUrls(text: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of String(text ?? "").matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const u = m[0].replace(/[.,;:!?)\]}'"]+$/, "");
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

export interface IncomingLink {
  chat: string;
  /** The first link, `urls[0]`. */
  url: string;
  /** Every link of the message, first included: the share sheet steps through them. */
  urls: string[];
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
    const urls = allUrls(m.text);
    if (urls.length === 0) continue;
    const url = urls[0]!;
    const key = "link:" + toastKey(m);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ chat, url, urls, ts: m.ts, key });
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
 * `prefer_imessage=on` in bridge.conf (parsed, never sourced).
 *
 * Default off: last inbound still wins, so a green thread stays green.
 * On: a DM that has a successful iMessage in the loaded window sends
 * iMessage even if the latest inbound was RCS/SMS. The failed-iMessage →
 * SMS lock still runs first.
 */
export function preferImessagePolicy(path = BRIDGE_CONF): boolean {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = /^\s*prefer_imessage\s*=\s*([A-Za-z0-9]+)\s*$/.exec(line);
      if (!m) continue;
      const v = m[1]!.toLowerCase();
      return v === "on" || v === "true" || v === "1" || v === "yes";
    }
  } catch { /* no conf: the default */ }
  return false;
}

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

export function pushUnreadArgs(chat: string): string[] | null {
  const id = String(chat || "");
  if (!/^\+?[0-9]{3,15}$/.test(id) && !/^[^@\s]+@[^@\s]+$/.test(id)) return null;
  return ["--unread", id];
}

/** DMs only: groups have no imessage:// form, same as per-thread mark-read. */
export function canAddressChat(chat: string): boolean {
  const id = String(chat || "");
  return /^\+?[0-9]{3,15}$/.test(id) || /^[^@\s]+@[^@\s]+$/.test(id);
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
  now = nowTs(),
): Toast[] {
  const seen = new Set(toasted);
  const out: Toast[] = [];
  const cutoff = nowTs(new Date(Date.parse(now) - FAILURE_TOAST_WINDOW_MS));
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
  for (const m of msgs) if (m.scheduled !== true && m.ts > hi) hi = m.ts;
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
  /** True when catch-up hit CATCHUP_MAX_ROWS before reaching the cutoff: the
   *  window does NOT cover every outstanding unread (Astra B#3). */
  capped?: boolean;
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
  const res = runner(shimPath("imsg"), ["--json", "recent", String(limit)], {
    encoding: "utf8",
    timeout: 15000, maxBuffer: 64 * 1024 * 1024,
  });

  if (res.error) {
    // spawn itself failed: the imsg shim missing (run blip-setup) or not executable
    return { ok: false, online: false, error: `cannot run ${shimPath("imsg")}: ${(res.error as Error).message}`, msgs: [], fetchedCount: 0 };
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
    // Normalise stamps HERE, the one door messages come through, so nothing
    // downstream has to know which bridge version produced them.
    const msgs = (parsed as ImsgMessage[]).filter(hasIdentity).map(normalizeMsgStamps);
    return { ok: true, online: true, error: "", msgs, fetchedCount: parsed.length };
  } catch (e) {
    return { ok: false, online: true, error: `bad JSON from imsg: ${e}`, msgs: [], fetchedCount: 0 };
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
    if (!fetched.ok || !cutoff || fetched.fetchedCount < limit) return fetched;
    if (limit >= CATCHUP_MAX_ROWS) return { ...fetched, capped: minTs(fetched.msgs, "") >= cutoff };
    // Fetch beyond the boundary, not merely to it: several rows can share a
    // one-second timestamp and otherwise straddle the window edge.
    if (minTs(fetched.msgs, "") < cutoff) return fetched;
    limit *= 2;
  }
}

/**
 * A per-chat catch-up fetch: how many rows one conversation is asked for, and
 * how many conversations one poll will ask about.
 *
 * The ledger has to cover every outstanding unread row so a message deleted or
 * read elsewhere is reconciled. That boundary is PER CHAT (`unreadOldest`), but
 * it used to be collapsed into one global minimum and handed to the window
 * fetch, so a single never-opened unread dragged the whole preview window back
 * to its date on every poll: 150 -> 300 -> ... -> 8192 rows across that many
 * SEQUENTIAL ssh calls, forever, for one dot. Measured on the gateway Mac
 * 2026-09-16, a 45-day-old unread cost 6 calls, 4798 rows and 3.18 s per poll
 * against a 6 s timer. Each chat now gets ONE bounded fetch of its own instead.
 */
export const CATCHUP_CHAT_ROWS = 400;
export const CATCHUP_CHAT_MAX = 3200;
export const CATCHUP_MAX_CHATS = 4;

/**
 * How far back the preview window reaches: NEW arrivals only. On migration it
 * seeds from the last read mark instead, so the first run after an upgrade
 * counts the whole backlog once.
 *
 * It used to reach back to the oldest outstanding unread ANYWHERE, so that the
 * ledger covered every unread row and a deletion was reconciled. One chat's
 * boundary therefore set every chat's fetch depth, and a dot nobody ever opened
 * held the window open at its own date for good. Those boundaries are per chat
 * and are now spent per chat — see `staleUnreadChats` below.
 */
export function windowCutoff(
  state: Pick<BlipState, "unreadInitialized" | "watermark" | "readMark">,
): string {
  return state.unreadInitialized ? state.watermark : state.readMark;
}

/**
 * Conversations whose oldest outstanding unread sits below what the window
 * reached, oldest boundary first — the ones that used to drag the window back.
 * `coveredFrom` is the oldest row the window actually returned; an empty
 * window (or an empty boundary) covers nothing, so nothing is stale.
 */
export function staleUnreadChats(
  unreadOldest: Record<string, string>,
  counts: Record<string, number>,
  coveredFrom: string,
): string[] {
  if (!coveredFrom) return [];
  return Object.entries(unreadOldest)
    .filter(([chat, ts]) => ts && ts < coveredFrom && (counts[chat] ?? 0) > 0)
    .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([chat]) => chat);
}

/** One conversation's own rows — `imsg thread --chat`, the same door as thread.ts. */
export function fetchChatRows(
  chat: string,
  limit = CATCHUP_CHAT_ROWS,
  runner = spawnSync,
): FetchResult {
  const res = runner(shimPath("imsg"), ["--json", "thread", "--chat", chat, String(limit)], {
    encoding: "utf8",
    timeout: 15000, maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) {
    return {
      ok: false,
      online: res.status !== null,
      error: `catch-up fetch failed for one conversation`,
      msgs: [], fetchedCount: 0,
    };
  }
  try {
    const parsed = JSON.parse(res.stdout as string);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    const msgs = (parsed as ImsgMessage[]).filter(hasIdentity).map(normalizeMsgStamps);
    return { ok: true, online: true, error: "", msgs, fetchedCount: parsed.length };
  } catch {
    return { ok: false, online: true, error: "bad JSON from imsg thread", msgs: [], fetchedCount: 0 };
  }
}

/**
 * Did a per-chat fetch actually reach that chat's boundary? Short of the limit
 * means the conversation has no more rows — the whole tail is in hand, which is
 * also how a DELETED unread row is noticed: the boundary is simply not there.
 */
export function coversBoundary(fetched: FetchResult, boundary: string, limit = CATCHUP_CHAT_ROWS): boolean {
  if (!fetched.ok) return false;
  if (fetched.fetchedCount < limit) return true;
  const from = minTs(fetched.msgs, "");
  return from !== "" && from <= boundary;
}

/**
 * One conversation's rows back to its own boundary, doubling only that
 * conversation's ask — 400 rows reaches years back in the quiet threads where a
 * never-opened dot actually lives, and a busy one escalates alone instead of
 * dragging every other conversation's rows along with it. `capped` means the
 * ceiling came first: the caller keeps that chat's existing count.
 *
 * `imsg thread` bounds by row count, not by date; a `--since` on the bridge
 * would make this one exact call.
 */
export function fetchChatBack(chat: string, boundary: string, runner = spawnSync): FetchResult {
  let limit = CATCHUP_CHAT_ROWS;
  while (true) {
    const got = fetchChatRows(chat, limit, runner);
    if (!got.ok) return got;
    if (coversBoundary(got, boundary, limit)) return got;
    if (limit >= CATCHUP_CHAT_MAX) return { ...got, capped: true };
    limit *= 2;
  }
}

/** Window rows plus per-chat catch-up rows, each message once (chat.db ROWID). */
export function mergeCatchupRows(window: ImsgMessage[], extra: ImsgMessage[]): ImsgMessage[] {
  if (!extra.length) return window;
  const seen = new Set(window.map((m) => m.id).filter((id) => id !== undefined));
  const out = [...window];
  for (const m of extra) {
    if (m.id !== undefined && seen.has(m.id)) continue;
    if (m.id !== undefined) seen.add(m.id);
    out.push(m);
  }
  return out;
}

/**
 * A chat the catch-up could not verify keeps the count it already had. The
 * ledger only ever grows here, which is the safe direction: an unread that IS
 * gone survives until the conversation is opened (which deletes its entry
 * outright) or a later poll reaches its boundary, whereas the other direction
 * would silently drop a real dot.
 */
export function keepUnverifiedUnread(
  counts: Record<string, number>,
  oldest: Record<string, string>,
  priorCounts: Record<string, number>,
  priorOldest: Record<string, string>,
  unverified: Set<string>,
): { counts: Record<string, number>; oldest: Record<string, string> } {
  const out = { ...counts };
  const from = { ...oldest };
  for (const chat of unverified) {
    const prior = priorCounts[chat] ?? 0;
    if (prior <= 0) continue;
    if ((out[chat] ?? 0) < prior) out[chat] = prior;
    const priorFrom = priorOldest[chat];
    if (priorFrom && (!from[chat] || priorFrom < from[chat]!)) from[chat] = priorFrom;
  }
  return { counts: out, oldest: from };
}

/**
 * A message is unread iff BOTH sides say so:
 *   - Apple side: chat.db `is_read` = 0 (imsg ≥1.9.0 emits `read`; it syncs
 *     from the iPhone via Messages in iCloud) — reading on the PHONE clears
 *     Blip within a poll.
 *   - Local side: newer than the effective read mark — reading in BLIP
 *     clears it here. The collector separately queues Mac read actions when
 *     the configured policy enables them.
 * A row without the `read` field (older imsg) falls back to local-only.
 */
/**
 * Now, in the bridge's wire format: UTC ISO-8601 to the second.
 *
 * This used to be the LINUX wall clock compared against MAC wall-clock
 * stamps — the same numbers only while both machines sat in one timezone.
 * A Mac an hour ahead put every read mark ahead of every message (nothing
 * ever unread); an hour behind and the backlog re-toasted. Both clocks are
 * UTC now, so the comparison means what it reads as.
 */
export function nowTs(now = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Re-anchor a pre-UTC stamp ("2026-09-07 14:33:12") to the wire format,
 * reading it as THIS machine's local time. A stamp already in the wire
 * format is returned untouched; junk becomes "".
 *
 * Two callers, one rule — every stamp inside Blip is UTC:
 *   - loadState(), for marks written by an older release;
 *   - the fetch boundary, for a Mac still running the pre-UTC bridge.
 * Both matter TOGETHER: migrating the marks while the bridge still emitted
 * naive stamps would sort every message below every mark (" " < "T") and
 * silently empty the badge and the toasts.
 *
 * Exact whenever the Mac shares the Linux timezone — every setup in which
 * the naive format looked correct in the first place. Where they differ a
 * mark lands off by the offset for one poll; the toast ring keys on message
 * identity rather than time, so that cannot re-toast a backlog.
 */
export function toUtcStamp(ts: string): string {
  if (!ts || ts.includes("T")) return ts;          // already UTC, or unset
  const ms = Date.parse(ts.replace(" ", "T"));     // naive → this machine's local
  return Number.isNaN(ms) ? "" : nowTs(new Date(ms));
}

/** Every stamp a message carries, normalised to the wire format. */
export function normalizeMsgStamps<T extends ImsgMessage>(m: T): T {
  if (typeof m.ts === "string" && !m.ts.includes("T")) m = { ...m, ts: toUtcStamp(m.ts) };
  if (typeof m.activity_ts === "string") m = { ...m, activity_ts: toUtcStamp(m.activity_ts) };
  if (typeof m.read_at === "string" && !m.read_at.includes("T")) m = { ...m, read_at: toUtcStamp(m.read_at) };
  return m;
}

export function isUnread(m: ImsgMessage, mark: string, ignoreAppleRead = false): boolean {
  // Tapbacks preview but never badge — matches every Apple client.
  return !m.from_me && m.ts > mark && m.tapback !== true && (ignoreAppleRead || m.read !== true);
}

/** The stamp a thread is measured against. unreadSince may sit below the
 *  global floor; a stale per-thread read mark may not. */
export function effectiveMark(
  chat: string,
  readMark: string,
  readMarks: Record<string, string>,
  unreadSince: Record<string, string> = {},
): string {
  if (unreadSince[chat]) return unreadSince[chat]!;
  return readMarks[chat] && readMarks[chat]! > readMark ? readMarks[chat]! : readMark;
}

/** Mark used for ONE message. Apple-unread (read===false) is the iPhone
 *  badge: the global floor must not hide it (first-run high-water would
 *  wipe every already-unread thread). Opening that conversation still
 *  hides it via readMarks[chat]. Missing `read` keeps the old local-only
 *  floor so a backlog cannot dump on install. */
export function unreadMark(
  chat: string,
  m: ImsgMessage,
  readMark: string,
  readMarks: Record<string, string>,
  unreadSince: Record<string, string> = {},
): string {
  if (unreadSince[chat]) return unreadSince[chat]!;
  if (m.read === false) return readMarks[chat] || "";
  return effectiveMark(chat, readMark, readMarks, unreadSince);
}

/** One second before an ISO stamp, so that message itself counts as unread. */
export function stampBefore(ts: string): string {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? "" : nowTs(new Date(ms - 1000));
}

export function lastInboundTs(msgs: ImsgMessage[], chat: string): string {
  let ts = "";
  for (const m of msgs) {
    if (chatKey(m) !== chat) continue;
    if (m.from_me || m.tapback === true) continue;
    if (m.ts > ts) ts = m.ts;
  }
  return ts;
}

/**
 * Unread is the TRAILING inbound that Messages still flags is_read=0.
 * Ghost is_read=0 rows under a read tip do not badge. Mark as Unread sets
 * is_read=0 on the latest inbound even when last_read_message_timestamp is
 * already past it — that is the blue-dot state. Opening the thread here
 * still hides it via readMarks[chat].
 */
export function trailingUnread(
  inbound: ImsgMessage[],
  readMark: string,
  localMark: string,
  forceSince = "",
): { count: number; oldest: string } {
  const list = [...inbound].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  if (forceSince) {
    const hit = list.filter((m) => isUnread(m, forceSince, true));
    return { count: hit.length, oldest: hit[0]?.ts ?? "" };
  }
  const newest = list[list.length - 1];
  if (!newest) return { count: 0, oldest: "" };
  if (newest.read === true) return { count: 0, oldest: "" };
  if (newest.read !== false && !readMark && !localMark) return { count: 0, oldest: "" };
  let count = 0;
  let oldest = "";
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]!;
    if (m.read === true) break;
    if (localMark && m.ts <= localMark) break;
    if (m.read !== false && readMark && m.ts <= readMark) break;
    count++;
    oldest = m.ts;
  }
  return { count, oldest };
}

export function unreadCounts(
  msgs: ImsgMessage[],
  readMark: string,
  readMarks: Record<string, string>,
  selfChats: string[] = [],
  unreadSince: Record<string, string> = {},
): Record<string, number> {
  const counts: Record<string, number> = {};
  const self = new Set(selfChats);
  const byChat = new Map<string, ImsgMessage[]>();
  for (const m of msgs) {
    const chat = chatKey(m);
    if (self.has(chat) || m.from_me || m.tapback === true) continue;
    const list = byChat.get(chat);
    if (list) list.push(m);
    else byChat.set(chat, [m]);
  }
  for (const [chat, list] of byChat) {
    const { count } = trailingUnread(list, readMark, readMarks[chat] || "", unreadSince[chat] || "");
    if (count) counts[chat] = count;
  }
  return counts;
}

export function unreadOldest(
  msgs: ImsgMessage[],
  readMark: string,
  readMarks: Record<string, string>,
  selfChats: string[] = [],
  unreadSince: Record<string, string> = {},
): Record<string, string> {
  const oldest: Record<string, string> = {};
  const self = new Set(selfChats);
  const byChat = new Map<string, ImsgMessage[]>();
  for (const m of msgs) {
    const chat = chatKey(m);
    if (self.has(chat) || m.from_me || m.tapback === true) continue;
    const list = byChat.get(chat);
    if (list) list.push(m);
    else byChat.set(chat, [m]);
  }
  for (const [chat, list] of byChat) {
    const hit = trailingUnread(list, readMark, readMarks[chat] || "", unreadSince[chat] || "");
    if (hit.count && hit.oldest) oldest[chat] = hit.oldest;
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
  muted: boolean;
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
  const res = runner(shimPath("imsg"), ["--json", "chats", String(CHAT_LIST_LIMIT)], {
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
          last: toUtcStamp(String(r.last ?? "")),
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
          muted: r.muted === true,
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
  // Every participant name the window already resolved, so a chat that is new
  // to this run still names its group after people rather than bare handles.
  const participantNames = new Map<string, string>();
  for (const thread of threads) {
    for (const person of thread.participants ?? []) {
      if (person.name && !participantNames.has(person.handle)) {
        participantNames.set(person.handle, person.name);
      }
    }
  }
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
    // The window's rule (PR #4) reads the last INBOUND row: the service the
    // other person's device actually used. `imsg chats` reports the CLUSTER's
    // newest row instead — Blip's own sends included, and for a merged 1:1
    // (an email iMessage row and a phone SMS row under one group_id) the phone
    // alias counts too. Letting that turn a blue DM green is self-reinforcing:
    // one green send becomes the list row's service, which makes the next send
    // green, and the conversation never comes back on its own. Refuse that one
    // direction; the list still names the service everywhere else. (#97, Ian)
    const listService = info.service || thread.service;
    const greenDowngrade = !group
      && normalizeSendService(thread.service) === "iMessage"
      && normalizeSendService(listService) !== "iMessage";
    return {
      ...thread,
      aliases,
      guid: group ? groupInfo?.guid ?? thread.guid : "",
      name: group
          ? (namedGroup(groupInfo?.name, thread.chat, aliases)
            || namedGroup(info.name, thread.chat, aliases)
            || (groupInfo?.participants.length
              ? groupName(thread.chat, groupInfo, knownParticipantNames)
              : namedGroup(thread.name, thread.chat, aliases) || thread.chat))
        : (info.last_name || info.name || thread.name || thread.chat),
      service: greenDowngrade ? thread.service : listService,
      last_text: info.last === thread.last_ts ? info.last_text : messagePreview(thread.last_text),
      pinned,
      pin_order,
      muted: info.muted === true,
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
        ? (namedGroup(groupInfo?.name, c.id, aliases) || namedGroup(c.name, c.id, aliases)
          || groupName(c.id, groupInfo, participantNames))
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
      muted: c.muted === true,
      ...(c.pin_name ? { pin_name: c.pin_name } : {}),
      ...(group ? { participants: groupParticipants(groupInfo) } : {}),
    });
  }
  return out.sort(compareThreads);
}

export function fetchGroups(runner = spawnSync): Record<string, GroupInfo> | null {
  const res = runner(shimPath("imsg"), ["--json", "groups"], { encoding: "utf8", timeout: 15000, maxBuffer: 64 * 1024 * 1024 });
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
        ...(Object.keys(nameMap(r.participant_short_names)).length
          ? {participantShortNames:nameMap(r.participant_short_names)} : {}),
      };
    }
    return out;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- main



export function fetchReadSnapshot(runner = spawnSync): ReadSnapshot | null {
  try {
    const r = runner(shimPath("imsg"), ["--json", "read-state"], {
      encoding: "utf8", timeout: 20000, maxBuffer: 16 * 1024 * 1024,
    });
    return r.status === 0 ? parseReadSnapshot(JSON.parse(String(r.stdout))) : null;
  } catch { return null; }
}

export function collect(deep: boolean, markRead = false, readChat = "", seenTs = "", unreadChat = "", explicitRead = false, menuAction = "", menuTarget = ""): BlipOutput {
  // When this POLL ran — the output's own metadata, not a message stamp.
  // Distinct from nowTs() below, which is the clock message stamps are
  // measured against and therefore has to be in the wire format.
  const producedAt = new Date().toISOString();
  const state = loadState();
  const readPush = pushReadPolicy();
  const globalSeen = seenTs || state.watermark;
  const worker = readWorkerState(HOME, state.pendingReads ?? {});
  if (worker.completed) deep = true; // refresh pin and alert metadata after acknowledgement
  let pendingReads = readPush === "off"
    ? Object.fromEntries(Object.entries(worker.pending).filter(([, r]) => r.action))
    : { ...worker.pending };
  if (menuAction && canAddressChat(menuTarget)) pendingReads = queueMenuIntent(pendingReads, menuTarget, menuAction);
  // Persist explicit intent before any network call. An offline click survives
  // the collector exiting and is retried after reconnection.
  if (readPush !== "off") {
    if (markRead) pendingReads = queueReadIntent(pendingReads, "*", false, globalSeen, state.readRowId);
    if (unreadChat && pushUnreadArgs(unreadChat)) pendingReads = queueReadIntent(pendingReads, unreadChat, true);
    if ((explicitRead || (readPush === "thread" && (state.unreadCounts[readChat] ?? 0) > 0)) && readChat && readChat !== unreadChat && canAddressChat(readChat)) pendingReads = queueReadIntent(pendingReads, readChat, false, seenTs);
  }
  if (JSON.stringify(pendingReads) !== JSON.stringify(state.pendingReads ?? {}) &&
      !saveState({ ...state, pendingReads })) {
    throw new Error("state write failed; read action was not queued");
  }
  const remoteReads = fetchReadSnapshot();
  if (remoteReads && !worker.busy) pendingReads = reconcileReadIntents(pendingReads, remoteReads);
  // On migration, seed the ledger all the way back to what the user last read.
  // Thereafter cover both new arrivals and every outstanding unread row. That
  // makes the ledger exact even if an unread message is deleted on the Mac.
  const oldestUnread = Object.values(state.unreadOldest).reduce(
    (oldest, ts) => !oldest || ts < oldest ? ts : oldest,
    "",
  );
  const cutoff = remoteReads ? state.watermark : state.unreadInitialized
    ? oldestUnread && oldestUnread < state.watermark ? oldestUnread : state.watermark
    : state.readMark;
  const fetched = fetchMessagesAfter(cutoff, deep ? DEEP_WINDOW : POLL_WINDOW);

  if (!fetched.ok) {
    return {
      ok: false,
      online: fetched.online,
      error: fetched.error,
      ts: producedAt,
      unread: 0,
      threads: [],
      toast: [],
      failures: [],
      links: [],
      persisted: true,
      // Reported on the failure path too: it comes from a local file, needs no
      // Mac, and "why are reads not reaching my phone" is asked precisely when
      // something is broken. Without it `status` says read_push=? exactly then.
      readPush: pushReadPolicy(),
      // The widget guards both with Array.isArray/=== true, so these were never
      // a crash — but BlipOutput declares them required and this return did not
      // carry them, so the type was lying about the failure path.
      codes: [],
      deep: false,
    };
  }

  // Reconcile every outstanding unread the window did not reach, one bounded
  // fetch per conversation, oldest boundary first. A chat left unverified — the
  // fetch failed, the conversation has more rows than the limit, or it sat past
  // the per-poll cap — keeps the count it already had (never fewer), which is
  // what the capped global walk did for the same chats before.
  const stale = staleUnreadChats(state.unreadOldest, state.unreadCounts, minTs(fetched.msgs, ""));
  const unverified = new Set<string>(stale.slice(CATCHUP_MAX_CHATS));
  let caughtUp = fetched.msgs;
  for (const chat of stale.slice(0, CATCHUP_MAX_CHATS)) {
    const rows = fetchChatBack(chat, state.unreadOldest[chat] ?? "");
    if (!rows.ok) { unverified.add(chat); continue; }
    caughtUp = mergeCatchupRows(caughtUp, rows.msgs);
    if (rows.capped) unverified.add(chat);
  }

  const highest = maxTs(fetched.msgs, state.watermark);
  // A message can carry a FUTURE timestamp (timezone skew — a "Sep 1
  // 08:53" birthday text arrived Aug 31 morning). A read mark taken from
  // the GLOBAL max therefore poisoned unrelated threads: anything arriving
  // before that future instant could never badge. So the global mark is
  // clamped to the local clock, and each chat that reaches past it gets a
  // PER-CHAT mark at its own max — every visible message is covered,
  // nothing beyond now leaks onto other threads.
  const now = nowTs();
  const chatMax: Record<string, string> = {};
  for (const m of fetched.msgs) {
    if (m.scheduled === true) continue;   // a queued Send Later is not seen yet
    const c = chatKey(m);
    if (!chatMax[c] || m.ts > chatMax[c]!) chatMax[c] = m.ts;
  }
  // Badge counts against readMark (what the user has seen); toasts fire against
  // watermark (what the collector has seen). See BlipState.
  const readMark = markRead && globalSeen ? (globalSeen <= now ? globalSeen : now) : state.readMark;
  // Opening one conversation clears only that thread's dot — marked with
  // THAT chat's newest ts, never the global max.
  // Under thread sync, confirmed Mac state replaces historical local marks.
  // Legacy permanent unread overrides are retired as soon as a full snapshot
  // is available. Failed actions are represented by pendingReads instead.
  const readMarks = remoteReads && readPush === "thread"
    ? Object.fromEntries(Object.entries(state.readMarks).filter(([chat]) => isGroupChat(chat)))
    : { ...state.readMarks };
  const unreadSince = remoteReads && readPush !== "off"
    ? Object.fromEntries(Object.entries(state.unreadSince ?? {}).filter(([chat]) => isGroupChat(chat)))
    : { ...state.unreadSince };
  if (markRead) {
    for (const c of Object.keys(readMarks)) delete readMarks[c];
    for (const [c, ts] of Object.entries(chatMax)) {
      if (!remoteReads && ts <= globalSeen) readMarks[c] = ts > now ? ts : now;
    }
    for (const c of Object.keys(unreadSince)) delete unreadSince[c];
  }
  if (unreadChat) {
    const inbound = lastInboundTs(fetched.msgs, unreadChat);
    const pivot = inbound || chatMax[unreadChat] || now;
    unreadSince[unreadChat] = stampBefore(pivot) || "1970-01-01T00:00:00Z";
    delete readMarks[unreadChat];
  }
  if (readChat && readChat !== unreadChat) {
    delete unreadSince[readChat];
    // Mark through what the user actually SAW (the panel passes the newest
    // bubble ts as --seen; it includes a future-dated row when the chat has
    // one on screen). A message arriving between the click and this run has
    // ts > seen and stays unread. Fallback without --seen: through now, or
    // the chat's own future row.
    const own = chatMax[readChat] ?? "";
    readMarks[readChat] = seenTs !== "" ? seenTs : (own > now ? own : now);
  }
  const readSeen = readChat && readChat !== unreadChat ? readMarks[readChat]! : "";
  // Group metadata is ~1000 rows; refresh it only on a deep (panel) fetch and
  // keep the last good copy if the lookup fails.
  const groups = (deep ? fetchGroups() : null) ?? state.groups;
  // persist only on two independent twins; one may be a coincidence (#6)
  const selfChats = [...new Set([...state.selfChats, ...detectSelfChats(fetched.msgs, 2)])];
  // The mute list cuts here, upstream of every count: a muted conversation is
  // absent from the ledger, the thread list and the toasts alike, exactly as
  // if the Mac had never received it. Read fresh each poll, like the allowlist.
  const mute = loadMutelist();
  // The catch-up rows join HERE, where the ledger is counted — not in the
  // watermark, the failure ring or the toast gates above: every one of them is
  // older than the watermark by construction, and a message that scrolled out
  // of the window months ago must not toast now.
  const deduped = dedupeSelfEcho(caughtUp, selfChats);
  const muted = mutedChats(deduped, mute);
  const msgs = dropMuted(deduped, muted);
  let exactCounts = unreadCounts(msgs, state.readMark, readMarks, selfChats, unreadSince);
  let exactOldest = unreadOldest(msgs, state.readMark, readMarks, selfChats, unreadSince);
  // Deep runs complete the sidebar from `imsg chats`. A capped catch-up
  // needs that list too: otherwise a chat hide_spam dropped in SQL is
  // restored from the ledger (Astra B#3) and pins every later poll.
  const listed = (deep || fetched.capped) ? dropMutedChats(fetchChats(), mute, muted) : null;
  if (fetched.capped) {
    const inWindow = new Set(msgs.map(chatKey));
    const kept = keepCappedUnread(
      exactCounts, exactOldest,
      state.unreadCounts, state.unreadOldest,
      inWindow, visibleLedgerChats(msgs, listed),
    );
    exactCounts = kept.counts;
    exactOldest = kept.oldest;
  }
  if (unverified.size) {
    const kept = keepUnverifiedUnread(
      exactCounts, exactOldest, state.unreadCounts, state.unreadOldest, unverified,
    );
    exactCounts = kept.counts;
    exactOldest = kept.oldest;
  }
  if (markRead) {
    exactCounts = {};
    exactOldest = {};
  }
  // Per-chat counts were already calculated through --seen above. Do not
  // zero them wholesale: that would hide arrivals newer than the rendered view.
  if (unreadChat && (exactCounts[unreadChat] ?? 0) === 0) {
    exactCounts[unreadChat] = 1;
    if (!exactOldest[unreadChat]) exactOldest[unreadChat] = unreadSince[unreadChat] || now;
  }
  // Prune per-thread marks the global mark has overtaken (Codex finding #13):
  // they no longer affect any count and would otherwise accumulate forever.
  for (const [chat, ts] of Object.entries(readMarks)) {
    if (!remoteReads && ts <= readMark) delete readMarks[chat];
  }
  const preferImessage = preferImessagePolicy();
  const windowThreads = buildThreads(msgs, readMark, readMarks, groups, exactCounts, preferImessage, unreadSince);
  // A shallow poll returns the window's rows; the widget keeps its last
  // complete list in memory (it skips identical assignments anyway).
  const chats = deep ? listed : null;
  // One entry per CONVERSATION. A re-keyed group has several chat rows; the
  // bridge names the older ones as aliases of the live row, and the map is
  // cached so shallow polls fold identically (a conversation must never
  // blink into two between a deep run and the next poll).
  const chatAliases = { ...(chats ? aliasesFromChats(chats) : state.chatAliases) };
  for (const [chat, row] of Object.entries(remoteReads ?? {})) {
    delete chatAliases[chat];
    for (const alias of row.aliases ?? []) chatAliases[alias] = chat;
  }
  const pins = chats ? pinsFromChats(chats) : state.pins;
  if (readChat && readChat !== unreadChat) {
    for (const a of aliasesOf(chatAliases, readChat)) {
      if (remoteReads || readSeen > readMark) readMarks[a] = readSeen;   // same prune rule as the canonical
      delete unreadSince[a];
      const remaining = unreadCounts(msgs, state.readMark, readMarks, selfChats, unreadSince);
      const oldestRemaining = unreadOldest(msgs, state.readMark, readMarks, selfChats, unreadSince);
      if (remaining[a]) {
        exactCounts[a] = remaining[a]!;
        exactOldest[a] = oldestRemaining[a]!;
      } else {
        delete exactCounts[a];
        delete exactOldest[a];
      }
    }
  }
  if (unreadChat) {
    for (const a of [unreadChat, ...aliasesOf(chatAliases, unreadChat)]) {
      unreadSince[a] = unreadSince[unreadChat]!;
      delete readMarks[a];
      if ((exactCounts[a] ?? 0) === 0) exactCounts[a] = 1;
    }
  }
  if (remoteReads) {
    exactCounts = {};
    exactOldest = {};
    for (const [chat, row] of Object.entries(remoteReads)) {
      if (selfChats.includes(chat) || muted.includes(chat) || mute.includes(chat)) continue;
      const canonical = chatAliases[chat] ?? chat;
      if (selfChats.includes(canonical) || muted.includes(canonical) || mute.includes(canonical)) continue;
      if (row.unread > 0) {
        exactCounts[chat] = row.unread;
        exactOldest[chat] = row.oldest;
      }
      const reading = canonical === readChat && readChat !== unreadChat;
      // Compare to the visible snapshot BEFORE advancing any read mark. An
      // unseen inbound must keep its dot and must not be cleared on the Mac.
      if (reading && readPush === "thread" && row.unread > 0 && seenTs && row.latest <= seenTs && canAddressChat(readChat)) {
        pendingReads = queueReadIntent(pendingReads, readChat, false, seenTs);
      }
      const intent = pendingReads[canonical] ?? pendingReads["*"];
      const localMark = readMarks[chat] || readMarks[canonical] || "";
      const globalRow = markRead ? state.readRowId : state.readAllRowId;
      const coveredByAll = globalRow !== undefined && row.max_id !== undefined && row.max_id <= globalRow;
      if ((markRead && coveredByAll) ||
          ((readPush !== "thread" || isGroupChat(canonical)) && coveredByAll) || (reading && seenTs && row.latest <= seenTs) ||
          ((readPush !== "thread" || isGroupChat(canonical)) && localMark && row.latest <= localMark) ||
          (intent && !intent.unread && (!intent.seen || row.latest <= intent.seen))) {
        delete exactCounts[chat]; delete exactOldest[chat];
      }
    }
  } else if (readPush === "thread" && readChat && canAddressChat(readChat) && readChat !== unreadChat) {
    // Older/offline bridges still retain the transition until it is verified.
    const before = unreadCounts(msgs, state.readMark, state.readMarks, selfChats, state.unreadSince);
    if (seenTs && lastInboundTs(msgs, readChat) > seenTs) {
      delete pendingReads[readChat];
    } else if ((before[readChat] ?? 0) > 0 || (state.unreadCounts[readChat] ?? 0) > 0) {
      pendingReads = queueReadIntent(pendingReads, readChat, false, seenTs);
    }
  }
  {
    for (const [chat, since] of Object.entries(unreadSince)) {
      if (readPush !== "off" && !isGroupChat(chat)) continue;
      exactCounts[chat] = Math.max(1, exactCounts[chat] ?? 0);
      exactOldest[chat] ||= since;
    }
  }
  for (const [chat, intent] of Object.entries(pendingReads)) {
    if (!intent.action && intent.unread) { exactCounts[chat] = Math.max(1, exactCounts[chat] ?? 0); exactOldest[chat] ||= unreadSince[chat] || now; }
  }
  exactCounts = foldChatRecord(exactCounts, chatAliases, (a, b) => a + b);
  exactOldest = foldChatRecord(exactOldest, chatAliases, (a, b) => (a < b ? a : b));
  const foldedWindow = foldThreadAliases(windowThreads, chatAliases).map(t => ({ ...t, unread: exactCounts[t.chat] ?? 0 }));
  const threads = chats ? mergeChats(foldedWindow, chats, groups, exactCounts) : applyPins(foldedWindow, pins);
  // The conversation on screen covers its alias rows, exactly as the read
  // marks above do: a message arriving under a retired chat row is the same
  // conversation you are looking at.
  const readingNow = readChat ? [readChat, ...aliasesOf(chatAliases, readChat)] : [];
  const alertMuted = listed ? listed.filter(c => c.muted).flatMap(c => [c.id, ...(c.aliases ?? [])]) : state.alertMuted ?? [];
  const toast = selectToasts(msgs, state.watermark, loadAllowlist(), state.toasted, readingNow)
    .filter(t => !alertMuted.includes(t.chat));
  const failures = selectFailures(fetched.msgs, state.toasted, now);
  const links = selectIncomingLinks(msgs, state.watermark, state.toasted, selfChats).filter(t => !alertMuted.includes(t.chat));
  const codes = selectCodes(msgs, state.watermark, state.toasted, selfChats).filter(t => !alertMuted.includes(t.chat));
  // Header/badge count conversations with a blue dot, not inbound rows.
  // Two chats with two unread messages each used to say "4 UNREAD".
  const unread = Object.values(exactCounts).filter((count) => count > 0).length;

  // Both marks advance only on a good fetch, so an outage cannot silently
  // swallow the messages that arrived during it.
  // A row dated tomorrow (tz skew) must not become the mark everything is
  // measured against — nothing would badge or toast until "tomorrow" (Astra B#4).
  const highestNow = highest <= now ? highest : now;
  const nextState: BlipState = {
    alertMuted,
    readAllRowId: markRead ? state.readRowId : state.readAllRowId,
    readRowId: remoteReads && Object.values(remoteReads).every(r => r.max_id !== undefined)
      ? Math.max(0, ...Object.values(remoteReads).map(r => r.max_id!)) : state.readRowId,
    pendingReads,
    watermark: highestNow,
    // First ever run: adopt the current high-water rather than reporting the
    // whole preview window as unread the moment the plugin is installed.
    readMark: state.readMark === "" ? highestNow : readMark,
    unreadCounts: exactCounts,
    unreadOldest: exactOldest,
    unreadInitialized: true,
    selfChats,
    readMarks,
    unreadSince,
    groups,
    chatAliases,
    pins,
    toasted: [...state.toasted, ...toast.map((t) => t.key), ...failures.map((f) => f.key),
      ...links.map((l) => l.key), ...codes.map((c) => c.key)],
  };
  const persisted = saveState(nextState);

  // The mailbox worker cannot write collector state or delay message polling.
  let syncError = worker.notice;
  if (persisted) {
    try { scheduleReadJob(HOME, pendingReads, worker.completed); }
    catch { syncError = "Read worker could not start; will retry"; }
  }
  const remaining = Object.keys(pendingReads).length;
  const warning = !persisted
    ? "state write failed; notifications paused"
    : syncError || (remaining ? (Object.values(pendingReads).find(r => r.error)?.error || `Read sync pending (${remaining}); retrying automatically`) :
      !remoteReads ? "Read sync snapshot unavailable; update/check the Mac bridge" : "");
  return {
    ok: true,
    online: true,
    error: warning,
    ts: producedAt,
    unread,
    unreadCounts: remoteReads ? exactCounts : undefined,
    threads,
    // Never emit notifications that could not be committed to the dedupe ring.
    toast: persisted ? toast : [],
    failures: persisted ? failures : [],
    links: persisted ? links : [],
    codes: persisted ? codes : [],
    persisted,
    deep: chats !== null,
    // Which reads reach the Mac. Surfaced so `status` can say it: the default
    // ("all") pushes ONLY on the mark-all gesture, so reading a conversation
    // clears it here and leaves the iPhone's badge alone — correct by design
    // and impossible to tell apart from a broken push without this (Fred,
    // 2026-09-08: "they are not marking them read on my iphone").
    readPush,
  };
}

if (import.meta.main) {
  const deep = process.argv.includes("--deep");
  const markRead = process.argv.includes("--mark-read");
  const ri = process.argv.indexOf("--read");
  let readChat = ri >= 0 ? String(process.argv[ri + 1] ?? "") : "";
  const si = process.argv.indexOf("--seen");
  const seenTs = si >= 0 ? String(process.argv[si + 1] ?? "") : "";
  const ui = process.argv.indexOf("--mark-unread");
  let unreadChat = ui >= 0 ? String(process.argv[ui + 1] ?? "") : "";
  const ai = process.argv.indexOf("--act");
  const act = ai >= 0 ? String(process.argv[ai + 1] ?? "") : "";
  const ti = process.argv.indexOf("--target");
  const actTarget = ti >= 0 ? String(process.argv[ti + 1] ?? "") : "";
  try {
    if (act === "unread" && actTarget) unreadChat = unreadChat || actTarget;
    if (act === "read" && actTarget) readChat = readChat || actTarget;
    const out = collect(deep, markRead, readChat, seenTs, unreadChat, act === "read", act, actTarget);
    console.log(JSON.stringify(out));
  } catch (e) {
    console.log(
      JSON.stringify({
        ok: false, online: false, error: String(e), ts: new Date().toISOString(),
        unread: 0, threads: [], toast: [], failures: [], persisted: false,
      }),
    );
  }
}
