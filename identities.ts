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
 *   printf '%s' '{"handle":"…"}' | bun identities.ts vcard
 *   printf '%s' '{"handle":"…","ownerToken":"sha256:…"}' | bun identities.ts compare
 *   printf '%s' '{"handle":"…","ownerToken":"sha256:…","token":"sha256:…","revision":"sha256:…","card":{…}}' | bun identities.ts edit-prepare
 *   printf '%s' '{"handle":"…","ownerToken":"sha256:…"}' | bun identities.ts link-prepare
 *   printf '%s' '{"handle":"…","ownerToken":"sha256:…"}' | bun identities.ts link
 *   printf '%s' '{"handle":"…","token":"sha256:…"}' | bun identities.ts inspect
 *   printf '%s' '{"handle":"…","token":"sha256:…"}' | bun identities.ts remove
 *   printf '%s' '{"undoToken":"undo:…"}' | bun identities.ts undo
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
import { pathToFileURL } from "node:url";

export const MAX_IDENTITIES_BYTES = 48 * 1024;
export const MAX_IDENTITY_REQUEST_BYTES = 48 * 1024;
export const MAX_IDENTITY_OUTPUT_BYTES = 48 * 1024;
export const MAX_BRIDGE_OUTPUT_BYTES = 48 * 1024;
export const MAX_VCARD_BYTES = 2 * 1024 * 1024;
export const MAX_VCARD_RESPONSE_BYTES = 3 * 1024 * 1024;
export const MAX_IDENTITY_ENTRIES = 64;
export const MAX_IDENTITY_CANDIDATES = 8;
export const MAX_IDENTITY_CARDS = 64;
export const MAX_REPAIR_FIELDS = 8;
export const MAX_COMPARE_CARDS = 8;
export const MAX_CARD_VALUES = 16;
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

export interface ContactRepairPreview {
  handle: string;
  name: string;
  kind: "phone" | "email";
  fieldCount: number;
  labels: string[];
  cardNumber: number;
  cardCount: number;
  accountNumber: number;
  sourceName: string;
  writeEnabled: boolean;
}

export interface ContactRemoval extends ContactRepairPreview {
  removed: true;
  undoToken: string;
}

export interface ContactUndo {
  restored: true;
  alreadyPresent: boolean;
  action: "field-removal" | "edit" | "delete" | "consolidate";
  handle: string;
  name: string;
  cardCount: number;
  fieldCount: number;
}

export interface ContactLabeledValue {
  label: string;
  value: string;
}

export interface ContactAddress {
  label: string;
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  countryCode: string;
}

export interface ContactCardDetail {
  token: string;
  revision: string;
  cardNumber: number;
  accountNumber: number;
  sourceName: string;
  hasPhoto: boolean;
  displayName: string;
  firstName: string;
  middleName: string;
  lastName: string;
  nickname: string;
  organization: string;
  department: string;
  jobTitle: string;
  birthday: string;
  note: string;
  phones: ContactLabeledValue[];
  emails: ContactLabeledValue[];
  urls: ContactLabeledValue[];
  addresses: ContactAddress[];
}

export type ContactCardDraft = Omit<
  ContactCardDetail,
  "token" | "revision" | "cardNumber" | "accountNumber" | "sourceName" | "hasPhoto" | "displayName"
>;

export interface ContactMutationPreview {
  action: "edit" | "delete" | "consolidate";
  handle: string;
  name: string;
  cardNumber: number;
  cardCount: number;
  accountNumber: number;
  sourceName: string;
  sourceCardCount: number;
  changedFields: string[];
  planHash: string;
  writeEnabled: boolean;
}

export interface ContactMutationResult extends ContactMutationPreview {
  applied: true;
  undoToken: string;
  revision?: string;
  displayName?: string;
}

export interface ContactComparison {
  handle: string;
  name: string;
  cardCount: number;
  sourceCount: number;
  writeEnabled: boolean;
  cards: ContactCardDetail[];
}

