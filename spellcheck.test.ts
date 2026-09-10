import { expect, test } from 'bun:test';
import { words, misspellings, check, MAX_BYTES } from './spellcheck';
test('ranges use UTF-16 editor offsets and skip links and email',()=> {
 const text = '😀 teh https://example.com/mispell foo@example.com wrng';
 expect(misspellings(text,'teh\nwrng\nexample\n')).toEqual([{start:3,end:6},{start:51,end:55}]);
});
test('spelling is bounded, literal, and stdin-only',()=> {
 expect(words('x'.repeat(MAX_BYTES+1))).toEqual([]);
 expect(misspellings('teh','x'.repeat(MAX_BYTES+1))).toEqual([]);
 let args:any, options:any;
 const result=check('teh',((_:any,a:any,o:any)=>{args=a;options=o;return {status:0,stdout:'teh\n'}}) as any);
 expect(args).not.toContain('teh'); expect(options.input).toBe('teh\n');
 expect(result).toEqual([{start:0,end:3}]);
 expect(check('teh',(()=>({status:1,stdout:''})) as any)).toEqual([]);
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
