#!/usr/bin/env bun
/**
 * Portable, user-chosen identity resolutions for ambiguous Messages handles.
 *
 * QML talks only to this short-lived helper. The helper bounds and validates
 * both ~/.config/blip/identities.json and the candidate response from the Mac,
 * then writes choices atomically with mode 0600. Handles travel to the bridge
 * over bounded stdin rather than argv.
 *
 *   bun identities.ts read
 *   printf '%s' '{"handle":"+1555…"}' | bun identities.ts candidates
 *   printf '%s' '{"handles":["+1555…","person@example.com"]}' | bun identities.ts audit
 *   printf '%s' '{"handle":"…","name":"…","token":"sha256:…"}' | bun identities.ts choose
 *   printf '%s' '{"handle":"…","name":"Family line"}' | bun identities.ts custom
 *   printf '%s' '{"handle":"…"}' | bun identities.ts clear
 *   printf '%s' '{"handle":"…","token":"sha256:…"}' | bun identities.ts open
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

export const MAX_IDENTITIES_BYTES = 48 * 1024;
export const MAX_IDENTITY_REQUEST_BYTES = 48 * 1024;
export const MAX_IDENTITY_OUTPUT_BYTES = 48 * 1024;
export const MAX_BRIDGE_OUTPUT_BYTES = 48 * 1024;
export const MAX_IDENTITY_ENTRIES = 64;
export const MAX_IDENTITY_CANDIDATES = 8;
export const MAX_IDENTITY_CARDS = 64;
export const MAX_REPAIR_FIELDS = 8;
export const MAX_CONTACT_AUDIT_HANDLES = 200;
export const MAX_BRIDGE_CONFIG_BYTES = 16 * 1024;
export const MAX_HANDLE_CHARS = 320;
export const MAX_NAME_CHARS = 160;

export type IdentitySource = "contacts" | "custom";

export interface IdentityChoice {
  name: string;
  source: IdentitySource;
  contactToken?: string;
}

export interface IdentityConfig {
  schemaVersion: 1;
  identities: Record<string, IdentityChoice>;
}

export interface IdentityCandidate {
  token: string;
  name: string;
  recordCount: number;
  sourceCount: number;
  hasPhoto: boolean;
  cards: IdentitySourceCard[];
}

export interface IdentitySourceCard {
  token: string;
  accountNumber: number;
  sourceName: string;
  hasPhoto: boolean;
  matchCount: number;
}

export interface ContactAuditEntry {
  handle: string;
  candidates: IdentityCandidate[];
}

export interface ContactAudit {
  handleCount: number;
  noMatchCount: number;
  singleCards: ContactAuditEntry[];
  duplicates: ContactAuditEntry[];
  conflicts: ContactAuditEntry[];
}

export const EMPTY_IDENTITIES: Readonly<IdentityConfig> = Object.freeze({
  schemaVersion: 1,
  identities: Object.freeze({}),
});

const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const CONTACT_TOKEN = /^sha256:[0-9a-f]{64}$/;

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (value.length > maximum) throw new Error(`${label} is too long`);
  const text = value.replace(UNSAFE_TEXT, " ").replace(/\s+/g, " ").trim();
  if (!text) throw new Error(`${label} must not be empty`);
  return text;
}

export function normalizeHandle(value: unknown): string {
  const handle = boundedString(value, "handle", MAX_HANDLE_CHARS);
  if (handle.includes("@")) {
    const email = handle.toLowerCase();
    if (email.length > 254 || !/^[^@\s]+@[^@\s]+$/.test(email))
      throw new Error("handle is not a valid email address");
    return handle;
  }
  if (!/^\+?[0-9][0-9 ()./-]{2,39}$/.test(handle))
    throw new Error("handle is not a valid phone number");
  const digits = handle.replace(/\D/g, "");
  if (digits.length < 5) throw new Error("phone handle is too short");
  return handle;
}

export function identityKey(value: unknown): string {
  const handle = normalizeHandle(value);
  if (handle.includes("@")) return `email:${handle.toLowerCase()}`;
  const digits = handle.replace(/\D/g, "");
  return `phone:${digits.length >= 10 ? digits.slice(-10) : digits}`;
}

export function normalizeIdentityName(value: unknown): string {
  return boundedString(value, "name", MAX_NAME_CHARS);
}

function normalizeContactToken(value: unknown): string {
  if (typeof value !== "string" || !CONTACT_TOKEN.test(value))
    throw new Error("contact token is invalid");
  return value;
}

export function normalizeIdentityConfig(value: unknown): IdentityConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("identities must be a JSON object");
  const input = value as Record<string, unknown>;
  if (own(input, "schemaVersion") !== 1) throw new Error("schemaVersion must be 1");
  const rawEntries = own(input, "identities");
  if (rawEntries === null || typeof rawEntries !== "object" || Array.isArray(rawEntries))
    throw new Error("identities must be an object keyed by handle");
  const pairs = Object.entries(rawEntries as Record<string, unknown>);
  if (pairs.length > MAX_IDENTITY_ENTRIES)
    throw new Error(`identities may contain at most ${MAX_IDENTITY_ENTRIES} choices`);

  const normalized: Record<string, IdentityChoice> = {};
  const seen = new Set<string>();
  for (const [rawHandle, rawChoice] of pairs) {
    const handle = normalizeHandle(rawHandle);
    const key = identityKey(handle);
    if (seen.has(key)) throw new Error("identities contains equivalent duplicate handles");
    seen.add(key);
    if (rawChoice === null || typeof rawChoice !== "object" || Array.isArray(rawChoice))
      throw new Error(`identity for ${handle} must be an object`);
    const choice = rawChoice as Record<string, unknown>;
    const name = normalizeIdentityName(own(choice, "name"));
    const source = own(choice, "source");
    if (source !== "contacts" && source !== "custom")
      throw new Error(`identity for ${handle} has an invalid source`);
    const result: IdentityChoice = { name, source };
    if (source === "contacts") result.contactToken = normalizeContactToken(own(choice, "contactToken"));
    normalized[handle] = result;
  }
  return { schemaVersion: 1, identities: normalized };
}

export function parseIdentities(text: string): IdentityConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("identities.json is not valid JSON");
  }
  return normalizeIdentityConfig(value);
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
  const info = fstatSync(fd);
  if (!info.isDirectory()) {
    closeSync(fd);
    throw new Error("identity directory is not a directory");
  }
  if (info.uid !== currentUid()) {
    closeSync(fd);
    throw new Error("identity directory is not owned by the current user");
  }
  if ((info.mode & 0o077) !== 0) fchmodSync(fd, 0o700);
  return fd;
}

function pinnedPath(directoryFd: number, name: string): string {
  return `/proc/self/fd/${directoryFd}/${name}`;
}

export function readBoundedIdentityFile(path: string): string | null {
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
    const info = fstatSync(fileFd);
    if (!info.isFile()) throw new Error("identities.json must be a regular file");
    if (info.uid !== currentUid()) throw new Error("identities.json is not owned by the current user");
    if (info.size > MAX_IDENTITIES_BYTES) throw new Error("identities.json is too large");

    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const room = MAX_IDENTITIES_BYTES + 1 - total;
      const chunk = Buffer.alloc(Math.min(4096, room));
      const count = readSync(fileFd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > MAX_IDENTITIES_BYTES) throw new Error("identities.json is too large");
      chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    if (fileFd >= 0) closeSync(fileFd);
    closeSync(directoryFd);
  }
}

/** Read the small bridge config through one no-follow descriptor. */
export function readBoundedBridgeConfig(path: string): string | null {
  let directoryFd = -1;
  let fileFd = -1;
  try {
    try { directoryFd = openPinnedDirectory(dirname(path), false); }
    catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    try {
      fileFd = openSync(
        pinnedPath(directoryFd, basename(path)),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    const info = fstatSync(fileFd);
    if (!info.isFile()) throw new Error("bridge.conf must be a regular file");
    if (info.uid !== currentUid()) throw new Error("bridge.conf is not owned by the current user");
    if ((info.mode & 0o022) !== 0) throw new Error("bridge.conf is writable by another user");
    if (info.size > MAX_BRIDGE_CONFIG_BYTES) throw new Error("bridge.conf is too large");
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(4096, MAX_BRIDGE_CONFIG_BYTES + 1 - total));
      const count = readSync(fileFd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > MAX_BRIDGE_CONFIG_BYTES) throw new Error("bridge.conf is too large");
      chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    if (fileFd >= 0) closeSync(fileFd);
    if (directoryFd >= 0) closeSync(directoryFd);
  }
}

export function bridgeConfigPath(): string {
  const overridden = process.env.BLIP_BRIDGE_CONF;
  if (overridden) {
    if (!isAbsolute(overridden)) throw new Error("BLIP_BRIDGE_CONF must be absolute");
    return overridden;
  }
  const home = process.env.HOME;
  if (!home || !isAbsolute(home)) throw new Error("HOME must be an absolute path");
  return join(home, ".config", "blip", "bridge.conf");
}

export function readIdentities(path = identitiesPath()): { exists: boolean; config: IdentityConfig } {
  let text: string | null;
  try {
    text = readBoundedIdentityFile(path);
  } catch (error: any) {
    if (error?.code === "ENOENT") return { exists: false, config: { schemaVersion: 1, identities: {} } };
    throw error;
  }
  if (text === null) return { exists: false, config: { schemaVersion: 1, identities: {} } };
  return { exists: true, config: parseIdentities(text) };
}

function verifyReplaceableTarget(directoryFd: number, name: string): void {
  try {
    const info = lstatSync(pinnedPath(directoryFd, name));
    if (!info.isFile()) throw new Error("identities.json must be a regular file");
    if (info.uid !== currentUid()) throw new Error("identities.json is not owned by the current user");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function writeIdentities(path: string, value: unknown): IdentityConfig {
  if (!isAbsolute(path)) throw new Error("identity path must be absolute");
  const config = normalizeIdentityConfig(value);
  const sorted = Object.fromEntries(
    Object.entries(config.identities).sort(([a], [b]) => a.localeCompare(b)),
  );
  const normalized: IdentityConfig = { schemaVersion: 1, identities: sorted };
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_IDENTITIES_BYTES)
    throw new Error("normalized identities exceed the size limit");

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
    return normalized;
  } finally {
    if (tempFd >= 0) closeSync(tempFd);
    if (!renamed) {
      try { unlinkSync(tempPath); } catch { /* no temporary file */ }
    }
    closeSync(directoryFd);
  }
}

export function identityNameFor(handle: unknown, config: IdentityConfig): string | null {
  let key: string;
  try { key = identityKey(handle); } catch { return null; }
  for (const [candidateHandle, choice] of Object.entries(config.identities)) {
    if (identityKey(candidateHandle) === key) return choice.name;
  }
  return null;
}

export function safeReadIdentityConfig(path = identitiesPath()): IdentityConfig {
  try { return readIdentities(path).config; }
  catch { return { schemaVersion: 1, identities: {} }; }
}

function finiteInteger(value: unknown, label: string, low: number, high: number): number {
  if (!Number.isInteger(value) || Number(value) < low || Number(value) > high)
    throw new Error(`${label} is invalid`);
  return Number(value);
}

function optionalLabel(value: unknown): string {
  if (typeof value !== "string" || value.length > 80) throw new Error("contact label is invalid");
  return value.replace(UNSAFE_TEXT, " ").replace(/\s+/g, " ").trim();
}

function contactSourceName(value: unknown): string {
  return boundedString(value, "contact source name", 120);
}

export function normalizeBridgeCandidates(value: unknown, requestedHandle: string): IdentityCandidate[] {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Contacts returned an invalid response");
  const response = value as Record<string, unknown>;
  if (response.ok !== true) {
    throw new Error(safeError(response.error || "Contacts could not resolve this handle"));
  }
  if (identityKey(response.handle) !== identityKey(requestedHandle))
    throw new Error("Contacts returned a different handle");
  if (!Array.isArray(response.candidates) || response.candidates.length > MAX_IDENTITY_CANDIDATES)
    throw new Error("Contacts returned too many candidates");
  const seen = new Set<string>();
  let cardCount = 0;
  return response.candidates.map((raw: unknown) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("Contacts returned an invalid candidate");
    const candidate = raw as Record<string, unknown>;
    const token = normalizeContactToken(candidate.token);
    if (seen.has(token)) throw new Error("Contacts returned a duplicate candidate");
    seen.add(token);
    const recordCount = finiteInteger(candidate.recordCount, "record count", 1, MAX_IDENTITY_CARDS);
    const sourceCount = finiteInteger(candidate.sourceCount, "source count", 1, MAX_IDENTITY_CARDS);
    if (!Array.isArray(candidate.cards) || candidate.cards.length !== recordCount)
      throw new Error("Contacts returned an invalid source-card list");
    cardCount += candidate.cards.length;
    if (cardCount > MAX_IDENTITY_CARDS) throw new Error("Contacts returned too many source cards");
    const accounts = new Set<number>();
    const cards = candidate.cards.map((rawCard: unknown): IdentitySourceCard => {
      if (rawCard === null || typeof rawCard !== "object" || Array.isArray(rawCard))
        throw new Error("Contacts returned an invalid source card");
      const card = rawCard as Record<string, unknown>;
      const cardToken = normalizeContactToken(card.token);
      if (seen.has(cardToken)) throw new Error("Contacts returned a duplicate card token");
      seen.add(cardToken);
      const accountNumber = finiteInteger(
        card.accountNumber, "contact account number", 1, MAX_IDENTITY_CARDS,
      );
      const matchCount = finiteInteger(card.matchCount ?? 1, "matching field count", 1, MAX_REPAIR_FIELDS);
      accounts.add(accountNumber);
      return {
        token: cardToken,
        accountNumber,
        sourceName: contactSourceName(card.sourceName),
        hasPhoto: card.hasPhoto === true,
        matchCount,
      };
    });
    if (accounts.size !== sourceCount)
      throw new Error("Contacts returned inconsistent account metadata");
    return {
      token,
      name: normalizeIdentityName(candidate.name),
      recordCount,
      sourceCount,
      hasPhoto: candidate.hasPhoto === true,
      cards,
    };
  });
}

