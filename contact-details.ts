#!/usr/bin/env bun
/** Exact-card, read-only field viewer. Contact contents stay in memory. */
import {spawnSync} from 'node:child_process';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {normalizeHandle, identityKey, readStdinBounded} from './contact-review';
const MAX_BYTES = 48 * 1024;
const TOKEN = /^sha256:[0-9a-f]{64}$/;
const LABELS: Record<string,string> = {
  prefix:'Prefix',firstName:'First name',middleName:'Middle name',lastName:'Last name',suffix:'Suffix',
  nickname:'Nickname',maidenName:'Maiden name',phoneticFirstName:'Phonetic first name',
  phoneticMiddleName:'Phonetic middle name',phoneticLastName:'Phonetic last name',
  organization:'Organization',department:'Department',jobTitle:'Job title',birthday:'Birthday',note:'Notes',
  phone:'Phone',email:'Email',url:'Website',address:'Address',relatedName:'Related person',
  date:'Date',socialProfile:'Social profile',instantMessage:'Instant message',
};
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw new Error('Invalid contact detail text');
  return value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,' ').trim();
}
export function cardDetails(request: any, runner = spawnSync) {
  const handle = normalizeHandle(request?.handle);
  if (typeof request?.token !== 'string' || !TOKEN.test(request.token)) throw new Error('Invalid contact card token');
  const result = runner(join(process.env.HOME ?? homedir(),'bin','contacts'),['--json','resolve'], {
    input:JSON.stringify({operation:'details',handle,token:request.token}),encoding:'utf8',timeout:35000,maxBuffer:MAX_BYTES,
  });
  if (result.error) throw new Error('Could not read contact details');
  if (Buffer.byteLength(String(result.stdout || '')) > MAX_BYTES) throw new Error('Contact details are too large');
  let body: any;
  try {body=JSON.parse(String(result.stdout));} catch {throw new Error('Invalid contact detail response');}
  if (!body || result.status !== 0 || body.ok !== true)
    throw new Error(text(body?.error || 'Could not read contact details',180));
  if (identityKey(body.handle)!==identityKey(handle) || body.token!==request.token)
    throw new Error('Contacts returned a different card');
  if (!Array.isArray(body.fields) || body.fields.length > 160) throw new Error('Invalid contact fields');
  if (!Number.isInteger(body.accountNumber) || body.accountNumber<1 || body.accountNumber>64)
    throw new Error('Invalid contact account');
  const fields=body.fields.map((field: any) => {
    if (!field || !Object.hasOwn(LABELS,field.key)) throw new Error('Unknown contact field');
    const label=text(field.label,80), value=text(field.value,4096);
    return {label:LABELS[field.key]+(label ? ' · '+label : ''),value};
  });
  return {ok:true,name:text(body.name,160),source:text(body.sourceName,120)+' · Account '+body.accountNumber,fields};
}
if (import.meta.main) {
  const timer=setTimeout(()=>{process.stdout.write('{"ok":false,"error":"Contact request timed out"}\n');process.exit(1);},5000);
  try {
    const request=JSON.parse(await readStdinBounded()); clearTimeout(timer);
    const result=cardDetails(request);
    const output=JSON.stringify(result);
    if (Buffer.byteLength(output)>MAX_BYTES) throw new Error('Contact details are too large');
    process.stdout.write(output+'\n');
  } catch (error) {
    clearTimeout(timer);
    process.stdout.write(JSON.stringify({ok:false,error:String(error instanceof Error ? error.message : error).slice(0,180)})+'\n');
    process.exitCode=1;
  }
}
