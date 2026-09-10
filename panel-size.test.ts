import {test,expect} from 'bun:test';
import {fitSize,parseSize} from './panel-size';
import {sizeStore} from './panel-size-store';
import {mkdtempSync,rmSync,writeFileSync,symlinkSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('panel sizes cap width at 500px and height at 80% of the current display',()=>{
 expect(fitSize(700,1500,1920,1080,1880,1000)).toEqual({width:500,height:864});
 expect(fitSize(700,1500,3072,1728,3032,1650)).toEqual({width:500,height:1382});
 expect(fitSize(700,1500,320,200,300,180)).toEqual({width:300,height:160});
 expect(fitSize(500,600,1920,1080,1880,1000)).toEqual({width:500,height:600});
 for (const value of [null,[],{}, {width:'500',height:600},{width:NaN,height:3},{width:20000,height:600}]) expect(parseSize(value)).toBeNull();
});
test('size storage round-trips dimensions and rejects oversized files and symlinks',()=>{
 const dir=mkdtempSync(join(tmpdir(),'blip-size-'));
 try {
  expect(sizeStore(dir,['500','600'])).toEqual({width:500,height:600});
  expect(sizeStore(dir,[])).toEqual({width:500,height:600});
  expect(statSync(join(dir,'panel.json')).mode & 0o777).toBe(0o600);
  writeFileSync(join(dir,'panel.json'),' '.repeat(257));
  expect(sizeStore(dir,[])).toBeNull();
  rmSync(join(dir,'panel.json'));
  symlinkSync('missing',join(dir,'panel.json'));
  expect(()=>sizeStore(dir,[])).toThrow();
  expect(sizeStore(dir,['bad','600'])).toBeNull();
 } finally {rmSync(dir,{recursive:true,force:true});}
});
