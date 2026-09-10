// Pure local-send state shared by the QML renderer and tests.
// Rebuild the QML module: bun build send-state.ts --target browser --format esm --outfile SendState.mjs
export interface LocalSend {
  localId?: string;
  failed?: boolean;
  failureReason?: string;
}

/** Change exactly one optimistic send, even when several share a timestamp. */
export function markSendFailed<T extends LocalSend>(items: T[], id: string, reason: string, fallback?: T): T[] {
  const safeReason = reason.slice(0, 240).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
  const current = fallback && !items.some((item) => item.localId === id) ? items.concat([fallback]) : items;
  return current.map((item) => item.localId === id
    ? Object.assign({}, item, { failed: true, failureReason: safeReason }) : item);
}
