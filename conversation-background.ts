#!/usr/bin/env bun
/** Explicit local appearance preference, stored in bridge.conf. No bridge or
 * conversation text enters this helper. Picked raster bytes are decoded,
 * resized and stripped before the private copy is shown by QML. */
import { spawnSync } from "node:child_process";
import { dlopen, FFIType } from "bun:ffi";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { imageMetrics } from "./fetch";

export const MAX_BACKGROUND_BYTES = 20 * 1024 * 1024;
const KEY_PREFIX = "conversation_background";
const SAFE_NAME = /^[a-f0-9]{64}\.png$/;
const CONTROL = /[\x00-\x1f\x7f]/;
export interface BackgroundPaths { config: string; assets: string }
export function backgroundPaths(home = homedir()): BackgroundPaths {
  return { config: join(home, ".config/blip/bridge.conf"), assets: join(home, ".local/state/blip/backgrounds") };
}
function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid!() || (st.mode & 0o022))
    throw new Error("Background storage must be a directory you own");
}
function readLocal(path: string, max: number, owned = false): Buffer {
  if (!isAbsolute(path) || path.length > 4096 || CONTROL.test(path)) throw new Error("Choose a local image file");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max || (owned && (st.uid !== process.getuid!() || (st.mode & 0o022))))
      throw new Error("Image or configuration file is not safe to read");
    const buffer = Buffer.alloc(Math.min(st.size + 1, max + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!count) break;
      offset += count;
    }
    if (offset > st.size || offset > max) throw new Error("Image changed while reading; choose it again");
    return buffer.subarray(0, offset);
  } finally { closeSync(fd); }
}
function readConfig(paths: BackgroundPaths): string {
  try { return readLocal(paths.config, 65536, true).toString("utf8"); }
  catch (e: any) { if (e.code === "ENOENT") return ""; throw e; }
}
export function backgroundKey(chat = ""): string {
  if (typeof chat !== "string" || chat.length > 320 || CONTROL.test(chat)) throw new Error("Invalid conversation");
  return KEY_PREFIX + (chat ? "_" + createHash("sha256").update(chat).digest("hex") : "");
}
function directName(config: string, chat = ""): string | undefined {
  const key = backgroundKey(chat);
  const matches = [...config.matchAll(new RegExp("^[ \\t]*" + key + "[ \\t]*=[ \\t]*(.*?)[ \\t]*$", "gm"))];
  if (!matches.length) return undefined;
  const value = matches[matches.length - 1]![1]!;
  if (value === "") return "";
  if (!SAFE_NAME.test(value)) throw new Error("Saved background is invalid; choose another local image");
  return value;
}
export function backgroundName(config: string, chat = ""): string {
  return directName(config, chat) ?? (chat ? directName(config) : undefined) ?? "";
}
export function backgroundConfig(config: string, name: string, chat = ""): string {
  if (name !== "" && !SAFE_NAME.test(name)) throw new Error("Invalid background name");
  const key = backgroundKey(chat);
  const clean = config.replace(new RegExp("^[ \\t]*" + key + "[ \\t]*=.*(?:\\r?\\n|$)", "gm"), "");
  return clean + (clean && !clean.endsWith("\n") ? "\n" : "") + (name ? `${key}=${name}\n` : "");
}
function referencedBackgrounds(config: string): Set<string> {
  return new Set([...config.matchAll(/^[ \t]*conversation_background(?:_[a-f0-9]{64})?[ \t]*=[ \t]*([a-f0-9]{64}\.png)[ \t]*$/gm)].map(match => match[1]!));
}
export function rasterType(bytes: Buffer): "png" | "jpeg" {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "png";
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpeg";
  throw new Error("Choose a PNG or JPEG image");
}
/** Recent ImageMagick still emits orNT after -strip, even when explicitly
 * excluded. Remove non-rendering metadata chunks from its bounded PNG output;
 * retained chunks and their CRCs remain byte-identical. */
