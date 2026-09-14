import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {prepareContact,normalizeContactDraft,previewContact,saveContact,MAX_CONTACT_SAVE_BYTES} from './contact-save';
const draft={handle:'+15551234567',firstName:'Example',lastName:'Person',phone:'+15551234567',email:'example@example.com'};
const request={...draft,confirmed:true};
const success={ok:true,created:true,id:'synthetic-contact-id',contact:draft};
function runner(body: any, status=0): any {return (_cmd: string,args: string[],options:any)=>{
  expect(args).toEqual([]);
  expect(JSON.parse(options.input)).toEqual({operation:'create',...request});
  expect(options.maxBuffer).toBe(MAX_CONTACT_SAVE_BYTES);
  expect(options.timeout).toBeGreaterThanOrEqual(150000);
  return {status,stdout:JSON.stringify(body)};
};}
test('prefills exactly the selected phone or email without guessing a name',()=>{
  expect(prepareContact(draft)).toEqual({...draft,firstName:'',lastName:'',email:''});
  expect(prepareContact({handle:'example@example.com'})).toEqual({handle:'example@example.com',firstName:'',lastName:'',phone:'',email:'example@example.com'});
});
test('requires a name and preserves the selected sender identity',()=>{
  expect(previewContact({...draft,firstName:'  Example  '})).toEqual({ok:true,draft,name:'Example Person'});
  for (const value of [null,{...draft,firstName:'',lastName:''},{...draft,phone:'+15551234568'},
    {...draft,phone:'example@example.com'},{...draft,email:'+15551234567'},
    {...draft,handle:'chat1234567'},{...draft,firstName:'Example\u202ePerson'},
    {...draft,lastName:'x'.repeat(161)},{...draft,phone:' +15551234567\n'},
    {...draft,phone:'+4415551234567'},{...draft,phone:'+1234567890123456'}])
    expect(()=>normalizeContactDraft(value)).toThrow();
  expect(normalizeContactDraft({...draft,phone:'1 (555) 123-4567'}).phone).toBe('1 (555) 123-4567');
});
test('parenthesized phone numbers work in the form and both native identity fields',()=>{
  const helper=native();
  for(const fields of [{handle:'(555) 123-4567',phone:'5551234567'},
    {handle:'5551234567',phone:'(555) 123-4567'}]) {
    const value={...draft,...fields};
    expect(normalizeContactDraft(value)).toEqual(value);
    expect(helper.normalizeSave({operation:'create',confirmed:true,...value})).toEqual(value);
  }
  for(const phone of ['(555) 123-4568','(abc) 123-4567','(12)','()','555+1234567']) {
    const value={...draft,handle:'5551234567',phone};
    expect(()=>normalizeContactDraft(value)).toThrow();
    expect(()=>helper.normalizeSave({operation:'create',confirmed:true,...value})).toThrow();
  }
});
test('sends a confirmed new card on bounded stdin and validates the exact result',()=>{
  expect(()=>saveContact(draft,runner(success))).toThrow('Review');
  expect(saveContact(request,runner(success))).toEqual({ok:true,name:'Example Person'});
  for(const body of [null,{}, {...success,id:''},{...success,created:false},
    {...success,contact:{...draft,firstName:'Other'}},{...success,contact:{...draft,phone:'15551234567'}}])
    expect(saveContact(request,runner(body))).toMatchObject({ok:false,uncertain:true});
});
test('unknown outcome disables retry and never echoes native diagnostics',()=>{
  expect(saveContact(request,(()=>({error:new Error('sensitive response')})) as any)).toMatchObject({ok:false,uncertain:true});
  expect(saveContact(request,(()=>({status:0,stdout:' '.repeat(MAX_CONTACT_SAVE_BYTES+1)})) as any)).toMatchObject({ok:false,uncertain:true});
  expect(saveContact(request,runner({ok:false,error:'sensitive response'},1))).toMatchObject({ok:false,uncertain:true});
  expect(JSON.stringify(saveContact(request,runner({ok:false,error:'sensitive response'},1)))).not.toContain('sensitive response');
  expect(saveContact(request,runner({ok:false,code:'duplicate'},1))).toMatchObject({ok:false,uncertain:false});
});
function native() {
  const source=readFileSync(new URL('./bridge/mac/contact-save.js',import.meta.url),'utf8');
  return runInNewContext(source+'\n({normalizeSave,createContact,nativeContactMatch})',{ObjC:{import:()=>{}}});
}
function adapter(overrides: any={}) {
  return {available:()=>true,contains:()=>false,create:()=>success.id,read:()=>draft,...overrides};
}
test('Mac adapter validates before native access and refuses existing identities',()=>{
  const helper=native();
  let calls=0;
  const guarded=adapter({available:()=>{calls++;return true;},create:()=>{calls++;return success.id;}});
  expect(helper.createContact({...request,operation:'wrong'},guarded)).toEqual({ok:false,code:'invalid'});
  expect(calls).toBe(0);
  expect(helper.createContact({operation:'create',...request},adapter({contains:()=>true,create:()=>{throw new Error('must not run');}}))).toEqual({ok:false,code:'duplicate'});
  expect(helper.createContact({operation:'create',...request},adapter({available:()=>false}))).toEqual({ok:false,code:'permission'});
});
test('Mac adapter verifies the created id and every returned field',()=>{
  const helper=native();
  expect(helper.createContact({operation:'create',...request},adapter({read:(id:string,handle:string)=>{
    expect(id).toBe(success.id);expect(handle).toBe(draft.handle);return draft;
  }}))).toEqual(success);
  for(const overrides of [{create:()=>''},{create:()=>{throw new Error('native failure');}},
    {read:()=>null},{read:()=>({...draft,phone:'+15551234568'})}])
    expect(helper.createContact({operation:'create',...request},adapter(overrides))).toEqual({ok:false,code:'unknown'});
});
test('denied Contacts access reports permission without attempting creation',()=>{
  const helper=native();
  let calls=0;
  const result=helper.createContact({operation:'create',...request},adapter({
    contains:()=>{throw new Error('native access denied');},permissionDenied:()=>true,
    create:()=>{calls++;throw new Error('must not run');},
  }));
  expect(result).toEqual({ok:false,code:'permission'});
  expect(calls).toBe(0);
});
test('Linux and Mac validators agree on hostile fields and selected identity',()=>{
  const helper=native();
  for(const override of [{confirmed:false},{firstName:'',lastName:''},{firstName:'x'.repeat(161)},
    {phone:'+15551234568'},{email:'not-an-email'},{handle:'chat1234567'},{lastName:'\u0000hidden'},
    {phone:'+4415551234567'},{phone:'+1234567890123456'}])
    expect(()=>helper.normalizeSave({operation:'create',...request,...override})).toThrow();
});

