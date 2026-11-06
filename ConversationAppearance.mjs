// conversation-appearance.ts
function conversationName(thread) {
  if (!thread)
    return "Select a conversation";
  const name = typeof thread.name === "string" ? thread.name.trim() : "";
  if (!name || name === thread.chat || name === thread.handle || /^[+\d\s().-]+$/.test(name) || /^[^\s@]+@[^\s@]+$/.test(name))
    return "Conversation";
  return name;
}
function conversationInitials(thread) {
  const name = conversationName(thread);
  if (name === "Conversation" || !thread)
    return "?";
  return name.split(/\s+/).slice(0, 2).map((word) => word.slice(0, (word.codePointAt(0) || 0) > 65535 ? 2 : 1)).join("").toUpperCase();
}
function pinnedName(thread, peers = [], group = false) {
  const name = conversationName(thread);
  if (group || name === "Conversation")
    return name;
  const words = name.split(/\s+/);
  if (words.length === 1)
    return name;
  const first = words[0];
  const duplicate = peers.filter((peer) => typeof peer.name === "string" && peer.name.trim().split(/\s+/)[0].toLocaleLowerCase() === first.toLocaleLowerCase()).length > 1;
  const last = words[words.length - 1];
  return duplicate ? first + " " + last.slice(0, (last.codePointAt(0) || 0) > 65535 ? 2 : 1).toUpperCase() + "." : first;
}
export {
  conversationInitials,
  conversationName,
  pinnedName
};