export interface ContactLinkPreview {
  handle: string;
  name: string;
  cardCount: number;
  sourceCount: number;
  writeEnabled: boolean;
  action: "Link Selected Cards" | "Merge Selected Cards" | "Merge and Link Selected Cards";
  ready: boolean;
}

export interface ContactLinkResult extends Omit<ContactLinkPreview, "ready"> {
  linked: true;
}

export const EMPTY_IDENTITIES: Readonly<IdentityConfig> = Object.freeze({
  schemaVersion: 1,
  identities: Object.freeze({}),
});

const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const CONTACT_TOKEN = /^sha256:[0-9a-f]{64}$/;
const CONTACT_REVISION = /^sha256:[0-9a-f]{64}$/;
const UNDO_TOKEN = /^undo:[0-9a-f]{32}$/;

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

function normalizeContactRevision(value: unknown): string {
  if (typeof value !== "string" || !CONTACT_REVISION.test(value))
    throw new Error("contact revision is invalid");
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

/** Fail closed: only an explicit, owner-controlled `contact_writes=on` enables UI writes. */
export function contactWritesEnabled(path = bridgeConfigPath()): boolean {
  let text: string | null;
  try { text = readBoundedBridgeConfig(path); }
  catch { return false; }
  if (text === null) return false;
  let enabled = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line || !line.includes("=")) continue;
    const split = line.indexOf("=");
    if (line.slice(0, split).trim() !== "contact_writes") continue;
    let value = line.slice(split + 1).trim().toLowerCase();
    if ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    enabled = ["on", "true", "1", "yes"].includes(value);
  }
  return enabled;
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

function normalizeUndoToken(value: unknown): string {
  if (typeof value !== "string" || !UNDO_TOKEN.test(value)) throw new Error("undo token is invalid");
  return value;
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

type Runner = typeof spawnSync;

export function normalizeRepairPreview(value: unknown, requestedHandle: string): ContactRepairPreview {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Contacts returned an invalid repair preview");
  const preview = value as Record<string, unknown>;
  const handle = normalizeHandle(preview.handle);
  if (identityKey(handle) !== identityKey(requestedHandle))
    throw new Error("Contacts returned a different handle");
  const kind = preview.kind === "phone" || preview.kind === "email" ? preview.kind : null;
  if (!kind) throw new Error("Contacts returned an invalid field kind");
  const fieldCount = finiteInteger(preview.fieldCount, "matching field count", 1, MAX_REPAIR_FIELDS);
  if (!Array.isArray(preview.labels) || preview.labels.length !== fieldCount)
    throw new Error("Contacts returned an invalid field-label list");
  const cardNumber = finiteInteger(preview.cardNumber, "card number", 1, MAX_IDENTITY_CARDS);
  const cardCount = finiteInteger(preview.cardCount, "card count", 1, MAX_IDENTITY_CARDS);
  if (cardNumber > cardCount) throw new Error("Contacts returned inconsistent card metadata");
  return {
    handle,
    name: normalizeIdentityName(preview.name),
    kind,
    fieldCount,
    labels: preview.labels.map(optionalLabel),
    cardNumber,
    cardCount,
    accountNumber: finiteInteger(
      preview.accountNumber, "contact account number", 1, MAX_IDENTITY_CARDS,
    ),
    sourceName: contactSourceName(preview.sourceName),
    writeEnabled: preview.writeEnabled === true,
  };
}

function contactText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum)
    throw new Error(`Contacts returned an invalid ${label}`);
  return value.replace(UNSAFE_TEXT, " ").replace(/\s+/g, " ").trim();
}

