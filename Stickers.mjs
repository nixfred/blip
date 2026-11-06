// stickers.ts
var MAX_VISIBLE_STICKERS = 24;
var sources = new Set(["memoji", "genmoji", "user", "app", "unknown"]);
var record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
var finite = (value, min, max) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
var label = (value, max = 160) => typeof value === "string" ? value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, max) : "";
function normalizeStickerPlacement(value) {
  if (!record(value) || !finite(value.x, -3, 3) || !finite(value.y, -3, 3) || !finite(value.scale, 0.1, 4) || !finite(value.rotation, -Math.PI * 2, Math.PI * 2))
    return;
  return Object.assign({ x: value.x, y: value.y, scale: value.scale, rotation: value.rotation }, finite(value.parentWidth, 1, 1e4) ? { parentWidth: value.parentWidth } : {});
}
function normalizeStickerMetadata(value) {
  if (!record(value))
    return;
  const placement = normalizeStickerPlacement(value.placement);
  const app = label(value.app_name, 80);
  return Object.assign({
    source: typeof value.source === "string" && sources.has(value.source) ? value.source : "unknown",
    label: label(value.label) || "Sticker",
    animated: value.animated === true
  }, app ? { app_name: app } : {}, placement ? { placement } : {});
}
function normalizeStickerAttachment(attachment) {
  const sticker = normalizeStickerMetadata(attachment.sticker);
  if (sticker)
    return Object.assign({}, attachment, { sticker });
  const plain = Object.assign({}, attachment);
  delete plain.sticker;
  return plain;
}
function normalizeStickerOverlays(value) {
  if (!Array.isArray(value))
    return { stickers: [], overflow: 0 };
  const valid = [];
  const identities = new Set;
  let total = 0;
  for (const raw of value) {
    if (!record(raw) || !record(raw.attachment))
      continue;
    const a = raw.attachment;
    const sticker = normalizeStickerMetadata(a.sticker);
    if (!sticker)
      continue;
    const id = typeof a.id === "string" && /^[0-9]{1,18}$/.test(a.id) ? a.id : "";
    const guid = label(raw.guid, 128);
    const key = `${guid}\x00${id}`;
    if ((guid || id) && identities.has(key))
      continue;
    if (guid || id)
      identities.add(key);
    total++;
    if (valid.length >= MAX_VISIBLE_STICKERS)
      continue;
    const placement = normalizeStickerPlacement(raw.placement) ?? sticker.placement;
    valid.push(Object.assign({
      attachment: {
        id,
        name: label(a.name, 256) || "Sticker",
        mime: typeof a.mime === "string" ? a.mime.slice(0, 100) : null,
        bytes: finite(a.bytes, 0, Number.MAX_SAFE_INTEGER) ? a.bytes : null,
        sticker
      },
      guid,
      part: finite(raw.part, 0, 999999) && Number.isInteger(raw.part) ? raw.part : 0,
      from_me: raw.from_me === true,
      by: label(raw.by, 160) || null,
      ts: typeof raw.ts === "string" ? raw.ts : ""
    }, placement ? { placement } : {}));
  }
  return { stickers: valid, overflow: Math.max(0, total - valid.length) };
}
function mergeStickers(a, b) {
  const all = [...a ?? [], ...b ?? []];
  if (!all.length)
    return;
  const seen = new Set;
  return all.filter((s) => {
    const key = `${s.guid}\x00${s.attachment?.id ?? ""}`;
    if (seen.has(key))
      return false;
    seen.add(key);
    return true;
  });
}
function placedStickers(stickers) {
  return (stickers ?? []).filter((s) => s.part === 0 && !!normalizeStickerPlacement(s.placement));
}
function unplacedStickers(stickers) {
  return (stickers ?? []).filter((s) => s.part !== 0 || !normalizeStickerPlacement(s.placement));
}
function stickerGeometry(placement, width, height, naturalWidth = 64, naturalHeight = 64) {
  const w = finite(width, 1, 1e4) ? width : 64;
  const h = finite(height, 1, 1e4) ? height : 64;
  const nw = finite(naturalWidth, 1, 1e5) ? naturalWidth : 64;
  const nh = finite(naturalHeight, 1, 1e5) ? naturalHeight : 64;
  const p = normalizeStickerPlacement(placement);
  const scale = p?.scale ?? 1;
  const longEdge = Math.min(Math.max(40 * scale, 24), 120, w);
  let sw = nw >= nh ? longEdge : longEdge * nw / nh;
  let sh = nh >= nw ? longEdge : longEdge * nh / nw;
  const angle = p?.rotation ?? 0;
  const cos = Math.abs(Math.cos(angle)), sin = Math.abs(Math.sin(angle));
  let bw = sw * cos + sh * sin, bh = sh * cos + sw * sin;
  const fit = Math.min(1, w / bw, h / bh);
  sw *= fit;
  sh *= fit;
  bw *= fit;
  bh *= fit;
  const insetX = (bw - sw) / 2, insetY = (bh - sh) / 2;
  return {
    x: p ? Math.max(insetX, Math.min(w - sw - insetX, p.x * w - sw / 2)) : 0,
    y: p ? Math.max(insetY, Math.min(h - sh - insetY, p.y * h - sh / 2)) : 0,
    width: sw,
    height: sh,
    rotation: p ? p.rotation * 180 / Math.PI : 0,
    placed: !!p
  };
}
export {
  MAX_VISIBLE_STICKERS,
  mergeStickers,
  normalizeStickerAttachment,
  normalizeStickerMetadata,
  normalizeStickerOverlays,
  normalizeStickerPlacement,
  placedStickers,
  stickerGeometry,
  unplacedStickers
};
