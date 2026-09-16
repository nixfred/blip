#!/usr/bin/env bun
/** New contacts only. All contact fields stay in memory and cross bounded stdin. */
import {spawnSync} from 'node:child_process';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {normalizeHandle, readStdinBounded} from './contact-review';
export const MAX_CONTACT_SAVE_BYTES = 8192;
const UNSAFE = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;
export interface ContactDraft {handle: string; firstName: string; lastName: string; phone: string; email: string}
function field(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum || UNSAFE.test(value))
    throw new Error(`Invalid ${label}`);
  return value.trim();
}
export function contactKey(value: string): string {
  return value.includes('@') ? 'email:'+value.toLowerCase() : 'phone:'+value.replace(/\D/g,'');
}
export function prepareContact(value: any): ContactDraft {
  const handle = normalizeHandle(field(value?.handle, 'sender', 320));
  return {handle, firstName:'', lastName:'', phone:handle.includes('@') ? '' : handle,
    email:handle.includes('@') ? handle : ''};
}
export function normalizeContactDraft(value: any): ContactDraft {
  const handle = prepareContact(value).handle;
  const firstName = field(value.firstName, 'first name', 160);
  const lastName = field(value.lastName, 'last name', 160);
  if (!firstName && !lastName) throw new Error('Enter a first or last name');
  const phone = field(value.phone, 'phone number', 80);
  const email = field(value.email, 'email address', 254);
  if (phone && (normalizeHandle(phone).includes('@') || phone.replace(/\D/g,'').length > 15))
    throw new Error('Invalid phone number');
  if (email && !normalizeHandle(email).includes('@')) throw new Error('Invalid email address');
  if (![phone,email].filter(Boolean).some(v=>contactKey(v)===contactKey(handle)))
    throw new Error('Keep the selected sender’s number or email on the new contact');
  return {handle,firstName,lastName,phone,email};
}
export function previewContact(value: any) {
  const draft = normalizeContactDraft(value);
  return {ok:true, draft, name:[draft.firstName,draft.lastName].filter(Boolean).join(' ')};
}
export function saveContact(value: any, runner = spawnSync) {
  const draft = normalizeContactDraft(value);
  if (value.confirmed !== true) throw new Error('Review the contact before saving');
  const input = JSON.stringify({operation:'create',...draft,confirmed:true});
  if (Buffer.byteLength(input)>MAX_CONTACT_SAVE_BYTES) throw new Error('Contact request is too large');
  const result = runner(join(process.env.HOME ?? homedir(),'bin','contact-save'),[], {
    input, encoding:'utf8',timeout:325000,maxBuffer:MAX_CONTACT_SAVE_BYTES,
  });
  // A lost response can follow a successful save. Do not offer an automatic retry.
  const unknown = 'Save could not be verified. Check Contacts on the Mac before trying again.';
  if (result.error || Buffer.byteLength(String(result.stdout || ''))>MAX_CONTACT_SAVE_BYTES)
    return {ok:false,uncertain:true,error:unknown};
  let body: any;
  try {body = JSON.parse(String(result.stdout));} catch {return {ok:false,uncertain:true,error:unknown};}
  if (result.status!==0 || body?.ok!==true) {
    const known = {busy:'Another contact is being saved. Wait for it to finish, then try again.',duplicate:'A contact already has this number or email. Open contact review to inspect it.',
      permission:'Allow Contacts access on the Mac, then reopen this form.',
      invalid:'The Mac rejected this contact. Reopen the form and check its fields.',
      unavailable:'The Mac Contacts helper is unavailable. Update the bridge and try again.'};
    if (body?.code && Object.hasOwn(known,body.code))
      return {ok:false,uncertain:false,error:known[body.code as keyof typeof known]};
    return {ok:false,uncertain:true,error:unknown};
  }
  if (body.created!==true || typeof body.id!=='string' || !body.id || body.id.length>200 || UNSAFE.test(body.id))
    return {ok:false,uncertain:true,error:unknown};
  let actual: ContactDraft;
  try {actual = normalizeContactDraft(body.contact);} catch {return {ok:false,uncertain:true,error:unknown};}
  if (Object.keys(draft).some(key=>draft[key as keyof ContactDraft]!==actual[key as keyof ContactDraft]))
    return {ok:false,uncertain:true,error:unknown};
  return {ok:true,name:previewContact(draft).name};
}
if (import.meta.main) {
  const timer=setTimeout(()=>{process.stdout.write('{"ok":false,"error":"Contact request timed out"}\n');process.exit(1);},5000);
  try {
    const value=JSON.parse(await readStdinBounded(process.stdin as any,MAX_CONTACT_SAVE_BYTES));
    clearTimeout(timer);
    const mode=process.argv[2];
    const result=mode==='prepare' ? {ok:true,draft:prepareContact(value)} : mode==='preview' ? previewContact(value)
      : mode==='save' ? saveContact(value) : (()=>{throw new Error('Invalid contact operation');})();
    process.stdout.write(JSON.stringify(result)+'\n');
  } catch (error) {
    clearTimeout(timer);
    process.stdout.write(JSON.stringify({ok:false,error:error instanceof Error ? error.message : 'Contact request failed'})+'\n');
    process.exitCode=1;
  }
}
