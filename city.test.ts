import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cityIdentity, parseSharedCity, visibleCity, CITY_TTL_MS } from "./city-policy";
import { loadCity, readCityRequest, validCity, MAX_CITY_BYTES, MAX_CITY_REQUEST_BYTES } from "./city";

const chat = "+15551234567", now = Date.parse("2026-11-06T12:00:00Z");
const body = { ok: true, handle: chat, city: "Sample City", observedAt: "2026-11-06T11:59:00Z", expiresAt: "2026-11-06T12:04:00Z" };
const record = { ...body, chat };
const enabled = { conf: "shared_city=on", now };
function runner(value: unknown = body, extra = {}): any {
  return (_command: string, args: string[], options: any) => {
    expect(args).toEqual(["--json", "shared-city"]);
    expect(JSON.parse(options.input)).toEqual({ handle: chat });
    expect(args.join(" ")).not.toContain(chat);
    expect(options.timeout).toBe(25000);
    expect(options.maxBuffer).toBe(MAX_CITY_BYTES);
    return { status: 0, stdout: JSON.stringify(value), ...extra };
  };
}

describe("shared city policy", () => {
  test("requires an explicit setting, with parsed comments and optional quotes", () => {
    for (const conf of ["", "shared_city=off", "shared_city=maybe", "other_shared_city=on", "shared_city=on\nshared_city=off"])
      expect(parseSharedCity(conf)).toBe(false);
    for (const value of ["on", "yes", "TRUE", "1", "'on'", '"on"'])
      expect(parseSharedCity(`  shared_city = ${value} # optional\n`)).toBe(true);
  });
  test("matches complete phone identities or exact case-insensitive emails", () => {
    expect(cityIdentity(chat)).toBe(cityIdentity("1 (555) 123-4567"));
    expect(cityIdentity("Person@example.test")).toBe(cityIdentity("person@EXAMPLE.test"));
    expect(cityIdentity("+445551234567")).not.toBe(cityIdentity(chat));
    for (const value of [null, "", "12345", "chat12345678", "a".repeat(32), "+15551234567;other", "x@@example.test", "<x>@example.test", " x@example.test", "x\n@example.test"])
      expect(cityIdentity(value)).toBe("");
  });
  test("accepts locality names without exposing addresses, coordinates or markup", () => {
    for (const city of ["Sample City", "São Paulo", "Saint-Étienne", "Xi’an", "東京", "St. John’s", "City, Region"])
      expect(validCity(city)).toBe(true);
    for (const city of [null, "", " ", "12 Example Road", "Sample City 2", "-74.5, 40.6", "<b>City</b>", "City\nOther", "City\u202eOther", "City\u2066Other", "City\u0000", "City ", "City/Other", "x".repeat(121)])
      expect(validCity(city)).toBe(false);
  });
  test("hides switched, stale, unavailable and future records", () => {
    expect(visibleCity(record, chat, now)).toBe("Sample City");
    expect(visibleCity(record, "1 (555) 123-4567", now)).toBe("Sample City");
    expect(visibleCity(record, "+15551234568", now)).toBe("");
    expect(visibleCity(record, "chat12345678", now)).toBe("");
    expect(visibleCity(record, chat, Date.parse(body.expiresAt))).toBe("");
    expect(visibleCity(record, chat, now - CITY_TTL_MS)).toBe("");
    for (const changes of [{ ok: false }, { city: null }, { observedAt: "2026-11-06T12:00:06Z" },
      { observedAt: "2026-11-06T11:54:59Z" }, { expiresAt: "2026-11-06T12:04:01Z" },
      { expiresAt: body.observedAt }, { expiresAt: "2026-11-06T12:00:00Z" },
      { observedAt: "2026-02-30T11:59:00Z" }, { observedAt: "2026-11-06 11:59:00" },
      { expiresAt: "2026-11-06T12:04:00+00:00" }, { city: "<i>Sample City</i>" }])
      expect(visibleCity({ ...record, ...changes }, chat, now)).toBe("");
  });
});

describe("shared city loader", () => {
  test("returns only a bounded, validated city over stdin", () => {
    expect(loadCity({ chat }, runner(), enabled)).toEqual({ ok: true, chat, city: body.city, observedAt: body.observedAt, expiresAt: body.expiresAt });
    expect(loadCity({ chat }, runner({ ...body, city: null }), enabled)).toEqual({ ok: true, chat, city: null });
  });
  test("does not spawn for disabled settings, groups or malformed requests", () => {
    const never = (() => { throw new Error("must not spawn"); }) as any;
    expect(loadCity({ chat }, never, { conf: "shared_city=off" })).toEqual({ ok: true, chat, city: null });
    for (const request of [null, [], {}, { chat: "chat12345678" }, { chat: "a".repeat(32) }, { chat: "12345" }])
      expect(loadCity(request, never, enabled).ok).toBe(true);
  });
  test("respects bin_dir and re-reads configuration on each request", () => {
    const home = mkdtempSync(join(tmpdir(), "blip-city-"));
    try {
      const directory = join(home, ".config/blip"); mkdirSync(directory, { recursive: true });
      const conf = join(directory, "bridge.conf");
      writeFileSync(conf, "shared_city=on\nbin_dir=$HOME/bridge\n");
      let calls = 0;
      const run = ((command: string) => { calls++; expect(command).toBe(join(home, "bridge/contacts")); return { status: 0, stdout: JSON.stringify(body) }; }) as any;
      expect(loadCity({ chat }, run, { home, now }).city).toBe(body.city);
      writeFileSync(conf, "shared_city=off\n");
      expect(loadCity({ chat }, run, { home, now }).city).toBeNull();
      expect(calls).toBe(1);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  test("drops wrong identities, stale data, malformed responses and bridge failures", () => {
    for (const value of [null, [], {}, { ...body, ok: false }, { ...body, handle: "+445551234567" },
      { ...body, handle: "+15551234568" }, { ...body, expiresAt: "2026-11-06T11:59:59Z" },
      { ...body, city: "12 Example Road" }, { ...body, city: "x".repeat(121) }])
      expect(loadCity({ chat }, runner(value), enabled)).toEqual({ ok: false, chat, city: null });
    for (const response of [{ status: 1 }, { error: new Error("private transport details") },
      { stdout: "not JSON" }, { stdout: "x".repeat(MAX_CITY_BYTES + 1) }])
      expect(loadCity({ chat }, runner(body, response), enabled)).toEqual({ ok: false, chat, city: null });
    expect(loadCity({ chat }, (() => { throw new Error("private transport details"); }) as any, enabled)).toEqual({ ok: false, chat, city: null });
  });
  test("reads bounded JSON stdin and rejects oversized streams", async () => {
    async function* chunks(text: string) { yield Buffer.from(text.slice(0, 3)); yield Buffer.from(text.slice(3)); }
    expect(await readCityRequest(chunks(JSON.stringify({ chat })))).toEqual({ chat });
    await expect(readCityRequest(chunks("x".repeat(MAX_CITY_REQUEST_BYTES + 1)))).rejects.toThrow("too large");
    await expect(readCityRequest(chunks("{"))).rejects.toThrow();
  });
});
