#!/usr/bin/env bun
/**
 * Blip attachment fetcher — pulls one attachment's bytes from the Mac into
 * the local media cache and prints {ok, path, url} JSON for QML.
 *
 *   bun fetch.ts <attachment-id> <name> <mime>
 *
 * The cache DELIBERATELY relaxes the "no message content on disk" invariant,
 * scoped to media (Fred's call, 2026-08-31): the disk is LUKS-encrypted at
 * rest, so plain files under ~/.cache/blip/att (dir 0700, files 0600) are
 * acceptable. state.json still never holds content.
 *
 * Cache key = <id>-<transform>-<sanitized name>: the transform distinguishes
 * a sips-converted JPEG from the original so the two never collide. LRU by
 * mtime (touched on every hit — atime is unreliable under relatime), capped
 * at 500 MB, evicted after each write.
 */

import { analyzeAudio, type AudioMetadata } from "./audio-metadata";
import { shimPath } from "./shim-path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  lstatSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HOME = process.env.HOME ?? homedir();
export const CACHE_DIR = join(process.env.XDG_CACHE_HOME ?? join(HOME, ".cache"), "blip", "att");
export const CACHE_CAP_BYTES = 500 * 1024 * 1024;
export const FETCH_MAX_BYTES = 100 * 1024 * 1024;
const IMAGE_HEADER_BYTES = 64 * 1024;

/** Long edge for an auto-fetched inline preview. The bubble decodes at 800;
 *  1600 keeps it crisp on a HiDPI panel and still lands well under any cap. */
export const PREVIEW_MAX_DIM = 1600;

/** HEIC needs converting on the Mac (sips) — Linux has no decoder. */
export function wantsJpeg(mime: string): boolean {
  return mime === "image/heic" || mime === "image/heif";
}

/** HEIC stickers need alpha-preserving PNG, including a still fallback for
 * Live Sticker sequences that sips cannot export as an animation. */
export function wantsStickerPng(mime: string): boolean {
  return ["image/heic", "image/heif", "image/heics", "image/heic-sequence", "image/heif-sequence"].includes(String(mime || "").toLowerCase());
}

/**
 * Formats whose whole point is that they MOVE.
 *
 * The inline preview path asks the Mac to resample with sips, which flattens
 * an animated GIF to a single frame — a 1.4 MB animation arrived as a 198 KB
 * still. So these never take that path: they cross as their original bytes,
 * capped like any other auto-fetch, and land in the shared `orig` cache slot.
 */
export function isAnimatedMime(mime: string): boolean {
  return String(mime || "").toLowerCase() === "image/gif";
}

/** Anything the panel would draw inline. */
export function isImageMime(mime: string): boolean {
  return String(mime || "").startsWith("image/");
}

export function sanitizeName(name: string): string {
  const base = (name || "file").replace(/[^\p{L}\p{N}._-]/gu, "_").slice(0, 100);
  return base.replace(/^[._]+/, "") || "file";
}

/** The extension xdg-open dispatches on comes from the MIME we gated on, never
 *  from the sender's filename: "image/png" + "evil.desktop" caches as .png. */
const MIME_EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
  "image/apng": "png",
  "image/heic": "jpg", "image/heif": "jpg", "image/tiff": "tiff", "image/bmp": "bmp",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/x-m4v": "m4v",
  "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/amr": "amr",
  // An iPhone voice message is Opus inside Apple's CAF container. Nothing on
  // Linux registers .caf (shared-mime-info reads it as octet-stream, so
  // xdg-open had no handler), so fetch rewraps it as Ogg: see rewrapCaf.
  "audio/x-caf": "ogg",
  "application/pdf": "pdf", "text/plain": "txt", "text/vcard": "vcf", "text/calendar": "ics",
};
export function cacheFileName(id: string, name: string, mime: string, preview = false, sticker = false): string {
  // Three transforms, never colliding: `orig` is the untouched file, `jpg` a
  // sips HEIC→JPEG at full size, `prev` a resampled inline preview. A preview
  // is ALWAYS JPEG whatever the source was, so its extension is too —
  // xdg-open dispatches on extension, and a JPEG inside a .png would be a lie
  // (war room #49).
  const png = sticker && wantsStickerPng(mime);
  const transform = png ? "png" : preview ? "prev" : wantsJpeg(mime) ? "jpg" : "orig";
  let base = sanitizeName(name);
  // The extension is ALWAYS ours. An unmapped type (image/svg+xml, anything
  // exotic) used to keep the sender's name — "evil.desktop" with an image MIME
  // passed the opening gate and reached xdg-open by extension (Astra B#1).
  const ext = png ? "png" : preview ? "jpg" : (MIME_EXT[String(mime || "").toLowerCase()] ?? "bin");
  base = base.replace(/\.[^.]{1,8}$/, "") + "." + ext;
  return `${id}-${transform}-${base}`;
}

