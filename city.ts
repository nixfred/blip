#!/usr/bin/env bun
/** One opted-in, direct conversation's shared city, held only in memory. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { shimPath } from "./shim-path";
import { cityIdentity, cityReason, parseSharedCity, visibleCity, type CityRecord } from "./city-policy";

export const MAX_CITY_BYTES = 16 * 1024;
export const MAX_CITY_REQUEST_BYTES = 2048;

interface CityOptions { home?: string; now?: number; conf?: string }

/** A locality is a name, never an address, coordinates, or rich text. Bun
 * validates Unicode categories here; QML only receives the validated label. */
export function validCity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 120
    && value === value.trim() && /^[\p{L}\p{M} .,'’ʼ\-]+$/u.test(value)
    && /\p{L}/u.test(value);
}

/** No data from the bridge is returned unless identity and lifetime agree. */
export function loadCity(request: unknown, runner = spawnSync, options: CityOptions = {}): CityRecord {
  const chat = request && typeof request === "object" && !Array.isArray(request)
    && typeof (request as any).chat === "string" && (request as any).chat.length <= 254
    ? (request as any).chat as string : "";
  const empty: CityRecord = { ok: true, chat, city: null, reason: "disabled" };
  if (!cityIdentity(chat)) return { ...empty, reason: "not-direct" };
  const home = options.home ?? process.env.HOME ?? homedir();
  let conf = options.conf ?? "";
  if (options.conf === undefined) {
    try { conf = readFileSync(`${home}/.config/blip/bridge.conf`, "utf8"); } catch { /* disabled */ }
  }
  if (!parseSharedCity(conf)) return empty;
  const failed: CityRecord = { ok: false, chat, city: null, reason: "bridge-failed" };
  try {
    const response = runner(shimPath("contacts", home), ["--json", "shared-city"], {
      encoding: "utf8", input: JSON.stringify({ handle: chat }), timeout: 25000, maxBuffer: MAX_CITY_BYTES,
    });
    if (response.error || response.status !== 0) return failed;
    const output = String(response.stdout || "");
    if (Buffer.byteLength(output) > MAX_CITY_BYTES) return failed;
    const body = JSON.parse(output);
    if (!body || typeof body !== "object" || Array.isArray(body) || body.ok !== true
      || cityIdentity(body.handle) !== cityIdentity(chat)) return failed;
    if (body.city === null) return { ...empty, reason: cityReason(body.reason) || "location-unavailable" };
    if (!validCity(body.city)) return failed;
    const record: CityRecord = { ok: true, chat, city: body.city, observedAt: body.observedAt, expiresAt: body.expiresAt };
    return visibleCity(record, chat, options.now ?? Date.now()) ? record : failed;
  } catch { return failed; }
}

/** The pipe is bounded and timed; request or transport failures reveal no payload. */
export async function readCityRequest(input: AsyncIterable<Uint8Array | string>): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_CITY_REQUEST_BYTES) throw new Error("City request is too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

if (import.meta.main) {
  const timer = setTimeout(() => {
    process.stdout.write('{"ok":false,"chat":"","city":null}\n'); process.exit(1);
  }, 3000);
  try {
    const request = await readCityRequest(process.stdin);
    clearTimeout(timer);
    process.stdout.write(JSON.stringify(loadCity(request)) + "\n");
  } catch {
    clearTimeout(timer);
    process.stdout.write('{"ok":false,"chat":"","city":null}\n');
    process.exitCode = 1;
  }
}
