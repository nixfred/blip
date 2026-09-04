/**
 * Blip appearance preferences.
 *
 * QML never reads the user-writable file directly. This helper owns a small,
 * bounded JSON contract and emits only normalized values. The same helper
 * writes atomically with private permissions, so preferences.json is safe to
 * copy into a dotfiles repository and restore later.
 *
 *   bun preferences.ts read
 *   printf '%s' '{...}' | bun preferences.ts write
 *   bun preferences.ts reset
 */
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";

export const MAX_PREFERENCES_BYTES = 16 * 1024;
export const MAX_HELPER_OUTPUT_BYTES = 4 * 1024;

export type BubbleColor = "theme" | `#${string}`;

export interface BlipPreferences {
  schemaVersion: 1;
  outgoingBubbleColor: BubbleColor;
  incomingBubbleColor: BubbleColor;
  backgroundOpacity: number;
  fontScale: number;
  density: number;
  sidebarWidth: number;
  avatarSize: number;
  cornerScale: number;
  hideShortCodeConversations: boolean;
  use12HourConversationTimes: boolean;
}

export const DEFAULT_PREFERENCES: Readonly<BlipPreferences> = Object.freeze({
  schemaVersion: 1,
  outgoingBubbleColor: "theme",
  incomingBubbleColor: "theme",
  backgroundOpacity: 0.7,
  fontScale: 1,
  density: 1,
  sidebarWidth: 320,
  avatarSize: 30,
  cornerScale: 1,
  hideShortCodeConversations: true,
  use12HourConversationTimes: true,
});

const NUMBER_RULES = {
  backgroundOpacity: { min: 0.2, max: 1, digits: 2 },
  fontScale: { min: 0.75, max: 1.5, digits: 2 },
  density: { min: 0.7, max: 1.4, digits: 2 },
  sidebarWidth: { min: 240, max: 520, digits: 0 },
  avatarSize: { min: 24, max: 64, digits: 0 },
  cornerScale: { min: 0, max: 2, digits: 2 },
} as const;

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function normalizedColor(value: unknown, key: string): BubbleColor {
  if (typeof value !== "string") throw new Error(`${key} must be "theme" or a hex color`);
  const color = value.trim().toLowerCase();
  if (color === "theme") return color;
  if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(color))
    throw new Error(`${key} must be "theme", #rrggbb, or #rrggbbaa`);
  return color as BubbleColor;
}

