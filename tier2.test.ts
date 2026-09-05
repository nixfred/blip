import { describe, expect, test } from "bun:test";

import { CACHE_DIR, bakeOrientation, cacheFileName, exifOrientation, fetchAttachment, imageMetrics, isImageMime, jpegtranArgs, lruEvictions, sanitizeName, wantsJpeg } from "./fetch";
import { extFor, existingLocalFile, firstFileUri, localFileFromPayload, pickFileType, pickImageType, snapshotClipboard } from "./paste";
import { resolveTarget, sendFile } from "./send-file";
import { linkHost, linkify, normalizeLink, selectThread } from "./thread";
import {
  decodeEntities,
  hostOf,
  isPrivateAddress,
  parseCard,
  previewsEnabled,
  previewKey,
  safeUrl,
  sniffImage,
} from "./linkpreview";
import { AVATAR_DIR, AVATAR_NONE_TTL_MS, AVATAR_TTL_MS, avatarArgs, avatarKey, fetchAvatar } from "./avatar";
import { readFileSync, writeFileSync, unlinkSync, utimesSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// A real 16×8 baseline JPEG (ImageMagick, -strip): no APP1 at all.
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABsSFBcUERsXFhceHBsgKEIrKCUlKFE6PTBCYFVlZF9VXVtqeJmBanGQc1tdhbWGkJ6jq62rZ4C8ybqmx5moq6T/2wBDARweHigjKE4rK06kbl1upKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKT/wAARCAAIABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABAb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCAANSP/9k=",
  "base64",
);

/** Insert an APP1 Exif segment carrying just an Orientation tag after SOI. */
function withExif(jpeg: Buffer, orientation: number, littleEndian = true): Buffer {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  const w16 = (o: number, v: number) => (littleEndian ? tiff.writeUInt16LE(v, o) : tiff.writeUInt16BE(v, o));
  const w32 = (o: number, v: number) => (littleEndian ? tiff.writeUInt32LE(v, o) : tiff.writeUInt32BE(v, o));
  tiff.write(littleEndian ? "II" : "MM", 0, "latin1");
  w16(2, 0x2a); w32(4, 8);          // IFD0 at offset 8
  w16(8, 1);                        // one entry
  w16(10, 0x0112); w16(12, 3); w32(14, 1); w16(18, orientation); w16(20, 0);
  w32(22, 0);                       // no IFD1
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const seg = Buffer.alloc(4);
  seg[0] = 0xff; seg[1] = 0xe1; seg.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), seg, body, jpeg.subarray(2)]);
}

/** Width × height from the SOF0/SOF2 marker. */
function sofSize(b: Buffer): [number, number] {
  for (let p = 2; p + 9 < b.length; ) {
    const m = b[p + 1];
    const len = b.readUInt16BE(p + 2);
    if (m === 0xc0 || m === 0xc2) return [b.readUInt16BE(p + 7), b.readUInt16BE(p + 5)];
    p += 2 + len;
  }
  return [0, 0];
}

describe("fetch cache", () => {
  test("HEIC wants a Mac-side JPEG conversion, others stream raw", () => {
    expect(wantsJpeg("image/heic")).toBe(true);
    expect(wantsJpeg("image/heif")).toBe(true);
    expect(wantsJpeg("image/png")).toBe(false);
    expect(wantsJpeg("application/pdf")).toBe(false);
  });

  test("cache names separate the jpeg transform from the original", () => {
    const orig = cacheFileName("42", "IMG_1.png", "image/png");
    const conv = cacheFileName("42", "IMG_1.heic", "image/heic");
    expect(orig).toBe("42-orig-IMG_1.png");
    expect(conv).toBe("42-jpg-IMG_1.jpg");   // extension follows the delivered format
    expect(orig).not.toBe(conv);
  });

  test("retina PNG density becomes a logical-pixel ratio", () => {
    const png = Buffer.alloc(54);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8); Buffer.from("IHDR").copy(png, 12);
    png.writeUInt32BE(1206, 16); png.writeUInt32BE(1728, 20);
    png.writeUInt32BE(9, 33); Buffer.from("pHYs").copy(png, 37);
    png.writeUInt32BE(5669, 41); png.writeUInt32BE(5669, 45); png[49] = 1;
    expect(imageMetrics(png, "image/png")).toEqual({
      pixelWidth: 1206, pixelHeight: 1728, pixelRatio: 2,
    });
  });

  test("ordinary PNG density stays at one logical pixel per source pixel", () => {
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8); Buffer.from("IHDR").copy(png, 12);
    png.writeUInt32BE(800, 16); png.writeUInt32BE(600, 20);
    expect(imageMetrics(png, "image/png")).toEqual({
      pixelWidth: 800, pixelHeight: 600, pixelRatio: 1,
    });
  });

  test("sanitizeName strips traversal and hidden-file tricks", () => {
    expect(sanitizeName("../../etc/passwd")).toBe("etc_passwd");
    expect(sanitizeName(".hidden")).toBe("hidden");
    expect(sanitizeName("")).toBe("file");
    expect(sanitizeName("ok name.png")).toBe("ok_name.png");
  });

  test("LRU evicts oldest first, never the just-written file", () => {
    const entries = [
      { name: "old", bytes: 60, mtimeMs: 1 },
      { name: "keepme", bytes: 60, mtimeMs: 2 },
      { name: "new", bytes: 60, mtimeMs: 3 },
    ];
    expect(lruEvictions(entries, 130, "keepme")).toEqual(["old"]);
    expect(lruEvictions(entries, 70, "keepme")).toEqual(["old", "new"]);
    expect(lruEvictions(entries, 500, "keepme")).toEqual([]);
  });

  test("rejects a non-decimal id before ever spawning", () => {
    let spawned = false;
    const runner = (() => { spawned = true; return { status: 0, stdout: Buffer.from("x") }; }) as never;
    const r = fetchAttachment("1 OR 1=1", "x", "image/png", runner);
    expect(r.ok).toBe(false);
    expect(spawned).toBe(false);
  });

  test("an auto-fetch cap rejects a stream larger than claimed (Codex audit #9)", () => {
    const runner = (() => ({ status: 0, stdout: Buffer.alloc(6 * 1024 * 1024), stderr: "" })) as never;
    const r = fetchAttachment("123456789012346", "big.png", "image/png", runner, 5 * 1024 * 1024);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ceiling/);
  });

  test("offline exit codes report online:false", () => {
    const runner = (() => ({ status: 69, stdout: Buffer.alloc(0), stderr: "" })) as never;
    const r = fetchAttachment("123456789012345", "x.png", "image/png", runner);
    expect(r.ok).toBe(false);
    expect(r.online).toBe(false);
  });
});

