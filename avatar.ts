#!/usr/bin/env bun
/**
 * Blip photo fetcher — `imsg avatar <handle>` on the Mac streams the Contacts
 * thumbnail (JPEG), `imsg avatar --chat <group id>` the group's own photo; this caches it under ~/.cache/blip/avatars keyed
 * by a hash of the handle, with a negative marker so contacts without a
 * photo are not re-asked every poll. Seven-day TTL either way.
 *
 *   bun avatar.ts <handle>   → {"ok":true,"url":"file://…"} | {"ok":false,…}
 */
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, utimesSync, writeSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isGroupChat } from "./collector";

const HOME = process.env.HOME ?? homedir();
export const AVATAR_DIR = join(process.env.XDG_CACHE_HOME ?? join(HOME, ".cache"), "blip", "avatars");
export const AVATAR_TTL_MS = 7 * 24 * 3600 * 1000;
/** "No photo" is remembered for a DAY, not a week. A photo can appear at any
 *  time — someone sets a group picture, adds a Contacts card, or a bridge fix
 *  starts finding one that was always there (a stale `.none` from a buggy
 *  build kept Sportsball! blank even after the bridge learned to find it).
 *  Short enough to self-heal, long enough that a photoless contact is not
 *  re-asked on every poll. */
export const AVATAR_NONE_TTL_MS = 24 * 3600 * 1000;
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

export interface AvatarResult { ok: boolean; url: string; error: string }

export function avatarKey(handle: string): string {
  return createHash("sha256").update(handle.trim().toLowerCase()).digest("hex").slice(0, 32);
}

function fresh(path: string, ttl = AVATAR_TTL_MS): boolean {
  try {
    const st = lstatSync(path);
    return st.isFile() && Date.now() - st.mtimeMs < ttl;
  } catch { return false; }
}

/** A person: `imsg avatar -- <handle>` (Contacts). A group id (32-hex or
 *  chat<digits>): `imsg avatar --chat <id>`, the group's own photo from
 *  Messages (the GroupPhotoImage attachment) — never a member's face. */
export function avatarArgs(id: string): string[] {
  return isGroupChat(id) ? ["avatar", "--chat", id] : ["avatar", "--", id];
}

export function fetchAvatar(handle: string, runner = spawnSync, opts: { retry?: boolean } = {}): AvatarResult {
  const h = handle.trim();
  if (h === "" || h.length > 320 || /[\s\x00-\x1f]/.test(h)) return { ok: false, url: "", error: "bad handle" };
  mkdirSync(AVATAR_DIR, { recursive: true, mode: 0o700 });
  const base = join(AVATAR_DIR, avatarKey(h));
  const file = `${base}.jpg`;
  const none = `${base}.none`;
  if (fresh(file)) return { ok: true, url: pathToFileURL(file).href, error: "" };
  // `--retry` skips the negative marker: a group/contact photo can appear
  // minutes after we first asked (someone just set one). The UI uses it on
  // every ask so a letter is not sticky for a day.
  if (!opts.retry && fresh(none, AVATAR_NONE_TTL_MS)) return { ok: false, url: "", error: "no photo" };

  const res = runner(`${HOME}/bin/imsg`, avatarArgs(h), { timeout: 20000, maxBuffer: AVATAR_MAX_BYTES + (1 << 20) });
  if (res.status === 69 || res.status === 255) return { ok: false, url: "", error: "Mac unreachable" };
  const bytes = res.stdout as Buffer;
  // Only a real image is cached; anything else (an error string, a Core Data
  // reference) becomes a negative marker instead of a broken file. GIF counts:
  // AddressBook stores a few that way and Qt renders them (#16).
  const isImage = !!bytes && bytes.length > 4 && (
    (bytes[0] === 0xff && bytes[1] === 0xd8) ||
    (bytes[0] === 0x89 && bytes[1] === 0x50) ||
    (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46));
  if (res.error || res.status === null || res.status === 69 || res.status === 255) {
    return { ok: false, url: "", error: "Mac unreachable" };   // transient: no negative marker
  }
  if (res.status !== 0 || !isImage || bytes.length > AVATAR_MAX_BYTES) {
    const fd = openSync(none, "w", 0o600); closeSync(fd);
    const now = new Date(); utimesSync(none, now, now);
    return { ok: false, url: "", error: "no photo" };
  }
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = openSync(tmp, "wx", 0o600);
  try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  try { unlinkSync(none); } catch { /* no marker, or already gone */ }
  return { ok: true, url: pathToFileURL(file).href, error: "" };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const retry = argv.includes("--retry");
  const handle = argv.find((a) => a !== "--retry") ?? "";
  try {
    console.log(JSON.stringify(fetchAvatar(handle, spawnSync, { retry })));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, url: "", error: String(e) }));
  }
}
