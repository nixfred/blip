// message-actions.ts
function quoteText(message) {
  if (message.retracted)
    return "";
  return String(message.text || message.link?.url || "").replace(/\s+/g, " ").trim();
}
function quotedDraft(message, draft) {
  const text = quoteText(message);
  if (!text)
    return draft;
  const points = Array.from(text);
  const excerpt = points.length > 200 ? points.slice(0, 200).join("") + "…" : text;
  return "> " + excerpt + `

` + draft;
}
function canReply(message, group) {
  if (!message || group || !String(message.guid || ""))
    return false;
  if (message.retracted || message.audio || message.pending || message.failed || message.scheduled || message.link)
    return false;
  const text = String(message.text || "").trim();
  const files = message.attachments ?? [];
  if (files.length === 0)
    return text !== "" && !/:\/\/|\bwww\./i.test(text);
  const only = files[0];
  return files.length === 1 && text === "" && !only.sticker && String(only.mime || "").toLowerCase().startsWith("image/");
}
function replyTarget(message) {
  const attachment = (message.attachments ?? [])[0] ?? null;
  return {
    guid: String(message.guid || ""),
    text: quoteText(message) || (attachment ? "Photo" : ""),
    mine: message.from_me === true,
    name: String(message.name || ""),
    attachment
  };
}
function bubbleIndexByGuid(bubbles, guid) {
  if (!guid)
    return -1;
  return (bubbles || []).findIndex((b) => String(b?.guid || "") === guid);
}
function saveableMime(mime) {
  const m = String(mime || "").toLowerCase();
  return m.startsWith("image/") || m.startsWith("video/") || m.startsWith("audio/") || m === "application/pdf" || m === "text/plain" || m === "text/vcard" || m === "text/calendar";
}
function attachmentActions(att) {
  const id = String(att?.id ?? "");
  if (!id)
    return { open: false, copy: false, save: false, saveLabel: "" };
  const image = String(att?.mime || "").toLowerCase().startsWith("image/");
  return { open: true, copy: image, save: saveableMime(att?.mime), saveLabel: image ? "Save image…" : "Save…" };
}
export {
  attachmentActions,
  bubbleIndexByGuid,
  canReply,
  quoteText,
  quotedDraft,
  replyTarget,
  saveableMime
};