describe("EXIF orientation is baked into cached JPEGs", () => {
  test("orientation is read from APP1 in either byte order; anything else is 1", () => {
    expect(exifOrientation(TINY_JPEG)).toBe(1);
    expect(exifOrientation(withExif(TINY_JPEG, 6))).toBe(6);
    expect(exifOrientation(withExif(TINY_JPEG, 8, false))).toBe(8);
    expect(exifOrientation(withExif(TINY_JPEG, 9))).toBe(1);        // out of range
    expect(exifOrientation(withExif(TINY_JPEG, 6).subarray(0, 20))).toBe(1);  // truncated
    expect(exifOrientation(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBe(1);  // PNG
    expect(exifOrientation(Buffer.alloc(0))).toBe(1);
  });

  test("each orientation maps to its lossless jpegtran transform", () => {
    expect(jpegtranArgs(1)).toBeNull();
    expect(jpegtranArgs(3)).toEqual(["-rotate", "180"]);
    expect(jpegtranArgs(6)).toEqual(["-rotate", "90"]);   // iPhone portrait
    expect(jpegtranArgs(8)).toEqual(["-rotate", "270"]);
    expect(jpegtranArgs(5)).toEqual(["-transpose"]);
    expect(jpegtranArgs(0)).toBeNull();
  });

  test("upright and non-JPEG bytes never spawn jpegtran", () => {
    let spawned = 0;
    const runner = (() => { spawned++; return { status: 0, stdout: Buffer.alloc(0) }; }) as never;
    expect(bakeOrientation(TINY_JPEG, runner)).toBe(TINY_JPEG);
    expect(bakeOrientation(Buffer.from("not a jpeg"), runner)).toEqual(Buffer.from("not a jpeg"));
    expect(spawned).toBe(0);
  });

  test("a fetched portrait photo is cached rotated, ICC kept, EXIF dropped", () => {
    const tagged = withExif(TINY_JPEG, 6);
    const rotated = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from("ROTATED")]);
    let seen: { args: string[]; input: Buffer } | null = null;
    const runner = ((cmd: string, args: string[], opts: { input?: Buffer }) => {
      if (cmd === "jpegtran") { seen = { args, input: opts.input! }; return { status: 0, stdout: rotated, stderr: "" }; }
      return { status: 0, stdout: tagged, stderr: "" };
    }) as never;
    const r = fetchAttachment("123456789012347", "IMG_1.heic", "image/heic", runner);
    expect(r.ok).toBe(true);
    expect(seen!.args).toEqual(["-rotate", "90", "-trim", "-copy", "icc"]);
    expect(seen!.input.equals(tagged)).toBe(true);           // bytes on stdin, never argv
    expect(readFileSync(join(CACHE_DIR, cacheFileName("123456789012347", "IMG_1.heic", "image/heic"))).equals(rotated)).toBe(true);
  });

  test("an old jpegtran that rejects -copy icc gets a -copy none retry", () => {
    const seen: string[][] = [];
    const runner = ((_c: string, args: string[]) => {
      seen.push(args);
      if (args.includes("icc")) return { status: 1, stdout: Buffer.alloc(0), stderr: "Invalid argument" };
      return { status: 0, stdout: Buffer.from([0xff, 0xd8, 0xff, 0xdb, 9, 9]), stderr: "" };
    }) as never;
    const out = bakeOrientation(withExif(TINY_JPEG, 6), runner);
    expect(seen.length).toBe(2);
    expect(seen[0]).toContain("icc");
    expect(seen[1]).toContain("none");
    expect(out[0]).toBe(0xff);
    expect(out.length).toBe(6);
  });

  test("when jpegtran is missing or fails, the original bytes are cached", () => {
    const tagged = withExif(TINY_JPEG, 6);
    const runner = ((cmd: string) =>
      cmd === "jpegtran" ? { status: null, stdout: null, error: new Error("ENOENT") } : { status: 0, stdout: tagged, stderr: "" }) as never;
    const r = fetchAttachment("123456789012348", "IMG_2.heic", "image/heic", runner);
    expect(r.ok).toBe(true);
    expect(readFileSync(r.path).equals(tagged)).toBe(true);
  });

  // Capability probe, not presence: the GitHub runner's jpegtran exists but
  // cannot transform this fixture (it left the bytes untouched and CI went red
  // for every push after #9). Skip when the local jpegtran can't do the job.
  const probe = spawnSync("jpegtran", ["-rotate", "90", "-trim", "-copy", "none"], { input: withExif(TINY_JPEG, 6) });
  const haveJpegtran = probe.status === 0 && !!probe.stdout && (probe.stdout as Buffer).length > 4;
  test.skipIf(!haveJpegtran)("real jpegtran turns a tagged 16×8 into an upright 8×16", () => {
    const out = bakeOrientation(withExif(TINY_JPEG, 6));
    expect(sofSize(withExif(TINY_JPEG, 6))).toEqual([16, 8]);
    expect(sofSize(out)).toEqual([8, 16]);
    expect(exifOrientation(out)).toBe(1);                    // tag gone: no double rotation in Qt
  });
});

