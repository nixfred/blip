// Rebuild QML module: bun build conversation-appearance.ts --target browser --format esm --outfile ConversationAppearance.mjs
export function conversationName(thread: { name?: unknown; chat?: unknown; handle?: unknown } | null): string {
  if (!thread) return "Select a conversation";
  const name = typeof thread.name === "string" ? thread.name.trim() : "";
  if (!name || name === thread.chat || name === thread.handle || /^[+\d\s().-]+$/.test(name) || /^[^\s@]+@[^\s@]+$/.test(name)) return "Conversation";
  return name;
}
export function conversationInitials(thread: { name?: unknown; chat?: unknown; handle?: unknown } | null): string {
  const name = conversationName(thread);
  if (name === "Conversation" || !thread) return "?";
  return name.split(/\s+/).slice(0, 2).map(word => word.slice(0, (word.codePointAt(0) || 0) > 0xffff ? 2 : 1)).join("").toUpperCase();
}
