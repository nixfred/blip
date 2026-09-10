import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,mkdirSync,symlinkSync,readdirSync,readFileSync,statSync,writeFileSync,utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,basename,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {vcardBytes,writeVcard,copyContactVcard,vcardFileName,saveVcardInFolder,exportContactVcard,vcardShortName} from './contact-vcard';
const card=Buffer.from('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Example Person\r\nN:Person;Example;;;\r\nNICKNAME:Ex\r\nEND:VCARD\r\n');
const token='sha256:'+'a'.repeat(64), handle='+15551234567';
const body={ok:true,token,handle,vcard:card.toString('base64')};
test('validates exact-card identity and bounded canonical vCard bytes',()=>{
  expect(vcardBytes(body,handle,token)).toEqual(card);
  for(const value of [null,{...body,token:'bad'},{...body,handle:'+15551234568'},
    {...body,vcard:'!!!!'}, {...body,vcard:Buffer.from('BEGIN:VCARD\r\ntruncated').toString('base64')},
    {...body,vcard:'A'.repeat(3*1024*1024+4)}]) expect(()=>vcardBytes(value,handle,token)).toThrow();
});
test('copies a runtime file through clipboard stdin and reports failure honestly',()=>{
  const dir=mkdtempSync(join(tmpdir(),'blip-vcard-'));
  try {
    const calls:any[]=[];
    const runner=((command:string,args:string[],options:any)=>{
      calls.push({command,args,input:options.input});
      return {status:0,stdout:command.endsWith('/contacts')?JSON.stringify(body):''};
    }) as any;
    expect(copyContactVcard({handle,token},runner,dir).view).toBe('copied');
    expect(calls[0].args).toEqual(['--json','resolve']);
    expect(JSON.parse(calls[0].input)).toEqual({operation:'vcard',handle,token});
    expect(calls[1].args).toEqual(['--type','text/uri-list']);
    expect(calls[1].input.endsWith('\r\n')).toBe(true);
    const uri=calls[1].input.trim(),path=fileURLToPath(uri);
    expect(readFileSync(path)).toEqual(card);
    expect(basename(path)).toBe('Ex.vcf');
    expect(statSync(dirname(path)).mode&0o777).toBe(0o700);
    expect(statSync(path).mode&0o777).toBe(0o600);
    expect(()=>copyContactVcard({handle,token},((command:string)=>({status:command.endsWith('/contacts')?0:1,stdout:JSON.stringify(body)})) as any,dir)).toThrow('clipboard');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('rejects symlink directories and keeps at most 32 prior clipboard files',()=>{
  const dir=mkdtempSync(join(tmpdir(),'blip-vcard-')),target=mkdtempSync(join(tmpdir(),'blip-vcard-target-'));
  try {
    symlinkSync(target,join(dir,'blip'));
    expect(()=>writeVcard(card,dir)).toThrow();
    rmSync(join(dir,'blip'));
    for(let i=0;i<34;i++) writeVcard(card,dir);
    expect(readdirSync(join(dir,'blip','vcards'))).toHaveLength(32);
    expect(()=>writeVcard(card,'relative')).toThrow('runtime');
  } finally {rmSync(dir,{recursive:true,force:true});rmSync(target,{recursive:true,force:true});}
});

test('saves a named private vCard without replacing existing files or links',()=>{
  const dir=mkdtempSync(join(tmpdir(),'blip-save-vcard-'));
  try {
    const first=saveVcardInFolder(card,dir,'Example Person');
    expect(first).toBe(join(dir,'Example Person.vcf'));
    expect(readFileSync(first)).toEqual(card);
    expect(statSync(first).mode&0o777).toBe(0o600);
    symlinkSync(first,join(dir,'Example Person (2).vcf'));
    const next=saveVcardInFolder(Buffer.from('different synthetic bytes'),dir,'Example Person');
    expect(next).toBe(join(dir,'Example Person (3).vcf'));
    expect(readFileSync(first)).toEqual(card);
    expect(readdirSync(dir).some(name=>name.startsWith('.blip-'))).toBe(false);
    expect(()=>saveVcardInFolder(card,'relative','Person')).toThrow('folder');
    expect(()=>saveVcardInFolder(Buffer.alloc(2*1024*1024+1),dir,'Person')).toThrow('large');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('suggested vCard names are bounded basenames',()=>{
  expect(vcardFileName('Example Person')).toBe('Example Person.vcf');
  expect(vcardFileName('../Example/Person\n\u202e')).toBe('Example Person.vcf');
  expect(vcardFileName(null)).toBe('Contact.vcf');
  expect(vcardFileName('x'.repeat(161))).toBe('Contact.vcf');
  expect(Buffer.byteLength(vcardFileName('界'.repeat(100)))).toBeLessThanOrEqual(124);
});
test('save uses the chosen folder and leaves the clipboard alone; cancellation writes nothing',()=>{
  const dir=mkdtempSync(join(tmpdir(),'blip-save-picker-'));
  try {
    let cancelled=true;
    const calls:any[]=[];
    const runner=((command:string,args:string[],options:any)=>{
      calls.push({command,args,options});
      if(command.endsWith('/contacts')) return {status:0,stdout:JSON.stringify({...body,name:'Example Person'})};
      if(command.endsWith('/xdg-user-dir')) return {status:0,stdout:dir+'\n'};
      if(command.endsWith('/zenity')) return {status:cancelled?1:0,stdout:dir+'\n'};
      throw new Error('Unexpected command');
    }) as any;
    expect(exportContactVcard({handle,token,action:'save'},runner).view).toBe('cancelled');
    expect(readdirSync(dir)).toHaveLength(0);
    cancelled=false;
    expect(exportContactVcard({handle,token,action:'save'},runner).view).toBe('saved');
    expect(readFileSync(join(dir,'Ex.vcf'))).toEqual(card);
    const picker=calls.find(call=>call.command.endsWith('/zenity'));
    expect(picker.args).toContain('--filename='+dir+'/');
    expect(picker.options.maxBuffer).toBe(4097);
    expect(picker.options.timeout).toBe(300000);
    expect(calls.some(call=>call.command.endsWith('/wl-copy'))).toBe(false);
    expect(()=>exportContactVcard({handle,token,action:'invalid'},runner)).toThrow('action');
  } finally {rmSync(dir,{recursive:true,force:true});}
});


test('uses nickname, then structured first name, without shortening compound names',()=>{
  const withFields=(fields:string)=>Buffer.from('BEGIN:VCARD\r\nVERSION:3.0\r\n'+fields+'\r\nEND:VCARD\r\n');
  expect(vcardShortName(card,'Example Person')).toBe('Ex');
  expect(vcardShortName(withFields('N:Person;Example Person;;;'))).toBe('Example Person');
  expect(vcardShortName(withFields('N:Person;Example \r\n Person;;;'))).toBe('Example Person');
  expect(vcardShortName(withFields('N:Person;;;;'))).toBe('Person');
  expect(vcardShortName(withFields('NICKNAME:Ex\\, Jr,Other'))).toBe('Ex, Jr');
  expect(vcardShortName(withFields('NICKNAME:   \r\nN:Person;Example;;;'))).toBe('Example');
  expect(vcardShortName(withFields('FN:Example Organization'),'Example Organization')).toBe('Example Organization');
  expect(vcardShortName(withFields('FN:'),null)).toBe('Contact');
});
test('repeated copies retain the same short filename without replacing earlier exports',()=>{
  const dir=mkdtempSync(join(tmpdir(),'blip-short-vcard-'));
  try {
    const first=fileURLToPath(writeVcard(card,dir,'Ex'));
    const next=fileURLToPath(writeVcard(Buffer.from('different synthetic bytes'),dir,'Ex'));
    expect(basename(first)).toBe('Ex.vcf');
    expect(basename(next)).toBe('Ex.vcf');
    expect(dirname(first)).not.toBe(dirname(next));
    expect(readFileSync(first)).toEqual(card);
    const old=join(dir,'blip','vcards','contact-'+'a'.repeat(32)+'.vcf');
    writeFileSync(old,card,{mode:0o600});utimesSync(old,0,0);
    utimesSync(dirname(first),0,0);
    writeVcard(card,dir,'Ex');
    expect(()=>statSync(old)).toThrow();
    expect(()=>statSync(dirname(first))).toThrow();
    expect(readFileSync(next)).toEqual(Buffer.from('different synthetic bytes'));
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('runtime cleanup refuses unexpected contents in a copy directory',()=>{
  const dir=mkdtempSync(join(tmpdir(),'blip-copy-cleanup-'));
  try {
    const path=fileURLToPath(writeVcard(card,dir,'Ex'));
    const target=join(dir,'keep.vcf');writeFileSync(target,card);
    rmSync(path);symlinkSync(target,path);utimesSync(dirname(path),0,0);
    expect(()=>writeVcard(card,dir,'Ex')).toThrow('Unexpected file');
    expect(readFileSync(target)).toEqual(card);
    rmSync(path);writeFileSync(path,card);writeFileSync(join(dirname(path),'extra.vcf'),card);utimesSync(dirname(path),0,0);
    expect(()=>writeVcard(card,dir,'Ex')).toThrow('Too many files');
    expect(readFileSync(path)).toEqual(card);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
