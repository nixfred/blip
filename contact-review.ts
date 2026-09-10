#!/usr/bin/env bun
/** Read-only contact review. Requests and handles cross bounded stdin; the
 * only stored data is a private, fingerprint-validated scan cache. */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, mkdirSync,
  openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
type Runner = typeof spawnSync;
export const MAX_IDENTITY_REQUEST_BYTES = 48 * 1024;
export const MAX_IDENTITY_OUTPUT_BYTES = 48 * 1024;
export const MAX_BRIDGE_OUTPUT_BYTES = 48 * 1024;
export const MAX_IDENTITY_CANDIDATES = 8;
export const MAX_IDENTITY_CARDS = 64;
export const MAX_REPAIR_FIELDS = 8;
export const MAX_CONTACT_AUDIT_HANDLES = 200; // per Mac request
export const MAX_CONTACT_SCAN_HANDLES = 10000;
export const MAX_SCAN_REQUEST_BYTES = 4 * 1024 * 1024;
export const SCAN_PAGE_SIZE = 40;
export const MAX_HANDLE_CHARS = 320;
export const MAX_NAME_CHARS = 160;
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

const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const CONTACT_TOKEN = /^sha256:[0-9a-f]{64}$/;

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

function finiteInteger(value: unknown, label: string, low: number, high: number): number {
  if (!Number.isInteger(value) || Number(value) < low || Number(value) > high)
    throw new Error(`${label} is invalid`);
  return Number(value);
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

export function normalizeContactAudit(value: unknown, expectedHandleCount: number, maximum = MAX_CONTACT_AUDIT_HANDLES): ContactAudit {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Contacts returned an invalid audit");
  if (!Number.isInteger(expectedHandleCount) || expectedHandleCount < 1
      || expectedHandleCount > maximum)
    throw new Error("contact audit handle count is invalid");
  const audit = value as Record<string, unknown>;
  const handleCount = finiteInteger(
    audit.handleCount, "audit handle count", 1, maximum,
  );
  if (handleCount !== expectedHandleCount)
    throw new Error("Contacts returned an incomplete audit");
  const noMatchCount = finiteInteger(
    audit.noMatchCount, "audit no-match count", 0, maximum,
  );
  const seen = new Set<string>();
  function entries(raw: unknown, kind: "single" | "duplicate" | "conflict"): ContactAuditEntry[] {
    if (!Array.isArray(raw) || raw.length > maximum)
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

export const MAX_AUDIT_CACHE_BYTES = 16 * 1024 * 1024;
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
  if (Buffer.byteLength(String(result.stdout || "")) > MAX_BRIDGE_OUTPUT_BYTES)
    throw new Error("Contacts returned too much data");
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
    .update(`blip-audit-handles-v1\0${JSON.stringify(keys)}`).digest("hex");
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
    try { audit = normalizeContactAudit(entry.audit, handleCount, MAX_CONTACT_SCAN_HANDLES); }
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
  value: unknown, runner: Runner = spawnSync, cachePath = auditCachePath(),
): { audit: ContactAudit; cached: boolean } {
  const deadline = Date.now() + 180000;
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CONTACT_SCAN_HANDLES)
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
  // Contacts stores changed at all — unchanged means the cached cleanup
  // results are still exact, so skip the full scan.
  const handleFingerprint = handleSetFingerprint(handles);
  let cache: AuditCacheEntry | null = null;
  try { cache = readAuditCache(cachePath); } catch { cache = null; }
  if (cache && cache.audit.handleCount === handles.length && cache.handleFingerprint === handleFingerprint) {
    try {
      if (storeFingerprintOnMac(runner) === cache.storeFingerprint) {
        const requested = new Set(handles.map(identityKey));
        const entries = [...cache.audit.singleCards, ...cache.audit.duplicates, ...cache.audit.conflicts];
        if (entries.every((entry) => requested.has(identityKey(entry.handle))))
          return { audit: cache.audit, cached: true };
      }
    } catch { /* fingerprint unavailable — fall through to a full scan */ }
  }
  const home = process.env.HOME ?? homedir();
  const audit: ContactAudit = {handleCount: 0, noMatchCount: 0, singleCards: [], duplicates: [], conflicts: []};
  let fingerprint: string | undefined;
  let cacheable = true;
  let retainedBytes = 0;
  function batch(batchHandles: string[]): void {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Contact scan timed out; no partial result was saved");
    const input = JSON.stringify({operation: "audit", handles: batchHandles});
    if (Buffer.byteLength(input) > MAX_IDENTITY_REQUEST_BYTES) {
      split(batchHandles); return;
    }
    const result: SpawnSyncReturns<string> = runner(join(home, "bin", "contacts"), ["--json", "resolve"], {
      encoding: "utf8", input, timeout: Math.min(35000, remaining), maxBuffer: MAX_BRIDGE_OUTPUT_BYTES,
    });
    const stdout = String(result.stdout || "");
    if ((result.error as any)?.code === "ENOBUFS" || Buffer.byteLength(stdout) > MAX_BRIDGE_OUTPUT_BYTES) {
      split(batchHandles); return;
    }
    let body: any;
    try { body = JSON.parse(stdout); } catch { /* report malformed replies below */ }
    if (body?.ok === false && /too (?:much data|large)|exceeded its size contract/i.test(String(body.error))) {
      split(batchHandles); return;
    }
    if (result.error) throw new Error(result.error.message || "Contacts bridge failed");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Contacts returned invalid JSON");
    if (result.status !== 0 || body.ok !== true) throw new Error(safeError(body.error || "Contacts audit failed"));
    const part = normalizeContactAudit(body, batchHandles.length);
    const requested = new Set(batchHandles.map(identityKey));
    for (const entry of [...part.singleCards, ...part.duplicates, ...part.conflicts]) {
      if (!requested.has(identityKey(entry.handle))) throw new Error("Contacts returned an unrequested audited handle");
    }
    if (typeof body.fingerprint === "string" && FINGERPRINT_PATTERN.test(body.fingerprint)) {
      if (fingerprint && fingerprint !== body.fingerprint)
        throw new Error("Contacts changed during the scan; please scan again");
      fingerprint = body.fingerprint;
    } else cacheable = false;
    retainedBytes += Buffer.byteLength(JSON.stringify(part));
    if (retainedBytes > MAX_AUDIT_CACHE_BYTES) throw new Error("Contact scan results exceed the storage limit");
    audit.handleCount += part.handleCount;
    audit.noMatchCount += part.noMatchCount;
    audit.singleCards.push(...part.singleCards);
    audit.duplicates.push(...part.duplicates);
    audit.conflicts.push(...part.conflicts);
  }
  function split(part: string[]): void {
    if (part.length < 2) throw new Error("One contact returned too much data; review it individually");
    const middle = Math.ceil(part.length / 2);
    batch(part.slice(0, middle)); batch(part.slice(middle));
  }
  for (let offset = 0; offset < handles.length; offset += MAX_CONTACT_AUDIT_HANDLES)
    batch(handles.slice(offset, offset + MAX_CONTACT_AUDIT_HANDLES));
  if (cacheable && fingerprint) {
    try { writeAuditCache({storeFingerprint: fingerprint, handleFingerprint, audit}, cachePath); }
    catch { /* caching is best-effort */ }
  }
  return {audit, cached: false};
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
  if (result.status !== 0) throw new Error("Contacts bridge failed");
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

export interface ReviewPerson { handle: string; name: string }
export interface ReviewRow extends ReviewPerson {
  detail: string;
  action: "candidates" | "open";
  token: string;
}
export interface ReviewView {
  ok: true;
  view: "people" | "cards" | "scan" | "opened";
  page?: number;
  pageCount?: number;
  title: string;
  detail: string;
  rows: ReviewRow[];
}

function person(value: unknown): ReviewPerson | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  try {
    const handle = normalizeHandle(raw.handle);
    const name = typeof raw.name === "string" && raw.name.length <= MAX_NAME_CHARS && raw.name.trim() !== ""
      ? normalizeIdentityName(raw.name) : handle;
    return { handle, name };
  } catch { return null; }
}

/** A group's last speaker is never treated as the whole conversation. */
export function conversationPeople(value: unknown): ReviewPerson[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const conversation = value as Record<string, unknown>;
  let direct = false;
  try { normalizeHandle(conversation.chat); direct = true; } catch { /* group */ }
  const source = direct
    ? [{ handle: conversation.chat, name: conversation.name }]
    : (Array.isArray(conversation.participants) ? conversation.participants.slice(0, 64) : []);
  const seen = new Set<string>();
  const people: ReviewPerson[] = [];
  for (const raw of source) {
    const item = person(typeof raw === "string" ? { handle: raw } : raw);
    if (!item) continue;
    const key = identityKey(item.handle);
    if (seen.has(key)) continue;
    seen.add(key);
    people.push(item);
  }
  return people;
}

/** Include named conversations and short codes; this never filters messages. */
export function scanHandles(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1000)
    throw new Error("contact scan conversation list is invalid");
  const found = new Map<string, string>();
  for (const raw of value) {
    for (const item of conversationPeople(raw)) {
      const key = identityKey(item.handle);
      if (!found.has(key)) found.set(key, item.handle);
      if (found.size > MAX_CONTACT_SCAN_HANDLES)
        throw new Error("Contact scan exceeds 10,000 distinct handles");
    }
  }
  return [...found.values()];
}