describe("clipboard file paste", () => {
  test("prefers a GNOME file object over URI-list and text", () => {
    expect(pickFileType(["text/plain", "text/uri-list", "x-special/gnome-copied-files"]))
      .toBe("x-special/gnome-copied-files");
  });

  test("extracts an existing local file from both supported payloads", () => {
    const tmp = `${process.env.XDG_CACHE_HOME}/blip-paste-${process.pid}.vcf`;
    writeFileSync(tmp, "BEGIN:VCARD\nEND:VCARD\n");
    const uri = new URL(`file://${tmp}`).href;
    try {
      expect(localFileFromPayload("x-special/gnome-copied-files", `copy\n${uri}\n`)).toBe(tmp);
      expect(localFileFromPayload("text/uri-list", `# contact\r\n${uri}\r\n`)).toBe(tmp);
    } finally { unlinkSync(tmp); }
  });

  test("rejects remote URIs and missing local files", () => {
    expect(localFileFromPayload("text/uri-list", "https://example.com/person.vcf\n")).toBe("");
    expect(localFileFromPayload("text/uri-list", "file:///definitely/missing/person.vcf\n")).toBe("");
  });

  test("snapshot returns a file attachment before attempting text", () => {
    const tmp = `${process.env.XDG_CACHE_HOME}/blip-snapshot-${process.pid}.vcf`;
    writeFileSync(tmp, "BEGIN:VCARD\nEND:VCARD\n");
    const calls: string[][] = [];
    const runner = ((_cmd: string, args: string[]) => {
      calls.push(args);
      if (args.includes("--list-types")) {
        return { status: 0, stdout: "text/plain\nx-special/gnome-copied-files\n" };
      }
      return { status: 0, stdout: `copy\n${new URL(`file://${tmp}`).href}\n` };
    }) as never;
    try {
      expect(snapshotClipboard(runner)).toMatchObject({ kind: "file", path: tmp, name: basename(tmp) });
      expect(calls.some((args) => args.includes("text"))).toBe(false);
    } finally { unlinkSync(tmp); }
  });
});

describe("send-file caption transport", () => {
  test("caption travels on stdin ahead of the file, never in argv (audit #4)", () => {
    let seen: { args: string[]; input: Buffer } | null = null;
    const runner = ((_cmd: string, args: string[], opts: { input: Buffer }) => {
      seen = { args, input: opts.input };
      return { status: 0, stdout: "", stderr: "" };
    }) as never;
    const tmp = `${process.env.XDG_CACHE_HOME}/blip-test-${process.pid}.txt`;
    writeFileSync(tmp, "FILEBYTES");
    try {
      const r = sendFile("+15551234567", tmp, "héllo", runner);
      expect(r.ok).toBe(true);
      expect(seen!.args.join(" ")).not.toContain("héllo");
      const capLen = Buffer.byteLength("héllo", "utf8");
      expect(seen!.args).toContain("--text-stdin-bytes");
      expect(seen!.args[seen!.args.indexOf("--text-stdin-bytes") + 1]).toBe(String(capLen));
      expect(seen!.input.subarray(0, capLen).toString("utf8")).toBe("héllo");
      expect(seen!.input.subarray(capLen).toString("utf8")).toBe("FILEBYTES");
    } finally { unlinkSync(tmp); }
  });
});

describe("send-file target resolution", () => {
  test("DM sends --to the chat handle", () => {
    expect(resolveTarget("+15551234567", {})).toEqual({ args: ["--to", "+15551234567"], error: "" });
  });

  test("group with a cached guid sends --chat-id", () => {
    const groups = { abcdef0123456789abcdef0123456789: { guid: "any;+;abcdef0123456789abcdef0123456789" } };
    expect(resolveTarget("abcdef0123456789abcdef0123456789", groups).args[0]).toBe("--chat-id");
  });

  test("group WITHOUT a guid is refused — never falls back to a handle", () => {
    const r = resolveTarget("abcdef0123456789abcdef0123456789", {});
    expect(r.args).toEqual([]);
    expect(r.error).toContain("refusing");
  });

  test("chat<digits> group shape is also refused without a guid", () => {
    expect(resolveTarget("chat16857519591879963", {}).error).toContain("refusing");
  });
});

describe("search shaping", () => {
  const { snippet, shapeResults } = require("./search") as typeof import("./search");

  test("short text passes through untrimmed", () => {
    expect(snippet("hello there", "hello")).toBe("hello there");
  });

  test("long text centers the snippet on the match", () => {
    const long = "x".repeat(200) + " birthday cake " + "y".repeat(200);
    const s = snippet(long, "birthday");
    expect(s).toContain("birthday");
    expect(s.length).toBeLessThanOrEqual(100);
    expect(s.startsWith("…")).toBe(true);
  });

  test("attachment-only rows (placeholder char) are dropped", () => {
    const rows = [
      { ts: "2026-08-31 10:00:00", from_me: false, handle: "+15551234567", name: "A",
        service: "iMessage", chat: "+15551234567", text: "￼" },
      { ts: "2026-08-31 10:01:00", from_me: true, handle: "+15551234567", name: "A",
        service: "iMessage", chat: "+15551234567", text: "real match" },
    ] as never[];
    const out = shapeResults(rows, "match", 10);
    expect(out.length).toBe(1);
    expect(out[0]!.text).toBe("real match");
    expect(out[0]!.from_me).toBe(true);
  });

  test("group hits are flagged and limit respected", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      ts: `2026-08-31 10:0${i}:00`, from_me: false, handle: "+15551234567", name: "G",
      service: "iMessage", chat: "abcdef0123456789abcdef0123456789", text: `hit ${i}`,
    })) as never[];
    const out = shapeResults(rows, "hit", 3);
    expect(out.length).toBe(3);
    expect(out[0]!.group).toBe(true);
  });

  test("whole-word hits outrank substring hits, ignoring case", () => {
    const { messageMatchScore, shapeResults: shape } = require("./search") as typeof import("./search");
    expect(messageMatchScore("cat", "The cat sat down.")).toBeGreaterThan(
      messageMatchScore("cat", "A scatter of leaves."),
    );
    const rows = [
      { ts: "2026-08-28 17:29:00", from_me: false, handle: "+15550001111", name: "Alice",
        service: "iMessage", chat: "group-a", text: "A scatter of leaves." },
      { ts: "2026-05-18 16:34:00", from_me: true, handle: "+15550002222", name: "Bob",
        service: "iMessage", chat: "+15550002222", text: "The cat sat down." },
    ] as never[];
    const out = shape(rows, "cat", 10);
    expect(out[0]!.text).toContain("cat sat");
    expect(out[1]!.text).toContain("scatter");
  });

  test("query case does not change whole-word recency order", () => {
    const { shapeResults: shape } = require("./search") as typeof import("./search");
    const rows = [
      { ts: "2026-05-25 22:20:00", from_me: false, handle: "+15550001111", name: "Alice",
        service: "iMessage", chat: "group-a", text: "Alice thanks Bob." },
      { ts: "2026-08-25 20:45:00", from_me: false, handle: "+15550002222", name: "Bob",
        service: "iMessage", chat: "+15550002222", text: "Thanks" },
    ] as never[];
    const lower = shape(rows, "thanks", 10).map((h) => h.ts);
    const titled = shape(rows, "Thanks", 10).map((h) => h.ts);
    expect(lower).toEqual(titled);
    expect(lower[0]).toBe("2026-08-25 20:45:00");
  });

  test("same match quality ties break on message time, not thread order", () => {
    const { shapeResults: shape } = require("./search") as typeof import("./search");
    const rows = [
      { ts: "2025-07-15 17:24:00", from_me: false, handle: "+15550001111", name: "Alice",
        service: "iMessage", chat: "quiet-old-thread", text: "Thanks everyone." },
      { ts: "2026-05-25 22:20:00", from_me: false, handle: "+15550002222", name: "Bob",
        service: "iMessage", chat: "busy-new-thread", text: "Alice thanks Bob." },
    ] as never[];
    const out = shape(rows, "thanks", 10);
    expect(out[0]!.name).toBe("Bob");
    expect(out[1]!.name).toBe("Alice");
  });

  test("matchConversations finds people by name, not by last message", () => {
    const { matchConversations } = require("./search") as typeof import("./search");
    const threads = [
      { chat: "+15550001111", name: "Alice", handle: "+15550001111", last_text: "see you in the car" },
      { chat: "+15550002222", name: "Carol", handle: "+15550002222", last_text: "hi" },
      { chat: "+15550003333", name: "Bob", handle: "+15550003333", last_text: "carol said no" },
    ];
    const hits = matchConversations(threads, "car");
    expect(hits.map((h) => h.name)).toEqual(["Carol"]);
    expect(hits[0]!.kind).toBe("conversation");
  });

  test("matchConversations fuzzy-matches a subsequence on the handle", () => {
    const { matchConversations } = require("./search") as typeof import("./search");
    const hits = matchConversations(
      [{ chat: "+15551234567", name: "Dad", handle: "+15551234567" }],
      "dad",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.chat).toBe("+15551234567");
  });

  test("runSearch prepends conversation matches from the thread list", () => {
    const { runSearch } = require("./search") as typeof import("./search");
    const runner = () => ({
      status: 0,
      stdout: JSON.stringify([{
        ts: "2026-05-01 10:00:00", from_me: false, handle: "+15550002222", name: "Bob",
        service: "iMessage", chat: "+15550002222", text: "the car is red",
      }]),
      stderr: "",
    });
    const out = runSearch("car", 10, runner as never, [
      { chat: "+15550001111", name: "Carol", handle: "+15550001111" },
    ]);
    expect(out.ok).toBe(true);
    expect(out.results[0]!.name).toBe("Carol");
    expect(out.results[0]!.kind).toBe("conversation");
    expect(out.results[1]!.name).toBe("Bob");
    expect(out.results[1]!.kind).toBe("message");
  });

  test("mergeSearchResults puts conversations above messages", () => {
    const { mergeSearchResults } = require("./search") as typeof import("./search");
    const people = [{
      chat: "+1", name: "Ann", handle: "+1", service: "iMessage",
      ts: "", from_me: false, text: "hey", group: false, kind: "conversation" as const,
    }];
    const msgs = [{
      chat: "+2", name: "Bob", handle: "+2", service: "iMessage",
      ts: "2026-09-02 10:00:00", from_me: true, text: "ann called", group: false,
    }];
    const out = mergeSearchResults(people, msgs);
    expect(out.map((h) => h.name)).toEqual(["Ann", "Bob"]);
    expect(out[0]!.kind).toBe("conversation");
    expect(out[1]!.kind).toBe("message");
  });
});

