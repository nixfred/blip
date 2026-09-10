// Only window dimensions are persisted. No message content is accepted.
import { constants as C, openSync, closeSync, fstatSync, readSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseSize } from './panel-size';
export function sizeStore(directory:string, args:string[]) {
  mkdirSync(directory,{recursive:true,mode:0o700});
  const dir = openSync(directory,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);
  try {
    const base = `/proc/self/fd/${dir}`;
    if (fstatSync(dir).uid !== process.getuid!()) return null;
    if (args.length) {
      if (args.length !== 2) return null;
      const size = parseSize({width:Number(args[0]),height:Number(args[1])});
      if (!size) return null;
      const temporary = `${base}/.panel-${crypto.randomUUID()}.tmp`;
      try {
        writeFileSync(temporary,JSON.stringify(size),{flag:'wx',mode:0o600});
        renameSync(temporary,`${base}/panel.json`);
      } finally { try { unlinkSync(temporary); } catch {} }
      return size;
    }
    const fd = openSync(`${base}/panel.json`,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);
    try {
      const stat=fstatSync(fd);
      if (!stat.isFile() || stat.size>256 || stat.uid!==process.getuid!()) return null;
      const bytes=Buffer.alloc(257);
      const count=readSync(fd,bytes,0,257,0);
      if (count>256) return null;
      return parseSize(JSON.parse(bytes.subarray(0,count).toString('utf8')));
    } finally { closeSync(fd); }
  } finally { closeSync(dir); }
}
if (import.meta.main) {
  try { console.log(JSON.stringify(sizeStore(join(homedir(),'.local/state/blip'),process.argv.slice(2)))); }
  catch { console.log('null'); }
}
