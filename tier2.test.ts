import { describe, expect, test } from "bun:test";

import { CACHE_DIR, bakeOrientation, cacheFileName, exifOrientation, fetchAttachment, jpegtranArgs, lruEvictions, sanitizeName, wantsJpeg } from "./fetch";
import { extFor, pickImageType } from "./paste";
import { resolveTarget, sendFile } from "./send-file";
import { linkHost, linkify, normalizeLink, selectThread } from "./thread";
import { AVATAR_DIR, avatarKey, fetchAvatar } from "./avatar";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

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

  test("when jpegtran is missing or fails, the original bytes are cached", () => {
    const tagged = withExif(TINY_JPEG, 6);
    const runner = ((cmd: string) =>
      cmd === "jpegtran" ? { status: null, stdout: null, error: new Error("ENOENT") } : { status: 0, stdout: tagged, stderr: "" }) as never;
    const r = fetchAttachment("123456789012348", "IMG_2.heic", "image/heic", runner);
    expect(r.ok).toBe(true);
    expect(readFileSync(r.path).equals(tagged)).toBe(true);
  });

  const haveJpegtran = spawnSync("jpegtran", ["-help"]).status !== null;
  test.skipIf(!haveJpegtran)("real jpegtran turns a tagged 16×8 into an upright 8×16", () => {
    const out = bakeOrientation(withExif(TINY_JPEG, 6));
    expect(sofSize(withExif(TINY_JPEG, 6))).toEqual([16, 8]);
    expect(sofSize(out)).toEqual([8, 16]);
    expect(exifOrientation(out)).toBe(1);                    // tag gone: no double rotation in Qt
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
});

describe("contact search shaping", () => {
  const { directHandle, normalizeHandle, shapeContacts } =
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
