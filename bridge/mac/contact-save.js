/* Create one contact through the native AddressBook object layer, never SQLite. */
ObjC.import('Foundation');
const MAX_SAVE_BYTES = 8192;
const UNSAFE_SAVE = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;
function saveField(value, maximum) {
  if (typeof value !== 'string' || value.length>maximum || UNSAFE_SAVE.test(value)) throw new Error('invalid');
  return value.trim();
}
function saveKey(value) {
  if (value.indexOf('@')>=0) {
    if (value.length>254 || !/^[^@\s]+@[^@\s]+$/.test(value)) throw new Error('invalid');
    return 'email:'+value.toLowerCase();
  }
  if (!/^\+?[0-9(][0-9 ()./-]{2,39}$/.test(value)) throw new Error('invalid');
  const digits=value.replace(/\D/g,'');
  if (digits.length<5 || digits.length>15) throw new Error('invalid');
  return 'phone:'+digits;
}
function normalizeSave(value) {
  if (!value || value.operation!=='create' || value.confirmed!==true) throw new Error('invalid');
  const draft={handle:saveField(value.handle,320),firstName:saveField(value.firstName,160),
    lastName:saveField(value.lastName,160),phone:saveField(value.phone,80),email:saveField(value.email,254)};
  if (!draft.firstName && !draft.lastName) throw new Error('invalid');
  if (draft.phone && saveKey(draft.phone).indexOf('phone:')!==0) throw new Error('invalid');
  if (draft.email && saveKey(draft.email).indexOf('email:')!==0) throw new Error('invalid');
  const selected=saveKey(draft.handle);
  if (![draft.phone,draft.email].filter(Boolean).some(function(v){return saveKey(v)===selected;})) throw new Error('invalid');
  return draft;
}
function nativePermissionDenied() {
  try {
    ObjC.import('Contacts');
    return [1,2,4].indexOf(Number($.CNContactStore.authorizationStatusForEntityType(0)))>=0;
  } catch (_) {return false;}
}
function contactUnavailable(adapter) {
  let denied=false;
  try {denied=adapter && adapter.permissionDenied ? adapter.permissionDenied() : nativePermissionDenied();} catch (_) {}
  return {ok:false,code:denied ? 'permission' : 'unavailable'};
}
function createContact(value, adapter) {
  let draft;
  try {draft=normalizeSave(value);} catch (_) {return {ok:false,code:'invalid'};}
  try {
    if (!adapter.available()) return {ok:false,code:'permission'};
    if (adapter.contains(draft)) return {ok:false,code:'duplicate'};
  } catch (_) {return contactUnavailable(adapter);}
  // Everything after this point may already have committed. Never promise that
  // a failed transport or verification means no contact was added.
  try {
    const id=adapter.create(draft);
    if (typeof id!=='string' || !id || id.length>200 || UNSAFE_SAVE.test(id)) throw new Error('unknown');
    const actual=adapter.read(id,draft.handle);
    if (!actual || Object.keys(draft).some(function(key){return actual[key]!==draft[key];})) throw new Error('unknown');
    return {ok:true,created:true,id:id,contact:actual};
  } catch (_) {return {ok:false,code:'unknown'};}
}
function nativeContactMatch(draft, lookup) {
  const values=[['phone',draft.phone],['email',draft.email]];
  for (let i=0;i<values.length;i++) {
    if (!values[i][1]) continue;
    const count=lookup(values[i][0],values[i][1]);
    if (!Number.isInteger(count) || count<0) throw new Error('unavailable');
    if (count>0) return true;
  }
  return false;
}
function nativeLookup() {
  // Let Contacts apply its own phone-region matching rules. Fetch identifiers
  // only; a nameless card still counts as an existing contact.
  ObjC.import('Contacts');
  const store=$.CNContactStore.alloc.init;
  return function(kind,value) {
    const predicate=kind==='phone'
      ? $.CNContact.predicateForContactsMatchingPhoneNumber($.CNPhoneNumber.phoneNumberWithStringValue($(value)))
      : $.CNContact.predicateForContactsMatchingEmailAddress($(value));
    const error=Ref();
    const found=store.unifiedContactsMatchingPredicateKeysToFetchError(predicate,$([$.CNContactIdentifierKey]),error);
    if (!ObjC.unwrap(found)) throw new Error('unavailable');
    return Number(found.count);
  };
}
function nativeAdapter() {
  ObjC.import('AddressBook');
  const book=$.ABAddressBook.sharedAddressBook;
  function string(value) {const plain=ObjC.unwrap(value);return plain===null || plain===undefined ? '' : String(plain);}
  function values(person,property) {
    const list=person.valueForProperty(property);
    if (!ObjC.unwrap(list)) return [];
    const count=Number(list.count);
    if (!Number.isInteger(count) || count<0 || count>256) throw new Error('unavailable');
    const result=[];
    for (let i=0;i<count;i++) result.push(string(list.valueAtIndex(i)));
    return result;
  }
  return {
    available:function(){return !nativePermissionDenied() && !!ObjC.unwrap(book);},
    permissionDenied:nativePermissionDenied,
    contains:function(draft){
      try {
        if (nativeContactMatch(draft,nativeLookup())) return true;
      } catch (_) {
        // A failed Contacts predicate must not bypass the AddressBook check
        // below or prevent inspection from collecting regional candidates.
        // AddressBook failures still propagate and block creation.
      }
      const people=book.people, count=Number(people.count);
      if (!Number.isInteger(count) || count<0 || count>100000) throw new Error('unavailable');
      const keys=[draft.phone,draft.email].filter(Boolean).map(saveKey);
      for (let i=0;i<count;i++) {
        const person=people.objectAtIndex(i);
        const found=values(person,$.kABPhoneProperty).concat(values(person,$.kABEmailProperty)).some(function(value){
          try {return keys.indexOf(saveKey(value.trim()))>=0;} catch (_) {return false;}
        });
        if (found) return true;
      }
      return false;
    },
    phoneCandidates:function(phone){
      if (!phone) return [];
      const digits=phone.replace(/\D/g,'');
      if (digits.length<7) return [];
      const suffix=digits.slice(-7), result=[];
      const people=book.people, count=Number(people.count);
      if (!Number.isInteger(count) || count<0 || count>100000) throw new Error('unavailable');
      for (let i=0;i<count;i++) {
        const person=people.objectAtIndex(i);
        values(person,$.kABPhoneProperty).forEach(function(value){
          if (value.replace(/\D/g,'').slice(-7)!==suffix || result.indexOf(value)>=0) return;
          if (value.length>80 || UNSAFE_SAVE.test(value) || result.length>=64) throw new Error('unavailable');
          result.push(value);
        });
      }
      return result;
    },
    create:function(draft){
      const person=$.ABPerson.alloc.initWithAddressBook(book);
      if (!ObjC.unwrap(person)) throw new Error('unknown');
      function set(value,property) {if (!person.setValueForProperty(value,property)) throw new Error('unknown');}
      if (draft.firstName) set($(draft.firstName),$.kABFirstNameProperty);
      if (draft.lastName) set($(draft.lastName),$.kABLastNameProperty);
      function add(value,property,label) {
        if (!value) return;
        const list=$.ABMutableMultiValue.alloc.init;
        list.addValueWithLabel($(value),label);
        set(list,property);
      }
      add(draft.phone,$.kABPhoneProperty,$.kABPhoneMobileLabel);
      add(draft.email,$.kABEmailProperty,$.kABEmailHomeLabel);
      if (!book.addRecord(person) || !book.saveAndReturnError(Ref())) throw new Error('unknown');
      return string(person.uniqueId);
    },
    read:function(id,handle){
      const persisted=$.ABAddressBook.addressBook;
      const person=persisted.recordForUniqueId($(id));
      if (!ObjC.unwrap(person)) throw new Error('unknown');
      const phones=values(person,$.kABPhoneProperty), emails=values(person,$.kABEmailProperty);
      if (phones.length>1 || emails.length>1) throw new Error('unknown');
      return {handle:handle,firstName:string(person.valueForProperty($.kABFirstNameProperty)),
        lastName:string(person.valueForProperty($.kABLastNameProperty)),phone:phones[0] || '',email:emails[0] || ''};
    }
  };
}
function run() {
  let value;
  try {
    const input=$.NSFileHandle.fileHandleWithStandardInput.readDataOfLength(MAX_SAVE_BYTES+1);
    if (Number(input.length)>MAX_SAVE_BYTES) return JSON.stringify({ok:false,code:'invalid'});
    value=JSON.parse(String(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input,$.NSUTF8StringEncoding))));
    normalizeSave(value);
  } catch (_) {return JSON.stringify({ok:false,code:'invalid'});}
  let adapter;
  try {
    adapter=nativeAdapter();
    if (value.phase==='inspect') {
      const draft=normalizeSave(value);
      if (!adapter.available()) return JSON.stringify({ok:false,code:'permission'});
      const duplicate=adapter.contains(draft);
      return JSON.stringify({ok:true,duplicate:duplicate,phones:duplicate ? [] : adapter.phoneCandidates(draft.phone)});
    }
    return JSON.stringify(createContact(value,adapter));
  }
  catch (_) {return JSON.stringify(contactUnavailable(adapter));}
}