export function normalizeContactAudit(value: unknown, expectedHandleCount: number): ContactAudit {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Contacts returned an invalid audit");
  if (!Number.isInteger(expectedHandleCount) || expectedHandleCount < 1
      || expectedHandleCount > MAX_CONTACT_AUDIT_HANDLES)
    throw new Error("contact audit handle count is invalid");
  const audit = value as Record<string, unknown>;
  const handleCount = finiteInteger(
    audit.handleCount, "audit handle count", 1, MAX_CONTACT_AUDIT_HANDLES,
  );
  if (handleCount !== expectedHandleCount)
    throw new Error("Contacts returned an incomplete audit");
  const noMatchCount = finiteInteger(
    audit.noMatchCount, "audit no-match count", 0, MAX_CONTACT_AUDIT_HANDLES,
  );
  const seen = new Set<string>();
  function entries(raw: unknown, kind: "single" | "duplicate" | "conflict"): ContactAuditEntry[] {
    if (!Array.isArray(raw) || raw.length > MAX_CONTACT_AUDIT_HANDLES)
      throw new Error("Contacts returned an invalid audit category");
    return raw.map((item) => {
      if (item === null || typeof item !== "object" || Array.isArray(item))
        throw new Error("Contacts returned an invalid audit entry");
      const entry = item as Record<string, unknown>;
      const handle = normalizeHandle(entry.handle);
      const key = identityKey(handle);
      if (seen.has(key)) throw new Error("Contacts returned a duplicate audited handle");
      seen.add(key);
      const candidates = normalizeBridgeCandidates({
        ok: true, handle, candidates: entry.candidates,
      }, handle);
      if (kind === "single" && (candidates.length !== 1 || candidates[0]!.recordCount !== 1))
        throw new Error("Contacts returned an invalid single-card audit entry");
      if (kind === "duplicate" && (candidates.length !== 1 || candidates[0]!.recordCount < 2))
        throw new Error("Contacts returned an invalid duplicate-card audit entry");
      if (kind === "conflict" && candidates.length < 2)
        throw new Error("Contacts returned an invalid conflict audit entry");
      return { handle, candidates };
    });
  }
  const singleCards = entries(audit.singleCards, "single");
  const duplicates = entries(audit.duplicates, "duplicate");
  const conflicts = entries(audit.conflicts, "conflict");
  if (noMatchCount + singleCards.length + duplicates.length + conflicts.length !== handleCount)
    throw new Error("Contacts returned inconsistent audit totals");
  return { handleCount, noMatchCount, singleCards, duplicates, conflicts };
}