describe("contact search shaping", () => {
  const { directHandle, normalizeHandle, shapeContacts, rankByRecency, fuzzyScore, filterFuzzy } =
    require("./contact-search") as typeof import("./contact-search");

  test("US numbers normalize to E.164 like chat.db handles", () => {
    expect(normalizeHandle("(404) 555-0123")).toBe("+14045550123");
    expect(normalizeHandle("404.555.0123")).toBe("+14045550123");
    expect(normalizeHandle("1 404 555 0123")).toBe("+14045550123");
    expect(normalizeHandle("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizeHandle("Mom@iCloud.COM")).toBe("mom@icloud.com");
  });

  test("ambiguous numbers are DROPPED, never rewritten (wrong-recipient guard)", () => {
    expect(normalizeHandle("404-555-0100 ext 4")).toBe("");
    expect(normalizeHandle("404 555 0123 x12")).toBe("");
    expect(normalizeHandle("555-0100")).toBe("");          // 7 digits: ambiguous
    expect(normalizeHandle("12345678901234567")).toBe(""); // absurd length
  });

  test("a query that IS a handle gets a direct-entry row first", () => {
    const out = shapeContacts([], "404-555-0100");
    expect(out[0]).toEqual({ name: "+14045550100", handle: "+14045550100", kind: "direct entry" });
    expect(directHandle("somebody@example.com")).toBe("somebody@example.com");
    expect(directHandle("mom")).toBe("");
  });

  test("each phone and email becomes its own row; Apple labels unwrap", () => {
    const out = shapeContacts(
      [{ name: "Mom", phones: [{ number: "(404) 555-0123", label: "_$!<Mobile>!$_" }],
         emails: ["mom@example.com"] }],
      "mom",
    );
    expect(out).toEqual([
      { name: "Mom", handle: "+14045550123", kind: "mobile" },
      { name: "Mom", handle: "mom@example.com", kind: "email" },
    ]);
  });

  test("duplicate handles across contacts collapse", () => {
    const out = shapeContacts(
      [{ name: "A", phones: [{ number: "4045550100", label: "" }] },
       { name: "B", phones: [{ number: "+14045550100", label: "" }] }],
      "x",
    );
    expect(out.length).toBe(1);
  });

  test("rankByRecency puts the most recently messaged handle first", () => {
    const hits = [
      { name: "C", handle: "+10001", kind: "phone" },
      { name: "C", handle: "old@x.com", kind: "email" },
      { name: "C", handle: "+10002", kind: "mobile" },
    ];
    const ranked = rankByRecency(hits, { "+10002": "2026-09-02T21:00:00Z", "old@x.com": "2024-01-01T00:00:00Z" });
    expect(ranked.map((h) => h.handle)).toEqual(["+10002", "old@x.com", "+10001"]);
  });

  test("fuzzyScore matches subsequences and rejects missing letters", () => {
    expect(fuzzyScore("alc", "Alice")).toBeGreaterThan(0);
    expect(fuzzyScore("xyz", "Alice")).toBe(0);
    expect(fuzzyScore("alice", "Alice Smith")).toBeGreaterThan(fuzzyScore("alc", "Alice Smith"));
  });

  test("filterFuzzy keeps contacts whose name matches as a subsequence", () => {
    const raw = [
      { name: "Alice", phones: [{ number: "+15550001111" }] },
      { name: "Bob", phones: [{ number: "+15550002222" }] },
    ];
    const hits = filterFuzzy(raw, "alc");
    expect(hits.map((c) => c.name)).toEqual(["Alice"]);
  });

  test("rankByRecency keeps a direct-entry row first", () => {
    const hits = [
      { name: "+10001", handle: "+10001", kind: "direct entry" },
      { name: "C", handle: "+10002", kind: "mobile" },
    ];
    const ranked = rankByRecency(hits, { "+10002": "2026-09-02T21:00:00Z" });
    expect(ranked[0]!.kind).toBe("direct entry");
    expect(ranked[1]!.handle).toBe("+10002");
  });
});

describe("paste type picking", () => {
  test("png preferred over other image types", () => {
    expect(pickImageType(["text/plain", "image/jpeg", "image/png"])).toBe("image/png");
  });
  test("first image type when no png", () => {
    expect(pickImageType(["text/html", "image/webp"])).toBe("image/webp");
  });
  test("no image offered → empty (text path)", () => {
    expect(pickImageType(["text/plain", "text/html"])).toBe("");
  });
  test("extensions map sanely", () => {
    expect(extFor("image/png")).toBe("png");
    expect(extFor("image/tiff")).toBe("img");
  });
  test("uri-list yields the first local file", () => {
    expect(firstFileUri("file:///tmp/photo.png\n")).toBe("/tmp/photo.png");
    expect(firstFileUri("copy\nfile:///tmp/a%20b.png")).toBe("/tmp/a b.png");
    expect(firstFileUri("https://example.com/x.png")).toBe("");
  });
  test("a copied file path attaches instead of pasting as text", () => {
    const dir = mkdtempSync(join(tmpdir(), "blip-paste-"));
    const file = join(dir, "shot.png");
    writeFileSync(file, "x");
    expect(existingLocalFile("file://" + file)).toBe(file);
    expect(existingLocalFile(file)).toBe(file);
    expect(existingLocalFile("not a path")).toBe("");
    const uri = "file://" + file;
    const runner = ((_cmd: string, args: string[]) => {
      if (args.includes("--list-types")) return { status: 0, stdout: "text/uri-list\ntext/plain\n", stderr: "" };
      if (args.includes("text/uri-list")) return { status: 0, stdout: uri + "\n", stderr: "" };
      return { status: 1, stdout: "", stderr: "" };
    }) as never;
    const snap = snapshotClipboard(runner);
    expect(snap.kind).toBe("file");
    expect(snap.path).toBe(file);
    unlinkSync(file);
  });
});

describe("rich-link cards", () => {
  test("only http(s) cards survive; image id must be decimal", () => {
    expect(normalizeLink({ url: "javascript:alert(1)", title: "x", summary: "", image_id: "1" })).toBeNull();
    expect(normalizeLink({ url: "https://a.b/c", title: " T ", summary: "", image_id: "1 OR 1" })).toEqual({ url: "https://a.b/c", title: "T", summary: "", image_id: "" });
    expect(normalizeLink(null)).toBeNull();
    expect(linkHost("https://www.Omarchy.org/x?y=1")).toBe("omarchy.org");
  });
});

describe("contact photos", () => {
  test("a missing photo is remembered as a negative marker and not re-asked", () => {
    let calls = 0;
    const runner = (() => { calls++; return { status: 1, stdout: Buffer.alloc(0), stderr: "" }; }) as never;
    const h = `+1555${Date.now() % 10000000}`;
    expect(fetchAvatar(h, runner).ok).toBe(false);
    expect(fetchAvatar(h, runner).ok).toBe(false);
    expect(calls).toBe(1);
    unlinkSync(`${AVATAR_DIR}/${avatarKey(h)}.none`);
  });
  test("a photo is cached and served from disk on the second ask", () => {
    let calls = 0;
    const runner = (() => { calls++; return { status: 0, stdout: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), stderr: "" }; }) as never;
    const h = `test-${Date.now()}@example.com`;
    const r1 = fetchAvatar(h, runner); const r2 = fetchAvatar(h, runner);
    expect(r1.ok && r2.ok).toBe(true);
    expect(r2.url).toMatch(/^file:\/\//);
    expect(calls).toBe(1);
    unlinkSync(`${AVATAR_DIR}/${avatarKey(h)}.jpg`);
  });
  test("non-image bytes are never cached as a photo", () => {
    const runner = (() => ({ status: 0, stdout: Buffer.from("6C39E3B3-2C4D-4B75-9D8C-B393A23D60CE"), stderr: "" })) as never;
    const h = `ref-${Date.now()}@example.com`;
    expect(fetchAvatar(h, runner).ok).toBe(false);
    unlinkSync(`${AVATAR_DIR}/${avatarKey(h)}.none`);
  });

  test("a no-photo marker expires in a day, so a new photo is found", () => {
    let calls = 0;
    const runner = (() => { calls++; return { status: 1, stdout: Buffer.alloc(0), stderr: "" }; }) as never;
    const h = `+1555${Date.now() % 10000000}`;
    expect(fetchAvatar(h, runner).ok).toBe(false);
    const marker = `${AVATAR_DIR}/${avatarKey(h)}.none`;
    // age it past the negative TTL but well inside the positive one
    const old = new Date(Date.now() - AVATAR_NONE_TTL_MS - 60_000);
    utimesSync(marker, old, old);
    expect(fetchAvatar(h, runner).ok).toBe(false);
    expect(calls).toBe(2);                       // re-asked, not trusted for a week
    expect(AVATAR_NONE_TTL_MS).toBeLessThan(AVATAR_TTL_MS);
    unlinkSync(marker);
  });

  test("retry ignores a fresh no-photo marker so a newly set picture is found", () => {
    let calls = 0;
    const miss = (() => ({ status: 1, stdout: Buffer.alloc(0), stderr: "" })) as never;
    const hit = (() => { calls++; return { status: 0, stdout: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), stderr: "" }; }) as never;
    const h = `retry-${Date.now()}@example.com`;
    expect(fetchAvatar(h, miss).ok).toBe(false);
    expect(fetchAvatar(h, hit).ok).toBe(false);            // marker still fresh
    expect(calls).toBe(0);
    expect(fetchAvatar(h, hit, { retry: true }).ok).toBe(true);
    expect(calls).toBe(1);
    unlinkSync(`${AVATAR_DIR}/${avatarKey(h)}.jpg`);
  });

  test("a group id asks for the GROUP's photo (--chat), a person for Contacts (--)", () => {
    expect(avatarArgs("ce5a593a78af408282d61461ade89135")).toEqual(["avatar", "--chat", "ce5a593a78af408282d61461ade89135"]);
    expect(avatarArgs("chat123456789")).toEqual(["avatar", "--chat", "chat123456789"]);
    expect(avatarArgs("+15551234567")).toEqual(["avatar", "--", "+15551234567"]);
    expect(avatarArgs("them@example.com")).toEqual(["avatar", "--", "them@example.com"]);
    let seen: string[] = [];
    const runner = ((_c: string, args: string[]) => { seen = args; return { status: 0, stdout: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), stderr: "" }; }) as never;
    const g = "chat" + String(Date.now());
    expect(fetchAvatar(g, runner).ok).toBe(true);
    expect(seen).toEqual(["avatar", "--chat", g]);
    unlinkSync(`${AVATAR_DIR}/${avatarKey(g)}.jpg`);
  });

  test("handles never reach imsg as flags", () => {
    expect(fetchAvatar("--evil", (() => ({ status: 0, stdout: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]), stderr: "" })) as never).ok).toBe(true); // '--' guards it
    unlinkSync(`${AVATAR_DIR}/${avatarKey("--evil")}.jpg`);
    expect(fetchAvatar("bad handle\n", (() => ({ status: 0, stdout: Buffer.from("x"), stderr: "" })) as never).ok).toBe(false);
  });
});

