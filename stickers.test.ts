import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decorate } from "./thread";
import { dedupeSelfEcho, messagePreview, type ImsgMessage } from "./collector";
import { MAX_VISIBLE_STICKERS, normalizeStickerAttachment, normalizeStickerMetadata,
  normalizeStickerOverlays, normalizeStickerPlacement, placedStickers, unplacedStickers, reactionStickers, stickerGeometry,
  type StickerOverlay } from "./stickers";
import { CACHE_DIR, FETCH_MAX_BYTES, cacheFileName, fetchAttachment, imageAnimation, imageMetrics,
  stickerAnimationPreview, stickerSequencePreview, wantsStickerPng } from "./fetch";
import { cachedOriginal } from "./save-attachment";

const position = { x: 0.9, y: 0.1, scale: 1.2, rotation: -.2, parentWidth: 160 };
const overlay = (n = 1): StickerOverlay => ({
  attachment: { id: String(n), name: "sticker.png", mime: "image/png", bytes: 128,
    sticker: { source: "user", label: "Heart", placement: position } },
  guid: `S${n}`, part: 0, from_me: false, by: "Example", ts: "2026-11-06T10:01:00Z", placement: position,
});
const message = (overrides: Partial<ImsgMessage> = {}): ImsgMessage => ({
  guid: "P", ts: "2026-11-06T10:00:00Z", text: "Example", from_me: false,
  chat: "+15551234567", handle: "+15551234567", name: null, service: "iMessage", ...overrides,
});

