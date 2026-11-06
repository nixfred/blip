#!/usr/bin/env bun
/** The picker only selects local files. No send happens until the composer is
 * explicitly sent; filenames never enter a shell command. */
import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
export function attachmentPaths(value: string): string[] {
  const files = [...new Set(value.replace(/\n$/, "").split("\n"))];
  if (!files.length || files.length > 10) throw new Error("Choose up to 10 files");
  for (const file of files) {
    if (!isAbsolute(file) || file.length > 4096 || /[\x00-\x1f\x7f]/.test(file)) throw new Error("Choose local files");
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error("Choose files, not folders or links");
    if (st.size > 100 * 1024 * 1024) throw new Error("Each attachment must be smaller than 100 MB");
  }
  return files;
}
if (import.meta.main) {
  try {
    const picked = spawnSync("zenity", ["--file-selection", "--multiple", "--separator=\n", "--title=Attach files"], { encoding: "utf8", timeout: 120000, maxBuffer: 65536 });
    if (picked.status === 1) console.log(JSON.stringify({ ok: true, cancelled: true }));
    else if (picked.status !== 0) throw new Error("Could not open the file picker");
    else console.log(JSON.stringify({ ok: true, paths: attachmentPaths(picked.stdout) }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Could not select files" }));
    process.exitCode = 1;
  }
}