function normalizeLabeledValues(value: unknown, label: string): ContactLabeledValue[] {
  if (!Array.isArray(value) || value.length > MAX_CARD_VALUES)
    throw new Error(`Contacts returned an invalid ${label} list`);
  return value.map((raw) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
      throw new Error(`Contacts returned an invalid ${label}`);
    const item = raw as Record<string, unknown>;
    const itemValue = contactText(item.value, `${label} value`, 320);
    if (!itemValue) throw new Error(`Contacts returned an empty ${label}`);
    return { label: contactText(item.label, `${label} label`, 80), value: itemValue };
  });
}

function normalizeAddresses(value: unknown): ContactAddress[] {
  if (!Array.isArray(value) || value.length > MAX_CARD_VALUES)
    throw new Error("Contacts returned an invalid address list");
  return value.map((raw) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("Contacts returned an invalid address");
    const item = raw as Record<string, unknown>;
    const address = {
      label: contactText(item.label, "address label", 80),
      street: contactText(item.street, "street", 320),
      city: contactText(item.city, "city", 320),
      state: contactText(item.state, "state", 320),
      postalCode: contactText(item.postalCode, "postal code", 80),
      country: contactText(item.country, "country", 160),
      countryCode: contactText(item.countryCode, "country code", 8),
    };
    if (![address.street, address.city, address.state, address.postalCode, address.country].some(Boolean))
      throw new Error("Contacts returned an empty address");
    return address;
  });
}

function normalizeCardDetail(value: unknown, seen: Set<string>): ContactCardDetail {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Contacts returned an invalid card detail");
  const card = value as Record<string, unknown>;
  const token = normalizeContactToken(card.token);
  if (seen.has(token)) throw new Error("Contacts returned a duplicate comparison card");
  seen.add(token);
  const birthday = contactText(card.birthday, "birthday", 10);
  if (birthday && !/^(?:\d{4}\-|--)\d{2}\-\d{2}$/.test(birthday))
    throw new Error("Contacts returned an invalid birthday");
  return {
    token,
    revision: normalizeContactRevision(card.revision),
    cardNumber: finiteInteger(card.cardNumber, "card number", 1, MAX_COMPARE_CARDS),
    accountNumber: finiteInteger(card.accountNumber, "contact account number", 1, MAX_IDENTITY_CARDS),
    sourceName: contactSourceName(card.sourceName),
    hasPhoto: card.hasPhoto === true,
    displayName: contactText(card.displayName, "display name", 160),
    firstName: contactText(card.firstName, "first name", 160),
    middleName: contactText(card.middleName, "middle name", 160),
    lastName: contactText(card.lastName, "last name", 160),
    nickname: contactText(card.nickname, "nickname", 160),
    organization: contactText(card.organization, "organization", 320),
    department: contactText(card.department, "department", 320),
    jobTitle: contactText(card.jobTitle, "job title", 320),
    birthday,
    note: contactText(card.note, "note", 1000),
    phones: normalizeLabeledValues(card.phones, "phone"),
    emails: normalizeLabeledValues(card.emails, "email"),
    urls: normalizeLabeledValues(card.urls, "URL"),
    addresses: normalizeAddresses(card.addresses),
  };
}

export function normalizeContactDraft(value: unknown): ContactCardDraft {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("contact card draft is invalid");
  const card = value as Record<string, unknown>;
  const birthday = contactText(card.birthday, "birthday", 10);
  if (birthday && !/^(?:\d{4}\-|--)\d{2}\-\d{2}$/.test(birthday))
    throw new Error("birthday must be YYYY-MM-DD or --MM-DD");
  const draft = {
    firstName: contactText(card.firstName, "first name", 160),
    middleName: contactText(card.middleName, "middle name", 160),
    lastName: contactText(card.lastName, "last name", 160),
    nickname: contactText(card.nickname, "nickname", 160),
    organization: contactText(card.organization, "organization", 320),
    department: contactText(card.department, "department", 320),
    jobTitle: contactText(card.jobTitle, "job title", 320),
    birthday,
    note: contactText(card.note, "note", 1000),
    phones: normalizeLabeledValues(card.phones, "phone"),
    emails: normalizeLabeledValues(card.emails, "email"),
    urls: normalizeLabeledValues(card.urls, "URL"),
    addresses: normalizeAddresses(card.addresses),
  };
  if (![draft.firstName, draft.lastName, draft.nickname, draft.organization].some(Boolean))
    throw new Error("contact card needs a name, nickname, or organization");
  return draft;
}