/** Oldest-mtime files to delete so the cache fits the cap. Pure for tests. */
export function lruEvictions(
  entries: { name: string; bytes: number; mtimeMs: number }[],
  cap: number,
  keep: string,
): string[] {
  let total = entries.reduce((s, e) => s + e.bytes, 0);
  const out: string[] = [];
  for (const e of [...entries].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= cap) break;
    if (e.name === keep) continue;
    out.push(e.name);
    total -= e.bytes;
  }
  return out;
}

export interface ImageMetrics {
  pixelWidth: number;
  pixelHeight: number;
  pixelRatio: number;
}

const EMPTY_IMAGE_METRICS: ImageMetrics = { pixelWidth: 0, pixelHeight: 0, pixelRatio: 1 };

function densityRatio(xDpi: number, yDpi: number): number {
  if (!Number.isFinite(xDpi) || !Number.isFinite(yDpi) || xDpi <= 0 || yDpi <= 0)
    return 1;
  if (Math.abs(xDpi - yDpi) / Math.max(xDpi, yDpi) > 0.05) return 1;
  const ratio = (xDpi + yDpi) / 144;
  const common = [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
  return common.find((value) => Math.abs(value - ratio) <= 0.06) ?? 1;
}

/** Bounded image metadata used only for display sizing; malformed data falls back to 1×. */
export function imageMetrics(bytes: Buffer, mime: string): ImageMetrics {
  if (!String(mime || "").startsWith("image/") || !bytes || bytes.length < 10)
    return { ...EMPTY_IMAGE_METRICS };

  // GIF: "GIF87a"/"GIF89a" then the logical screen size, u16 little-endian.
  // Without this an animated GIF reported 0×0 and the bubble had nothing to
  // size itself from.
  if (bytes.length >= 10 && bytes.toString("ascii", 0, 3) === "GIF") {
    return {
      pixelWidth: bytes.readUInt16LE(6),
      pixelHeight: bytes.readUInt16LE(8),
      pixelRatio: 1,                       // GIF carries no density
    };
  }

  // WebP extended header (including animations), lossless, and lossy.
  if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    const kind = bytes.toString("ascii", 12, 16);
    if (kind === "VP8X") return {
      pixelWidth: bytes.readUIntLE(24, 3) + 1, pixelHeight: bytes.readUIntLE(27, 3) + 1, pixelRatio: 1,
    };
    if (kind === "VP8L" && bytes[20] === 0x2f) return {
      pixelWidth: 1 + (bytes.readUInt32LE(21) & 0x3fff),
      pixelHeight: 1 + ((bytes.readUInt32LE(21) >>> 14) & 0x3fff), pixelRatio: 1,
    };
    if (kind === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return {
      pixelWidth: bytes.readUInt16LE(26) & 0x3fff, pixelHeight: bytes.readUInt16LE(28) & 0x3fff, pixelRatio: 1,
    };
  }

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(png)) {
    const pixelWidth = bytes.readUInt32BE(16);
    const pixelHeight = bytes.readUInt32BE(20);
    let pixelRatio = 1;
    for (let pos = 8; pos + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(pos);
      if (length > IMAGE_HEADER_BYTES || pos + 12 + length > bytes.length) break;
      const type = bytes.toString("ascii", pos + 4, pos + 8);
      if (type === "pHYs" && length === 9 && bytes[pos + 16] === 1) {
        const xDpi = bytes.readUInt32BE(pos + 8) * 0.0254;
        const yDpi = bytes.readUInt32BE(pos + 12) * 0.0254;
        pixelRatio = densityRatio(xDpi, yDpi);
        break;
      }
      if (type === "IDAT" || type === "IEND") break;
      pos += 12 + length;
    }
    return { pixelWidth, pixelHeight, pixelRatio };
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let pixelWidth = 0;
    let pixelHeight = 0;
    let pixelRatio = 1;
    const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    for (let pos = 2; pos + 4 <= bytes.length;) {
      if (bytes[pos] !== 0xff) { pos++; continue; }
      while (pos < bytes.length && bytes[pos] === 0xff) pos++;
      if (pos >= bytes.length) break;
      const marker = bytes[pos++];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (marker === 0xd9 || marker === 0xda || pos + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(pos);
      if (length < 2 || pos + length > bytes.length) break;
      const data = pos + 2;
      if (marker === 0xe0 && length >= 14 && bytes.toString("ascii", data, data + 5) === "JFIF\0") {
        const units = bytes[data + 7];
        const x = bytes.readUInt16BE(data + 8);
        const y = bytes.readUInt16BE(data + 10);
        if (units === 1) pixelRatio = densityRatio(x, y);
        else if (units === 2) pixelRatio = densityRatio(x * 2.54, y * 2.54);
      }
      if (sof.has(marker) && length >= 7) {
        pixelHeight = bytes.readUInt16BE(data + 1);
        pixelWidth = bytes.readUInt16BE(data + 3);
      }
      pos += length;
    }
    return { pixelWidth, pixelHeight, pixelRatio };
  }
  return { ...EMPTY_IMAGE_METRICS };
}

export interface ImageAnimation { animated: boolean; frames: number; format: string }

/** Sticker images bypass JPEG previewing, so do not let a sender use that
 * path to load SVG or another resource-bearing format in the QML renderer. */
export function stickerRasterMime(bytes: Buffer): string {
  if (bytes.length >= 24 && bytes.toString("hex", 0, 8) === "89504e470d0a1a0a"
      && bytes.toString("ascii", 12, 16) === "IHDR") return "image/png";
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 10 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "image/gif";
  if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
      && ["VP8X", "VP8L", "VP8 "].includes(bytes.toString("ascii", 12, 16))) return "image/webp";
  return "";
}