export const MAX_AUDIT_CACHE_BYTES = 512 * 1024;
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function auditCachePath(): string {
  const home = process.env.HOME ?? homedir();
  return join(home, ".local", "state", "blip", "audit-cache.json");
}

export function storeFingerprintOnMac(runner: Runner = spawnSync): string {
  const home = process.env.HOME ?? homedir();
  const result: SpawnSyncReturns<string> = runner(
    join(home, "bin", "contacts"),
    ["--json", "resolve"],
    { encoding: "utf8", input: JSON.stringify({ operation: "fingerprint" }),
      timeout: 15000, maxBuffer: MAX_BRIDGE_OUTPUT_BYTES },
  );
  if (result.error) throw new Error(result.error.message || "Contacts bridge failed");
  let response: unknown;
  try { response = JSON.parse(String(result.stdout || "")); }
  catch { throw new Error("Contacts returned invalid JSON"); }
  const body = (response ?? {}) as Record<string, unknown>;
  if (result.status !== 0 || body.ok !== true)
    throw new Error(safeError(body.error || "Contacts fingerprint failed"));
  if (typeof body.fingerprint !== "string" || !FINGERPRINT_PATTERN.test(body.fingerprint))
    throw new Error("Contacts returned an invalid store fingerprint");
  return body.fingerprint;
}