test('native duplicate matching delegates phone and email lookups without requiring a name',()=>{
  const helper=native();
  const calls: unknown[]=[];
  expect(helper.nativeContactMatch(draft,(kind:string,value:string)=>{
    calls.push([kind,value]);return kind==='email' ? 1 : 0;
  })).toBe(true);
  expect(calls).toEqual([['phone',draft.phone],['email',draft.email]]);
  expect(helper.nativeContactMatch(draft,()=>0)).toBe(false);
  expect(helper.nativeContactMatch({...draft,phone:''},(kind:string)=>{expect(kind).toBe('email');return 1;})).toBe(true);
  for(const count of [null,undefined,-1,NaN,1.5])
    expect(()=>helper.nativeContactMatch(draft,()=>count)).toThrow('unavailable');
  expect(()=>helper.nativeContactMatch(draft,()=>{throw new Error('permission');})).toThrow('permission');
});

test('native contact creation invokes the unambiguous save selector before verification',()=>{
  const source=readFileSync(new URL('./bridge/mac/contact-save.js',import.meta.url),'utf8');
  const fields: Record<string,unknown>={};
  let saved=false;
  const person={uniqueId:'synthetic-contact-id',setValueForProperty:(value:unknown,key:string)=>{fields[key]=value;return true;}};
  const book={addRecord:(value:unknown)=>{expect(value).toBe(person);return true;},
    saveAndReturnError:(error:unknown)=>{expect(error).toEqual([]);saved=true;return true;},
    get save(){throw new Error('ambiguous save selector');}};
  const dollar:any=(value:unknown)=>value;
  Object.assign(dollar,{ABAddressBook:{sharedAddressBook:book},ABPerson:{alloc:{initWithAddressBook:()=>person}},
    ABMutableMultiValue:{alloc:{get init(){return {addValueWithLabel:()=>{}};}}},
    kABFirstNameProperty:'firstName',kABLastNameProperty:'lastName',kABPhoneProperty:'phone',kABEmailProperty:'email'});
  const helper=runInNewContext(source+'\n({nativeAdapter})',{ObjC:{import:()=>{},unwrap:(value:unknown)=>value},$:dollar,Ref:()=>[]});
  expect(helper.nativeAdapter().create(draft)).toBe('synthetic-contact-id');
  expect(saved).toBe(true);
  expect(fields.firstName).toBe(draft.firstName);
});