export function stripPngMetadata(bytes: Buffer): Buffer {
  if (rasterType(bytes) !== "png") throw new Error("Image decoder did not return PNG");
  const chunks = [bytes.subarray(0, 8)];
  const metadata = new Set(["tIME", "orNT", "eXIf", "tEXt", "zTXt", "iTXt"]);
  let offset = 8, ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > bytes.length) throw new Error("Image decoder returned an incomplete PNG");
    const kind = bytes.toString("ascii", offset + 4, offset + 8);
    if (!metadata.has(kind)) chunks.push(bytes.subarray(offset, end));
    offset = end;
    if (kind === "IEND") { ended = true; break; }
  }
  if (!ended || offset !== bytes.length) throw new Error("Image decoder returned an incomplete PNG");
  return Buffer.concat(chunks);
}
export function normalizeBackground(bytes: Buffer): Buffer {
  if (!bytes.length || bytes.length > MAX_BACKGROUND_BYTES) throw new Error("Image is empty or too large (maximum 20 MB)");
  const format = rasterType(bytes);
  const {pixelWidth: w, pixelHeight: h} = imageMetrics(bytes, "image/" + format);
  if (!w || !h || w > 12000 || h > 12000 || w * h > 40000000) throw new Error("Image dimensions exceed the 40 megapixel limit");
  const args = ["-limit", "memory", "128MiB", "-limit", "map", "128MiB", "-limit", "disk", "0", `${format}:-[0]`, "-auto-orient", "-resize", "2560x2560>", "-strip", "-define", "png:exclude-chunk=tIME,orNT", "png:-"];
  const options = { input: bytes, maxBuffer: MAX_BACKGROUND_BYTES, timeout: 12000 };
  let r = spawnSync("magick", args, options);
  // Arch ships ImageMagick 7; Ubuntu's package can still expose IM6 convert.
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") r = spawnSync("convert", args, options);
  if (r.status !== 0 || !r.stdout?.length) throw new Error("Could not decode this image; choose a different PNG or JPEG");
  return stripPngMetadata(r.stdout);
}
function atomicWrite(path: string, bytes: Buffer | string): void {
  const temp = path + "." + randomUUID() + ".tmp";
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, bytes); fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temp, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch {}
  }
}
export function loadBackground(paths = backgroundPaths(), chat = ""): string {
  const name = backgroundName(readConfig(paths), chat);
  if (!name) return "";
  const folder = lstatSync(paths.assets);
  if (!folder.isDirectory() || folder.isSymbolicLink() || folder.uid !== process.getuid!() || (folder.mode & 0o077)) throw new Error("Background storage is not private");
  const path = join(paths.assets, name);
  const bytes = readLocal(path, MAX_BACKGROUND_BYTES, true);
  if (rasterType(bytes) !== "png" || createHash("sha256").update(bytes).digest("hex") + ".png" !== name)
    throw new Error("Saved background has changed; choose the image again");
  const size = imageMetrics(bytes, "image/png");
  if (!size.pixelWidth || !size.pixelHeight || size.pixelWidth > 2560 || size.pixelHeight > 2560) throw new Error("Saved background dimensions are invalid");
  return pathToFileURL(path).href;
}
// Linux advisory locks are released by the kernel even if the helper dies.
// This serializes two open Blip surfaces without stale lock-directory recovery.
const libc = dlopen("libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
export function saveBackground(path: string | null, paths = backgroundPaths(), chat = ""): string {
  privateDirectory(dirname(paths.config));
  const fd = openSync(paths.config + ".background.lock", constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid!() || (st.mode & 0o077)) throw new Error("Background settings lock is not private");
    if (libc.symbols.flock(fd, 6) !== 0) throw new Error("Another window is updating backgrounds; try again");
    return saveBackgroundLocked(path, paths, chat);
  } finally { libc.symbols.flock(fd, 8); closeSync(fd); }
}
function saveBackgroundLocked(path: string | null, paths = backgroundPaths(), chat = ""): string {

  const original = readConfig(paths);
  // Even an invalid old preference can be cleared or replaced explicitly.
  let previous = ""; try { previous = directName(original, chat) || ""; } catch {}
  let name = "";
  if (path !== null) {
    const bytes = normalizeBackground(readLocal(path, MAX_BACKGROUND_BYTES));
    name = createHash("sha256").update(bytes).digest("hex") + ".png";
    privateDirectory(paths.assets);
    const st = lstatSync(paths.assets);
    if (st.mode & 0o077) throw new Error("Background storage is not private");
    atomicWrite(join(paths.assets, name), bytes);
  }
  privateDirectory(dirname(paths.config));
  const next = backgroundConfig(original, name, chat);
  try {
    if (Buffer.byteLength(next, "utf8") > 65536) throw new Error("Too many conversation backgrounds; reset an old background first");
    if (readConfig(paths) !== original) throw new Error("Configuration changed; try again");
    atomicWrite(paths.config, next);
  }
  catch (error) {
    if (name && !referencedBackgrounds(original).has(name)) { try { unlinkSync(join(paths.assets, name)); } catch {} }
    throw error;
  }
  if (previous && !referencedBackgrounds(next).has(previous)) { try { unlinkSync(join(paths.assets, previous)); } catch {} }
  return loadBackground(paths, chat);
}
export function chooseBackground(paths = backgroundPaths(), picker = () => spawnSync("zenity", ["--file-selection", "--title=Choose conversation background", "--file-filter=Images | *.png *.jpg *.jpeg *.PNG *.JPG *.JPEG"], { encoding: "utf8", timeout: 120000, maxBuffer: 8192 }), chat = "") {
  const picked = picker();
  if (picked.status === 1) return { ok: true, cancelled: true };
  if (picked.status !== 0) throw new Error("Could not open the image picker");
  return { ok: true, url: saveBackground(picked.stdout.replace(/\r?\n$/, ""), paths, chat) };
}
if (import.meta.main) {
  try {
    const action = process.argv[2] || "load";
    let input = "";
    if (!process.stdin.isTTY) for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (Buffer.byteLength(input) > 2048) throw new Error("Background request is too large");
    }
    const request = input.trim() ? JSON.parse(input) : {};
    const chat = typeof request.chat === "string" ? request.chat : "";
    backgroundKey(chat);
    let url = "";
    if (action === "load") url = loadBackground(backgroundPaths(), chat);
    else if (action === "clear") url = saveBackground(null, backgroundPaths(), chat);
    else if (action === "choose") {
      console.log(JSON.stringify(chooseBackground(backgroundPaths(), undefined, chat)));
      process.exit(0);
    } else throw new Error("Unknown background action");
    console.log(JSON.stringify({ ok: true, url }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Background could not be changed" }));
    process.exitCode = 1;
  }
}