describe("war-room hardening (2.1)", () => {
  test("cache file extension follows the gated MIME, never the sender's name", () => {
    expect(cacheFileName("7", "evil.desktop", "image/png")).toBe("7-orig-evil.png");
    expect(cacheFileName("8", "report.pdf", "application/pdf")).toBe("8-orig-report.pdf");
    expect(cacheFileName("9", "blob.bin", "application/octet-stream")).toBe("9-orig-blob.bin");
  });
  test("non-ASCII attachment names survive sanitizing", () => {
    expect(sanitizeName("Fotos-Café.jpg")).toBe("Fotos-Café.jpg");
    expect(sanitizeName("写真.png")).toBe("写真.png");
  });
  test("a DM thread never admits the same person's GROUP messages", () => {
    const dm = { ts: "2026-08-30 12:00:00", from_me: false, handle: "+15551234567", name: "A", service: "iMessage", chat: "+15551234567", text: "dm" } as never;
    const grp = { ts: "2026-08-30 12:01:00", from_me: false, handle: "+15551234567", name: "A", service: "iMessage", chat: "abcdef0123456789abcdef0123456789", text: "in group" } as never;
    const out = selectThread([dm, grp], "+15551234567", false, 50);
    expect(out.map((m: { text: string }) => m.text)).toEqual(["dm"]);
  });
  test("link cards refuse userinfo spoofing and keep Wikipedia parens", () => {
    expect(normalizeLink({ url: "https://apple.com@evil.example/x", title: "t", summary: "", image_id: "" })).toBeNull();
    expect(linkify("see https://en.wikipedia.org/wiki/Blip_(band) now")).toContain('href="https://en.wikipedia.org/wiki/Blip_(band)"');
    expect(linkify("(https://x.com/a)")).toContain('href="https://x.com/a"');
  });
  test("an unreachable Mac does not poison the avatar negative cache", () => {
    let calls = 0;
    const runner = (() => { calls++; return { status: 255, stdout: Buffer.alloc(0), stderr: "" }; }) as never;
    const h = `+1555${(Date.now() + 7) % 10000000}`;
    expect(fetchAvatar(h, runner).error).toBe("Mac unreachable");
    expect(fetchAvatar(h, runner).error).toBe("Mac unreachable");
    expect(calls).toBe(2);
  });
  test("file sends declare their exact size and keep the user's dashes", () => {
    let seen: string[] = [];
    const runner = ((_c: string, args: string[]) => { seen = args; return { status: 0, stdout: "", stderr: "" }; }) as never;
    const tmp = `${process.env.XDG_CACHE_HOME}/sz-${process.pid}.txt`;
    writeFileSync(tmp, "12345");
    try {
      expect(sendFile("+15551234567", tmp, "", runner).ok).toBe(true);
      expect(seen.slice(seen.indexOf("--file-bytes"), seen.indexOf("--file-bytes") + 2)).toEqual(["--file-bytes", "5"]);
      expect(seen).toContain("--keep-dashes");
    } finally { unlinkSync(tmp); }
  });
});