function stickerRasterValid(bytes: Buffer, mime: string): boolean {
  const expected = mime === "image/apng" ? "image/png" : mime;
  if (stickerRasterMime(bytes) !== expected) return false;
  const metrics = imageMetrics(bytes, expected);
  return metrics.pixelWidth > 0 && metrics.pixelHeight > 0 && metrics.pixelWidth <= 2048 && metrics.pixelHeight <= 2048;
}

/** Only inspect bounded container headers. PNG's acTL precedes IDAT. */
export function imageAnimation(bytes: Buffer): ImageAnimation {
  const plain = { animated: false, frames: 1, format: "" };
  if (bytes.length >= 10 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)))
    return { animated: true, frames: 0, format: "gif" };
  if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP")
    return { animated: bytes.toString("ascii", 12, 16) === "VP8X" && (bytes[20]! & 2) !== 0, frames: 0, format: "webp" };
  if (bytes.length < 24 || bytes.toString("hex", 0, 8) !== "89504e470d0a1a0a") return plain;
  for (let pos = 8; pos + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(pos);
    if (length > IMAGE_HEADER_BYTES || pos + 12 + length > bytes.length) break;
    const type = bytes.toString("ascii", pos + 4, pos + 8);
    if (type === "acTL" && length === 8) {
      const frames = bytes.readUInt32BE(pos + 8);
      return { animated: frames > 1, frames, format: "png" };
    }
    if (type === "IDAT" || type === "IEND") break;
    pos += length + 12;
  }
  return { ...plain, format: "png" };
}

/** Qt's PNG reader renders APNG as a still. Convert only the inline sticker
 * preview to lossless animated WebP, preserving alpha. Originals still back
 * explicit Open/Copy/Save; no conversation text enters files or argv. */
export function stickerAnimationPreview(bytes: Buffer, runner = spawnSync, dir = CACHE_DIR): { bytes: Buffer; converted: boolean; unavailable: boolean } {
  const animation = imageAnimation(bytes.subarray(0, IMAGE_HEADER_BYTES));
  if (animation.format !== "png" || !animation.animated) return { bytes, converted: false, unavailable: false };
  const size = imageMetrics(bytes.subarray(0, IMAGE_HEADER_BYTES), "image/png");
  if (animation.frames > 100 || size.pixelWidth <= 0 || size.pixelHeight <= 0
      || size.pixelWidth > 2048 || size.pixelHeight > 2048
      || size.pixelWidth * size.pixelHeight * animation.frames > 64_000_000)
    return { bytes, converted: false, unavailable: true };
  // FFmpeg 6's APNG demuxer asks for input length even with ignore_loop=1;
  // a looping APNG on stdin fails with ENOSYS. Keep one bounded, seekable
  // private media file, as with HEICS, and remove it on every exit path.
  const tmp = join(dir, `.sticker-${process.pid}-${Math.random().toString(36).slice(2, 10)}.apng`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fd = openSync(tmp, "wx", 0o600);
    try { writeSync(fd, bytes); } finally { closeSync(fd); }
    const res = runner("ffmpeg", ["-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-max_pixels", "4194304", "-f", "apng", "-ignore_loop", "1", "-i", tmp,
      "-map_metadata", "-1", "-c:v", "libwebp_anim", "-lossless", "1", "-loop", "0",
      "-frames:v", String(Math.min(100, Math.floor(64_000_000 / (size.pixelWidth * size.pixelHeight)))), "-f", "webp", "pipe:1"],
    { timeout: 30000, maxBuffer: FETCH_MAX_BYTES + (1 << 20) });
    const out = res.stdout as Buffer;
    if (res.status === 0 && Buffer.isBuffer(out) && out.length > 30 && imageAnimation(out).format === "webp")
      return { bytes: out, converted: true, unavailable: false };
  } catch { /* A missing ffmpeg or decoder retains a usable transparent still. */ }
  finally { try { unlinkSync(tmp); } catch { /* no temp file survived */ } }
  return { bytes, converted: false, unavailable: true };
}