// Exercise the shipped native adapter and inspect entry point with synthetic
// framework objects. No real Contacts store is opened or modified.
function inspectNative(options: {native?: 'nil'|'throw'|'empty'|'match', phones?: string[], email?: string,
  brokenBook?: boolean, denied?: boolean} = {}) {
  const source=readFileSync(new URL('./bridge/mac/contact-save.js',import.meta.url),'utf8');
  const value={operation:'create',...request,phase:'inspect',handle:'5551234567',phone:'5551234567'};
  const person={valueForProperty:(property:string)=>{
    const entries=property==='phone' ? options.phones ?? ['+15551234567'] : [options.email ?? ''];
    return {count:entries.length,valueAtIndex:(index:number)=>entries[index]};
  }};
  const book={get people(){
    if(options.brokenBook) throw new Error('AddressBook read failed');
    return {count:1,objectAtIndex:()=>person};
  },addRecord:()=>{throw new Error('inspection must never create');}};
  const dollar:any=(item:unknown)=>item;
  Object.assign(dollar,{
    ABAddressBook:{sharedAddressBook:book},kABPhoneProperty:'phone',kABEmailProperty:'email',
    CNContactStore:{authorizationStatusForEntityType:()=>options.denied ? 2 : 3,alloc:{init:{
      unifiedContactsMatchingPredicateKeysToFetchError:()=>{
        if(options.native==='throw') throw new Error('native predicate failed');
        return options.native==='empty' ? {count:0} : options.native==='match' ? {count:1} : null;
      },
    }}},
    CNContact:{predicateForContactsMatchingPhoneNumber:()=>({}),predicateForContactsMatchingEmailAddress:()=>({})},
    CNPhoneNumber:{phoneNumberWithStringValue:(item:unknown)=>item},CNContactIdentifierKey:'identifier',
    NSFileHandle:{fileHandleWithStandardInput:{readDataOfLength:()=>JSON.stringify(value)}},
    NSString:{alloc:{initWithDataEncoding:(item:unknown)=>item}},NSUTF8StringEncoding:4,
  });
  const helper=runInNewContext(source+'\n({run,nativeAdapter})',{
    ObjC:{import:()=>{},unwrap:(item:unknown)=>item},$:dollar,Ref:()=>[],
  });
  return {response:JSON.parse(helper.run()),adapter:helper.nativeAdapter(),value};
}
test('nil or throwing native predicates still produce regional phone candidates',()=>{
  for(const native of ['nil','throw','empty'] as const)
    expect(inspectNative({native}).response).toEqual({ok:true,duplicate:false,phones:['+15551234567']});
});
test('failed or empty native predicates still check exact phones and email before creation',()=>{
  for(const result of ['nil','empty'] as const)
  for(const options of [{phones:['5551234567']},{email:draft.email.toUpperCase()}]) {
    const fixture=inspectNative({...options,native:result});
    expect(fixture.response).toEqual({ok:true,duplicate:true,phones:[]});
    expect(native().createContact(fixture.value,fixture.adapter)).toEqual({ok:false,code:'duplicate'});
  }
});
test('failed native and AddressBook checks refuse inspection and creation',()=>{
  const fixture=inspectNative({brokenBook:true});
  expect(fixture.response).toEqual({ok:false,code:'unavailable'});
  expect(native().createContact(fixture.value,fixture.adapter)).toEqual({ok:false,code:'unavailable'});
  expect(inspectNative({denied:true}).response).toEqual({ok:false,code:'permission'});
});
test('successful native duplicate result does not require AddressBook fallback',()=>{
  expect(inspectNative({native:'match',brokenBook:true}).response).toEqual({ok:true,duplicate:true,phones:[]});
});
test('phone format grammar cannot drift across the four contact validators',()=>{
  const sites=[['contact-review.ts',/!\/\^(.+)\$\/\.test\(handle\)/],
    ['bridge/mac/contact-save.js',/!\/\^(.+)\$\/\.test\(value\)/],
    ['bridge/mac/contact-save',/re\.fullmatch\(r"([^"]+)", value\)/g],
    ['bridge/mac/contacts',/re\.fullmatch\(r"([^"]+)", handle\)/]] as const;
  const expected=String.raw`\+?[0-9(][0-9 ()./-]{2,39}`;
  for(const [file,pattern] of sites) {
    const source=readFileSync(new URL(file,import.meta.url),'utf8');
    const matches=[...source.matchAll(new RegExp(pattern.source,'g'))].map(match=>match[1]);
    expect(matches.filter(rule=>rule.startsWith(String.raw`\+?`))).toEqual([expected]);
  }
});