function handleSetFingerprint(handles: string[]): string {
  const keys = handles.map(identityKey).sort();
  return "sha256:" + createHash("sha256")
    .update(`blip-audit-handles-v1 ${JSON.stringify(keys)}`).digest("hex");
}

type AuditCacheEntry = { storeFingerprint: string; handleFingerprint: string; audit: ContactAudit };

export function readAuditCache(path = auditCachePath()): AuditCacheEntry | null {
  let directoryFd = -1;
  let fileFd = -1;
  try {
    try { directoryFd = openPinnedDirectory(dirname(path), false); }
    catch (error: any) { if (error?.code === "ENOENT") return null; throw error; }
    try {
      fileFd = openSync(
        pinnedPath(directoryFd, basename(path)),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error: any) { if (error?.code === "ENOENT") return null; throw error; }
    const info = fstatSync(fileFd);
    if (!info.isFile() || info.uid !== currentUid() || info.size > MAX_AUDIT_CACHE_BYTES)
      return null;
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(4096, MAX_AUDIT_CACHE_BYTES + 1 - total));
      const count = readSync(fileFd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > MAX_AUDIT_CACHE_BYTES) return null;
      chunks.push(chunk.subarray(0, count));
    }
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(chunks, total).toString("utf8")); }
    catch { return null; }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const entry = parsed as Record<string, unknown>;
    if (typeof entry.storeFingerprint !== "string" || !FINGERPRINT_PATTERN.test(entry.storeFingerprint)
        || typeof entry.handleFingerprint !== "string"
        || !FINGERPRINT_PATTERN.test(entry.handleFingerprint)) return null;
    const rawAudit = entry.audit as Record<string, unknown> | undefined;
    const handleCount = Number(rawAudit?.handleCount);
    if (!Number.isInteger(handleCount)) return null;
    let audit: ContactAudit;
    try { audit = normalizeContactAudit(entry.audit, handleCount); }
    catch { return null; }
    return { storeFingerprint: entry.storeFingerprint, handleFingerprint: entry.handleFingerprint, audit };
  } finally {
    if (fileFd >= 0) closeSync(fileFd);
    if (directoryFd >= 0) closeSync(directoryFd);
  }
}

