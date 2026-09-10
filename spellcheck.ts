// Local-only spelling: draft text uses bounded stdin and is never persisted.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
export const MAX_BYTES = 8192;
const CONF_PATH = join(homedir(), ".config/blip/bridge.conf");
const USER_DICTS = join(homedir(), ".local/share/blip/dictionaries");
/** `spell=` in bridge.conf: the dictionaries hunspell checks against, comma-separated
 *  (`en_US,nb_NO` — a word found in any of them passes, which is what a bilingual draft
 *  needs), or `off`. Parsed, never sourced: the value is one character class, so only
 *  names reach the argv, and a value outside it means the default. Default `en_US`, as
 *  #51 shipped; a name hunspell cannot find it skips itself, as long as one loads. */
export function dictionaries(path = CONF_PATH): string[] {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = /^\s*spell\s*=\s*([A-Za-z0-9_, -]+?)\s*$/.exec(line);
      if (!m) continue;
      if (/^(off|no|false|0)$/i.test(m[1]!)) return [];
      const names = m[1]!.split(",").map(n => n.trim()).filter(Boolean);
      return names.length ? names : ["en_US"];
    }
  } catch { /* no conf: the default */ }
  return ["en_US"];
}
/** What `-d` gets. A dictionary dropped under ~/.local/share/blip/dictionaries wins over
 *  the system one of the same name (a path is a valid `-d` entry). */
export function dictionaryArg(names: string[], userDir = USER_DICTS): string {
  return names.map(n => {
    const local = join(userDir, n);
    return existsSync(local + ".aff") && existsSync(local + ".dic") ? local : n;
  }).join(",");
}
export function words(text: string): {word:string; start:number; end:number}[] {
  if (Buffer.byteLength(text) > MAX_BYTES) return [];
  const ignored = [...text.matchAll(/https?:\/\/\S+|[\w.+-]+@[\w.-]+\.[a-z]+/gi)]
    .map(m => [m.index!, m.index! + m[0].length]);
  return [...text.matchAll(/\p{L}+(?:['’]\p{L}+)*/gu)]
    .filter(m => m[0].length > 1 && m[0].length <= 48 && !ignored.some(([a,b]) => m.index! >= a! && m.index! < b!))
    .slice(0,256).map(m => ({word:m[0],start:m.index!,end:m.index!+m[0].length}));
}
export function misspellings(text: string, output: string) {
  if (Buffer.byteLength(output) > MAX_BYTES) return [];
  const bad = new Set(output.split(/\r?\n/));
  return words(text).filter(w => bad.has(w.word)).map(({start,end})=>({start,end}));
}
export function check(text:string, runner = spawnSync, dicts = dictionaries()) {
  if (!dicts.length) return [];
  const tokens = words(text);
  if (!tokens.length) return [];
  const result = runner('/usr/bin/hunspell',['-l','-d',dictionaryArg(dicts)], {
    input: tokens.map(w=>w.word).join('\n')+'\n', encoding:'utf8', timeout:1500, maxBuffer:MAX_BYTES,
  });
  return result.status === 0 ? misspellings(text, result.stdout) : [];
}
if (import.meta.main) {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of Bun.stdin.stream()) {
    bytes += chunk.byteLength;
    if (bytes > MAX_BYTES) { console.log('[]'); process.exit(0); }
    chunks.push(chunk);
  }
  console.log(JSON.stringify(check(Buffer.concat(chunks).toString('utf8'))));
}
