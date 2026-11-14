// send-state.ts
function markSendFailed(items, id, reason, fallback) {
  const safeReason = reason.slice(0, 240).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
  const current = fallback && !items.some((item) => item.localId === id) ? items.concat([fallback]) : items;
  return current.map((item) => item.localId === id ? Object.assign({}, item, { failed: true, failureReason: safeReason }) : item);
}
function friendlySendError(raw) {
  return /(^|[^\d])-10810(\D|$)/.test(raw) ? "Messages can't start on the Mac: nobody is logged in there. Log in on the Mac, then send again." : raw;
}
var REPLY_NOT_STARTED = -2;
function replyExitCode(code, status) {
  return status === 0 ? code : 76;
}
function replyFailure(code, detail) {
  return !replyCanRestore(code) ? "Check Messages before sending again" : detail.trim().slice(0, 240) || "Reply was not sent";
}
function replyCanRestore(code) {
  return [REPLY_NOT_STARTED, 1, 64, 65, 75, 77, 78].includes(code);
}
export {
  REPLY_NOT_STARTED,
  friendlySendError,
  markSendFailed,
  replyCanRestore,
  replyExitCode,
  replyFailure
};