function normalizedNumber(
  value: unknown,
  key: keyof typeof NUMBER_RULES,
): number {
  const rule = NUMBER_RULES[key];
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${key} must be a finite number`);
  if (value < rule.min || value > rule.max)
    throw new Error(`${key} must be between ${rule.min} and ${rule.max}`);
  if (rule.digits === 0) return Math.round(value);
  const factor = 10 ** rule.digits;
  return Math.round(value * factor) / factor;
}

function normalizedBoolean(value: unknown, key: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

/** Strict for known fields, tolerant of unknown future fields. */
export function normalizePreferences(value: unknown): BlipPreferences {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("preferences must be a JSON object");
  const input = value as Record<string, unknown>;
  if (own(input, "schemaVersion") !== 1)
    throw new Error("schemaVersion must be 1");

  return {
    schemaVersion: 1,
    outgoingBubbleColor: normalizedColor(own(input, "outgoingBubbleColor"), "outgoingBubbleColor"),
    incomingBubbleColor: normalizedColor(own(input, "incomingBubbleColor"), "incomingBubbleColor"),
    backgroundOpacity: normalizedNumber(own(input, "backgroundOpacity"), "backgroundOpacity"),
    fontScale: normalizedNumber(own(input, "fontScale"), "fontScale"),
    density: normalizedNumber(own(input, "density"), "density"),
    sidebarWidth: normalizedNumber(own(input, "sidebarWidth"), "sidebarWidth"),
    avatarSize: normalizedNumber(own(input, "avatarSize"), "avatarSize"),
    cornerScale: normalizedNumber(own(input, "cornerScale"), "cornerScale"),
    hideShortCodeConversations: normalizedBoolean(
      own(input, "hideShortCodeConversations"),
      "hideShortCodeConversations",
      true,
    ),
    use12HourConversationTimes: normalizedBoolean(
      own(input, "use12HourConversationTimes"),
      "use12HourConversationTimes",
      true,
    ),
  };
}

export function parsePreferences(text: string): BlipPreferences {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("preferences.json is not valid JSON");
  }
  return normalizePreferences(parsed);
}

function currentUid(): number {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (uid < 0) throw new Error("cannot determine the current user");
  return uid;
}

function openPinnedDirectory(path: string, create: boolean): number {
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const stat = fstatSync(fd);
  if (!stat.isDirectory()) {
    closeSync(fd);
    throw new Error("preferences directory is not a directory");
  }
  if (stat.uid !== currentUid()) {
    closeSync(fd);
    throw new Error("preferences directory is not owned by the current user");
  }
  if ((stat.mode & 0o077) !== 0) fchmodSync(fd, 0o700);
  return fd;
}

function pinnedPath(directoryFd: number, name: string): string {
  return `/proc/self/fd/${directoryFd}/${name}`;
}

/** Read exactly one pinned, regular, owner-controlled file with a hard cap. */
export function readBoundedPreferenceFile(path: string): string | null {
  const directoryFd = openPinnedDirectory(dirname(path), false);
  let fileFd = -1;
  try {
    try {
      fileFd = openSync(
        pinnedPath(directoryFd, basename(path)),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    const stat = fstatSync(fileFd);
    if (!stat.isFile()) throw new Error("preferences.json must be a regular file");
    if (stat.uid !== currentUid()) throw new Error("preferences.json is not owned by the current user");
    if (stat.size > MAX_PREFERENCES_BYTES) throw new Error("preferences.json is too large");

    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(4096, MAX_PREFERENCES_BYTES + 1 - total));
      const count = readSync(fileFd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > MAX_PREFERENCES_BYTES) throw new Error("preferences.json is too large");
      chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    if (fileFd >= 0) closeSync(fileFd);
    closeSync(directoryFd);
  }
}

export function readPreferences(path: string): { exists: boolean; preferences: BlipPreferences } {
  let text: string | null;
  try {
    text = readBoundedPreferenceFile(path);
  } catch (error: any) {
    if (error?.code === "ENOENT") return { exists: false, preferences: { ...DEFAULT_PREFERENCES } };
    throw error;
  }
  if (text === null) return { exists: false, preferences: { ...DEFAULT_PREFERENCES } };
  return { exists: true, preferences: parsePreferences(text) };
}

function verifyReplaceableTarget(directoryFd: number, name: string): void {
  try {
    const stat = lstatSync(pinnedPath(directoryFd, name));
    if (!stat.isFile()) throw new Error("preferences.json must be a regular file");
    if (stat.uid !== currentUid()) throw new Error("preferences.json is not owned by the current user");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

/** Atomic, owner-only write inside a pinned config directory. */
export function writePreferences(path: string, value: unknown): BlipPreferences {
  if (!isAbsolute(path)) throw new Error("preferences path must be absolute");
  const preferences = normalizePreferences(value);
  const serialized = `${JSON.stringify(preferences, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_PREFERENCES_BYTES)
    throw new Error("normalized preferences exceed the size limit");

  const directoryFd = openPinnedDirectory(dirname(path), true);
  const name = basename(path);
  const tempName = `.${name}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  const tempPath = pinnedPath(directoryFd, tempName);
  let tempFd = -1;
  let renamed = false;
  try {
    verifyReplaceableTarget(directoryFd, name);
    tempFd = openSync(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const bytes = Buffer.from(serialized, "utf8");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(tempFd, bytes, offset, bytes.length - offset);
    fchmodSync(tempFd, 0o600);
    fsyncSync(tempFd);
    closeSync(tempFd);
    tempFd = -1;
    renameSync(tempPath, pinnedPath(directoryFd, name));
    renamed = true;
    chmodSync(pinnedPath(directoryFd, name), 0o600);
    fsyncSync(directoryFd);
    return preferences;
  } finally {
    if (tempFd >= 0) closeSync(tempFd);
    if (!renamed) {
      try { unlinkSync(tempPath); } catch { /* no temporary file */ }
    }
    closeSync(directoryFd);
  }
}

export async function readStdinBounded(
  input: AsyncIterable<Uint8Array | string> = process.stdin as any,
  maximum = MAX_PREFERENCES_BYTES,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of input) {
    const chunk = typeof raw === "string" ? Buffer.from(raw) : Buffer.from(raw);
    total += chunk.length;
    if (total > maximum) throw new Error("preference input is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "preference operation failed";
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "preference operation failed";
}

function emit(value: unknown): void {
  const output = JSON.stringify(value);
  if (Buffer.byteLength(output) > MAX_HELPER_OUTPUT_BYTES)
    throw new Error("preference helper output exceeded its contract");
  process.stdout.write(`${output}\n`);
}

export function preferencesPath(): string {
  const overridden = process.env.BLIP_PREFERENCES_PATH;
  if (overridden) {
    if (!isAbsolute(overridden)) throw new Error("BLIP_PREFERENCES_PATH must be absolute");
    return overridden;
  }
  const home = process.env.HOME;
  if (!home || !isAbsolute(home)) throw new Error("HOME must be an absolute path");
  return join(home, ".config", "blip", "preferences.json");
}

async function main(): Promise<void> {
  const operation = process.argv[2] || "read";
  const path = preferencesPath();
  try {
    if (operation === "read") {
      emit({ ok: true, ...readPreferences(path) });
      return;
    }
    if (operation === "write") {
      const text = await readStdinBounded();
      const preferences = writePreferences(path, parsePreferences(text));
      emit({ ok: true, exists: true, preferences });
      return;
    }
    if (operation === "reset") {
      const preferences = writePreferences(path, DEFAULT_PREFERENCES);
      emit({ ok: true, exists: true, preferences });
      return;
    }
    throw new Error("operation must be read, write, or reset");
  } catch (error) {
    emit({ ok: false, error: safeError(error) });
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
