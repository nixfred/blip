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

/** Compact favorite captions retain full names elsewhere, disambiguating first names. */
export function pinnedName(thread: { name?: unknown; chat?: unknown; handle?: unknown }, peers: Array<{ name?: unknown }> = [], group = false): string {
  const name = conversationName(thread);
  if (group || name === "Conversation") return name;
  const words = name.split(/\s+/);
  if (words.length === 1) return name;
  const first = words[0];
  const duplicate = peers.filter(peer => typeof peer.name === "string" && peer.name.trim().split(/\s+/)[0].toLocaleLowerCase() === first.toLocaleLowerCase()).length > 1;
  const last = words[words.length - 1];
  return duplicate ? first + " " + last.slice(0, (last.codePointAt(0) || 0) > 0xffff ? 2 : 1).toUpperCase() + "." : first;
}
