import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedOriginal, saveAttachment, saveBytesAs, suggestedSaveName } from "./save-attachment";

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "blip-save-att-"));
  const cache = join(dir, "att"), out = join(dir, "Downloads");
  mkdirSync(cache); mkdirSync(out);
  return { dir, cache, out };
}

test("the suggested name keeps the sender's name with the cached bytes' extension", () => {
  expect(suggestedSaveName("IMG_0042.HEIC", "/c/att/5-jpg-IMG_0042.jpg")).toBe("IMG_0042.jpg");
  expect(suggestedSaveName("Screenshot 2026-10-19 at 3.12.04 PM.png", "/c/att/5-orig-x.png"))
    .toBe("Screenshot 2026-10-19 at 3.12.04 PM.png");
  expect(suggestedSaveName("../Holiday/photo.png\n\u202e", "/c/att/5-orig-photo.png")).toBe("Holiday photo.png");
  expect(suggestedSaveName("../../.bashrc", "/c/att/5-orig-file.txt")).toBe("attachment.txt");
  expect(suggestedSaveName("evil.desktop", "/c/att/5-orig-evil.png")).toBe("evil.png");
  expect(suggestedSaveName(null, "/c/att/5-orig-file.pdf")).toBe("attachment.pdf");
  expect(Buffer.byteLength(suggestedSaveName("界".repeat(100) + ".png", "/c/att/5-orig-a.png"))).toBeLessThanOrEqual(124);
});

test("only a fetched original inside the media cache is a source", () => {
  const { dir, cache } = scratch();
  try {
    const orig = join(cache, "5-orig-a.png"), prev = join(cache, "5-prev-a.jpg");
    writeFileSync(orig, "png bytes"); writeFileSync(prev, "jpeg bytes");
    expect(cachedOriginal(orig, cache)).toBe(orig);
    expect(() => cachedOriginal(prev, cache)).toThrow("original");
    writeFileSync(join(dir, "5-orig-outside.png"), "x");
    expect(() => cachedOriginal(join(dir, "5-orig-outside.png"), cache)).toThrow("original");
    expect(() => cachedOriginal("relative/5-orig-a.png", cache)).toThrow("Invalid");
    writeFileSync(join(cache, "6-orig-empty.png"), "");
    expect(() => cachedOriginal(join(cache, "6-orig-empty.png"), cache)).toThrow("empty");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a save never replaces a file, follows no symlink and leaves no staging file", () => {
  const { dir, out } = scratch();
  try {
    const first = saveBytesAs(Buffer.from("one"), out, "photo.jpg");
    expect(first).toBe(join(out, "photo.jpg"));
    expect(statSync(first).mode & 0o777).toBe(0o600);
    symlinkSync(join(dir, "elsewhere"), join(out, "photo (2).jpg"));
    const next = saveBytesAs(Buffer.from("two"), out, "photo.jpg");
    expect(next).toBe(join(out, "photo (3).jpg"));
    expect(readFileSync(first, "utf8")).toBe("one");
    expect(readFileSync(next, "utf8")).toBe("two");
    expect(saveBytesAs(Buffer.from("three"), out, "notes")).toBe(join(out, "notes"));
    expect(saveBytesAs(Buffer.from("four"), out, "notes")).toBe(join(out, "notes (2)"));
    expect(readdirSync(out).some((n) => n.startsWith(".blip-"))).toBe(false);
    for (const bad of ["", ".", "..", "a/b", "a\nb"]) expect(() => saveBytesAs(Buffer.from("x"), out, bad)).toThrow("name");
    expect(() => saveBytesAs(Buffer.from("x"), "relative", "a.png")).toThrow("folder");
    expect(() => saveBytesAs(Buffer.alloc(0), out, "a.png")).toThrow("empty");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the picker starts in Downloads with the original name; cancel writes nothing", () => {
  const { dir, cache, out } = scratch();
  try {
    const source = join(cache, "42-jpg-IMG_0042.jpg");
    writeFileSync(source, "full size jpeg");
    let answer: { status: number; stdout: string } = { status: 1, stdout: "" };
    const calls: any[] = [];
    const runner = ((command: string, args: string[], options: any) => {
      calls.push({ command, args, options });
      if (command.endsWith("/xdg-user-dir")) return { status: 0, stdout: out + "\n" };
      if (command.endsWith("/zenity")) return answer;
      throw new Error("Unexpected command " + command);
    }) as any;
    expect(saveAttachment(source, "IMG_0042.HEIC", runner, cache).view).toBe("cancelled");
    expect(readdirSync(out)).toHaveLength(0);
    const picker = calls.find((c) => c.command.endsWith("/zenity"));
    expect(picker.args).toEqual(["--file-selection", "--save", "--title=Save image", "--filename=" + join(out, "IMG_0042.jpg")]);
    expect(picker.options.timeout).toBe(300000);
    // the user picked a name that already exists: it is kept, the copy gets (2)
    writeFileSync(join(out, "IMG_0042.jpg"), "someone else's file");
    answer = { status: 0, stdout: join(out, "IMG_0042.jpg") + "\n" };
    const saved = saveAttachment(source, "IMG_0042.HEIC", runner, cache);
    expect(saved.view).toBe("saved");
    expect(saved.path).toBe(join(out, "IMG_0042 (2).jpg"));
    expect(readFileSync(join(out, "IMG_0042.jpg"), "utf8")).toBe("someone else's file");
    expect(readFileSync(saved.path!, "utf8")).toBe("full size jpeg");
    // no zenity: a plain sentence, not a crash
    const missing = ((command: string) => command.endsWith("/zenity")
      ? { status: null, error: Object.assign(new Error("spawn"), { code: "ENOENT" }) }
      : { status: 0, stdout: out }) as any;
    expect(() => saveAttachment(source, "IMG_0042.HEIC", missing, cache)).toThrow("zenity");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
