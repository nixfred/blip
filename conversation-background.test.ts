import { dlopen, FFIType } from "bun:ffi";
import { afterEach, expect, test } from "bun:test";
import { closeSync, openSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { chooseBackground, backgroundConfig, backgroundName, backgroundPaths, loadBackground, normalizeBackground, rasterType, saveBackground } from "./conversation-background";

const homes: string[] = [];
function setup() {
  const home = mkdtempSync(join(tmpdir(), "blip-background-test-")); homes.push(home);
  const paths = backgroundPaths(home);
  mkdirSync(join(home, ".config/blip"), { recursive: true, mode: 0o700 });
  writeFileSync(paths.config, "# keep me\nhost=demo\ntapbacks=on\n", { mode: 0o600 });
  return { home, paths };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jjuQAAAAASUVORK5CYII=", "base64");
const digest = "a".repeat(64) + ".png";
test("one bridge.conf preference preserves unrelated configuration and collapses duplicates", () => {
  const original = "# kept\nhost=demo\nconversation_background=old\ntapbacks=on\n conversation_background=other\n";
  expect(backgroundConfig(original, digest)).toBe(`# kept\nhost=demo\ntapbacks=on\nconversation_background=${digest}\n`);
  expect(backgroundName(backgroundConfig(original, digest))).toBe(digest);
  expect(backgroundConfig(original, "")).toBe("# kept\nhost=demo\ntapbacks=on\n");
});
test("remote URLs, traversal and shell text can never become background sources", () => {
  for (const value of ["https://example.com/a.png", "file:///etc/passwd", "../a.png", "$(whoami)", "/tmp/a.png", "a.png"]) {
    expect(() => backgroundName(`conversation_background=${value}`)).toThrow();
    expect(() => backgroundConfig("", value)).toThrow();
  }
});
test("magic validation refuses SVG, HTML, PDFs and renamed non-images", () => {
  for (const bytes of [Buffer.from("<svg/>"), Buffer.from("<html>"), Buffer.from("%PDF-1.4"), Buffer.from("not a png")])
    expect(() => rasterType(bytes)).toThrow();
  expect(rasterType(tinyPng)).toBe("png");
});
test("huge declared dimensions are rejected before decoding", () => {
  const bytes = Buffer.from(tinyPng); bytes.writeUInt32BE(12001, 16);
  expect(() => normalizeBackground(bytes)).toThrow("dimensions");
});
test("absent preference loads without creating files", () => {
  const { paths } = setup(); expect(loadBackground(paths)).toBe("");
});
test("source symlinks and non-local paths are refused without changing config", () => {
  const { home, paths } = setup(); const source = join(home, "image.png");
  writeFileSync(source, tinyPng); symlinkSync(source, join(home, "link.png"));
  const original = readFileSync(paths.config, "utf8");
  expect(() => saveBackground(join(home, "link.png"), paths)).toThrow();
  expect(() => saveBackground("https://example.com/image.png", paths)).toThrow();
  expect(readFileSync(paths.config, "utf8")).toBe(original);
});
test("configuration symlinks cannot overwrite their targets", () => {
  const { home, paths } = setup(); const target = join(home, "other");
  writeFileSync(target, "untouched"); rmSync(paths.config); symlinkSync(target, paths.config);
  expect(() => saveBackground(null, paths)).toThrow();
  expect(readFileSync(target, "utf8")).toBe("untouched");
});
test("local raster round trip copies privately, persists, detects tampering and resets", () => {
  const { home, paths } = setup();
  const source = join(home, "image.png");
  let r = spawnSync("magick", ["-size", "24x16", "xc:#72829a", "png:-"]);
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") r = spawnSync("convert", ["-size", "24x16", "xc:#72829a", "png:-"]);
  expect(r.status).toBe(0); writeFileSync(source, r.stdout);
  const url = saveBackground(source, paths);
  expect(url.startsWith("file://")).toBe(true);
  expect(loadBackground(paths)).toBe(url);
  const stored = new URL(url); expect(statSync(stored).mode & 0o777).toBe(0o600);
  const png = readFileSync(stored);
  const chunks: string[] = [];
  for (let offset = 8; offset + 12 <= png.length;) {
    chunks.push(png.toString("ascii", offset + 4, offset + 8));
    offset += 12 + png.readUInt32BE(offset);
  }
  for (const metadata of ["tIME", "orNT", "eXIf", "tEXt", "iTXt", "zTXt"]) expect(chunks).not.toContain(metadata);
  expect(statSync(paths.assets).mode & 0o777).toBe(0o700);
  expect(readFileSync(paths.config, "utf8")).toContain("tapbacks=on");
  writeFileSync(stored, tinyPng);
  expect(() => loadBackground(paths)).toThrow("changed");
  expect(saveBackground(null, paths)).toBe("");
  expect(loadBackground(paths)).toBe("");
  expect(readFileSync(paths.config, "utf8")).toBe("# keep me\nhost=demo\ntapbacks=on\n");
});

test("cancelled picker changes no files or preference", () => {
  const { paths } = setup();
  const original = readFileSync(paths.config, "utf8");
  const result = chooseBackground(paths, (() => ({ status: 1, stdout: "" })) as any);
  expect(result).toEqual({ ok: true, cancelled: true });
  expect(readFileSync(paths.config, "utf8")).toBe(original);
});

test("conversation overrides use opaque keys and preserve default and other conversations", () => {
  const a = "+15551234567", b = "other@example.com";
  let config = backgroundConfig("host=demo\n", digest);
  const alternate = "b".repeat(64) + ".png";
  config = backgroundConfig(config, alternate, a);
  expect(config).not.toContain(a);
  expect(backgroundName(config)).toBe(digest);
  expect(backgroundName(config, a)).toBe(alternate);
  expect(backgroundName(config, b)).toBe(digest);
  const cleared = backgroundConfig(config, "", a);
  expect(backgroundName(cleared, a)).toBe(digest);
  expect(cleared).toBe(backgroundConfig("host=demo\n", digest));
});

test("clearing one shared override cannot remove the default asset", () => {
  const { home, paths } = setup();
  const source = join(home, "shared.png");
  let result = spawnSync("magick", ["-size", "16x16", "xc:#abcdef", "png:-"]);
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") result = spawnSync("convert", ["-size", "16x16", "xc:#abcdef", "png:-"]);
  expect(result.status).toBe(0); writeFileSync(source, result.stdout);
  const url = saveBackground(source, paths);
  expect(saveBackground(source, paths, "+15551234567")).toBe(url);
  expect(saveBackground(null, paths, "+15551234567")).toBe(url);
  expect(loadBackground(paths)).toBe(url);
  expect(loadBackground(paths, "+15551234567")).toBe(url);
});

test("concurrent settings write reports a conflict and leaves config unchanged", () => {
  const { paths } = setup();
  const native = dlopen("libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
  const fd = openSync(paths.config + ".background.lock", "w", 0o600);
  const original = readFileSync(paths.config, "utf8");
  try {
    expect(native.symbols.flock(fd, 6)).toBe(0);
    expect(() => saveBackground(null, paths)).toThrow("Another window");
    expect(readFileSync(paths.config, "utf8")).toBe(original);
  } finally { native.symbols.flock(fd, 8); closeSync(fd); native.close(); }
  expect(saveBackground(null, paths)).toBe("");
});

test("oversized resulting configuration is refused and the imported orphan removed", () => {
  const { home, paths } = setup();
  const original = "#" + "x".repeat(65490) + "\n";
  writeFileSync(paths.config, original);
  const source = join(home, "large-config-image.png");
  let result = spawnSync("magick", ["-size", "8x8", "xc:#123456", "png:-"]);
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") result = spawnSync("convert", ["-size", "8x8", "xc:#123456", "png:-"]);
  expect(result.status).toBe(0); writeFileSync(source, result.stdout);
  expect(() => saveBackground(source, paths)).toThrow("Too many conversation backgrounds");
  expect(readFileSync(paths.config, "utf8")).toBe(original);
  expect(readdirSync(paths.assets)).toEqual([]);
});