export function normalizeContactComparison(
  value: unknown, requestedHandle: string,
): ContactComparison {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Contacts returned an invalid card comparison");
  const body = value as Record<string, unknown>;
  const handle = normalizeHandle(body.handle);
  if (identityKey(handle) !== identityKey(requestedHandle))
    throw new Error("Contacts returned a different handle");
  const cardCount = finiteInteger(body.cardCount, "card count", 1, MAX_COMPARE_CARDS);
  const sourceCount = finiteInteger(body.sourceCount, "source count", 1, MAX_COMPARE_CARDS);
  if (!Array.isArray(body.cards) || body.cards.length !== cardCount)
    throw new Error("Contacts returned an invalid comparison-card list");
  const seen = new Set<string>();
  const cards = body.cards.map((card) => normalizeCardDetail(card, seen));
  if (cards.some((card, index) => card.cardNumber !== index + 1))
    throw new Error("Contacts returned inconsistent comparison-card numbers");
  if (new Set(cards.map((card) => card.accountNumber)).size !== sourceCount)
    throw new Error("Contacts returned inconsistent comparison accounts");
  return {
    handle,
    name: normalizeIdentityName(body.name),
    cardCount,
    sourceCount,
    writeEnabled: body.writeEnabled === true,
    cards,
  };
}

function normalizeLinkMetadata(
  value: Record<string, unknown>, requestedHandle: string,
): Omit<ContactLinkPreview, "ready"> {
  const handle = normalizeHandle(value.handle);
  if (identityKey(handle) !== identityKey(requestedHandle))
    throw new Error("Contacts returned a different handle");
  const action = value.action;
  if (action !== "Link Selected Cards" && action !== "Merge Selected Cards"
      && action !== "Merge and Link Selected Cards")
    throw new Error("Contacts returned an invalid link action");
  return {
    handle,
    name: normalizeIdentityName(value.name),
    cardCount: finiteInteger(value.cardCount, "card count", 2, MAX_COMPARE_CARDS),
    sourceCount: finiteInteger(value.sourceCount, "source count", 1, MAX_COMPARE_CARDS),
    writeEnabled: value.writeEnabled === true,
    action,
  };
}

function normalizeExpectedLinkAction(value: unknown): ContactLinkPreview["action"] {
  if (value !== "Link Selected Cards" && value !== "Merge Selected Cards"
      && value !== "Merge and Link Selected Cards")
    throw new Error("the confirmed Contacts action is invalid");
  return value;
}

function normalizeMutationPreview(
  value: unknown, requestedHandle: string, expectedAction?: ContactMutationPreview["action"],
): ContactMutationPreview {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Contacts returned an invalid mutation preview");
  const preview = value as Record<string, unknown>;
  const action = preview.action;
  if (action !== "edit" && action !== "delete" && action !== "consolidate")
    throw new Error("Contacts returned an invalid contact action");
  if (expectedAction && action !== expectedAction)
    throw new Error("the contact action changed; preview it again");
  const handle = normalizeHandle(preview.handle);
  if (identityKey(handle) !== identityKey(requestedHandle))
    throw new Error("Contacts returned a different handle");
  if (!Array.isArray(preview.changedFields) || preview.changedFields.length < 1
      || preview.changedFields.length > 13)
    throw new Error("Contacts returned an invalid change summary");
  return {
    action,
    handle,
    name: normalizeIdentityName(preview.name),
    cardNumber: finiteInteger(preview.cardNumber, "card number", 1, MAX_COMPARE_CARDS),
    cardCount: finiteInteger(preview.cardCount, "card count", 1, MAX_COMPARE_CARDS),
    accountNumber: finiteInteger(
      preview.accountNumber, "contact account number", 1, MAX_IDENTITY_CARDS,
    ),
    sourceName: contactSourceName(preview.sourceName),
    sourceCardCount: finiteInteger(
      preview.sourceCardCount, "source card count", 0, MAX_COMPARE_CARDS - 1,
    ),
    changedFields: preview.changedFields.map((field) => contactText(field, "changed field", 40)),
    planHash: normalizeContactRevision(preview.planHash),
    writeEnabled: preview.writeEnabled === true,
  };
}

