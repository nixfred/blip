// QML adapter: see read-sync-qml.ts for the renderer build command.
/** Read synchronization metadata. No message bodies or contact names. */
export interface RemoteRead { unread: number; oldest: string; latest: string; aliases?: string[] }
export type ReadSnapshot = Record<string, RemoteRead>;
export interface ReadIntent { unread: boolean; seen: string; attempts: number; retryAt: number; error?: string; chats?: string[] }
export type ReadIntents = Record<string, ReadIntent>;
export interface ReadSyncNotice { pending: number; reason: "locked" | "pending"; label: string; detail: string }
export interface ReadSyncStatus { error: string; notice: ReadSyncNotice | null }

/** True when imsg-read failed solely because the gateway Mac's screen is locked.
 *  That is a normal, recoverable pause — queued intents retry automatically and
 *  drain once unlocked — rather than a broken bridge needing a red alert. */
export function isScreenLockedError(error: string): boolean {
  return /screen is locked/i.test(error);
}

/** Split collector read-sync state into a hard bridge `error` (red banner) vs a
 *  compact non-alarming `notice` (queued updates waiting on a locked Mac or retry). */
export function classifyReadSync(opts: {
  persisted: boolean;
  remoteReads: ReadSnapshot | null;
  pendingReads: ReadIntents;
  syncError: string;
}): ReadSyncStatus {
  const { persisted, remoteReads, pendingReads, syncError } = opts;
  if (!persisted) return { error: "state write failed; notifications paused", notice: null };
  if (syncError && !isScreenLockedError(syncError)) return { error: syncError, notice: null };

  const intents = Object.values(pendingReads);
  const hardError = intents.find(r => r.error && !isScreenLockedError(r.error))?.error;
  if (hardError) return { error: hardError, notice: null };

  const keys = Object.keys(pendingReads);
  if (keys.length > 0) {
    const bulk = Boolean(pendingReads["*"] && !pendingReads["*"].chats?.length);
    const pending = bulk ? keys.length : keys.reduce((n, k) => n + (k === "*" ? (pendingReads[k]?.chats?.length ?? 1) : 1), 0);
    const lockedError = (syncError && isScreenLockedError(syncError) ? syncError : "")
      || intents.find(r => r.error && isScreenLockedError(r.error))?.error
      || "";
    if (lockedError) {
      const cleaned = lockedError.replace(/^imsg-read:\s*/i, "").replace(/[\x00-\x1f\x7f]+/g, " ").trim();
      const body = cleaned ? cleaned[0]!.toUpperCase() + cleaned.slice(1) : lockedError;
      return {
        error: "",
        notice: {
          pending,
          reason: "locked",
          label: bulk ? "Read sync paused" : `Read sync paused (${pending})`,
          detail: `Read updates are queued and will sync when unlocked. ${body}`,
        },
      };
    }
    return {
      error: "",
      notice: {
        pending,
        reason: "pending",
        label: bulk ? "Read sync pending" : `Read sync pending (${pending})`,
        detail: bulk
          ? "Read updates are queued and retrying automatically."
          : `${pending} read ${pending === 1 ? "update is" : "updates are"} queued and retrying automatically.`,
      },
    };
  }

  if (syncError) return { error: syncError, notice: null };
  if (!remoteReads) {
    return { error: "Read sync snapshot unavailable; update/check the Mac bridge", notice: null };
  }
  return { error: "", notice: null };
}

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
    out[r.chat] = { unread: r.unread, oldest: r.oldest, latest: r.latest, aliases: r.aliases ?? [] };
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
    if (chat !== "*" && !/^\+?[0-9]{3,15}$/.test(chat) && !/^[^@\s]+@[^@\s]+$/.test(chat)
        && !/^(?:chat[0-9]{1,40}|[a-fA-F0-9]{32})$/.test(chat)) continue;
    if (r.chats !== undefined && (chat !== "*" || !Array.isArray(r.chats) || r.chats.length > 32768 ||
        r.chats.some(id => typeof id !== "string" || !id || id.length > 512 || /[\x00-\x1f\x7f]/.test(id)))) continue;
    out[chat] = { unread: r.unread, seen: r.seen, attempts: r.attempts, retryAt: r.retryAt,
      ...(r.chats ? { chats: r.chats } : {}),
      ...(typeof r.error === "string" ? { error: r.error.slice(0, 240).replace(/[\x00-\x1f\x7f]/g, " ") } : {}) };
  }
  return out;
}

/** Latest user intent wins; identical polls never reset a failed action's backoff. */
export function queueReadIntent(pending: ReadIntents, chat: string, unread: boolean, seen = ""): ReadIntents {
  const old = pending[chat];
  if (old && old.unread === unread && (unread || old.seen >= seen)) return pending;
  const next = chat === "*" ? {} : { ...pending };
  next[chat] = { unread, seen, attempts: 0, retryAt: 0 };
  return next;
}

export function retryReadIntent(intent: ReadIntent, now: number, error = ""): ReadIntent {
  return { ...intent, ...(error ? { error: error.slice(0, 240).replace(/[\x00-\x1f\x7f]/g, " ") } : {}), attempts: intent.attempts + 1,
    retryAt: now + Math.min(60000, 2000 * 2 ** Math.min(intent.attempts, 5)) };
}

/** Only a read snapshot may acknowledge a queued operation. A later inbound
 * is not covered by --seen and must never be marked read by an old retry. */
export function reconcileReadIntents(pending: ReadIntents, snapshot: ReadSnapshot): ReadIntents {
  const next = { ...pending };
  for (const [chat, intent] of Object.entries(next)) {
    if (chat === "*") {
      const covered = Object.entries(snapshot).filter(([id, r]) =>
        (!intent.chats || intent.chats.includes(id)) && (!intent.seen || r.latest <= intent.seen)).map(([, r]) => r);
      if (covered.every(r => r.unread === 0)) delete next[chat];
      continue;
    }
    if (next["*"]?.attempts === 0) continue; // an unattempted mark-all precedes this gesture
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
