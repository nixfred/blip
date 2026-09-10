#!/usr/bin/osascript -l JavaScript
/*
 * Read-only Contacts availability and exact-card details for Blip.
 *
 * The Python bridge sends one bounded JSON request on stdin. Raw Contacts
 * identifiers never appear in argv, and this helper emits a small JSON
 * result only. Its availability operation answers which person ids the object
 * layer can actually address — raw per-account databases can retain
 * inactive cache rows. It mutates nothing.
 */
ObjC.import("Foundation");

const MAX_INPUT_BYTES = 48 * 1024;
const MAX_OUTPUT_BYTES = 48 * 1024;
const MAX_PERSON_IDS = 64;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

function boundedString(value, label, maximum) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    throw new Error(label + " is invalid");
  const cleaned = value.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) throw new Error(label + " is invalid");
  return cleaned;
}

function readRequest() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  if (Number(data.length) > MAX_INPUT_BYTES) throw new Error("repair request is too large");
  const source = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
  let parsed;
  try { parsed = JSON.parse(String(source)); }
  catch (_) { throw new Error("repair request is not valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("repair request must be an object");
  return parsed;
}

function normalizeRequest(value) {
  if (["available", "details"].indexOf(value.operation) < 0) throw new Error("repair operation is invalid");
  if (!Array.isArray(value.personUids) || value.personUids.length < 1
      || value.personUids.length > MAX_PERSON_IDS)
    throw new Error("person id list is invalid");
  const seen = {};
  const personUids = value.personUids.map(function(uid) {
    const normalized = boundedString(uid, "person id", 200);
    if (seen[normalized]) throw new Error("person id list contains a duplicate");
    seen[normalized] = true;
    return normalized;
  });
  if (value.operation === "details" && personUids.length !== 1) throw new Error("details requires one exact card");
  return { operation: value.operation, personUids: personUids };
}

// Read-only subset of the source-card comparison from contact management.
// The AddressBook object layer avoids driving Contacts.app or compiling Swift.
function describePerson(person) {
  const fields = [];
  function text(value) {
    const plain = ObjC.unwrap(value);
    if (plain === undefined || plain === null) return "";
    const result = String(plain);
    if (result.length > 4096) throw new Error("Contact field is too long to display");
    return result.replace(UNSAFE, " ").trim();
  }
  function add(key, value, label) {
    if (value) fields.push({key: key, value: value, label: label || ""});
    if (fields.length > 160) throw new Error("Too many contact fields");
  }
  function date(value) {
    if (!ObjC.unwrap(value)) return "";
    const formatter = $.NSDateFormatter.alloc.init;
    formatter.dateFormat = "yyyy-MM-dd";
    return text(formatter.stringFromDate(value));
  }
  const scalar = [
    ["prefix", $.kABTitleProperty], ["firstName", $.kABFirstNameProperty],
    ["middleName", $.kABMiddleNameProperty], ["lastName", $.kABLastNameProperty],
    ["suffix", $.kABSuffixProperty], ["nickname", $.kABNicknameProperty],
    ["maidenName", $.kABMaidenNameProperty],
    ["phoneticFirstName", $.kABFirstNamePhoneticProperty],
    ["phoneticMiddleName", $.kABMiddleNamePhoneticProperty],
    ["phoneticLastName", $.kABLastNamePhoneticProperty],
    ["organization", $.kABOrganizationProperty], ["department", $.kABDepartmentProperty],
    ["jobTitle", $.kABJobTitleProperty], ["note", $.kABNoteProperty]
  ];
  scalar.forEach(function(pair) { add(pair[0], text(person.valueForProperty(pair[1]))); });
  add("birthday", date(person.valueForProperty($.kABBirthdayProperty)));
  const collections = [
    ["phone", $.kABPhoneProperty], ["email", $.kABEmailProperty],
    ["url", $.kABURLsProperty], ["address", $.kABAddressProperty],
    ["relatedName", $.kABRelatedNamesProperty], ["date", $.kABOtherDatesProperty],
    ["socialProfile", $.kABSocialProfileProperty], ["instantMessage", $.kABInstantMessageProperty]
  ];
  collections.forEach(function(pair) {
    const values = person.valueForProperty(pair[1]);
    if (!ObjC.unwrap(values)) return;
    const count = Number(values.count);
    if (!Number.isInteger(count) || count > 32) throw new Error("Too many values for one contact field");
    for (let i = 0; i < count; i++) {
      let value = values.valueAtIndex(i);
      if (pair[0] === "date") value = date(value);
      else if (["address", "socialProfile", "instantMessage"].indexOf(pair[0]) >= 0) {
        const dict = ObjC.deepUnwrap(value);
        if (!dict || typeof dict !== "object" || Array.isArray(dict)) throw new Error("Invalid contact field");
        const keys = Object.keys(dict);
        if (keys.length > 16) throw new Error("Too many contact field components");
        value = keys.map(function(key) {
          if (key.length > 80 || typeof dict[key] !== "string" || dict[key].length > 1024) throw new Error("Invalid contact field component");
          return key + ": " + dict[key];
        }).join("; ");
      } else value = text(value);
      const label = text($.ABLocalizedPropertyOrLabel(values.labelAtIndex(i)));
      if (label.length > 80) throw new Error("Contact label is too long");
      add(pair[0], String(value).replace(UNSAFE, " "), label);
    }
  });
  return fields;
}

function perform(request) {
  // The object layer exposes only cards that Contacts can actually address;
  // raw per-account databases can retain inactive cache rows.
  ObjC.import("AddressBook");
  const book = $.ABAddressBook.sharedAddressBook;
  if (request.operation === "details") {
    const person = book.recordForUniqueId($(request.personUids[0]));
    if (!ObjC.unwrap(person)) throw new Error("This contact card is no longer available");
    return {ok: true, fields: describePerson(person)};
  }
  const available = request.personUids.filter(function(uid) {
    try {
      const person = book.recordForUniqueId($(uid));
      const value = ObjC.unwrap(person);
      return value !== undefined && value !== null;
    } catch (_) {
      return false;
    }
  });
  return { ok: true, available: available };
}

function run() {
  try {
    const result = perform(normalizeRequest(readRequest()));
    const output = JSON.stringify(result);
    if ($.NSString.alloc.initWithUTF8String(output).lengthOfBytesUsingEncoding($.NSUTF8StringEncoding) > MAX_OUTPUT_BYTES)
      throw new Error("repair response is too large");
    return output;
  } catch (error) {
    const message = String(error && error.message ? error.message : error)
      .replace(UNSAFE, " ").replace(/\s+/g, " ").trim().slice(0, 180)
      || "Contacts availability check failed";
    return JSON.stringify({ ok: false, error: message });
  }
}