interface StickerSequenceResult { bytes: Buffer; renderMime: "image/webp" | "image/png"; unavailable: boolean }

/** Live Stickers use a color track and a separate grayscale alpha track.
 * In HEICS the first pair is the still image; tracks 2/3 are the animation.
 * Probe only container metadata before allowing bounded decode. A private
 * media temp file supplies seekable input (MOV/HEICS often puts moov last).
 */
export function stickerSequencePreview(bytes: Buffer, mime: string, runner = spawnSync, dir = CACHE_DIR): StickerSequenceResult | undefined {
  if (!bytes.length || bytes.length > FETCH_MAX_BYTES) return undefined;
  const tmp = join(dir, `.sticker-${process.pid}-${Math.random().toString(36).slice(2, 10)}.media`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fd = openSync(tmp, "wx", 0o600);
    try { writeSync(fd, bytes); } finally { closeSync(fd); }
    const probe = runner("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe",
      "-show_entries", "stream=index,codec_type,width,height,nb_frames,duration,pix_fmt",
      "-of", "json", "-max_pixels", "4194304", "-f", "mov", "-i", tmp], { timeout: 10000, maxBuffer: 65536 });
    if (probe.status !== 0) return undefined;
    const data = JSON.parse(String(probe.stdout));
    if (!Array.isArray(data.streams) || data.streams.length > 8) return undefined;
    const video = data.streams.filter((s: any) => s.codec_type === "video");
    const heics = wantsStickerPng(mime);
    if (!video.length || (heics && video.length < 4)) return undefined;
    const color = heics ? video[2] : video[0];
    const mask = heics ? video[3] : video.length === 2 && /^gray/.test(video[1].pix_fmt) ? video[1] : null;
    const width = Number(color.width), height = Number(color.height), count = Number(color.nb_frames), seconds = Number(color.duration);
    const validSize = (s: any) => Number.isInteger(s.index) && s.index >= 0 && s.index <= 16
      && Number.isInteger(s.width) && Number.isInteger(s.height) && s.width > 0 && s.height > 0 && s.width <= 2048 && s.height <= 2048;
    if (!validSize(color) || (mask && (!validSize(mask) || mask.width !== width || mask.height !== height || !/^gray/.test(mask.pix_fmt)))) return undefined;
    const animate = Number.isInteger(count) && count > 1 && count <= 100
      && width * height * count <= 64_000_000 && Number.isFinite(seconds) && seconds > 0 && seconds <= 8;
    const filter = mask
      ? `[0:${color.index}][0:${mask.index}]alphamerge,format=rgba[out]`
      : `[0:${color.index}]format=rgba[out]`;
    const output = animate
      ? ["-c:v", "libwebp_anim", "-lossless", "1", "-loop", "0", "-frames:v", String(Math.min(100, Math.floor(64_000_000 / (width * height)))), "-t", "8", "-f", "webp"]
      : ["-c:v", "png", "-frames:v", "1", "-f", "image2pipe"];
    const result = runner("ffmpeg", ["-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe",
      "-threads", "1", "-max_pixels", "4194304", "-f", "mov", "-i", tmp, "-filter_complex_threads", "1", "-filter_complex", filter,
      "-map", "[out]", "-an", "-map_metadata", "-1", ...output, "pipe:1"],
    { timeout: 30000, maxBuffer: FETCH_MAX_BYTES + (1 << 20) });
    const out = result.stdout as Buffer;
    if (result.status !== 0 || !Buffer.isBuffer(out) || out.length > FETCH_MAX_BYTES) return undefined;
    const format = imageAnimation(out).format;
    if ((animate && format !== "webp") || (!animate && format !== "png")) return undefined;
    return { bytes: out, renderMime: animate ? "image/webp" : "image/png", unavailable: !animate };
  } catch { return undefined; }
  finally { try { unlinkSync(tmp); } catch { /* no temp file survived */ } }
}

