import { expect, test } from 'bun:test';
import { words, misspellings, check, dictionaries, dictionaryArg, MAX_BYTES } from './spellcheck';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('ranges use UTF-16 editor offsets and skip links and email',()=> {
 const text = '😀 teh https://example.com/mispell foo@example.com wrng';
 expect(misspellings(text,'teh\nwrng\nexample\n')).toEqual([{start:3,end:6},{start:51,end:55}]);
});
test('spelling is bounded, literal, and stdin-only',()=> {
 expect(words('x'.repeat(MAX_BYTES+1))).toEqual([]);
 expect(misspellings('teh','x'.repeat(MAX_BYTES+1))).toEqual([]);
 let args:any, options:any;
 const result=check('teh',((_:any,a:any,o:any)=>{args=a;options=o;return {status:0,stdout:'teh\n'}}) as any,['en_US']);
 expect(args).not.toContain('teh'); expect(options.input).toBe('teh\n');
 expect(result).toEqual([{start:0,end:3}]);
 expect(check('teh',(()=>({status:1,stdout:''})) as any,['en_US'])).toEqual([]);
});
test('word and byte limits include Unicode and exact boundaries', () => {
 expect(words(' '.repeat(MAX_BYTES-3)+'teh')).toEqual([{word:'teh',start:MAX_BYTES-3,end:MAX_BYTES}]);
 expect(words(' '.repeat(MAX_BYTES-3)+'téhh')).toEqual([]);
 expect(words('teh '.repeat(300))).toHaveLength(256);
 expect(words('a'.repeat(49))).toEqual([]);
 expect(misspellings('teh teh','teh\n')).toEqual([{start:0,end:3},{start:4,end:7}]);
});
test('oversized stdin exits without waiting for EOF', async () => {
 const child = Bun.spawn(['bun', 'spellcheck.ts'], {stdin:'pipe',stdout:'pipe',stderr:'pipe'});
 child.stdin.write('x'.repeat(MAX_BYTES+1));
 child.stdin.flush();
 const timer=setTimeout(()=>child.kill(),2000);
 try {
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stdout).text()).toBe('[]\n');
 } finally { clearTimeout(timer); child.kill(); }
});
test('spell= in bridge.conf picks the dictionaries, off turns the checker off', () => {
 const dir = mkdtempSync(join(tmpdir(), 'blip-spell-'));
 const conf = (body:string) => { const p = join(dir, 'bridge.conf'); writeFileSync(p, body); return p; };
 expect(dictionaries(join(dir, 'missing.conf'))).toEqual(['en_US']);          // no conf: as before
 expect(dictionaries(conf('host=mac\n'))).toEqual(['en_US']);                 // no key: as before
 expect(dictionaries(conf('spell=en_US,nb_NO\n'))).toEqual(['en_US','nb_NO']);
 expect(dictionaries(conf('spell = nb_NO, en_US-large \n'))).toEqual(['nb_NO','en_US-large']);
 expect(dictionaries(conf('spell=off\n'))).toEqual([]);
 // only names reach the argv: a value outside [A-Za-z0-9_-] is not a list, so it is the default
 expect(dictionaries(conf('spell=nb_NO,../../etc/passwd\n'))).toEqual(['en_US']);
 expect(dictionaries(conf('spell=$(id)\n'))).toEqual(['en_US']);
 expect(dictionaries(conf('spell=,\n'))).toEqual(['en_US']);
 // off: hunspell is never run
 let ran = false;
 expect(check('teh', ((()=>{ ran = true; return {status:0,stdout:'teh\n'}; }) as any), [])).toEqual([]);
 expect(ran).toBe(false);
 // a dictionary dropped under the user dir wins over the system one of the same name
 writeFileSync(join(dir, 'nb_NO.aff'), ''); writeFileSync(join(dir, 'nb_NO.dic'), '');
 expect(dictionaryArg(['en_US','nb_NO'], dir)).toBe('en_US,' + join(dir, 'nb_NO'));
 let args:any;
 check('teh', ((_:any,a:any)=>{args=a;return {status:0,stdout:''}}) as any, ['en_US','nb_NO']);
 expect(args.slice(0,2)).toEqual(['-l','-d']); expect(args[2].startsWith('en_US,')).toBe(true);
});
