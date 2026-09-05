#!/usr/bin/env bun
/**
 * Blip clipboard paste helper — snapshots the Wayland clipboard ONCE and
 * reports what it held: a file, an image (staged as a draft file), or text.
 *
 *   bun paste.ts   →  {kind:"file", path, url, name} | {kind:"image", path, url}
 *                    | {kind:"text", text} | {kind:"none"}
 *
 * QML intercepts Ctrl+V and calls this instead of letting TextEdit paste,
 * because the decision (attach vs insert) needs the mime types, and probing
 * then re-reading the clipboard is a race — so one process does both.
 * Drafts land in $XDG_RUNTIME_DIR/blip (tmpfs, 0700, dies with the session);
 * anything older than an hour is swept on each call.
 */

import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RUNTIME = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`;
export const DRAFT_DIR = join(RUNTIME, "blip");
const DRAFT_GC_MS = 3600_000;

/** Preferred image mime from an offered-types list; "" when no image. */
export function pickImageType(types: string[]): string {
  if (types.includes("image/png")) return "image/png";
  return types.find((t) => t.startsWith("image/")) ?? "";
}

export function extFor(mime: string): string {
  return { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[mime] ?? "img";
}

/** First local file:// path in a uri-list or GNOME copied-files dump. */
export function firstFileUri(raw: string): string {
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t === "copy" || t === "cut") continue;
    if (!t.startsWith("file://")) continue;
    let path = "";
    try {
      path = decodeURIComponent(t.slice("file://".length));
    } catch {
      continue;
    }
    if (path.startsWith("localhost/")) path = path.slice("localhost".length);
    if (path.startsWith("/")) return path;
  }
  return "";
}

/** A single absolute path or file:// URI that names an existing regular file. */
export function existingLocalFile(text: string): string {
  const t = text.trim();
  if (t === "" || /[\r\n]/.test(t) || t.includes("\0")) return "";
  const path = t.startsWith("file://") ? firstFileUri(t)
    : (t.startsWith("/") && !t.startsWith("//") ? t : "");
  if (path === "") return "";
  try {
    if (statSync(path).isFile()) return path;
  } catch { /* not a file */ }
  return "";
}

function asFile(path: string): Record<string, string> {
  return { kind: "file", path, url: pathToFileURL(path).href };
}

/** Preferred local-file clipboard format; GNOME carries copy/cut semantics. */
export function pickFileType(types: string[]): string {
  if (types.includes("x-special/gnome-copied-files")) return "x-special/gnome-copied-files";
  if (types.includes("text/uri-list")) return "text/uri-list";
  return "";
}

/** Extract the first safe local file from a Wayland file-copy payload. */
export function localFileFromPayload(mime: string, payload: string): string {
  const lines = payload.replace(/\r/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
  if (mime === "x-special/gnome-copied-files" && /^(copy|cut)$/i.test(lines[0] ?? "")) lines.shift();
  const uri = lines.find((line) => !line.startsWith("#")) ?? "";
  if (!uri.startsWith("file://")) return "";
  try {
    const path = fileURLToPath(uri);
    return lstatSync(path).isFile() ? path : "";
  } catch {
    return "";
  }
}

function gcDrafts(): void {
  const now = Date.now();
  try {
    for (const f of readdirSync(DRAFT_DIR)) {
      const p = join(DRAFT_DIR, f);
      try {
        if (now - statSync(p).mtimeMs > DRAFT_GC_MS) unlinkSync(p);
      } catch { /* ignore */ }
    }
  } catch { /* no dir yet */ }
}

export function snapshotClipboard(runner = spawnSync): Record<string, string> {
  const types = runner("wl-paste", ["--list-types"], { encoding: "utf8", timeout: 4000 });
  if (types.status !== 0) return { kind: "none" };
  const offered = (types.stdout as string).trim().split("\n").filter(Boolean);
  const paste = (mime: string, extra: Record<string, unknown> = {}) =>
    runner("wl-paste", ["-t", mime], { encoding: "utf8", timeout: 4000, ...extra });

  // File objects must win over their optional text representation. This is
  // what makes Copy vCard → paste into another Blip conversation attach the
  // .vcf instead of inserting its URI or source text into the composer.
  const fileMime = pickFileType(offered);
  if (fileMime !== "") {
    const dump = runner("wl-paste", ["--no-newline", "-t", fileMime], { encoding: "utf8", timeout: 4000 });
    if (dump.status === 0) {
      const path = localFileFromPayload(fileMime, dump.stdout as string);
      if (path !== "") return { kind: "file", path, url: pathToFileURL(path).href, name: basename(path) };
    }
  }

  const imageMime = pickImageType(offered);
  if (imageMime !== "") {
    const dump = runner("wl-paste", ["-t", imageMime], { timeout: 10000, maxBuffer: 110 * 1024 * 1024 });
    const bytes = dump.stdout as Buffer;
    if (dump.status !== 0 || !bytes || bytes.length === 0) {
      // The clipboard changed between the type probe and the read (the two
      // are separate wl-paste calls — an inherent, tiny race). Fall through
      // to the text read rather than swallowing the paste.
    } else {
    mkdirSync(DRAFT_DIR, { recursive: true, mode: 0o700 });
    gcDrafts();
    const path = join(DRAFT_DIR, `draft-${Date.now()}-${process.pid}.${extFor(imageMime)}`);
    writeFileSync(path, bytes, { mode: 0o600 });
    return { kind: "image", path, url: pathToFileURL(path).href };
    }
  }

  // File managers put the path as text/uri-list (and often text/plain), not
  // image/*. Treat that as an attachment, matching drag-and-drop.
  for (const mime of ["text/uri-list", "x-special/gnome-copied-files"]) {
    if (!offered.includes(mime)) continue;
    const dump = paste(mime);
    if (dump.status !== 0) continue;
    const decoded = firstFileUri(String(dump.stdout || ""));
    const path = decoded !== "" ? existingLocalFile(decoded) : "";
    if (path !== "") return asFile(path);
  }

  const text = runner("wl-paste", ["--no-newline", "-t", "text"], { encoding: "utf8", timeout: 4000 });
  if (text.status === 0 && (text.stdout as string) !== "") {
    const path = existingLocalFile(text.stdout as string);
    if (path !== "") return asFile(path);
    return { kind: "text", text: text.stdout as string };
  }
  return { kind: "none" };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(snapshotClipboard()));
  } catch (e) {
    console.log(JSON.stringify({ kind: "none", error: String(e) }));
  }
}