function cachedImageMetrics(path: string, mime: string): ImageMetrics & { animated: boolean; animationUnavailable: boolean; rasterMime: string } {
  const empty = { ...EMPTY_IMAGE_METRICS, animated: false, animationUnavailable: false, rasterMime: "" };
  let fd = -1;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid() || st.size <= 0) return empty;
    const header = Buffer.alloc(Math.min(st.size, IMAGE_HEADER_BYTES));
    const count = readSync(fd, header, 0, header.length, 0);
    const bytes = header.subarray(0, count);
    const animation = imageAnimation(bytes);
    return { ...imageMetrics(bytes, mime), animated: animation.animated && animation.format !== "png",
      animationUnavailable: animation.animated && animation.format === "png", rasterMime: stickerRasterMime(bytes) };
  } catch {
    return empty;
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

function cachedMediaBytes(path: string, cap: number): Buffer | undefined {
  let fd = -1;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.size <= 0 || stat.size > cap) return undefined;
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!n) return undefined;
      offset += n;
    }
    return bytes;
  } catch { return undefined; }
  finally { if (fd >= 0) closeSync(fd); }
}

function evict(keep: string): void {
  let entries: { name: string; bytes: number; mtimeMs: number }[] = [];
  try {
    entries = [];
    for (const name of readdirSync(CACHE_DIR)) {
      // per entry: one dangling symlink used to abort the whole pass (Astra B#9)
      try {
        const st = lstatSync(join(CACHE_DIR, name));
        if (st.isFile()) entries.push({ name, bytes: st.size, mtimeMs: st.mtimeMs });
      } catch { /* vanished or unreadable: not ours to count */ }
    }
  } catch {
    return;
  }
  for (const name of lruEvictions(entries, CACHE_CAP_BYTES, keep)) {
    try { unlinkSync(join(CACHE_DIR, name)); } catch { /* viewer may hold it; next pass */ }
  }
}

/** EXIF orientation (1–8) of a JPEG, or 1 when absent or unparseable. Walks
 *  the marker chain only as far as the first APP1 Exif segment and never
 *  decodes pixels. Pure, bounds-checked at every read. */
export function exifOrientation(b: Buffer): number {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) return 1;
    const marker = b[p + 1];
    if (marker === 0xff) { p += 1; continue; }                       // fill byte
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { p += 2; continue; }  // standalone
    if (marker === 0xda || marker === 0xd9) return 1;                // scan data / EOI: no EXIF ahead
    const len = b.readUInt16BE(p + 2);
    if (len < 2 || p + 2 + len > b.length) return 1;
    if (marker === 0xe1 && len >= 16 && b.toString("latin1", p + 4, p + 10) === "Exif\0\0") {
      return tiffOrientation(b.subarray(p + 10, p + 2 + len));
    }
    p += 2 + len;
  }
  return 1;
}