describe("country code + service (2.2.0)", () => {
  const { normalizeHandle } = require("./contact-search") as typeof import("./contact-search");
  test("non-NANP bare numbers use the configured country code", () => {
    expect(normalizeHandle("07911 123456", "44")).toBe("+447911123456");
    expect(normalizeHandle("447911123456", "44")).toBe("+447911123456");
    expect(normalizeHandle("(404) 555-0123", "1")).toBe("+14045550123");
  });
  test("SMS threads send files on the SMS service; groups never carry --service", () => {
    let seen: string[] = [];
    const runner = ((_c: string, args: string[]) => { seen = args; return { status: 0, stdout: "", stderr: "" }; }) as never;
    const tmp = `${process.env.XDG_CACHE_HOME}/svc-${process.pid}.txt`;
    writeFileSync(tmp, "x");
    try {
      sendFile("+15551234567", tmp, "", runner, "SMS");
      expect(seen.slice(seen.indexOf("--service"), seen.indexOf("--service") + 2)).toEqual(["--service", "SMS"]);
      sendFile("+15551234567", tmp, "", runner, "iMessage");
      expect(seen).not.toContain("--service");
    } finally { unlinkSync(tmp); }
  });
});

describe("link previews for URLs Messages never decorated", () => {
  test("Open Graph wins, then Twitter, then the plain document", () => {
    const html = `<html><head>
      <title>fallback title</title>
      <meta property="og:title" content="Real &amp; Proper Title">
      <meta name="twitter:description" content="a summary">
      <meta property="og:image" content="/img/card.png">
    </head><body>x</body></html>`;
    const c = parseCard(html, "https://example.com/a/b");
    expect(c.title).toBe("Real & Proper Title");
    expect(c.summary).toBe("a summary");
    expect(c.image).toBe("https://example.com/img/card.png");   // relative resolved against the page
  });

  test("no tags at all falls back to <title>, and a javascript: image is dropped", () => {
    const c = parseCard('<title>Just A Page</title><meta property="og:image" content="javascript:alert(1)">',
                        "https://example.com/");
    expect(c.title).toBe("Just A Page");
    expect(c.image).toBe("");
  });

  test("entities and whitespace are decoded once", () => {
    expect(decodeEntities("a &amp; b &#39;c&#39;&nbsp;&#x64;")).toBe("a & b 'c' d");
  });

  test("only real image bytes are cached, extension follows the SNIFF", () => {
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13]))).toBe("png");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0, 0, 0, 0, 0, 0]))).toBe("jpg");
    expect(sniffImage(Buffer.from("RIFF____WEBPVP8 "))).toBe("webp");
    expect(sniffImage(Buffer.from("<!DOCTYPE html><html>"))).toBe("");
    expect(sniffImage(Buffer.from([0x89]))).toBe("");
  });

  test("the LAN is never fetched — loopback, RFC1918, metadata, tailnet, v6", () => {
    for (const ip of ["127.0.0.1", "10.0.0.239", "192.168.1.1", "172.16.0.1", "169.254.169.254",
                      "100.115.139.100", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ["1.1.1.1", "140.82.114.4", "2606:4700::1111"]) {
      expect(isPrivateAddress(ip)).toBe(false);
    }
  });

  test("safeUrl refuses non-http, credentials, private literals and .local — no DNS needed", async () => {
    const never = (async () => { throw new Error("resolver must not be called"); }) as never;
    expect(await safeUrl("file:///etc/passwd", never)).toBe("only http(s)");
    expect(await safeUrl("ftp://x.test/a", never)).toBe("only http(s)");
    expect(await safeUrl("not a url", never)).toBe("not a url");
    expect(await safeUrl("http://user:pw@example.com/", never)).toBe("credentials in url");
    expect(await safeUrl("http://127.0.0.1/x", never)).toBe("private address");
    expect(await safeUrl("http://[::1]/x", never)).toBe("private address");
    expect(await safeUrl("http://localhost:8765/", never)).toBe("private host");
    expect(await safeUrl("http://nas.local/", never)).toBe("private host");
  });

  test("a public name is allowed, and a name resolving into the LAN is not", async () => {
    const pub = (async () => [{ address: "140.82.114.4" }]) as never;
    const lan = (async () => [{ address: "192.168.1.50" }]) as never;
    const split = (async () => [{ address: "1.1.1.1" }, { address: "127.0.0.1" }]) as never;
    expect(await safeUrl("https://github.com/x", pub)).toBe("");
    expect(await safeUrl("https://rebind.test/x", lan)).toBe("private address");
    expect(await safeUrl("https://split.test/x", split)).toBe("private address");
  });

  test("bridge.conf can turn previews off; anything else leaves them on", () => {
    const p = `${process.env.XDG_CACHE_HOME}/lp-conf-${process.pid}`;
    writeFileSync(p, "host=mac\nlink_previews=off\n");
    expect(previewsEnabled(p)).toBe(false);
    writeFileSync(p, "host=mac\nlink_previews = FALSE\n");
    expect(previewsEnabled(p)).toBe(false);
    writeFileSync(p, "host=mac\nlink_previews=on\n");
    expect(previewsEnabled(p)).toBe(true);
    writeFileSync(p, "host=mac\n");
    expect(previewsEnabled(p)).toBe(true);
    expect(previewsEnabled(`${p}-missing`)).toBe(true);
    unlinkSync(p);
  });

  test("host display drops www, and the cache key is a hash of the url", () => {
    expect(hostOf("https://www.Example.COM/a?b=1")).toBe("example.com");
    expect(hostOf("nonsense")).toBe("");
    expect(previewKey("https://a.test/1")).toMatch(/^[0-9a-f]{32}$/);
    expect(previewKey("https://a.test/1")).toBe(previewKey("https://a.test/1"));
    expect(previewKey("https://a.test/2")).not.toBe(previewKey("https://a.test/1"));
  });
});