describe("sticker presentation model", () => {
  test("a transparent photo never becomes a sticker based on its filename or MIME", () => {
    const a = { name: "sticker.png", mime: "image/png", bytes: 100 };
    expect(normalizeStickerAttachment(a)).toEqual(a);
    expect(normalizeStickerMetadata(true)).toBeUndefined();
    expect(normalizeStickerMetadata([])).toBeUndefined();
    expect(messagePreview("\uFFFC", a)).toBe("Photo");
    expect(messagePreview("\uFFFC", { ...a, sticker: true })).toBe("Sticker");
    expect(messagePreview("caption", { ...a, sticker: true })).toBe("caption");
  });
  test("only finite bounded placement numbers reach the renderer", () => {
    expect(normalizeStickerPlacement(position)).toEqual(position);
    for (const value of [NaN, Infinity, -Infinity, true, "0.5", null, 100])
      expect(normalizeStickerPlacement({ ...position, x: value })).toBeUndefined();
    expect(normalizeStickerPlacement({ ...position, parentWidth: Infinity })).not.toHaveProperty("parentWidth");
  });
  test("labels are bounded plain text; unknown attribution is still a sticker", () => {
    expect(normalizeStickerMetadata({ source: "weird", label: "<hello>\u202e\0" })).toEqual({
      source: "unknown", label: "<hello>", animated: false,
    });
    expect(normalizeStickerMetadata({ label: "a".repeat(1000) })!.label.length).toBe(160);
    expect(normalizeStickerMetadata({ source: { toString: "not callable" } })!.source).toBe("unknown");
  });
  test("duplicates do not consume the bounded overlay budget; overflow is honest", () => {
    const input = Array.from({ length: MAX_VISIBLE_STICKERS + 9 }, (_, i) => overlay(i + 1));
    const result = normalizeStickerOverlays([null, {}, ...input, input[0], input[1]]);
    expect(result.stickers.length).toBe(MAX_VISIBLE_STICKERS);
    expect(result.overflow).toBe(9);
  });
  test("missing media survives as a labeled non-fetchable placeholder", () => {
    const s = overlay(); s.attachment.id = "not-an-id";
    const result = normalizeStickerOverlays([s]);
    expect(result.stickers[0]!.attachment.id).toBe("");
    expect(result.stickers[0]!.attachment.sticker!.label).toBe("Heart");
  });
  test("unknown body parts and absent geometry use an attached strip", () => {
    const first = overlay(1), second = { ...overlay(2), part: 2 }, third = overlay(3);
    delete third.placement;
    delete third.attachment.sticker!.placement;
    expect(placedStickers([first, second, third]).map(s => s.guid)).toEqual(["S1"]);
    expect(unplacedStickers([first, second, third]).map(s => s.guid)).toEqual(["S2", "S3"]);
  });
  test("decorating preserves sticker activity without moving message time", () => {
    const result = decorate([message({ stickers: [overlay()], activity_ts: "2026-11-06T10:01:00Z" })], "2026-11-06")[0]!;
    expect(result.ts).toBe("2026-11-06T10:00:00Z");
    expect(result.seen_ts).toBe("2026-11-06T10:01:00Z");
    expect(result.stickers[0]!.placement).toEqual(position);
    expect(result.tapbacks).toEqual([]);
  });
  test("native sticker reactions remain distinct from additive decorations", () => {
    const input = [overlay(1), { ...overlay(2), reaction: true },
      { ...overlay(3), reaction: "true" }, { ...overlay(4), reaction: true, part: 2 }];
    const normalized = normalizeStickerOverlays(input).stickers;
    expect(reactionStickers(normalized).map(s => s.guid)).toEqual(["S2", "S4"]);
    expect(placedStickers(normalized).map(s => s.guid)).toEqual(["S1", "S3"]);
    expect(unplacedStickers(normalized)).toEqual([]);
    expect(decorate([message({ stickers: normalized })], "2026-11-06")[0]!.stickers[1]!.reaction).toBe(true);
  });
  test("an unsent parent hides sticker decoration", () => {
    const b = decorate([message({ stickers: [overlay()], retracted: true })], "2026-11-06")[0]!;
    expect(b.stickers).toEqual([]);
    expect(b.stickersOverflow).toBe(0);
  });
  test("either self-thread twin keeps stickers and their read boundary", () => {
    for (const reversed of [false, true]) {
      const rows = [message({ from_me: true }), message({ stickers: [overlay()], activity_ts: "2026-11-06T10:01:00Z" })];
      const result = dedupeSelfEcho(reversed ? rows.reverse() : rows, ["+15551234567"]);
      expect(result.length).toBe(1);
      expect(result[0]!.stickers!.length).toBe(1);
      expect(result[0]!.activity_ts).toBe("2026-11-06T10:01:00Z");
    }
  });
  test("empty outbound self echo transfers its decorations to the displayed inbound", () => {
    const result = dedupeSelfEcho([
      message({ text: "", from_me: true, stickers: [overlay()], activity_ts: "2026-11-06T10:01:00Z" }),
      message({ text: "" }),
    ], ["+15551234567"]);
    expect(result.length).toBe(1);
    expect(result[0]!.stickers![0]!.guid).toBe("S1");
    expect(result[0]!.activity_ts).toBe("2026-11-06T10:01:00Z");
  });
  test("geometry preserves image aspect and clamps absurd source dimensions", () => {
    const g = stickerGeometry(position, 200, 100, 200, 100);
    expect(g.width / g.height).toBe(2);
    expect(g.rotation).toBeCloseTo(-.2 * 180 / Math.PI);
    expect(g.x).toBeGreaterThanOrEqual(0);
    expect(g.x + g.width).toBeLessThanOrEqual(200);
    const fallback = stickerGeometry(undefined, NaN, Infinity, 0, -1);
    expect(Object.values(fallback).every(v => typeof v !== "number" || Number.isFinite(v))).toBe(true);
    expect(fallback.placed).toBe(false);
    for (const rotation of [0, Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI / 3]) {
      const g = stickerGeometry({ ...position, x: 3, y: -3, scale: 4, rotation }, 80, 30, 200, 100);
      const bw = g.width * Math.abs(Math.cos(rotation)) + g.height * Math.abs(Math.sin(rotation));
      const bh = g.height * Math.abs(Math.cos(rotation)) + g.width * Math.abs(Math.sin(rotation));
      expect(g.x + g.width / 2 - bw / 2).toBeGreaterThanOrEqual(-1e-6);
      expect(g.y + g.height / 2 - bh / 2).toBeGreaterThanOrEqual(-1e-6);
      expect(g.x + g.width / 2 + bw / 2).toBeLessThanOrEqual(80 + 1e-6);
      expect(g.y + g.height / 2 + bh / 2).toBeLessThanOrEqual(30 + 1e-6);
    }
  });
});

