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

import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
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

/** Long edge for an auto-fetched inline preview. The bubble decodes at 800;
 *  1600 keeps it crisp on a HiDPI panel and still lands well under any cap. */
export const PREVIEW_MAX_DIM = 1600;

/** HEIC needs converting on the Mac (sips) — Linux has no decoder. */
export function wantsJpeg(mime: string): boolean {
  return mime === "image/heic" || mime === "image/heif";
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
  "image/heic": "jpg", "image/heif": "jpg", "image/tiff": "tiff", "image/bmp": "bmp",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/x-m4v": "m4v",
  "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/amr": "amr",
  "application/pdf": "pdf", "text/plain": "txt", "text/vcard": "vcf", "text/calendar": "ics",
};
export function cacheFileName(id: string, name: string, mime: string, preview = false): string {
  // Three transforms, never colliding: `orig` is the untouched file, `jpg` a
  // sips HEIC→JPEG at full size, `prev` a resampled inline preview. A preview
  // is ALWAYS JPEG whatever the source was, so its extension is too —
  // xdg-open dispatches on extension, and a JPEG inside a .png would be a lie
  // (war room #49).
  const transform = preview ? "prev" : wantsJpeg(mime) ? "jpg" : "orig";
  let base = sanitizeName(name);
  const ext = preview ? "jpg" : MIME_EXT[String(mime || "").toLowerCase()];
  if (ext) base = base.replace(/\.[^.]{1,8}$/, "") + "." + ext;
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

function evict(keep: string): void {
  let entries: { name: string; bytes: number; mtimeMs: number }[] = [];
  try {
    entries = readdirSync(CACHE_DIR).map((name) => {
      const st = statSync(join(CACHE_DIR, name));
      return { name, bytes: st.size, mtimeMs: st.mtimeMs };
    });
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
  ok: boolean;
  online: boolean;
  path: string;
  url: string;
  error: string;
}

export function fetchAttachment(
  id: string,
  name: string,
  mime: string,
  runner = spawnSync,
  maxBytes = FETCH_MAX_BYTES,
): FetchResult {
  const fail = (error: string, online = true): FetchResult =>
    ({ ok: false, online, path: "", url: "", error });

  if (!/^[0-9]{1,18}$/.test(id)) return fail("bad attachment id");
  mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });

  const preview = maxBytes < FETCH_MAX_BYTES && isImageMime(mime);
  const file = join(CACHE_DIR, cacheFileName(id, name, mime, preview));
  try {
    const st = lstatSync(file);
    // A symlink planted in the cache must never be followed (or touched).
    if (st.isFile() && st.size > 0) {
      const now = new Date();
      utimesSync(file, now, now); // mtime is the LRU clock
      return { ok: true, online: true, path: file, url: pathToFileURL(file).href, error: "" };
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
    ...(wantsJpeg(mime) || preview ? ["--jpeg"] : []),
    ...(preview ? ["--max-dim", String(PREVIEW_MAX_DIM)] : []),
  ];
  const res = runner(`${HOME}/bin/imsg`, args, {
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
  const bytes = bakeOrientation(raw, runner);

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
  evict(cacheFileName(id, name, mime, preview));
  return { ok: true, online: true, path: file, url: pathToFileURL(file).href, error: "" };
}

if (import.meta.main) {
  const [id, name, mime] = [process.argv[2] ?? "", process.argv[3] ?? "file", process.argv[4] ?? ""];
  const cap = Number(process.argv[5] ?? "");
  try {
    console.log(JSON.stringify(fetchAttachment(id, name, mime, undefined, cap > 0 ? cap : FETCH_MAX_BYTES)));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, online: true, path: "", url: "", error: String(e) }));
  }
}