type ContactMutationOperation =
  "edit-prepare" | "edit" | "delete-prepare" | "delete" | "merge-prepare" | "merge";

export function contactMutationOnMac(
  operation: ContactMutationOperation,
  input: Record<string, unknown>,
  runner: Runner = spawnSync,
): { preview?: ContactMutationPreview; result?: ContactMutationResult } {
  const handle = normalizeHandle(input.handle);
  const ownerToken = normalizeContactToken(input.ownerToken);
  const request: Record<string, unknown> = { operation, handle, ownerToken };
  let action: ContactMutationPreview["action"];
  if (operation === "edit-prepare" || operation === "edit") {
    action = "edit";
    request.token = normalizeContactToken(input.token);
    request.revision = normalizeContactRevision(input.revision);
    request.card = normalizeContactDraft(input.card);
  } else if (operation === "delete-prepare" || operation === "delete") {
    action = "delete";
    request.token = normalizeContactToken(input.token);
    request.revision = normalizeContactRevision(input.revision);
  } else {
    action = "consolidate";
    request.targetToken = normalizeContactToken(input.targetToken);
    request.card = normalizeContactDraft(input.card);
    // Explicit cross-name merge: the second owner token widens the scope to
    // both people's cards; it must be a distinct, valid token.
    if (input.otherOwnerToken !== undefined && input.otherOwnerToken !== null
        && input.otherOwnerToken !== "") {
      const otherOwnerToken = normalizeContactToken(input.otherOwnerToken);
      if (otherOwnerToken === ownerToken)
        throw new Error("the other person must be a different candidate");
      request.otherOwnerToken = otherOwnerToken;
    }
    if (!Array.isArray(input.revisions) || input.revisions.length < 2
        || input.revisions.length > MAX_COMPARE_CARDS)
      throw new Error("contact revision list is invalid");
    const seen = new Set<string>();
    request.revisions = input.revisions.map((raw) => {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("contact revision is invalid");
      const item = raw as Record<string, unknown>;
      const token = normalizeContactToken(item.token);
      if (seen.has(token)) throw new Error("contact revision list contains a duplicate card");
      seen.add(token);
      return { token, revision: normalizeContactRevision(item.revision) };
    });
  }
  const applying = operation === "edit" || operation === "delete" || operation === "merge";
  if (applying) request.planHash = normalizeContactRevision(input.planHash);
  const home = process.env.HOME ?? homedir();
  const result = runner(join(home, "bin", "contacts"), ["--json", "resolve"], {
    encoding: "utf8",
    input: JSON.stringify(request),
    timeout: 35000,
    maxBuffer: MAX_BRIDGE_OUTPUT_BYTES,
  });
  if (result.error) throw new Error(result.error.message || "Contacts bridge failed");
  const stdout = String(result.stdout || "");
  if (Buffer.byteLength(stdout) > MAX_BRIDGE_OUTPUT_BYTES)
    throw new Error("Contacts returned too much data");
  let response: unknown;
  try { response = JSON.parse(stdout); }
  catch { throw new Error("Contacts returned invalid JSON"); }
  if (response === null || typeof response !== "object" || Array.isArray(response))
    throw new Error("Contacts returned an invalid response");
  const body = response as Record<string, unknown>;
  if (result.status !== 0 || body.ok !== true)
    throw new Error(safeError(body.error || "Contacts operation failed"));
  const preview = normalizeMutationPreview(applying ? body : body.preview, handle, action);
  if (!applying) return { preview };
  if (body.applied !== true) throw new Error("Contacts did not confirm the contact change");
  const mutation: ContactMutationResult = {
    ...preview,
    applied: true,
    undoToken: normalizeUndoToken(body.undoToken),
  };
  if (action !== "delete") {
    mutation.revision = normalizeContactRevision(body.revision);
    mutation.displayName = contactText(body.displayName, "display name", 160);
  }
  return { result: mutation };
}