function tiffOrientation(t: Buffer): number {
  if (t.length < 8) return 1;
  const bo = t.toString("latin1", 0, 2);
  const le = bo === "II";
  if (!le && bo !== "MM") return 1;
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  if (u16(2) !== 0x2a) return 1;
  const ifd = u32(4);
  if (ifd + 2 > t.length) return 1;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > t.length) return 1;
    if (u16(e) === 0x0112) {
      if (u16(e + 2) !== 3) return 1;   // must be a SHORT
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

/** The lossless jpegtran operation that undoes an EXIF orientation, or null
 *  when the image is already upright (1) or the tag is nonsense. */
export function jpegtranArgs(orientation: number): string[] | null {
  switch (orientation) {
    case 2: return ["-flip", "horizontal"];
    case 3: return ["-rotate", "180"];
    case 4: return ["-flip", "vertical"];
    case 5: return ["-transpose"];
    case 6: return ["-rotate", "90"];
    case 7: return ["-transverse"];
    case 8: return ["-rotate", "270"];
    default: return null;
  }
}

/** Bake an EXIF orientation into the pixels so the cached file is upright in
 *  EVERY consumer, not just Qt: a photo taken in portrait arrives from the
 *  Mac as landscape pixels plus a "rotate 90" tag (sips keeps the tag when
 *  it converts HEIC), and imv — Omarchy's default viewer — ignores EXIF.
 *  jpegtran (libjpeg-turbo, a hard dependency of Qt so always installed) does
 *  the transform losslessly on stdin→stdout; `-copy icc` keeps the colour
 *  profile (iPhone photos are Display P3) and drops the EXIF block, so no
 *  stale orientation tag survives to double-rotate in Qt. The same library
 *  decodes these bytes in the panel anyway, so this adds no attack surface.
 *  Any failure (no jpegtran, bad stream) keeps the original bytes — the
 *  panel's autoTransform still shows those upright. */
export function bakeOrientation(bytes: Buffer, runner = spawnSync): Buffer {
  const op = jpegtranArgs(exifOrientation(bytes));
  if (!op) return bytes;
  // `-copy icc` keeps the colour profile (libjpeg-turbo ≥ 2.1, every Omarchy
  // box). An older jpegtran rejects the option and exits non-zero — retry
  // with `-copy none` so the photo is at least upright; only if that fails
  // too do the original bytes go into the cache (Qt's autoTransform still
  // shows them upright).
  for (const copy of ["icc", "none"]) {
    let res: { status: number | null; stdout: Buffer | string };
    try {
      res = runner("jpegtran", [...op, "-trim", "-copy", copy], {
        input: bytes,
        timeout: 30000,
        maxBuffer: FETCH_MAX_BYTES + (1 << 20),
      });
    } catch {
      return bytes;
    }
    const out = res.stdout as Buffer;
    if (res.status === 0 && out && out.length >= 4 && out[0] === 0xff && out[1] === 0xd8) return out;
  }
  return bytes;
}

export interface FetchResult {
  audio?: AudioMetadata;
  ok: boolean;
  online: boolean;
  path: string;
  url: string;
  error: string;
  pixelWidth: number;
  pixelHeight: number;
  pixelRatio: number;
  /** Actual cached bytes, for clipboard MIME and sticker render selection. */
  renderMime: string;
  animated: boolean;
  /** A transparent still is available, but its source animation could not be decoded. */
  animationUnavailable: boolean;
  /** Real decoded envelope, kept in memory; absent for non-audio media. */
}

/** An iPhone voice message (CAF, Opus inside) → Ogg Opus, so the default
 *  audio player opens it. Measured on a real one (2026-09-26): ffmpeg cannot
 *  read CAF from a pipe (the packet table sits at the END: "Missing packet
 *  table"), and a stream copy fails too (Apple's Opus carries no OpusHead:
 *  "No extradata present"), so the bytes go to a private temp file in the
 *  0700 cache dir and are re-encoded at 48 kb/s. The temp file is always
 *  removed. Any failure (no ffmpeg, an unreadable stream, output that is not
 *  Ogg) keeps the original bytes: mpv still probes content, it just arrives
 *  under an .ogg name. */
export function rewrapCaf(bytes: Buffer, runner = spawnSync, dir = CACHE_DIR): Buffer {
  const tmp = join(dir, `.caf-${process.pid}-${Math.random().toString(36).slice(2, 10)}.caf`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fd = openSync(tmp, "wx", 0o600);
    try { writeSync(fd, bytes); } finally { closeSync(fd); }
    const res = runner("ffmpeg", [
      "-v", "error", "-f", "caf", "-i", tmp, "-vn", "-map_metadata", "-1",
      "-c:a", "libopus", "-b:a", "48k", "-f", "ogg", "pipe:1",
    ], { timeout: 60000, maxBuffer: FETCH_MAX_BYTES + (1 << 20) });
    const out = res.stdout as Buffer | undefined;
    if (res.status === 0 && out && out.length > 4 && out.subarray(0, 4).toString("latin1") === "OggS") return out;
  } catch { /* keep the original */ } finally {
    try { unlinkSync(tmp); } catch { /* never written */ }
  }
  return bytes;
}

export function fetchAttachment(
  id: string,
  name: string,
  mime: string,
  runner = spawnSync,
  maxBytes = FETCH_MAX_BYTES,
  sticker = false,
): FetchResult {
  const fail = (error: string, online = true): FetchResult =>
    ({ ok: false, online, path: "", url: "", error, ...EMPTY_IMAGE_METRICS,
       renderMime: "", animated: false, animationUnavailable: false });

  if (!/^[0-9]{1,18}$/.test(id)) return fail("bad attachment id");
  mime = String(mime || "").toLowerCase();
  if (sticker && !["image/png", "image/apng", "image/jpeg", "image/gif", "image/webp"].includes(mime)
      && !wantsStickerPng(mime) && !mime.startsWith("video/")) return fail("unsupported sticker media format");
  mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });

  const auto = maxBytes < FETCH_MAX_BYTES;
  const preview = auto && isImageMime(mime) && !isAnimatedMime(mime) && !sticker;
  const png = sticker && wantsStickerPng(mime);
  const animatedPreview = sticker && auto && ["image/png", "image/apng"].includes(mime.toLowerCase());
  const sequencePreview = sticker && auto && (mime.toLowerCase().startsWith("video/")
    || (png && !["image/heic", "image/heif"].includes(mime.toLowerCase())));
  const rawFile = join(CACHE_DIR, cacheFileName(id, name, mime, preview, sticker));
  const animationFile = join(CACHE_DIR, cacheFileName(id, name, "image/webp").replace(`${id}-orig-`, `${id}-anim-`));
  const stillFile = join(CACHE_DIR, cacheFileName(id, name, "image/png").replace(`${id}-orig-`, `${id}-still-`));
  const failedFile = stillFile + ".failed";
  if (sequencePreview && cachedMediaBytes(failedFile, 16)?.toString() === "unavailable") {
    try { if (Date.now() - lstatSync(failedFile).mtimeMs < 3600000) return fail("sticker preview unavailable; open the original attachment"); } catch {}
  }
  let file = rawFile;
  let cachedRaw: Buffer | undefined;
  let renderMime = png ? "image/png" : preview || wantsJpeg(mime) ? "image/jpeg" : mime;
  const sequenceStill = png && !["image/heic", "image/heif"].includes(mime.toLowerCase());
  const candidates = sequencePreview ? [animationFile, stillFile].concat(png ? [rawFile] : [])
    : animatedPreview ? [animationFile, stillFile, rawFile] : [rawFile];
  for (const candidate of candidates) try {
    const st = lstatSync(candidate);
    // A symlink planted in the cache must never be followed (or touched).
    if (st.isFile() && st.size > 0 && st.size <= (sticker ? Math.min(maxBytes, FETCH_MAX_BYTES) : FETCH_MAX_BYTES)) {
      const now = new Date();
      utimesSync(candidate, now, now); // mtime is the LRU clock
      const cachedMime = candidate === animationFile ? "image/webp" : candidate === stillFile ? "image/png" : renderMime;
      const { rasterMime, ...metrics } = cachedImageMetrics(candidate, cachedMime);
      if (sticker && !cachedMime.startsWith("video/") && (rasterMime !== (cachedMime === "image/apng" ? "image/png" : cachedMime)
          || metrics.pixelWidth <= 0 || metrics.pixelHeight <= 0 || metrics.pixelWidth > 2048 || metrics.pixelHeight > 2048))
        return fail("sticker media is not a supported bounded raster image");
      if (animatedPreview && candidate === rawFile && metrics.animationUnavailable) {
        cachedRaw = cachedMediaBytes(candidate, Math.min(maxBytes, FETCH_MAX_BYTES));
        if (cachedRaw) break; // convert an already cached APNG without another bridge read
      }
      const audio = String(mime).toLowerCase().startsWith("audio/") ? analyzeAudio(candidate, runner) : undefined;
      if (audio) evict(candidate.slice(candidate.lastIndexOf("/") + 1));
      return {
        ...(audio ? {audio} : {}),
        ok: true, online: true, path: candidate, url: pathToFileURL(candidate).href, error: "",
        renderMime: cachedMime, ...metrics,
        animationUnavailable: candidate !== animationFile && (sequenceStill || candidate === stillFile || metrics.animationUnavailable),
      };
    }
  } catch { /* not cached */ }

  // An auto-fetch is for the inline bubble, which draws at ~800 px. Ask the
  // Mac to resample rather than shipping a full-resolution frame: sips turns a
  // 5 MB HEIC into a 7.8 MB JPEG, so the transfer ceiling was rejecting the
  // very photos it was meant to let through. A click has no cap and still
  // fetches the original.
  // Every image, not just HEIC: a 12 MP PNG shipped raw is just as slow, and
  // the preview lands in its own cache slot (`<id>-prev-…`) so a click can
  // still fetch the untouched original into `<id>-orig-…`.
  const args = [
    "attachment", id,
    ...(png && !sequencePreview ? ["--png"] : !sequencePreview && (wantsJpeg(mime) || preview) ? ["--jpeg"] : []),
    ...(png && !sequencePreview ? ["--max-dim", "2048"] : preview ? ["--max-dim", String(PREVIEW_MAX_DIM)] : []),
  ];
  const res = cachedRaw ? { status: 0, stdout: cachedRaw, stderr: "" } : runner(shimPath("imsg"), args, {
    timeout: 120000,
    maxBuffer: FETCH_MAX_BYTES + (1 << 20),
  });
  if (res.status === 69 || res.status === 255) return fail("Mac unreachable", false);
  if (res.status !== 0) {
    const err = (res.stderr || "").toString().trim().split("\n")[0] || `imsg exit ${res.status}`;
    return fail(err);
  }
  const raw = res.stdout as Buffer;
  if (!raw || raw.length === 0) return fail("empty attachment stream");
  if (raw.length > Math.min(maxBytes, FETCH_MAX_BYTES)) return fail("attachment exceeds the fetch ceiling");
  let bytes = String(mime || "").toLowerCase() === "audio/x-caf"
    ? rewrapCaf(raw, runner)
    : bakeOrientation(raw, runner);
  let animationUnavailable = sequenceStill;
  if (sequencePreview) {
    const converted = stickerSequencePreview(bytes, mime, runner);
    if (converted && converted.bytes.length <= Math.min(maxBytes, FETCH_MAX_BYTES)) {
      bytes = converted.bytes;
      file = converted.renderMime === "image/webp" ? animationFile : stillFile;
      renderMime = converted.renderMime;
      animationUnavailable = converted.unavailable;
    } else if (png) {
      // A missing ffmpeg, unknown HEICS layout, or oversized preview still
      // gets the Mac's transparent first image. Never cache raw HEICS as PNG.
      const fallback = runner(shimPath("imsg"), ["attachment", id, "--png", "--max-dim", "2048"],
        { timeout: 120000, maxBuffer: FETCH_MAX_BYTES + (1 << 20) });
      if (fallback.status === 69 || fallback.status === 255) return fail("Mac unreachable", false);
      const still = fallback.stdout as Buffer;
      if (fallback.status !== 0 || !Buffer.isBuffer(still) || imageAnimation(still).format !== "png")
        return fail("sticker animation and still preview unavailable");
      if (still.length > Math.min(maxBytes, FETCH_MAX_BYTES)) return fail("sticker preview exceeds the fetch ceiling");
      bytes = still;
      animationUnavailable = true;
    } else {
      try {
        const fd = openSync(failedFile, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_TRUNC, 0o600);
        try { writeSync(fd, "unavailable"); } finally { closeSync(fd); }
        evict(failedFile.slice(failedFile.lastIndexOf("/") + 1));
      } catch { /* the failure itself must still be reported */ }
      return fail("sticker video preview unavailable; open the original attachment");
    }
  }
  if (animatedPreview) {
    const converted = stickerAnimationPreview(bytes, runner);
    animationUnavailable = converted.unavailable;
    if (converted.converted) {
      if (converted.bytes.length <= Math.min(maxBytes, FETCH_MAX_BYTES)) {
        bytes = converted.bytes;
        file = animationFile;
        renderMime = "image/webp";
      } else animationUnavailable = true;
    }
  }
  if (animatedPreview && animationUnavailable) file = stillFile;
  if (sticker && !renderMime.startsWith("video/") && !stickerRasterValid(bytes.subarray(0, IMAGE_HEADER_BYTES), renderMime))
    return fail("sticker media is not a supported bounded raster image");

  // tmp + fsync + rename: a killed fetch must never leave a cache hit that
  // looks complete.
  // pid alone collides after a crash + pid reuse (EEXIST forever); add entropy.
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  evict(file.slice(file.lastIndexOf("/") + 1));
  const animation = imageAnimation(bytes.subarray(0, IMAGE_HEADER_BYTES));
  const audio = String(mime).toLowerCase().startsWith("audio/") ? analyzeAudio(file, runner) : undefined;
  return {
    ...(audio ? {audio} : {}),
    ok: true, online: true, path: file, url: pathToFileURL(file).href, error: "",
    ...imageMetrics(bytes.subarray(0, IMAGE_HEADER_BYTES), renderMime), renderMime,
    animated: animation.animated && animation.format !== "png",
    animationUnavailable: animationUnavailable || (animation.animated && animation.format === "png"),
  };
}

if (import.meta.main) {
  const [id, name, mime] = [process.argv[2] ?? "", process.argv[3] ?? "file", process.argv[4] ?? ""];
  const cap = Number(process.argv[5] ?? "");
  try {
    console.log(JSON.stringify(fetchAttachment(id, name, mime, undefined, cap > 0 ? cap : FETCH_MAX_BYTES, process.argv.includes("--sticker"))));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, online: true, path: "", url: "", error: String(e) }));
  }
}
