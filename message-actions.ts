// Pure message helpers (quotation, the selected bubble, attachment menu rows), shared with the QML renderer.
// Rebuild: bun build message-actions.ts --target browser --format esm --outfile MessageActions.mjs
export interface QuotableMessage {
  text?: string;
  link?: { url?: string } | null;
  retracted?: boolean;
}

export function quoteText(message: QuotableMessage): string {
  if (message.retracted) return "";
  return String(message.text || message.link?.url || "").replace(/\s+/g, " ").trim();
}

/** Keep the existing short quotation convention, with a visible truncation mark.
 * The user's draft is retained byte-for-byte after the quotation. */
export function quotedDraft(message: QuotableMessage, draft: string): string {
  const text = quoteText(message);
  if (!text) return draft;
  const points = Array.from(text);
  const excerpt = points.length > 200 ? points.slice(0, 200).join("") + "…" : text;
  return "> " + excerpt + "\n\n" + draft;
}

/** Where the selected bubble is after a reload: the row with the same guid,
 *  or -1 when it is gone or has none. A reload renumbers the rows, and a
 *  tapback landing on the selected bubble is itself a reload. */
export function bubbleIndexByGuid(bubbles: { guid?: string }[], guid: string): number {
  if (!guid) return -1;
  return (bubbles || []).findIndex((b) => String(b?.guid || "") === guid);
}

export interface MenuAttachment {
  id?: string | number;
  mime?: string;
}
export interface AttachmentActions {
  /** Open: the same fetch-then-open path a click takes (openableMime still gates xdg-open). */
  open: boolean;
  /** Copy image: the picture itself on the clipboard, as Ctrl+C does for a picture bubble. */
  copy: boolean;
  /** Save…: a copy of the fetched original at a place the user picks. */
  save: boolean;
  saveLabel: string;
}

/** Only what Blip would hand to xdg-open is offered for saving: media,
 *  PDF and the plain text/vCard/calendar types. The same list as
 *  openableMime in BlipView, so anything a sender could make executable is
 *  never written out under a name of their choosing. */
export function saveableMime(mime: unknown): boolean {
  const m = String(mime || "").toLowerCase();
  return m.startsWith("image/") || m.startsWith("video/") || m.startsWith("audio/") ||
    m === "application/pdf" || m === "text/plain" || m === "text/vcard" || m === "text/calendar";
}

/** The menu rows for a right-clicked attachment. No attachment, no rows. */
export function attachmentActions(att: MenuAttachment | null | undefined): AttachmentActions {
  const id = String(att?.id ?? "");
  if (!id) return { open: false, copy: false, save: false, saveLabel: "" };
  const image = String(att?.mime || "").toLowerCase().startsWith("image/");
  return { open: true, copy: image, save: saveableMime(att?.mime), saveLabel: image ? "Save image…" : "Save…" };
}
