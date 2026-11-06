// city-policy.ts
var CITY_TTL_MS = 5 * 60 * 1000;
var CITY_MAX_LOCATION_AGE_MS = 24 * 60 * 60 * 1000;
var CITY_CLOCK_SKEW_MS = 5000;
var CITY_REASONS = [
  "available",
  "disabled",
  "not-direct",
  "no-match",
  "location-unavailable",
  "source-unavailable",
  "unsupported-location",
  "observation-too-old",
  "bridge-failed",
  "invalid-response"
];
function cityReason(value) {
  return typeof value === "string" && CITY_REASONS.indexOf(value) >= 0 ? value : "";
}
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
  if (!Number.isFinite(observed) || !Number.isFinite(expires) || observed > now + CITY_CLOCK_SKEW_MS || now - observed >= CITY_MAX_LOCATION_AGE_MS || expires <= now || expires <= observed || expires > now + CITY_TTL_MS + CITY_CLOCK_SKEW_MS || expires > observed + CITY_MAX_LOCATION_AGE_MS)
    return "";
  return data.city;
}
function citySubtitle(record, chat, now = Date.now()) {
  const city = visibleCity(record, chat, now);
  if (!city)
    return "";
  const minutes = Math.max(0, Math.floor((now - utcMillis(record.observedAt)) / 60000));
  if (minutes < 5)
    return city;
  const age = minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} hr ago`;
  return `${city} · ${age}`;
}
function cityDiagnostics(record, chat, now = Date.now()) {
  const data = record && typeof record === "object" && !Array.isArray(record) ? record : null;
  const eligible = !!cityIdentity(chat);
  const visible = !!visibleCity(data, chat, now);
  let reason = eligible ? "waiting" : "not-direct";
  if (data) {
    if (!eligible || cityIdentity(data.chat) !== cityIdentity(chat))
      reason = "invalid-response";
    else if (visible)
      reason = "available";
    else if (!data.ok)
      reason = cityReason(data.reason) || "bridge-failed";
    else if (!data.city)
      reason = cityReason(data.reason) || "location-unavailable";
    else if (utcMillis(data.expiresAt) <= now)
      reason = "expired";
    else
      reason = "invalid-response";
  }
  return {
    eligible,
    hasRecord: !!data,
    responseOk: data?.ok === true,
    hasCity: typeof data?.city === "string" && data.city.length > 0,
    visible,
    reason
  };
}
function cityStateLabel(record, chat, now = Date.now()) {
  const status = cityDiagnostics(record, chat, now);
  return status.eligible && status.responseOk && !status.hasCity && status.reason === "location-unavailable" ? "Location unavailable" : "";
}
export {
  CITY_CLOCK_SKEW_MS,
  CITY_MAX_LOCATION_AGE_MS,
  CITY_TTL_MS,
  cityDiagnostics,
  cityIdentity,
  cityReason,
  cityStateLabel,
  citySubtitle,
  parseSharedCity,
  visibleCity
};
