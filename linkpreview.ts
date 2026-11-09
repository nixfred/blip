#!/usr/bin/env bun
/**
 * Blip link previews — the card Messages did not make.
 *
 * Messages decorates a URL with an LPLinkMetadata balloon and Blip renders
 * that (thread.ts `link`). But most links never get one: a link inside a
 * sentence, an SMS/RCS message, anything sent from Android. On Fred's Mac 20
 * of 27 recent URL messages were bare. This fetches the page itself and
 * builds the same card from its Open Graph tags.
 *
 *   bun linkpreview.ts <url>
 *     → {"ok":true,"title":"…","summary":"…","host":"…","image":"file://…"}
 *
 * The fetch happens HERE, on the Linux box, never on the Mac: the Mac's job
 * is chat.db and AppleScript. It contacts the site directly — the same thing
 * Messages.app does when it builds a preview — so it is off by default for
 * nobody, and off entirely with `link_previews=off` in bridge.conf.
 *
 * Hardening, because the URL comes from a message a stranger can send:
 *   - http(s) only, no redirects to anything else, at most 3 hops;
 *   - the host must resolve to a PUBLIC address (no localhost, no 10./192.168,
 *     no 169.254 metadata service) — checked on every hop, so a redirect
 *     cannot walk us into the LAN;
 *   - HTML read up to 512 KB, image up to 5 MB, whole thing under ~10 s;
 *   - no cookies, no redirect credentials, no JS;
 *   - the image is content-sniffed (PNG/JPEG/GIF/WebP) before it is cached,
 *     and the cache extension follows the SNIFF, never the URL (war room #49).
 */
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, utimesSync, writeSync,
} from "node:fs";
import { join } from "node:path";
import { sweepStale } from "./avatar";
import { pathToFileURL } from "node:url";

const HOME = process.env.HOME ?? homedir();
export const PREVIEW_DIR = join(process.env.XDG_CACHE_HOME ?? join(HOME, ".cache"), "blip", "linkpreview");
export const CONF_PATH = `${HOME}/.config/blip/bridge.conf`;
/** A page's own card is stable; a week matches the attachment cache. */
export const PREVIEW_TTL_MS = 7 * 24 * 3600 * 1000;
/** "This page has no card" is only worth remembering for a day. */
export const PREVIEW_NONE_TTL_MS = 24 * 3600 * 1000;
export const HTML_MAX_BYTES = 512 * 1024;
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 8000;
export const MAX_HOPS = 3;
/** Sent so a site can identify (and refuse) Blip rather than seeing a blank. */
export const UA = "Mozilla/5.0 (X11; Linux x86_64) Blip/2.3 (+https://github.com/nixfred/blip) like Gecko";

export interface Preview {
  ok: boolean;
  url: string;
  host: string;
  title: string;
  summary: string;
  image: string;   // file:// url, "" when the page has no usable image
  error: string;
}

const fail = (url: string, error: string): Preview =>
  ({ ok: false, url, host: hostOf(url), title: "", summary: "", image: "", error });

export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./i, "").toLowerCase(); } catch { return ""; }
}

export function previewKey(url: string): string {
  return createHash("sha256").update(url.trim()).digest("hex").slice(0, 32);
}

/**
 * True when this address must never be fetched. Blocks loopback, private,
 * link-local (169.254.169.254 is the cloud metadata service), unique-local
 * and unspecified ranges — an incoming message must not make Blip probe the
 * LAN it runs on.
 */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = p as [number, number, number, number];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT / tailnet
    if (a >= 224) return true;                            // multicast + reserved
    return false;
  }
  if (v === 6) {
    const s = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (s === "::" || s === "::1") return true;
    if (s.startsWith("fe80") || s.startsWith("fc") || s.startsWith("fd")) return true;
    if (s.startsWith("::ffff:")) return isPrivateAddress(s.slice(7));
    return false;
  }
  return true;   // not an IP at all
}

