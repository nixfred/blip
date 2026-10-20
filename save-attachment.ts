#!/usr/bin/env bun
/**
 * "Save image…" / "Save…" from the attachment menu: copy one fetched
 * ORIGINAL out of the media cache to a place the user picks.
 *
 *   bun save-attachment.ts <cached-path> <original-name>
 *
 * BlipView fetches the attachment first (the same non-auto fetch a click and
 * Copy image use, so the bytes are the full original, never the inline
 * preview), then hands this script the cache path fetch.ts printed. The
 * picker is zenity, as for Save vCard…; Downloads is the starting folder and
 * the attachment's own name the suggested filename. The file is written
 * 0600 and NEVER replaces anything: a taken name becomes "name (2).ext".
 * Nothing is opened or executed; QML only offers this for the media/document
 * types openableMime would hand to xdg-open.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync,
  readSync, realpathSync, unlinkSync, writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { CACHE_DIR, FETCH_MAX_BYTES } from "./fetch";

const CONTROL = /[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/;

/** Only an original (`<id>-orig-…`) or the full-size HEIC→JPEG (`<id>-jpg-…`)
 *  inside the media cache is a valid source: never a preview, never a path a
 *  caller made up. Returns the resolved path. */
export function cachedOriginal(path: string, cacheDir = CACHE_DIR): string {
  if (typeof path !== "string" || !isAbsolute(path) || CONTROL.test(path)) throw new Error("Invalid attachment path");
  const resolved = realpathSync(path);
  if (dirname(resolved) !== realpathSync(cacheDir) || !/^[^/]+-(orig|jpg)-[^/]+$/.test(basename(resolved)))
    throw new Error("Not a fetched original");
  const st = lstatSync(resolved);
  if (!st.isFile()) throw new Error("Not a fetched original");
  if (st.size === 0 || st.size > FETCH_MAX_BYTES) throw new Error("Attachment is empty or too large");
  return resolved;
}

/** The suggested filename: the sender's name as a bounded basename, with the
 *  extension of the bytes actually cached (fetch.ts derives it from the gated
 *  MIME — a HEIC arrives as JPEG, so IMG_1.HEIC is offered as IMG_1.jpg). */
export function suggestedSaveName(name: unknown, cachedPath: string): string {
  const ext = extname(cachedPath).toLowerCase();
  let stem = typeof name === "string" && name.length <= 255 ? name : "";
  stem = stem.replace(/[^\p{L}\p{N} _.()-]/gu, " ").replace(/\s+/g, " ").trim();
  stem = stem.replace(/\.[^.]{1,8}$/, "").replace(/^[.\s]+/, "").trim();
  while (Buffer.byteLength(stem) > 120) stem = Array.from(stem).slice(0, -1).join("").trim();
  return (stem || "attachment") + (/^\.[a-z0-9]{1,8}$/.test(ext) ? ext : "");
}

/** Write `bytes` as `filename` in `folder` without ever replacing a file:
 *  the folder is pinned component by component (no symlink swaps), the bytes
 *  go to a private staging file, and link(2) publishes it — EEXIST moves on
 *  to "name (2).ext". Returns the path written. Same shape as saveVcardInFolder. */
export function saveBytesAs(bytes: Buffer, folder: string, filename: string): string {
  if (typeof folder !== "string" || folder.length > 4096 || !isAbsolute(folder) || CONTROL.test(folder))
    throw new Error("Invalid destination folder");
  if (typeof filename !== "string" || filename === "" || filename === "." || filename === ".." ||
      filename.includes("/") || CONTROL.test(filename) || Buffer.byteLength(filename) > 200)
    throw new Error("Invalid file name");
  if (!bytes.length || bytes.length > FETCH_MAX_BYTES) throw new Error("Attachment is empty or too large");
  const resolved = realpathSync(folder);
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let parent = openSync("/", flags);
  let staging = "";
  try {
    for (const component of resolved.split("/").filter(Boolean)) {
      const child = openSync(`/proc/self/fd/${parent}/${component}`, flags);
      closeSync(parent); parent = child;
    }
    if (fstatSync(parent).uid !== process.getuid!()) throw new Error("Choose a folder you own");
    const root = `/proc/self/fd/${parent}`;
    const temporary = join(root, ".blip-save-" + randomBytes(16).toString("hex"));
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    staging = temporary;
    try {
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    const ext = extname(filename);
    const stem = ext ? filename.slice(0, -ext.length) : filename;
    for (let index = 1; index <= 100; index++) {
      const candidate = index === 1 ? filename : `${stem} (${index})${ext}`;
      try { linkSync(staging, join(root, candidate)); }
      catch (error: any) { if (error.code === "EEXIST") continue; throw error; }
      return join(resolved, candidate);
    }
    throw new Error("Too many files with this name in the selected folder");
  } finally {
    try { if (staging) unlinkSync(staging); } finally { closeSync(parent); }
  }
}

function readBounded(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const size = fstatSync(fd).size;
    if (size === 0 || size > FETCH_MAX_BYTES) throw new Error("Attachment is empty or too large");
    const bytes = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, bytes, read, size - read, read);
      if (n === 0) break;
      read += n;
    }
    if (read !== size) throw new Error("Attachment changed while saving");
    return bytes;
  } finally { closeSync(fd); }
}

export interface SaveResult { ok: boolean; view?: "saved" | "cancelled"; detail?: string; path?: string; error?: string }

/** Picker → copy. `runner` is injected so tests never open a real dialog. */
export function saveAttachment(path: string, name: unknown, runner = spawnSync, cacheDir = CACHE_DIR): SaveResult {
  const source = cachedOriginal(path, cacheDir);
  const filename = suggestedSaveName(name, source);
  const downloads = runner("/usr/bin/xdg-user-dir", ["DOWNLOAD"], { encoding: "utf8", timeout: 2000, maxBuffer: 4097 });
  const location = String(downloads.stdout || "").trim();
  const initial = downloads.status === 0 && location.length <= 4096 && isAbsolute(location) && !CONTROL.test(location)
    ? location : homedir();
  const title = /\.(png|jpe?g|gif|webp|tiff|bmp)$/i.test(filename) ? "Save image" : "Save attachment";
  const choice = runner("/usr/bin/zenity", ["--file-selection", "--save", "--title=" + title,
    "--filename=" + join(initial, filename)], { encoding: "utf8", timeout: 300000, maxBuffer: 4097 });
  if (choice.error) throw new Error((choice.error as NodeJS.ErrnoException).code === "ENOENT"
    ? "Save requires zenity to choose a location" : "The file picker failed or timed out");
  if (choice.status === 1) return { ok: true, view: "cancelled", detail: "save cancelled" };
  if (choice.status !== 0) throw new Error("Could not choose a destination");
  const chosen = String(choice.stdout || "").replace(/\r?\n$/, "");
  if (!isAbsolute(chosen) || chosen.endsWith("/")) throw new Error("Invalid destination");
  const written = saveBytesAs(readBounded(source), dirname(chosen), basename(chosen));
  return { ok: true, view: "saved", detail: "saved " + basename(written) + " to " + dirname(written), path: written };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(saveAttachment(process.argv[2] ?? "", process.argv[3] ?? "")));
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).replace(/[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, " ").slice(0, 180);
    console.log(JSON.stringify({ ok: false, error: message }));
    process.exitCode = 1;
  }
}
