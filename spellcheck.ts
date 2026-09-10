// Local-only spelling: draft text uses bounded stdin and is never persisted.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
export const MAX_BYTES = 8192;
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
export function check(text:string, runner = spawnSync) {
  const tokens = words(text);
  if (!tokens.length) return [];
  const local = join(homedir(), '.local/share/blip/dictionaries/en_US');
  const dictionary = existsSync(local+'.aff') && existsSync(local+'.dic') ? local : 'en_US';
  const result = runner('/usr/bin/hunspell',['-l','-d',dictionary], {
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