function vCardFileName(name: string): string {
  const safe = name.normalize("NFKC")
    .replace(/[\\/\0-\x1f\x7f]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return `${safe || "Contact"}.vcf`;
}

function writeClipboardVCard(card: Buffer, name: string, runtimeRoot: string): {
  path: string;
  fileName: string;
} {
  const copyDirectory = join(
    runtimeRoot,
    "blip",
    "vcards",
    `${Date.now()}-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  const directoryFd = openPinnedDirectory(copyDirectory, true);
  const fileName = vCardFileName(name);
  let fileFd = -1;
  try {
    fileFd = openSync(
      pinnedPath(directoryFd, fileName),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let offset = 0;
    while (offset < card.length)
      offset += writeSync(fileFd, card, offset, card.length - offset);
    fchmodSync(fileFd, 0o600);
    fsyncSync(fileFd);
  } finally {
    if (fileFd >= 0) closeSync(fileFd);
    closeSync(directoryFd);
  }
  return { path: join(copyDirectory, fileName), fileName };
}

/** Export one unambiguous Mac contact to an owner-only runtime .vcf file. */
export function exportContactVCard(
  handle: unknown,
  runner: Runner = spawnSync,
  runtimeRoot: string = process.env.XDG_RUNTIME_DIR
    ?? `/run/user/${typeof process.getuid === "function" ? process.getuid() : 1000}`,
): { handle: string; name: string; bytes: number; fileName: string; fileUri: string } {
  const normalizedHandle = normalizeHandle(handle);
  const home = process.env.HOME ?? homedir();
  const result = runner(join(home, "bin", "contacts"), ["--json", "resolve"], {
    encoding: "utf8",
    input: JSON.stringify({ operation: "vcard", handle: normalizedHandle }),
    timeout: 35000,
    maxBuffer: MAX_VCARD_RESPONSE_BYTES,
  });
  if (result.error) throw new Error(result.error.message || "Contacts bridge failed");
  const stdout = String(result.stdout || "");
  if (Buffer.byteLength(stdout) > MAX_VCARD_RESPONSE_BYTES)
    throw new Error("Contacts returned too much vCard data");
  let response: unknown;
  try { response = JSON.parse(stdout); }
  catch { throw new Error("Contacts returned an invalid vCard response"); }
  if (response === null || typeof response !== "object" || Array.isArray(response))
    throw new Error("Contacts returned an invalid vCard response");
  const body = response as Record<string, unknown>;
  if (result.status !== 0 || body.ok !== true)
    throw new Error(safeError(body.error || "Contacts vCard export failed"));
  if (typeof body.vcard !== "string" || body.vcard.length > MAX_VCARD_RESPONSE_BYTES
      || !/^[A-Za-z0-9+/=\r\n]+$/.test(body.vcard))
    throw new Error("Contacts returned an invalid vCard");
  const card = Buffer.from(body.vcard.replace(/[\r\n]/g, ""), "base64");
  if (!card.length || card.length > MAX_VCARD_BYTES
      || !card.subarray(0, 32).toString("utf8").startsWith("BEGIN:VCARD"))
    throw new Error("Contacts returned an invalid vCard");
  const name = normalizeIdentityName(body.name);
  const file = writeClipboardVCard(card, name, runtimeRoot);
  return {
    handle: normalizedHandle,
    name,
    bytes: card.length,
    fileName: file.fileName,
    fileUri: pathToFileURL(file.path).href,
  };
}

export function resolveOnMac(
  operation: "candidates" | "open" | "compare" | "link-prepare" | "link"
    | "inspect" | "remove" | "undo" | "discard-unsaved",
  handle: unknown = undefined,
  token: unknown = undefined,
  runner: Runner = spawnSync,
  ownerToken: unknown = undefined,
  expectedAction: unknown = undefined,
  otherOwnerToken: unknown = undefined,
): {
  handle?: string;
  candidates?: IdentityCandidate[];
  opened?: boolean;
  name?: string;
  cardNumber?: number;
  cardCount?: number;
  accountNumber?: number;
  sourceName?: string;
  preview?: ContactRepairPreview;
  removal?: ContactRemoval;
  undo?: ContactUndo;
  comparison?: ContactComparison;
  linkPreview?: ContactLinkPreview;
  linkResult?: ContactLinkResult;
  discarded?: boolean;
} {
  const normalizedHandle = operation === "undo" || operation === "discard-unsaved"
    ? "" : normalizeHandle(handle);
  const request: Record<string, unknown> = { operation };
  if (operation === "undo") request.undoToken = normalizeUndoToken(token);
  else if (operation === "discard-unsaved") { /* no contact data crosses this boundary */ }
  else request.handle = normalizedHandle;
  if (operation === "open" || operation === "inspect" || operation === "remove")
    request.token = normalizeContactToken(token);
  if (operation === "compare" || operation === "link-prepare" || operation === "link")
    request.ownerToken = normalizeContactToken(token);
  if (operation === "compare" && otherOwnerToken !== undefined && otherOwnerToken !== null
      && otherOwnerToken !== "") {
    const normalizedOther = normalizeContactToken(otherOwnerToken);
    if (normalizedOther === request.ownerToken)
      throw new Error("the other person must be a different candidate");
    request.otherOwnerToken = normalizedOther;
  }
  const confirmedAction = operation === "link" ? normalizeExpectedLinkAction(expectedAction) : "";
  if (operation === "link") request.expectedAction = confirmedAction;
  if (operation === "inspect" || operation === "remove") {
    const normalizedOwner = normalizeContactToken(ownerToken);
    if (normalizedOwner === request.token) throw new Error("the correct and repair contact cannot be the same");
    request.ownerToken = normalizedOwner;
  }
  const home = process.env.HOME ?? homedir();
  const result: SpawnSyncReturns<string> = runner(
    join(home, "bin", "contacts"),
    ["--json", "resolve"],
    {
      encoding: "utf8",
      input: JSON.stringify(request),
      timeout: operation === "candidates" || operation === "open" ? 15000 : 35000,
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
  if (operation === "discard-unsaved") {
    if (typeof body.discarded !== "boolean")
      throw new Error("Contacts returned an invalid unsaved-change result");
    return { discarded: body.discarded };
  }
  if (operation === "open") {
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
  if (operation === "compare") {
    return { comparison: normalizeContactComparison(body, normalizedHandle) };
  }
  if (operation === "link-prepare") {
    const metadata = normalizeLinkMetadata(body, normalizedHandle);
    if (typeof body.ready !== "boolean") throw new Error("Contacts returned an invalid link preview");
    return { linkPreview: { ...metadata, ready: body.ready } };
  }
  if (operation === "link") {
    const metadata = normalizeLinkMetadata(body, normalizedHandle);
    if (metadata.action !== confirmedAction)
      throw new Error("Contacts link action changed; review the cards again");
    if (body.linked !== true) throw new Error("Contacts did not confirm the link action");
    return { linkResult: { ...metadata, linked: true } };
  }
  if (operation === "inspect") {
    return { handle: normalizedHandle, preview: normalizeRepairPreview(body.preview, normalizedHandle) };
  }
  if (operation === "remove") {
    const preview = normalizeRepairPreview(body, normalizedHandle);
    if (body.removed !== true) throw new Error("Contacts did not confirm the removal");
    return {
      handle: normalizedHandle,
      removal: { ...preview, removed: true, undoToken: normalizeUndoToken(body.undoToken) },
    };
  }
  if (body.restored !== true) throw new Error("Contacts did not confirm the restore");
  const undoAction = body.action;
  if (undoAction !== "field-removal" && undoAction !== "edit" && undoAction !== "delete"
      && undoAction !== "consolidate")
    throw new Error("Contacts returned an invalid undo action");
  return {
    undo: {
      restored: true,
      alreadyPresent: body.alreadyPresent === true,
      action: undoAction,
      handle: normalizeHandle(body.handle),
      name: normalizeIdentityName(body.name),
      cardCount: finiteInteger(body.cardCount, "restored card count", 1, MAX_COMPARE_CARDS),
      fieldCount: finiteInteger(body.fieldCount, "restored field count", 1, 13),
    },
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
        contactWrites: contactWritesEnabled(),
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
    if (operation === "vcard") {
      const result = exportContactVCard(request.handle);
      emit({
        ok: true, handle: result.handle, name: result.name,
        bytes: result.bytes, fileName: result.fileName, fileUri: result.fileUri,
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
    if (operation === "compare" || operation === "link-prepare" || operation === "link") {
      if (operation !== "compare" && !contactWritesEnabled())
        throw new Error("contact writes are disabled; set contact_writes=on in bridge.conf");
      const result = resolveOnMac(
        operation, request.handle, request.ownerToken, spawnSync, undefined,
        request.expectedAction, request.otherOwnerToken,
      );
      if (operation === "compare") emit({ ok: true, comparison: result.comparison });
      else if (operation === "link-prepare") emit({ ok: true, preview: result.linkPreview });
      else emit({ ok: true, ...result.linkResult });
      return;
    }
    if (["edit-prepare", "edit", "delete-prepare", "delete", "merge-prepare", "merge"]
      .includes(operation)) {
      const mutationOperation = operation as ContactMutationOperation;
      const applying = operation === "edit" || operation === "delete" || operation === "merge";
      if (applying && !contactWritesEnabled())
        throw new Error("contact writes are disabled; set contact_writes=on in bridge.conf");
      const result = contactMutationOnMac(mutationOperation, request);
      if (result.preview) emit({ ok: true, preview: result.preview });
      else emit({ ok: true, ...result.result });
      return;
    }
    if (operation === "inspect" || operation === "remove") {
      if (!contactWritesEnabled())
        throw new Error("contact writes are disabled; set contact_writes=on in bridge.conf");
      const result = resolveOnMac(operation, request.handle, request.token, spawnSync, request.ownerToken);
      if (operation === "inspect") emit({ ok: true, preview: result.preview });
      else emit({ ok: true, ...result.removal });
      return;
    }
    if (operation === "undo") {
      if (!contactWritesEnabled())
        throw new Error("contact writes are disabled; set contact_writes=on in bridge.conf");
      const result = resolveOnMac("undo", undefined, request.undoToken);
      emit({ ok: true, ...result.undo });
      return;
    }
    if (operation === "discard-unsaved") {
      if (!contactWritesEnabled())
        throw new Error("contact writes are disabled; set contact_writes=on in bridge.conf");
      const result = resolveOnMac("discard-unsaved");
      emit({ ok: true, discarded: result.discarded === true });
      return;
    }
    throw new Error(
      "operation must be read, candidates, vcard, audit, choose, custom, clear, open, compare, edit-prepare, "
      + "edit, delete-prepare, delete, merge-prepare, merge, link-prepare, link, inspect, remove, undo, or discard-unsaved",
    );
  } catch (error) {
    emit({ ok: false, error: safeError(error) });
    process.exitCode = 1;
  }
}

if (import.meta.main) void main();