export function writeAuditCache(entry: AuditCacheEntry, path = auditCachePath()): void {
  const serialized = `${JSON.stringify(entry)}
`;
  if (Buffer.byteLength(serialized) > MAX_AUDIT_CACHE_BYTES)
    throw new Error("audit cache entry is too large");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const directoryFd = openPinnedDirectory(dirname(path), true);
  const name = basename(path);
  const tempName = `.${name}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  const tempPath = pinnedPath(directoryFd, tempName);
  let tempFd = -1;
  let renamed = false;
  try {
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
  } finally {
    if (tempFd >= 0) closeSync(tempFd);
    if (!renamed) { try { unlinkSync(tempPath); } catch { /* no temporary file */ } }
    closeSync(directoryFd);
  }
}

export function auditContactsOnMac(
  value: unknown, runner: Runner = spawnSync,
): { audit: ContactAudit; cached: boolean } {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CONTACT_AUDIT_HANDLES)
    throw new Error("contact audit handle list is invalid");
  const seen = new Set<string>();
  const handles = value.map((raw) => {
    const handle = normalizeHandle(raw);
    const key = identityKey(handle);
    if (seen.has(key)) throw new Error("contact audit contains a duplicate handle");
    seen.add(key);
    return handle;
  });
  // Freshness short-circuit: when the conversation set matches the cached
  // scan, one cheap fingerprint round-trip decides whether the Mac's
  // Contacts stores changed at all â unchanged means the cached cleanup
  // results are still exact, so skip the full scan.
  const handleFingerprint = handleSetFingerprint(handles);
  let cache: AuditCacheEntry | null = null;
  try { cache = readAuditCache(); } catch { cache = null; }
  if (cache && cache.handleFingerprint === handleFingerprint) {
    try {
      if (storeFingerprintOnMac(runner) === cache.storeFingerprint) {
        const requested = new Set(handles.map(identityKey));
        const entries = [...cache.audit.singleCards, ...cache.audit.duplicates, ...cache.audit.conflicts];
        if (entries.every((entry) => requested.has(identityKey(entry.handle))))
          return { audit: cache.audit, cached: true };
      }
    } catch { /* fingerprint unavailable â fall through to a full scan */ }
  }
  const home = process.env.HOME ?? homedir();
  const result: SpawnSyncReturns<string> = runner(
    join(home, "bin", "contacts"),
    ["--json", "resolve"],
    {
      encoding: "utf8",
      input: JSON.stringify({ operation: "audit", handles }),
      timeout: 35000,
      maxBuffer: MAX_BRIDGE_OUTPUT_BYTES,
    },
  );
  if (result.error) throw new Error(result.error.message || "Contacts bridge failed");
  const stdout = String(result.stdout || "");
  if (Buffer.byteLength(stdout) > MAX_BRIDGE_OUTPUT_BYTES)
    throw new Error("Contacts returned too much data");
  let response: unknown;
  try { response = JSON.parse(stdout); }
  catch { throw new Error("Contacts returned invalid JSON"); }
  if (response === null || typeof response !== "object" || Array.isArray(response))
    throw new Error("Contacts returned an invalid audit response");
  const body = response as Record<string, unknown>;
  if (result.status !== 0 || body.ok !== true)
    throw new Error(safeError(body.error || "Contacts audit failed"));
  const audit = normalizeContactAudit(body, handles.length);
  const requestedKeys = new Set(handles.map(identityKey));
  for (const entry of [...audit.singleCards, ...audit.duplicates, ...audit.conflicts]) {
    if (!requestedKeys.has(identityKey(entry.handle)))
      throw new Error("Contacts returned an unrequested audited handle");
  }
  if (typeof body.fingerprint === "string" && FINGERPRINT_PATTERN.test(body.fingerprint)) {
    try { writeAuditCache({ storeFingerprint: body.fingerprint, handleFingerprint, audit }); }
    catch { /* caching is best-effort */ }
  }
  return { audit, cached: false };
}

export function resolveOnMac(
  operation: "candidates" | "open",
  handle: unknown = undefined,
  token: unknown = undefined,
  runner: Runner = spawnSync,
): {
  handle?: string;
  candidates?: IdentityCandidate[];
  opened?: boolean;
  name?: string;
  cardNumber?: number;
  cardCount?: number;
  accountNumber?: number;
  sourceName?: string;
} {
  const normalizedHandle = normalizeHandle(handle);
  const request: Record<string, unknown> = { operation, handle: normalizedHandle };
  if (operation === "open") request.token = normalizeContactToken(token);
  const home = process.env.HOME ?? homedir();
  const result: SpawnSyncReturns<string> = runner(
    join(home, "bin", "contacts"),
    ["--json", "resolve"],
    {
      encoding: "utf8",
      input: JSON.stringify(request),
      timeout: 15000,
      maxBuffer: MAX_BRIDGE_OUTPUT_BYTES,
    },
  );
  if (result.error) throw new Error(result.error.message || "Contacts bridge failed");
  const stdout = String(result.stdout || "");
  if (Buffer.byteLength(stdout) > MAX_BRIDGE_OUTPUT_BYTES)
    throw new Error("Contacts returned too much data");
  let response: unknown;
  try { response = JSON.parse(stdout); }
  catch { throw new Error("Contacts returned invalid JSON"); }
  if (operation === "candidates") {
    const candidates = normalizeBridgeCandidates(response, normalizedHandle);
    return { handle: normalizedHandle, candidates };
  }
  if (response === null || typeof response !== "object" || Array.isArray(response))
    throw new Error("Contacts returned an invalid response");
  const body = response as Record<string, unknown>;
  if (result.status !== 0 || body.ok !== true)
    throw new Error(safeError(body.error || "Contacts operation failed"));
  if (body.opened !== true) throw new Error("Contacts could not open this card");
  return {
    handle: normalizedHandle,
    opened: true,
    name: normalizeIdentityName(body.name),
    cardNumber: finiteInteger(body.cardNumber, "card number", 1, MAX_IDENTITY_CARDS),
    cardCount: finiteInteger(body.cardCount, "card count", 1, MAX_IDENTITY_CARDS),
    accountNumber: finiteInteger(
      body.accountNumber, "contact account number", 1, MAX_IDENTITY_CARDS,
    ),
    sourceName: contactSourceName(body.sourceName),
  };
}

export async function readStdinBounded(
  input: AsyncIterable<Uint8Array | string> = process.stdin as any,
  maximum = MAX_IDENTITY_REQUEST_BYTES,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of input) {
    const chunk = typeof raw === "string" ? Buffer.from(raw) : Buffer.from(raw);
    total += chunk.length;
    if (total > maximum) throw new Error("identity request is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function parseRequest(text: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("identity request must be valid JSON"); }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("identity request must be a JSON object");
  return value as Record<string, unknown>;
}

export function identitiesPath(): string {
  const overridden = process.env.BLIP_IDENTITIES_PATH;
  if (overridden) {
    if (!isAbsolute(overridden)) throw new Error("BLIP_IDENTITIES_PATH must be absolute");
    return overridden;
  }
  const home = process.env.HOME;
  if (!home || !isAbsolute(home)) throw new Error("HOME must be an absolute path");
  return join(home, ".config", "blip", "identities.json");
}

function entries(config: IdentityConfig): Array<IdentityChoice & { handle: string }> {
  return Object.entries(config.identities).map(([handle, choice]) => ({ handle, ...choice }));
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "identity operation failed");
  return message.replace(UNSAFE_TEXT, " ").replace(/\s+/g, " ").trim().slice(0, 180)
    || "identity operation failed";
}

function emit(value: unknown): void {
  const output = JSON.stringify(value);
  if (Buffer.byteLength(output) > MAX_IDENTITY_OUTPUT_BYTES)
    throw new Error("identity helper output exceeded its contract");
  process.stdout.write(`${output}\n`);
}

function withChoice(config: IdentityConfig, handle: string, choice: IdentityChoice): IdentityConfig {
  const targetKey = identityKey(handle);
  const next: Record<string, IdentityChoice> = {};
  for (const [savedHandle, savedChoice] of Object.entries(config.identities)) {
    if (identityKey(savedHandle) !== targetKey) next[savedHandle] = savedChoice;
  }
  next[handle] = choice;
  return normalizeIdentityConfig({ schemaVersion: 1, identities: next });
}

function withoutChoice(config: IdentityConfig, handle: string): IdentityConfig {
  const targetKey = identityKey(handle);
  return normalizeIdentityConfig({
    schemaVersion: 1,
    identities: Object.fromEntries(
      Object.entries(config.identities).filter(([savedHandle]) => identityKey(savedHandle) !== targetKey),
    ),
  });
}

async function main(): Promise<void> {
  const operation = process.argv[2] || "read";
  const path = identitiesPath();
  try {
    if (operation === "read") {
      const result = readIdentities(path);
      emit({
        ok: true,
        exists: result.exists,
        path,
        identities: entries(result.config),
      });
      return;
    }
    const request = parseRequest(await readStdinBounded());
    if (operation === "candidates") {
      const result = resolveOnMac("candidates", request.handle);
      emit({
        ok: true,
        handle: result.handle,
        ambiguous: (result.candidates?.length ?? 0) > 1,
        candidates: result.candidates ?? [],
      });
      return;
    }
    if (operation === "audit") {
      const result = auditContactsOnMac(request.handles);
      emit({ ok: true, audit: result.audit, cached: result.cached });
      return;
    }
    if (operation === "choose") {
      const handle = normalizeHandle(request.handle);
      const name = normalizeIdentityName(request.name);
      const token = normalizeContactToken(request.token);
      const candidateResult = resolveOnMac("candidates", handle);
      const selected = candidateResult.candidates?.find((c) => c.token === token && c.name === name);
      if (!selected) throw new Error("the selected contact is no longer a candidate");
      const current = readIdentities(path).config;
      const config = writeIdentities(path, withChoice(current, handle, {
        name: selected.name, source: "contacts", contactToken: selected.token,
      }));
      emit({ ok: true, path, identity: { handle, ...config.identities[handle]! } });
      return;
    }
    if (operation === "custom") {
      const handle = normalizeHandle(request.handle);
      const name = normalizeIdentityName(request.name);
      const current = readIdentities(path).config;
      const config = writeIdentities(path, withChoice(current, handle, { name, source: "custom" }));
      emit({ ok: true, path, identity: { handle, ...config.identities[handle]! } });
      return;
    }
    if (operation === "clear") {
      const handle = normalizeHandle(request.handle);
      const current = readIdentities(path).config;
      const config = writeIdentities(path, withoutChoice(current, handle));
      emit({ ok: true, path, cleared: handle, identities: entries(config) });
      return;
    }
    if (operation === "open") {
      const result = resolveOnMac("open", request.handle, request.token);
      emit({
        ok: true,
        opened: result.opened === true,
        name: result.name,
        cardNumber: result.cardNumber,
        cardCount: result.cardCount,
        accountNumber: result.accountNumber,
        sourceName: result.sourceName,
      });
      return;
    }
    throw new Error(
      "operation must be read, candidates, audit, choose, custom, clear, or open",
    );
  } catch (error) {
    emit({ ok: false, error: safeError(error) });
    process.exitCode = 1;
  }
}

if (import.meta.main) void main();