// Deliberately tiny container headers for parser/runner tests. Pixel decoding
// is covered by scripts/test-sticker-ui.py with generated, valid media.
function png(frames = 1, width = 64, height = 64): Buffer {
  const chunk = (type: string, body: Buffer) => {
    const b = Buffer.alloc(12 + body.length); b.writeUInt32BE(body.length); b.write(type, 4); body.copy(b, 8); return b;
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const actl = Buffer.alloc(8); actl.writeUInt32BE(frames);
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr),
    ...(frames > 1 ? [chunk("acTL", actl)] : []), chunk("IDAT", Buffer.alloc(0))]);
}
function webp(): Buffer {
  const b = Buffer.alloc(40); b.write("RIFF", 0); b.writeUInt32LE(32, 4); b.write("WEBPVP8X", 8);
  b.writeUInt32LE(10, 16); b[20] = 0x12; b.writeUIntLE(63, 24, 3); b.writeUIntLE(31, 27, 3); return b;
}
const cap = 5 * 1024 * 1024;
let nextId = 80000;
const id = () => String(nextId++);

describe("alpha and animated sticker fetches", () => {
  test("HEIC and HEICS sticker transforms have PNG filenames; photos retain JPEG", () => {
    expect(wantsStickerPng("image/heic-sequence")).toBe(true);
    expect(cacheFileName("1", "evil.desktop", "image/heic", false, true)).toBe("1-png-evil.png");
    expect(cacheFileName("1", "same.heic", "image/heic")).toBe("1-jpg-same.jpg");
  });
  test("sticker attribution never admits SVG or MIME-spoofed external-resource media", () => {
    let calls = 0;
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.invalid/private"/></svg>');
    const runner = (() => { calls++; return { status: 0, stdout: svg }; }) as never;
    expect(fetchAttachment(id(), "unsafe.svg", "image/svg+xml", runner, cap, true).ok).toBe(false);
    expect(calls).toBe(0);
    for (const mime of ["image/png", "image/gif", "image/jpeg", "image/webp", "image/heic"])
      expect(fetchAttachment(id(), "fake.png", mime, runner, cap, true).ok).toBe(false);
    expect(fetchAttachment(id(), "wrong.gif", "image/gif", (() => ({ status: 0, stdout: png() })) as never, cap, true).ok).toBe(false);
    expect(fetchAttachment(id(), "zero.png", "image/png", (() => ({ status: 0, stdout: png(1, 0, 0) })) as never, cap, true).ok).toBe(false);
  });
  test("cached sticker bytes are revalidated instead of trusting their extension", () => {
    const aid = id();
    mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    const file = join(CACHE_DIR, cacheFileName(aid, "cached.png", "image/png"));
    writeFileSync(file, '<svg xmlns="http://www.w3.org/2000/svg"/>', { mode: 0o600 });
    let called = false;
    const result = fetchAttachment(aid, "cached.png", "image/png", (() => { called = true; throw Error("unexpected"); }) as never, cap, true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("raster");
    expect(called).toBe(false);
  });
  test("transparent PNG stickers avoid sips JPEG preview, on first fetch and cache hit", () => {
    const calls: string[][] = [];
    const runner = ((_cmd: string, args: string[]) => { calls.push(args); return { status: 0, stdout: png() }; }) as never;
    const aid = id();
    const result = fetchAttachment(aid, "sticker.png", "image/png", runner, cap, true);
    expect(result.ok).toBe(true);
    expect(calls).toEqual([["attachment", aid]]);
    expect(result.renderMime).toBe("image/png");
    expect(readFileSync(result.path)).toEqual(png());
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
    expect(fetchAttachment(aid, "sticker.png", "image/png", runner, cap, true).url).toBe(result.url);
    expect(calls.length).toBe(1);
  });
  test("HEIC sticker asks for PNG and can be saved as a full-size converted original", () => {
    const calls: string[][] = [];
    const runner = ((_cmd: string, args: string[]) => { calls.push(args); return { status: 0, stdout: png() }; }) as never;
    const aid = id();
    const result = fetchAttachment(aid, "sticker.heic", "image/heic", runner, cap, true);
    expect(calls).toEqual([["attachment", aid, "--png", "--max-dim", "2048"]]);
    expect(result.renderMime).toBe("image/png");
    expect(result.path).toContain("-png-");
    expect(cachedOriginal(result.path)).toBe(result.path);
  });
  test("APNG auto-preview becomes animated WebP; copy/save retains original PNG", () => {
    const calls: any[] = [];
    const runner = ((cmd: string, args: string[], options: any) => {
      calls.push({ cmd, args, options });
      if (cmd === "ffmpeg") {
        const input = args[args.indexOf("-i") + 1]!;
        expect(readFileSync(input)).toEqual(png(2));
        expect(statSync(input).mode & 0o777).toBe(0o600);
      }
      return { status: 0, stdout: cmd === "ffmpeg" ? webp() : png(2) };
    }) as never;
    const aid = id();
    const result = fetchAttachment(aid, "animated.png", "image/png", runner, cap, true);
    expect(result.renderMime).toBe("image/webp"); expect(result.animated).toBe(true);
    expect(result.path).toContain("-anim-");
    expect(calls[1].options.input).toBeUndefined();
    expect(calls[1].args).toContain("-ignore_loop");
    expect(readdirSync(CACHE_DIR).some(n => n.startsWith(".sticker-"))).toBe(false);
    expect(calls[1].args).toContain("-lossless");
    expect(() => cachedOriginal(result.path)).toThrow("original");
    const original = fetchAttachment(aid, "animated.png", "image/png", runner, FETCH_MAX_BYTES, true);
    expect(original.renderMime).toBe("image/png");
    expect(readFileSync(original.path)).toEqual(png(2));
    expect(cachedOriginal(original.path)).toBe(original.path);
    const count = calls.length;
    expect(fetchAttachment(aid, "animated.png", "image/png", runner, cap, true).path).toBe(result.path);
    expect(calls.length).toBe(count);
  });
  test("an APNG cached by copy converts locally without another bridge read", () => {
    const aid = id();
    fetchAttachment(aid, "loop.png", "image/png", (() => ({ status: 0, stdout: png(2) })) as never, FETCH_MAX_BYTES, true);
    const calls: string[] = [];
    const r = fetchAttachment(aid, "loop.png", "image/png", ((cmd: string) => {
      calls.push(cmd); return { status: 0, stdout: webp() };
    }) as never, cap, true);
    expect(calls).toEqual(["ffmpeg"]);
    expect(r.animated).toBe(true);
  });
  test("malformed headers cannot make the parser read past the buffer", () => {
    for (let end = 0; end < png(2).length; end++) expect(() => imageAnimation(png(2).subarray(0, end))).not.toThrow();
    const malformed = png(2); malformed.writeUInt32BE(0xffffffff, 8);
    expect(imageAnimation(malformed).animated).toBe(false);
    expect(imageMetrics(webp(), "image/webp")).toEqual({ pixelWidth: 64, pixelHeight: 32, pixelRatio: 1 });
  });
  test("huge APNG dimensions or frame counts never enter a decoder", () => {
    let calls = 0;
    const runner = (() => { calls++; throw Error("must not run"); }) as never;
    for (const bytes of [png(101), png(2, 100000, 100000), png(100, 2048, 2048)]) {
      const r = stickerAnimationPreview(bytes, runner);
      expect(r.unavailable).toBe(true); expect(r.bytes).toBe(bytes);
    }
    expect(calls).toBe(0);
  });
  test("missing decoder, timeout, corrupt output, and large output preserve a transparent still", () => {
    for (const behavior of ["missing", "timeout", "corrupt", "large"]) {
      const runner = ((cmd: string, _args: string[], opts: any) => {
        if (cmd !== "ffmpeg") return { status: 0, stdout: png(2) };
        expect(opts.timeout).toBe(30000); expect(opts.maxBuffer).toBeLessThanOrEqual(FETCH_MAX_BYTES + (1 << 20));
        if (behavior === "missing") throw Error("ENOENT");
        if (behavior === "timeout") return { status: null, stdout: Buffer.alloc(0), error: Error("ETIMEDOUT") };
        if (behavior === "large") return { status: 0, stdout: Buffer.concat([webp(), Buffer.alloc(cap)]) };
        return { status: 0, stdout: Buffer.from("not an image") };
      }) as never;
      const r = fetchAttachment(id(), "loop.png", "image/png", runner, cap, true);
      expect(r.ok).toBe(true); expect(r.animationUnavailable).toBe(true);
      expect(r.renderMime).toBe("image/png"); expect(readFileSync(r.path)).toEqual(png(2));
      expect(readdirSync(CACHE_DIR).some(n => n.startsWith(".sticker-"))).toBe(false);
    }
  });
  test("HEICS failure asks the Mac for a transparent still and names the lost motion", () => {
    const calls: any[] = [];
    const runner = ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (cmd === "ffprobe") return { status: 1, stdout: "" };
      return { status: 0, stdout: args.includes("--png") ? png() : Buffer.from("synthetic sequence") };
    }) as never;
    const aid = id(), r = fetchAttachment(aid, "live.heics", "image/heic-sequence", runner, cap, true);
    expect(r.ok).toBe(true); expect(r.renderMime).toBe("image/png"); expect(r.animationUnavailable).toBe(true);
    expect(calls[0].args).toEqual(["attachment", aid]);
    expect(calls.at(-1).args).toEqual(["attachment", aid, "--png", "--max-dim", "2048"]);
    expect(readdirSync(CACHE_DIR).some(n => n.startsWith(".sticker-"))).toBe(false);
  });
  test("HEICS color and alpha tracks are selected only after bounded metadata validation", () => {
    const dir = mkdtempSync(join(tmpdir(), "blip-sticker-sequence-"));
    const streams = Array.from({ length: 4 }, (_, index) => ({ index, codec_type: "video", width: 64, height: 32,
      pix_fmt: index % 2 ? "gray" : "yuv420p", nb_frames: "5", duration: "1" }));
    const calls: any[] = [];
    const runner = ((cmd: string, args: string[], opts: any) => {
      calls.push({ cmd, args, opts });
      if (cmd === "ffprobe") { expect(statSync(args.at(-1)!).mode & 0o777).toBe(0o600); return { status: 0, stdout: JSON.stringify({ streams }) }; }
      return { status: 0, stdout: webp() };
    }) as never;
    try {
      expect(stickerSequencePreview(Buffer.from("media"), "image/heics", runner, dir)?.renderMime).toBe("image/webp");
      expect(calls[1].args).toContain("[0:2][0:3]alphamerge,format=rgba[out]");
      expect(calls[1].args).toContain("file,pipe");
      expect(readdirSync(dir)).toEqual([]);
      streams[2]!.width = 999999;
      calls.length = 0;
      expect(stickerSequencePreview(Buffer.from("media"), "image/heics", runner, dir)).toBeUndefined();
      expect(calls.length).toBe(1);
      expect(readdirSync(dir)).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

test("decoder frame budget does not trust advertised APNG count", () => {
  stickerAnimationPreview(png(2, 1024, 1024), ((_cmd: string, args: string[]) => {
    expect(args[args.indexOf("-frames:v") + 1]).toBe("61");
    expect(args[args.indexOf("-max_pixels") + 1]).toBe("4194304");
    return {status: 0, stdout: webp()};
  }) as never);
});
test("MOV input gate, pixel ceiling, and independent sequence limits", () => {
  for (const [width, height, count, seconds, animated] of [
    [2048, 2048, 2, 1, true], [2049, 2049, 2, 1, false],
    [64, 64, 100, 8, true], [64, 64, 101, 8, false],
    [64, 64, 100, 8.01, false], [1024, 1024, 62, 1, false],
  ] as const) {
    let decoded = false;
    const r = stickerSequencePreview(Buffer.from("media"), "video/quicktime", ((cmd: string, args: string[]) => {
      expect(args[args.indexOf("-f") + 1]).toBe("mov");
      expect(args.indexOf("-f")).toBeLessThan(args.indexOf("-i"));
      expect(args[args.indexOf("-max_pixels") + 1]).toBe("4194304");
      if (cmd === "ffprobe") return {status: 0, stdout: JSON.stringify({streams:[{index:0, codec_type:"video", width,height,nb_frames:String(count),duration:String(seconds)}]})};
      decoded = true;
      if (animated) expect(Number(args[args.indexOf("-frames:v") + 1]) * width * height).toBeLessThanOrEqual(64_000_000);
      return {status:0, stdout:args.includes("libwebp_anim") ? webp() : png()};
    }) as never);
    expect(r?.renderMime === "image/webp").toBe(animated);
    expect(decoded).toBe(width <= 2048);
  }
});
test("failed APNG conversion is cached as a still", () => {
  const aid=id(); let calls=0;
  const runner=((cmd:string)=>{calls++; return {status:cmd === "ffmpeg" ? 1 : 0, stdout:png(2)};}) as never;
  expect(fetchAttachment(aid,"failure.png","image/png",runner,cap,true).animationUnavailable).toBe(true);
  const before=calls;
  expect(fetchAttachment(aid,"failure.png","image/png",runner,cap,true).animationUnavailable).toBe(true);
  expect(calls).toBe(before);
});

test("a failed video decode is not retried on every thread open", () => {
  const aid=id(); let calls=0;
  const runner=((cmd:string)=>{calls++; return {status:cmd === "ffprobe" ? 1 : 0, stdout:Buffer.from("ffconcat version 1.0\nfile other.png")};}) as never;
  expect(fetchAttachment(aid,"fake.mov","video/quicktime",runner,cap,true).ok).toBe(false);
  const before=calls;
  expect(fetchAttachment(aid,"fake.mov","video/quicktime",runner,cap,true).ok).toBe(false);
  expect(calls).toBe(before);
});
test("the real MOV demuxer refuses a concat payload", () => {
  expect(stickerSequencePreview(Buffer.from("ffconcat version 1.0\nfile other.png"),"video/quicktime")).toBeUndefined();
});

test("a non-sticker GIF cached by Open remains a hit above the auto-fetch ceiling", () => {
  const aid=id(); mkdirSync(CACHE_DIR,{recursive:true,mode:0o700});
  const path=join(CACHE_DIR,cacheFileName(aid,"large.gif","image/gif"));
  const bytes=Buffer.alloc(6*1024*1024); bytes.write("GIF89a"); bytes.writeUInt16LE(64,6); bytes.writeUInt16LE(64,8);
  writeFileSync(path,bytes,{mode:0o600});
  expect(fetchAttachment(aid,"large.gif","image/gif",(()=>{throw Error("cache miss");}) as never,cap).ok).toBe(true);
});
test("static sticker edge checks are independent of animation and mask checks", () => {
  for (const width of [2048,2049]) {
    const r=fetchAttachment(id(),"edge.png","image/png",(()=>({status:0,stdout:png(1,width,64)})) as never,cap,true);
    expect(r.ok).toBe(width === 2048);
  }
});
