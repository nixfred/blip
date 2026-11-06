// Shared-city display policy. No filesystem, network, coordinates or messages.
// Rebuild QML module: bun build city-policy.ts --target browser --format esm --outfile City.mjs

export const CITY_TTL_MS = 5 * 60 * 1000;
export const CITY_MAX_LOCATION_AGE_MS = 24 * 60 * 60 * 1000;
export const CITY_CLOCK_SKEW_MS = 5000;

export interface CityRecord {
  ok: boolean;
  chat: string;
  city: string | null;
  observedAt?: string;
  expiresAt?: string;
}

/** Exact identity only: a shared national-number suffix is not identity. */
export function cityIdentity(value: unknown): string {
  if (typeof value !== "string" || value.length > 254 || value !== value.trim()) return "";
  if (/^[^@\s<>\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]+@[^@\s<>\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]+$/.test(value))
    return "email:" + value.toLowerCase();
  if (value.length > 64 || !/^\+?[0-9][0-9 ().-]*$/.test(value)) return "";
  const digits = value.replace(/[^0-9]/g, "");
  return /^[1-9][0-9]{6,14}$/.test(digits) ? "phone:" + digits : "";
}

/** Parsed as data, with the shim's comments and optional quotes. */
export function parseSharedCity(conf: string): boolean {
  let enabled = false;
  for (const raw of String(conf || "").split("\n")) {
    const line = raw.split("#", 1)[0]!;
    const match = /^\s*shared_city\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const value = match[1]!.replace(/^(['"])(.*)\1$/, "$2").toLowerCase();
    enabled = /^(on|yes|true|1)$/.test(value);
  }
  return enabled;
}

/** Final plain-text guard for a city already validated by city.ts. Keep this
 * portable: Qt's JavaScript engine lacks Unicode property regex escapes. */
function plainCity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 120
    && value === value.trim()
    && !/[\x00-\x1f\x21-\x26\x28-\x2b\x2f-\x40\x5b-\x60\x7b-\x9f\u2028-\u202e\u2066-\u2069]/.test(value)
    && /[^ .,'’ʼ\-]/.test(value);
}

function utcMillis(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return NaN;
  const stamp = Date.parse(value);
  // Date.parse normalizes impossible dates; those must not extend freshness.
  return Number.isFinite(stamp) && new Date(stamp).toISOString().replace(/\.000Z$/, "Z") === value.replace(/\.000Z$/, "Z")
    ? stamp : NaN;
}

/** Called on every UI clock tick so stale data disappears without a reply. */
export function visibleCity(record: unknown, chat: unknown, now = Date.now()): string {
  if (!record || typeof record !== "object" || Array.isArray(record) || !Number.isFinite(now)) return "";
  const data = record as CityRecord;
  const identity = cityIdentity(chat);
  if (!identity || data.ok !== true || cityIdentity(data.chat) !== identity || !plainCity(data.city)) return "";
  const observed = utcMillis(data.observedAt), expires = utcMillis(data.expiresAt);
  if (!Number.isFinite(observed) || !Number.isFinite(expires)
    || observed > now + CITY_CLOCK_SKEW_MS || now - observed >= CITY_MAX_LOCATION_AGE_MS
    || expires <= now || expires <= observed
    || expires > now + CITY_TTL_MS + CITY_CLOCK_SKEW_MS
    || expires > observed + CITY_MAX_LOCATION_AGE_MS) return "";
  return data.city;
}

/** Keep an older Find My observation useful without presenting it as live. */
export function citySubtitle(record: unknown, chat: unknown, now = Date.now()): string {
  const city = visibleCity(record, chat, now);
  if (!city) return "";
  const minutes = Math.max(0, Math.floor((now - utcMillis((record as CityRecord).observedAt)) / 60000));
  if (minutes < 5) return city;
  const age = minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} hr ago`;
  return `${city} · ${age}`;
}