/** http(s), a resolvable PUBLIC host, no credentials in the URL. */
export async function safeUrl(raw: string, resolver = lookup): Promise<string> {
  let u: URL;
  try { u = new URL(raw); } catch { return "not a url"; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "only http(s)";
  if (u.username || u.password) return "credentials in url";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return isPrivateAddress(host) ? "private address" : "";
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) return "private host";
  try {
    const all = await resolver(host, { all: true, verbatim: true } as never) as unknown as Array<{ address: string }>;
    const list = Array.isArray(all) ? all : [all as unknown as { address: string }];
    if (list.length === 0) return "does not resolve";
    if (list.some((a) => isPrivateAddress(String(a.address)))) return "private address";
  } catch { return "does not resolve"; }
  return "";
}

function meta(html: string, keys: string[]): string {
  for (const key of keys) {
    const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `<meta[^>]+(?:property|name)\\s*=\\s*["']${k}["'][^>]*>`,
      "i",
    );
    const tag = re.exec(html)?.[0];
    if (!tag) continue;
    const v = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]
      ?? /content\s*=\s*([^\s>]+)/i.exec(tag)?.[1];
    if (v && v.trim()) return decodeEntities(v.trim());
  }
  return "";
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos|nbsp|#39);/gi, (m, e: string) => {
      const l = e.toLowerCase();
      if (l === "amp") return "&";
      if (l === "lt") return "<";
      if (l === "gt") return ">";
      if (l === "quot") return '"';
      if (l === "apos" || l === "#39") return "'";
      if (l === "nbsp") return " ";
      if (l.startsWith("#x")) return String.fromCodePoint(parseInt(l.slice(2), 16) || 32);
      if (l.startsWith("#")) return String.fromCodePoint(parseInt(l.slice(1), 10) || 32);
      return m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** Open Graph first, then Twitter cards, then the plain document. */
export function parseCard(html: string, base: string): { title: string; summary: string; image: string } {
  const title = meta(html, ["og:title", "twitter:title"])
    || decodeEntities((/<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html)?.[1] ?? ""));
  const summary = meta(html, ["og:description", "twitter:description", "description"]);
  const rawImg = meta(html, ["og:image:secure_url", "og:image:url", "og:image", "twitter:image", "twitter:image:src"]);
  let image = "";
  if (rawImg) {
    try { image = new URL(rawImg, base).href; } catch { image = ""; }
    if (image && !/^https?:/i.test(image)) image = "";
  }
  return { title: title.slice(0, 200), summary: summary.slice(0, 400), image };
}

/** PNG / JPEG / GIF / WebP → its extension. "" for anything else. */
export function sniffImage(b: Uint8Array): string {
  if (b.length < 12) return "";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return "webp";
  return "";
}

/** `link_previews=off` in bridge.conf turns this off. Parsed, never sourced. */
export function previewsEnabled(path = CONF_PATH): boolean {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = /^\s*link_previews\s*=\s*([A-Za-z]+)\s*$/.exec(line);
      if (m) return !/^(off|no|false|0)$/i.test(m[1]!);
    }
  } catch { /* no conf: previews on */ }
  return true;
}

function fresh(path: string, ttl: number): boolean {
  try {
    const st = lstatSync(path);
    return st.isFile() && Date.now() - st.mtimeMs < ttl;
  } catch { return false; }
}

function writeAtomic(path: string, bytes: Uint8Array | string): void {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const fd = openSync(tmp, "wx", 0o600);
  try { writeSync(fd, bytes as never); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}

async function get(url: string, timeout: number): Promise<{ res: Response; timer: ReturnType<typeof setTimeout> } | null> {
  let current = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const why = await safeUrl(current);
    if (why) return null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    let res: Response;
    try {
      res = await fetch(current, {
        redirect: "manual",
        signal: ctl.signal,
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5" },
      });
    } catch { clearTimeout(timer); return null; }
    if (res.status >= 300 && res.status < 400) {
      clearTimeout(timer);
      const loc = res.headers.get("location");
      if (!loc) return null;
      try { current = new URL(loc, current).href; } catch { return null; }
      continue;                       // re-checked against the private ranges next loop
    }
    if (!res.ok) { clearTimeout(timer); return null; }
    // The deadline stays armed until the BODY is consumed: a server that sends
    // headers promptly and then holds the stream open used to park this process
    // forever, and the widget's preview queue behind it (Astra #20).
    return { res, timer };
  }
  return null;
}