export function cardView(handle: string, candidates: IdentityCandidate[]): ReviewView {
  return {
    ok: true, view: "cards", title: "Contact review", detail: handle,
    rows: candidates.flatMap((candidate) => candidate.cards.map((card) => ({
      handle, name: candidate.name, token: card.token, action: "open" as const,
      detail: `${card.sourceName} · Account ${card.accountNumber} · ${card.matchCount} matching field${card.matchCount === 1 ? "" : "s"}${card.hasPhoto ? " · Photo" : ""}`,
    }))),
  };
}

export function auditView(audit: ContactAudit, requestedPage = 0): ReviewView {
  const rows = (entries: ContactAuditEntry[], label: string): ReviewRow[] => entries.map((entry) => ({
    handle: entry.handle,
    name: entry.candidates.map((candidate) => candidate.name).join(" / ").slice(0, 160),
    detail: `${label} · ${entry.candidates.reduce((n, candidate) => n + candidate.recordCount, 0)} cards`,
    action: "candidates", token: "",
  }));
  const allRows = [...rows(audit.conflicts, "Different names share this handle"), ...rows(audit.duplicates, "Possible duplicate")];
  const pageCount = Math.max(1, Math.ceil(allRows.length / SCAN_PAGE_SIZE));
  const page = Math.min(finiteInteger(requestedPage, "scan page", 0, MAX_CONTACT_SCAN_HANDLES), pageCount - 1);
  return {
    ok: true, view: "scan", title: "Contact scan", page, pageCount,
    detail: `${audit.handleCount} checked · ${audit.duplicates.length} possible duplicates · ${audit.conflicts.length} name conflicts · ${audit.singleCards.length} single cards · ${audit.noMatchCount} unmatched`,
    rows: allRows.slice(page * SCAN_PAGE_SIZE, (page + 1) * SCAN_PAGE_SIZE),
  };
}