describe("the contact graph never rides argv", () => {
  const { parseRecency } = require("./contact-search") as typeof import("./contact-search");
  const panelSrc = readFileSync(new URL("./BlipView.qml", import.meta.url), "utf8");

  test("QML hands the recency map to stdin, not the command line", () => {
    // Every handle you have a thread with is your contact graph, and argv is
    // readable by any process here through `ps` — the same reason message text
    // has never travelled that way.
    expect(panelSrc).toContain('"--recency-stdin"');
    expect(panelSrc).toContain("contactProc.write(root.threadRecencyJson())");
    expect(panelSrc).not.toContain("root.contactScript, q, threadRecencyJson()");
  });

  test("a bad or absent map degrades ranking, never the search", () => {
    expect(parseRecency('{"+15550100011":"2026-09-03 09:00:00"}'))
      .toEqual({ "+15550100011": "2026-09-03 09:00:00" });
    expect(parseRecency("not json")).toEqual({});
    expect(parseRecency("[1,2,3]")).toEqual({});
    expect(parseRecency("null")).toEqual({});
    expect(parseRecency("")).toEqual({});
    expect(parseRecency('{"a":1,"b":"x"}')).toEqual({ b: "x" });   // non-strings dropped
  });
});

describe("AddressBook photos behind a tag byte (#16)", () => {
  test("a GIF contact photo is cached, not thrown away as a non-image", () => {
    const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]);
    const runner = (() => ({ status: 0, stdout: gif, stderr: "" })) as never;
    const h = `gif-${Date.now()}@example.com`;
    const r = fetchAvatar(h, runner);
    expect(r.ok).toBe(true);
    unlinkSync(`${AVATAR_DIR}/${avatarKey(h)}.jpg`);
  });

  test("a Core Data reference is still not an image", () => {
    const runner = (() => ({ status: 0, stdout: Buffer.from("\x02ABCDEF01-2345-6789-ABCD-EF0123456789\x00"), stderr: "" })) as never;
    const h = `ref2-${Date.now()}@example.com`;
    expect(fetchAvatar(h, runner).ok).toBe(false);
    unlinkSync(`${AVATAR_DIR}/${avatarKey(h)}.none`);
  });
});

