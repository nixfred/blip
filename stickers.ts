/** Sticker wire normalization and layout. No files, processes, or message state.
 * Regenerate the QML module: bun build stickers.ts --target=browser --format=esm --outfile=Stickers.mjs
 */
import type { AttachmentMeta } from "./collector";

export interface StickerPlacement {
  /** Center as a fraction of the target bubble's dimensions. */
  x: number;
  y: number;
  scale: number;
  /** Clockwise radians, as stored by Messages. */
  rotation: number;
  parentWidth?: number;
}
export interface StickerMetadata {
  source: "memoji" | "genmoji" | "user" | "app" | "unknown";
  label: string;
  app_name?: string;
  animated?: boolean;
  placement?: StickerPlacement;
}
export interface StickerOverlay {
  attachment: AttachmentMeta;
  guid: string;
  part: number;
  from_me: boolean;
  by: string | null;
  ts: string;
  placement?: StickerPlacement;
}

/** Protect the render tree from a very long history of decorations on one message. */
export const MAX_VISIBLE_STICKERS = 24;
const sources = new Set(["memoji", "genmoji", "user", "app", "unknown"]);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const label = (value: unknown, max = 160): string =>
  typeof value === "string" ? value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, max) : "";

export function normalizeStickerPlacement(value: unknown): StickerPlacement | undefined {
  if (!record(value) || !finite(value.x, -3, 3) || !finite(value.y, -3, 3)
      || !finite(value.scale, 0.1, 4) || !finite(value.rotation, -Math.PI * 2, Math.PI * 2)) return undefined;
  return Object.assign({ x: value.x, y: value.y, scale: value.scale, rotation: value.rotation },
    finite(value.parentWidth, 1, 10000) ? { parentWidth: value.parentWidth } : {});
}

export function normalizeStickerMetadata(value: unknown): StickerMetadata | undefined {
  if (!record(value)) return undefined;
  const placement = normalizeStickerPlacement(value.placement);
  const app = label(value.app_name, 80);
  return Object.assign({
    source: typeof value.source === "string" && sources.has(value.source) ? value.source as StickerMetadata["source"] : "unknown",
    label: label(value.label) || "Sticker",
    animated: value.animated === true,
  }, app ? { app_name: app } : {}, placement ? { placement } : {});
}

/** Ordinary transparent PNGs remain ordinary images: sticker attribution is explicit. */
export function normalizeStickerAttachment(attachment: AttachmentMeta): AttachmentMeta {
  const sticker = normalizeStickerMetadata(attachment.sticker);
  if (sticker) return Object.assign({}, attachment, { sticker });
  const plain = Object.assign({}, attachment);
  delete plain.sticker;
  return plain;
}

export function normalizeStickerOverlays(value: unknown): { stickers: StickerOverlay[]; overflow: number } {
  if (!Array.isArray(value)) return { stickers: [], overflow: 0 };
  const valid: StickerOverlay[] = [];
  const identities = new Set<string>();
  let total = 0;
  for (const raw of value) {
    if (!record(raw) || !record(raw.attachment)) continue;
    const a = raw.attachment;
    const sticker = normalizeStickerMetadata(a.sticker);
    if (!sticker) continue;
    const id = typeof a.id === "string" && /^[0-9]{1,18}$/.test(a.id) ? a.id : "";
    const guid = label(raw.guid, 128);
    const key = `${guid}\0${id}`;
    // A missing-media placeholder still needs its message identity to avoid
    // merging unrelated unloaded stickers. Blank identities are not deduped.
    if ((guid || id) && identities.has(key)) continue;
    if (guid || id) identities.add(key);
    total++;
    if (valid.length >= MAX_VISIBLE_STICKERS) continue;
    const placement = normalizeStickerPlacement(raw.placement) ?? sticker.placement;
    valid.push(Object.assign({
      attachment: {
        id, name: label(a.name, 256) || "Sticker",
        mime: typeof a.mime === "string" ? a.mime.slice(0, 100) : null,
        bytes: finite(a.bytes, 0, Number.MAX_SAFE_INTEGER) ? a.bytes : null,
        sticker,
      },
      guid,
      part: finite(raw.part, 0, 999999) && Number.isInteger(raw.part) ? raw.part : 0,
      from_me: raw.from_me === true,
      by: label(raw.by, 160) || null,
      ts: typeof raw.ts === "string" ? raw.ts : "",
    }, placement ? { placement } : {}));
  }
  return { stickers: valid, overflow: Math.max(0, total - valid.length) };
}

/** A self-thread can store decoration on either echo. Preserve both, once. */
export function mergeStickers(a?: StickerOverlay[] | null, b?: StickerOverlay[] | null): StickerOverlay[] | undefined {
  const all = [...(a ?? []), ...(b ?? [])];
  if (!all.length) return undefined;
  const seen = new Set<string>();
  return all.filter(s => {
    const key = `${s.guid}\0${s.attachment?.id ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Body-part 0 is the only safely addressable part without attributed-body
 * range mapping. The renderer anchors it to text, or the first attachment.
 */
export function placedStickers(stickers: StickerOverlay[] | undefined): StickerOverlay[] {
  return (stickers ?? []).filter(s => s.part === 0 && !!normalizeStickerPlacement(s.placement));
}

export function unplacedStickers(stickers: StickerOverlay[] | undefined): StickerOverlay[] {
  return (stickers ?? []).filter(s => s.part !== 0 || !normalizeStickerPlacement(s.placement));
}

/** A compact decoration stays bounded even when metadata claims huge scaling.
 * Unknown placement gets a readable row below the bubble, never a guessed
 * position obscuring its text. The renderer chooses the target body part.
 */
export function stickerGeometry(placement: StickerPlacement | undefined, width: number, height: number,
                                naturalWidth = 64, naturalHeight = 64):
    { x: number; y: number; width: number; height: number; rotation: number; placed: boolean } {
  const w = finite(width, 1, 10000) ? width : 64;
  const h = finite(height, 1, 10000) ? height : 64;
  const nw = finite(naturalWidth, 1, 100000) ? naturalWidth : 64;
  const nh = finite(naturalHeight, 1, 100000) ? naturalHeight : 64;
  const p = normalizeStickerPlacement(placement);
  const scale = p?.scale ?? 1;
  const longEdge = Math.min(Math.max(40 * scale, 24), 120, w);
  let sw = nw >= nh ? longEdge : longEdge * nw / nh;
  let sh = nh >= nw ? longEdge : longEdge * nh / nw;
  const angle = p?.rotation ?? 0;
  const cos = Math.abs(Math.cos(angle)), sin = Math.abs(Math.sin(angle));
  let bw = sw * cos + sh * sin, bh = sh * cos + sw * sin;
  const fit = Math.min(1, w / bw, h / bh);
  sw *= fit; sh *= fit; bw *= fit; bh *= fit;
  const insetX = (bw - sw) / 2, insetY = (bh - sh) / 2;
  return {
    // Sender offsets can sit outside the native bubble. Clamp to our target
    // so they cannot escape the panel or cover another message's actions.
    // Rotation is around the image center; clamp its rotated bounding box,
    // not just the unrotated image, to the target. parentWidth is preserved
    // as provenance but native point-for-point scale is intentionally not
    // reproduced in a much narrower Linux bubble.
    x: p ? Math.max(insetX, Math.min(w - sw - insetX, p.x * w - sw / 2)) : 0,
    y: p ? Math.max(insetY, Math.min(h - sh - insetY, p.y * h - sh / 2)) : 0,
    width: sw, height: sh, rotation: p ? p.rotation * 180 / Math.PI : 0, placed: !!p,
  };
}
