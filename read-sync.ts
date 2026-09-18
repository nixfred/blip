// QML adapter: see read-sync-qml.ts for the renderer build command.
/** Read synchronization metadata. No message bodies or contact names. */
export interface RemoteRead { unread: number; oldest: string; latest: string; aliases?: string[]; max_id?: number }
export type ReadSnapshot = Record<string, RemoteRead>;
export interface ReadIntent { id?: string; throughRow?: number; action?: "pin" | "unpin" | "mute" | "unmute"; unread: boolean; seen: string; attempts: number; retryAt: number; error?: string }
export type ReadIntents = Record<string, ReadIntent>;

export function parseReadSnapshot(value: unknown): ReadSnapshot | null {
  const v = value as { version?: number; chats?: unknown[] };
  if (!v || v.version !== 1 || !Array.isArray(v.chats)) return null;
  const out: ReadSnapshot = Object.create(null);
  const stamp = (s: unknown) => typeof s === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(s);
  for (const raw of v.chats) {
    const r = raw as RemoteRead & { chat: string };
    if (!r || typeof r.chat !== "string" || !r.chat || r.chat.length > 512 ||
        /[\x00-\x1f\x7f]/.test(r.chat) || !Number.isSafeInteger(r.unread) || r.unread < 0 ||
        !stamp(r.latest) || (r.unread > 0 ? !stamp(r.oldest) : r.oldest !== "")) return null;
    if (r.aliases !== undefined && (!Array.isArray(r.aliases) || r.aliases.some(a => typeof a !== "string" || !a || a.length > 512))) return null;
    if (r.max_id !== undefined && (!Number.isSafeInteger(r.max_id) || r.max_id < 0)) return null;
    out[r.chat] = { ...(r.max_id !== undefined ? { max_id: r.max_id } : {}), unread: r.unread, oldest: r.oldest, latest: r.latest, aliases: r.aliases ?? [] };
  }
  return out;
}

export function parseReadIntents(value: unknown): ReadIntents {
  const out: ReadIntents = Object.create(null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [chat, raw] of Object.entries(value)) {
    const r = raw as ReadIntent;
    if (!r || typeof r.unread !== "boolean" || typeof r.seen !== "string" ||
        !Number.isSafeInteger(r.attempts) || r.attempts < 0 ||
        !Number.isFinite(r.retryAt) || r.retryAt < 0) continue;
    const target = r.action ? chat.slice(chat.indexOf("|") + 1) : chat;
    if (r.action && !["pin", "unpin", "mute", "unmute"].includes(r.action)) continue;
    if (target !== "*" && !/^\+?[0-9]{3,15}$/.test(target) && !/^[^@\s]+@[^@\s]+$/.test(target)) continue;
    out[chat] = { ...(Number.isSafeInteger(r.throughRow) && r.throughRow! >= 0 ? { throughRow: r.throughRow } : {}), ...(r.action ? { action: r.action } : {}), id: typeof r.id === "string" ? r.id : crypto.randomUUID(), unread: r.unread, seen: r.seen, attempts: r.attempts, retryAt: r.retryAt,
      ...(typeof r.error === "string" ? { error: r.error.slice(0, 240).replace(/[\x00-\x1f\x7f]/g, " ") } : {}) };
  }
  return out;
}

/** Latest user intent wins; identical polls never reset a failed action's backoff. */
export function queueReadIntent(pending: ReadIntents, chat: string, unread: boolean, seen = "", throughRow?: number): ReadIntents {
  const old = pending[chat];
  if (old && old.unread === unread && (unread || old.seen >= seen) &&
      (chat !== "*" || old.throughRow === throughRow)) return pending;
  const next = chat === "*"
    ? Object.fromEntries(Object.entries(pending).filter(([, r]) => r.action))
    : { ...pending };
  // A later explicit per-chat gesture cancels the old global operation.
  if (chat !== "*") delete next["*"];
  next[chat] = { ...(throughRow !== undefined ? { throughRow } : {}), id: crypto.randomUUID(), unread, seen, attempts: 0, retryAt: 0 };
  return next;
}

export function retryReadIntent(intent: ReadIntent, now: number, error = ""): ReadIntent {
  return { ...intent, id: crypto.randomUUID(), ...(error ? { error: error.slice(0, 240).replace(/[\x00-\x1f\x7f]/g, " ") } : {}), attempts: intent.attempts + 1,
    retryAt: now + Math.min(60000, 2000 * 2 ** Math.min(intent.attempts, 5)) };
}

/** Only a read snapshot may acknowledge a queued operation. A later inbound
 * is not covered by --seen and must never be marked read by an old retry. */
export function reconcileReadIntents(pending: ReadIntents, snapshot: ReadSnapshot): ReadIntents {
  const next = { ...pending };
  for (const [chat, intent] of Object.entries(next)) {
    if (intent.action) continue;
    if (chat === "*") {
      if (!intent.seen || intent.throughRow === undefined || Object.values(snapshot).some(r => r.max_id === undefined || r.max_id > intent.throughRow!) || Object.values(snapshot).every(r => r.unread === 0) ||
          Object.values(snapshot).some(r => r.latest > intent.seen)) delete next[chat];
      continue;
    }
    if (next["*"]) continue; // a preceding mark-all must land before this gesture
    const remote = snapshot[chat] ?? Object.values(snapshot).find(r => r.aliases?.includes(chat));
    if (remote && ((remote.unread > 0) === intent.unread ||
        (!intent.unread && intent.seen && remote.latest > intent.seen))) delete next[chat];
  }
  return next;
}

/** Coalescing cannot cross an explicit gesture: read → unread → read must
 * keep that order instead of moving the last read ahead of mark-unread. */
export function enqueueRefresh<T extends { markRead: boolean; unreadChat: string;
  act: string; readChat: string; seen: string; deep: boolean }>(queue: T[], req: T): T[] {
  const q = queue.slice();
  const barrier = (r: T) => r.markRead || r.unreadChat || r.act;
  if (!barrier(req)) {
    for (let i = q.length - 1; i >= 0; i--) {
      if (barrier(q[i]!)) break;
      if (q[i]!.readChat === req.readChat) {
        q[i] = Object.assign({}, req, { deep: q[i]!.deep || req.deep, seen: req.seen > q[i]!.seen ? req.seen : q[i]!.seen });
        return q;
      }
    }
  }
  q.push(req);
  return q;
}

/** Each menu property is independent of read state and of the other property. */
export function queueMenuIntent(pending: ReadIntents, chat: string, action: string): ReadIntents {
  if (!["pin", "unpin", "mute", "unmute"].includes(action)) return pending;
  const key = `${action === "pin" || action === "unpin" ? "pin" : "mute"}|${chat}`;
  return { ...pending, [key]: { id: crypto.randomUUID(), action: action as ReadIntent["action"],
    unread: false, seen: "", attempts: 0, retryAt: 0 } };
}