describe("multi-photo messages and the preview transform (#Crystal/Thatchers)", () => {
  test("an auto-fetch asks the Mac to resample; a click asks for the original", () => {
    const seen: string[][] = [];
    const runner = ((_c: string, args: string[]) => {
      seen.push(args);
      return { status: 0, stdout: Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 4]), stderr: "" };
    }) as never;
    // auto: a cap below the ceiling means "this is for the bubble"
    fetchAttachment("991", "IMG_1.HEIC", "image/heic", runner, 5 * 1024 * 1024);
    expect(seen[0]).toContain("--max-dim");
    expect(seen[0]).toContain("--jpeg");
    // click: no cap, no resample
    fetchAttachment("992", "IMG_2.HEIC", "image/heic", runner);
    expect(seen[1]).not.toContain("--max-dim");
    for (const f of ["991-prev-IMG_1.jpg", "992-jpg-IMG_2.jpg"]) {
      try { unlinkSync(`${CACHE_DIR}/${f}`); } catch { /* fine */ }
    }
  });

  test("a PNG preview is resampled too, and is named .jpg because it IS a JPEG", () => {
    expect(cacheFileName("7", "shot.png", "image/png", true)).toBe("7-prev-shot.jpg");
    expect(cacheFileName("7", "shot.png", "image/png", false)).toBe("7-orig-shot.png");
    expect(cacheFileName("7", "IMG.HEIC", "image/heic", false)).toBe("7-jpg-IMG.jpg");
    // preview and original never collide, so a click still gets the full file
    expect(cacheFileName("7", "shot.png", "image/png", true))
      .not.toBe(cacheFileName("7", "shot.png", "image/png", false));
  });

  test("every image in one message is enqueued, not just the first", () => {
    const panelSrc = readFileSync(new URL("./BlipView.qml", import.meta.url), "utf8");
    expect(panelSrc).toContain("for (var j = 0; j < atts.length; j++)");
    expect(panelSrc).toContain("b <= root.autoFetchMaxSource");
    expect(panelSrc).not.toContain("b <= 5 * 1024 * 1024");
  });
});
