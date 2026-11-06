import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { attachmentPaths } from "./attachment-picker";
test("picker accepts bounded distinct regular local files and refuses URLs, directories and symlinks", () => {
  const dir = mkdtempSync(join(tmpdir(), "blip-picker-test-"));
  try {
    const file = join(dir, "photo one.png"); writeFileSync(file, "bytes");
    symlinkSync(file, join(dir, "link"));
    expect(attachmentPaths(`${file}\n${file}\n`)).toEqual([file]);
    for (const value of ["https://example.com/file", "relative", dir, join(dir, "link"), ""]) expect(() => attachmentPaths(value)).toThrow();
    expect(() => attachmentPaths(Array.from({length:11}, (_, i) => join(dir, String(i))).join("\n"))).toThrow("10 files");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
