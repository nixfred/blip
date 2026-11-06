// city-policy.ts
var CITY_TTL_MS = 5 * 60 * 1000;
var CITY_CLOCK_SKEW_MS = 5000;
function cityIdentity(value) {
  if (typeof value !== "string" || value.length > 254 || value !== value.trim())
    return "";
  if (/^[^@\s<>\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]+@[^@\s<>\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]+$/.test(value))
    return "email:" + value.toLowerCase();
  if (value.length > 64 || !/^\+?[0-9][0-9 ().-]*$/.test(value))
    return "";
  const digits = value.replace(/[^0-9]/g, "");
  return /^[1-9][0-9]{6,14}$/.test(digits) ? "phone:" + digits : "";
}
function parseSharedCity(conf) {
  let enabled = false;
  for (const raw of String(conf || "").split(`
`)) {
    const line = raw.split("#", 1)[0];
    const match = /^\s*shared_city\s*=\s*(.*?)\s*$/.exec(line);
    if (!match)
      continue;
    const value = match[1].replace(/^(['"])(.*)\1$/, "$2").toLowerCase();
    enabled = /^(on|yes|true|1)$/.test(value);
  }
  return enabled;
}
function plainCity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 120 && value === value.trim() && !/[\x00-\x1f\x21-\x26\x28-\x2b\x2f-\x40\x5b-\x60\x7b-\x9f\u2028-\u202e\u2066-\u2069]/.test(value) && /[^ .,'’ʼ\-]/.test(value);
}
function utcMillis(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))
    return NaN;
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().replace(/\.000Z$/, "Z") === value.replace(/\.000Z$/, "Z") ? stamp : NaN;
}
function visibleCity(record, chat, now = Date.now()) {
  if (!record || typeof record !== "object" || Array.isArray(record) || !Number.isFinite(now))
    return "";
  const data = record;
  const identity = cityIdentity(chat);
  if (!identity || data.ok !== true || cityIdentity(data.chat) !== identity || !plainCity(data.city))
    return "";
  const observed = utcMillis(data.observedAt), expires = utcMillis(data.expiresAt);
  if (!Number.isFinite(observed) || !Number.isFinite(expires) || observed > now + CITY_CLOCK_SKEW_MS || now - observed > CITY_TTL_MS || expires <= now || expires <= observed || expires > observed + CITY_TTL_MS)
    return "";
  return data.city;
}
export {
  CITY_CLOCK_SKEW_MS,
  CITY_TTL_MS,
  cityIdentity,
  parseSharedCity,
  visibleCity
};
