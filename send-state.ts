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

/** The `--service` a send in this conversation carries, or "" for none: iMessage
 *  is imsg-send's default, and a group sends by chat id and never carries one.
 *  The opened conversation's own rows (thread.ts `service`, kept with the chat
 *  they were loaded for) outrank the list row's service. That is the Mac's chat
 *  label, which follows the Mac's own last send and stayed "iMessage" for a
 *  contact texting on RCS, so every send failed with error 22 (2026-11-12). */
export function sendServiceArg(
  chat: string,
  group: boolean,
  listService: string,
  loadedChat: string,
  loadedService: string,
): string {
  if (group) return "";
  const svc = loadedChat === chat && loadedService !== "" ? loadedService : listService;
  return /^(SMS|RCS)$/i.test(svc) ? svc.toUpperCase() : "";
}

/** Say what a send failure MEANS when the Mac's own words are only a number.
 *  -10810 is Launch Services failing to start Messages for `tell application "Messages"`; seen
 *  2026-11-10 when the gateway's WindowServer died and loginwindow logged the user out, which leaves no
 *  GUI session to launch anything into (every launch said "Domain does not support specified action").
 *  Only the proven code is mapped. Anything else keeps the Mac's wording, because a guess is worse. */
export function friendlySendError(raw: string): string {
  return /(^|[^\d])-10810(\D|$)/.test(raw)
    ? "Messages can't start on the Mac: nobody is logged in there. Log in on the Mac, then send again."
    : raw;
}