export function runReview(
  operation: string, request: Record<string, unknown>, runner: Runner = spawnSync,
  cachePath = auditCachePath(),
): ReviewView {
  if (operation === "review") {
    const people = conversationPeople(request.conversation);
    if (people.length === 1) return runReview("candidates", { handle: people[0]!.handle }, runner, cachePath);
    return { ok: true, view: "people", title: "Review contacts",
      detail: people.length ? "Choose a person in this conversation" : "No contact handles are available for this conversation",
      rows: people.map((item) => ({ ...item, detail: item.handle, action: "candidates", token: "" })),
    };
  }
  if (operation === "candidates") {
    const handle = normalizeHandle(request.handle);
    const result = resolveOnMac("candidates", handle, undefined, runner);
    return cardView(handle, result.candidates!);
  }
  if (operation === "audit") {
    const handles = scanHandles(request.conversations);
    if (!handles.length) return { ok: true, view: "scan", title: "Contact scan", detail: "No contact handles to scan", rows: [], page: 0, pageCount: 1 };
    return auditView(auditContactsOnMac(handles, runner, cachePath).audit, Number(request.page ?? 0));
  }
  if (operation === "open") {
    const result = resolveOnMac("open", request.handle, request.token, runner);
    return { ok: true, view: "opened", title: "Contact review", detail: `Opened ${result.name} in Contacts on Mac`, rows: [] };
  }
  throw new Error("operation must be review, candidates, audit, or open");
}

async function main(): Promise<void> {
  const deadline = setTimeout(() => {
    emit({ ok: false, error: "Contact request timed out" });
    process.exit(1);
  }, 5000);
  try {
    const request = parseRequest(await readStdinBounded(process.stdin as any, process.argv[2] === "audit" ? MAX_SCAN_REQUEST_BYTES : MAX_IDENTITY_REQUEST_BYTES));
    clearTimeout(deadline);
    emit(runReview(process.argv[2] || "", request));
  } catch (error) {
    clearTimeout(deadline);
    emit({ ok: false, error: safeError(error) });
    process.exitCode = 1;
  }
}

if (import.meta.main) void main();
