#!/usr/bin/osascript -l JavaScript
/*
 * Read-only Contacts availability check for Blip.
 *
 * The Python bridge sends one bounded JSON request on stdin. Raw Contacts
 * identifiers never appear in argv, and this helper emits a small JSON
 * result only. Its single operation answers which person ids the object
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
  if (value.operation !== "available") throw new Error("repair operation is invalid");
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
  return { operation: "available", personUids: personUids };
}

function perform(request) {
  // The object layer exposes only cards that Contacts can actually address;
  // raw per-account databases can retain inactive cache rows.
  ObjC.import("AddressBook");
  const book = $.ABAddressBook.sharedAddressBook;
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
