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
export {
  conversationInitials,
  conversationName
};
