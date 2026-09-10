// send-state.ts
function markSendFailed(items, id, reason, fallback) {
  const safeReason = reason.slice(0, 240).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
  const current = fallback && !items.some((item) => item.localId === id) ? items.concat([fallback]) : items;
  return current.map((item) => item.localId === id ? Object.assign({}, item, { failed: true, failureReason: safeReason }) : item);
}
export {
  markSendFailed
};