async function readCapped(res: Response, cap: number): Promise<Uint8Array | null> {
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > cap) return null;
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > cap) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
  } catch { return null; }            // the deadline fired mid-body
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

export async function fetchPreview(url: string): Promise<Preview> {
  const u = url.trim();
  if (!previewsEnabled()) return fail(u, "link previews are off (bridge.conf)");
  const why = await safeUrl(u);
  if (why) return fail(u, why);

  mkdirSync(PREVIEW_DIR, { recursive: true, mode: 0o700 });
  const base = join(PREVIEW_DIR, previewKey(u));
  const metaFile = `${base}.json`;
  const noneFile = `${base}.none`;
  if (fresh(metaFile, PREVIEW_TTL_MS)) {
    try { return { ...(JSON.parse(readFileSync(metaFile, "utf8")) as Preview), url: u, error: "" }; } catch { /* refetch */ }
  }
  if (fresh(noneFile, PREVIEW_NONE_TTL_MS)) return fail(u, "no card");

  const got = await get(u, FETCH_TIMEOUT_MS);
  const res = got?.res ?? null;
  const ctype = (res?.headers.get("content-type") ?? "").toLowerCase();
  if (!res || !got || !/^(text\/html|application\/xhtml)/.test(ctype)) {
    if (got) clearTimeout(got.timer);
    writeAtomic(noneFile, "");
    return fail(u, "no card");
  }
  const body = await readCapped(res, HTML_MAX_BYTES);
  clearTimeout(got.timer);
  if (!body) { writeAtomic(noneFile, ""); return fail(u, "no card"); }
  const card = parseCard(new TextDecoder("utf-8", { fatal: false }).decode(body), res.url || u);

  let image = "";
  if (card.image) {
    const igot = await get(card.image, FETCH_TIMEOUT_MS);
    const ires = igot?.res ?? null;
    if (ires && (ires.headers.get("content-type") ?? "").toLowerCase().startsWith("image/")) {
      const bytes = await readCapped(ires!, IMAGE_MAX_BYTES);
      if (igot) clearTimeout(igot.timer);
      const ext = bytes ? sniffImage(bytes) : "";
      if (bytes && ext) {
        const file = `${base}.${ext}`;
        writeAtomic(file, bytes);
        image = pathToFileURL(file).href;
      }
    }
  }
  if (!card.title && !card.summary && !image) {
    writeAtomic(noneFile, "");
    return fail(u, "no card");
  }
  const out: Preview = { ok: true, url: u, host: hostOf(u), title: card.title, summary: card.summary, image, error: "" };
  // The URL came out of a message; the cache file is named by its hash so the
  // URL itself never lands on disk. The caller re-attaches it (Astra #6).
  writeAtomic(metaFile, JSON.stringify({ ...out, url: "" }));
  sweepStale(PREVIEW_DIR, PREVIEW_TTL_MS * 2);   // bounded: expired cards, images and markers go (Astra B#8)
  const now = new Date();
  utimesSync(metaFile, now, now);
  return out;
}

if (import.meta.main) {
  try {
    // `--stdin`: the URL is message content and never rides argv (BlipView).
    const arg = process.argv[2] ?? "";
    const url = arg === "--stdin" ? (await Bun.stdin.text()).trim() : arg;
    console.log(JSON.stringify(await fetchPreview(url)));
  } catch (e) {
    console.log(JSON.stringify(fail(process.argv[2] ?? "", String(e))));
  }
}
