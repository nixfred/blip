#!/usr/bin/osascript -l JavaScript
/*
 * Supported Contacts.app mutation boundary for Blip.
 *
 * The Python bridge sends one bounded JSON request on stdin. Raw Contacts
 * identifiers and field values never appear in argv, and this helper emits a
 * small JSON result only. It deliberately refuses to save while Contacts has
 * unrelated unsaved changes.
 */
ObjC.import("Foundation");

const MAX_INPUT_BYTES = 48 * 1024;
const MAX_OUTPUT_BYTES = 48 * 1024;
const MAX_FIELDS = 8;
const MAX_PERSON_IDS = 64;
const MAX_COMPARE_CARDS = 8;
const MAX_VALUES_PER_KIND = 16;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

function boundedString(value, label, maximum) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    throw new Error(label + " is invalid");
  const cleaned = value.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) throw new Error(label + " is invalid");
  return cleaned;
}

function normalizePhone(value) {
  const digits = boundedString(value, "phone value", 320).replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function normalizeEmail(value) {
  return boundedString(value, "email value", 320).toLowerCase();
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
  const operation = value.operation === "available" || value.operation === "describe"
    || value.operation === "inspect" || value.operation === "remove"
    || value.operation === "undo" || value.operation === "edit"
    || value.operation === "delete" || value.operation === "restore"
    || value.operation === "consolidate" || value.operation === "undo-consolidate"
    || value.operation === "discard-unsaved" || value.operation === "delete-fallback"
    ? value.operation : "";
  if (!operation) throw new Error("repair operation is invalid");
  if (operation === "discard-unsaved") return { operation: operation };
  if (operation === "available" || operation === "delete-fallback") {
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
    return { operation: operation, personUids: personUids };
  }
  if (operation === "describe") {
    if (!Array.isArray(value.personUids) || value.personUids.length < 1
        || value.personUids.length > MAX_COMPARE_CARDS)
      throw new Error("comparison card list is invalid");
    const seen = {};
    const personUids = value.personUids.map(function(uid) {
      const normalized = boundedString(uid, "person id", 200);
      if (seen[normalized]) throw new Error("comparison card list contains a duplicate");
      seen[normalized] = true;
      return normalized;
    });
    return { operation: operation, personUids: personUids };
  }
  if (operation === "restore") {
    return { operation: operation, card: normalizeCard(value.card, false) };
  }
  if (operation === "undo-consolidate") {
    const targetUid = boundedString(value.targetUid, "target person id", 200);
    if (!Array.isArray(value.restoreCards) || value.restoreCards.length < 1
        || value.restoreCards.length >= MAX_COMPARE_CARDS)
      throw new Error("restore card list is invalid");
    return {
      operation: operation,
      targetUid: targetUid,
      expectedCard: normalizeCard(value.expectedCard, true),
      card: normalizeCard(value.card, false),
      restoreCards: value.restoreCards.map(function(card) { return normalizeCard(card, false); })
    };
  }
  if (operation === "consolidate") {
    const targetUid = boundedString(value.targetUid, "target person id", 200);
    if (!Array.isArray(value.sourceUids) || value.sourceUids.length < 1
        || value.sourceUids.length >= MAX_COMPARE_CARDS)
      throw new Error("source person id list is invalid");
    if (!Array.isArray(value.expectedCards)
        || value.expectedCards.length !== value.sourceUids.length + 1)
      throw new Error("expected card list is invalid");
    const sourceUids = value.sourceUids.map(function(uid) {
      const normalized = boundedString(uid, "source person id", 200);
      if (normalized === targetUid) throw new Error("target cannot also be a source card");
      return normalized;
    });
    if (new Set(sourceUids).size !== sourceUids.length)
      throw new Error("source person id list contains a duplicate");
    const request = {
      operation: operation,
      targetUid: targetUid,
      sourceUids: sourceUids,
      expectedCards: value.expectedCards.map(function(card) { return normalizeCard(card, true); }),
      card: normalizeCard(value.card, false)
    };
    return request;
  }
  if (operation === "edit" || operation === "delete") {
    const request = {
      operation: operation,
      personUid: boundedString(value.personUid, "person id", 200),
      expectedCard: normalizeCard(value.expectedCard, true)
    };
    if (operation === "edit") request.card = normalizeCard(value.card, false);
    return request;
  }
  const uid = boundedString(value.personUid, "person id", 200);
  const kind = value.kind === "phone" || value.kind === "email" ? value.kind : "";
  if (!kind) throw new Error("repair kind is invalid");
  const key = boundedString(value.key, "handle key", 320);
  const request = { operation: operation, personUid: uid, kind: kind, key: key, fields: [] };
  if (operation === "remove" || operation === "undo") {
    if (!Array.isArray(value.fields) || value.fields.length < 1 || value.fields.length > MAX_FIELDS)
      throw new Error("repair field list is invalid");
    request.fields = value.fields.map(function(field) {
      if (!field || typeof field !== "object" || Array.isArray(field))
        throw new Error("repair field is invalid");
      return {
        id: operation === "remove" ? boundedString(field.id, "field id", 200) : "",
        value: boundedString(field.value, "field value", 320),
        label: typeof field.label === "string"
          ? field.label.replace(UNSAFE, " ").replace(/\s+/g, " ").trim().slice(0, 80) : ""
      };
    });
  }
  return request;
}

function peopleForId(contacts, uid) {
  const people = contacts.people.whose({ id: uid })();
  if (!Array.isArray(people) || people.length !== 1)
    throw new Error("the exact Contacts card is unavailable");
  return people[0];
}

function normalizedValue(kind, value) {
  return kind === "email" ? normalizeEmail(value) : normalizePhone(value);
}

function matchingFields(person, kind, key) {
  const entries = kind === "email" ? person.emails() : person.phones();
  const matches = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    let value;
    try { value = boundedString(entry.value(), "field value", 320); }
    catch (_) { continue; }
    if (normalizedValue(kind, value) !== key) continue;
    const id = boundedString(entry.id(), "field id", 200);
    let label = "";
    try {
      const rawLabel = entry.label();
      if (typeof rawLabel === "string")
        label = rawLabel.replace(UNSAFE, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    } catch (_) { /* labels are optional */ }
    matches.push({ specifier: entry, id: id, value: value, label: label });
    if (matches.length > MAX_FIELDS) throw new Error("too many matching fields on this card");
  }
  return matches;
}

function publicFields(fields) {
  return fields.map(function(field) {
    return { id: field.id, value: field.value, label: field.label };
  });
}

function optionalString(value, label, maximum) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new Error(label + " is invalid");
  if (value.length > maximum) throw new Error(label + " is too long");
  return value.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
}

function normalizeLabeledInput(value, label) {
  if (!Array.isArray(value) || value.length > MAX_VALUES_PER_KIND)
    throw new Error(label + " list is invalid");
  return value.map(function(entry) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error(label + " is invalid");
    const item = {
      label: optionalString(entry.label, label + " label", 80),
      value: optionalString(entry.value, label + " value", 320)
    };
    if (!item.value) throw new Error(label + " value is empty");
    return item;
  });
}

function normalizeAddressInput(value) {
  if (!Array.isArray(value) || value.length > MAX_VALUES_PER_KIND)
    throw new Error("address list is invalid");
  return value.map(function(entry) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("address is invalid");
    const address = {
      label: optionalString(entry.label, "address label", 80),
      street: optionalString(entry.street, "street", 320),
      city: optionalString(entry.city, "city", 320),
      state: optionalString(entry.state, "state", 320),
      postalCode: optionalString(entry.postalCode, "postal code", 80),
      country: optionalString(entry.country, "country", 160),
      countryCode: optionalString(entry.countryCode, "country code", 8)
    };
    if (!address.street && !address.city && !address.state && !address.postalCode && !address.country)
      throw new Error("address is empty");
    return address;
  });
}

function normalizeCard(value, includeDisplayName) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("contact card is invalid");
  const birthday = optionalString(value.birthday, "birthday", 10);
  if (birthday && !/^(?:\d{4}\-|--)\d{2}\-\d{2}$/.test(birthday))
    throw new Error("birthday is invalid");
  const card = {
    firstName: optionalString(value.firstName, "first name", 160),
    middleName: optionalString(value.middleName, "middle name", 160),
    lastName: optionalString(value.lastName, "last name", 160),
    nickname: optionalString(value.nickname, "nickname", 160),
    organization: optionalString(value.organization, "organization", 320),
    department: optionalString(value.department, "department", 320),
    jobTitle: optionalString(value.jobTitle, "job title", 320),
    birthday: birthday,
    note: optionalString(value.note, "note", 1000),
    phones: normalizeLabeledInput(value.phones, "phone"),
    emails: normalizeLabeledInput(value.emails, "email"),
    urls: normalizeLabeledInput(value.urls, "URL"),
    addresses: normalizeAddressInput(value.addresses)
  };
  if (!card.firstName && !card.lastName && !card.nickname && !card.organization)
    throw new Error("contact card needs a name, nickname, or organization");
  if (includeDisplayName)
    card.displayName = optionalString(value.displayName, "display name", 160);
  return card;
}

function personString(person, property, label, maximum) {
  try { return optionalString(person[property](), label, maximum); }
  catch (error) {
    if (String(error).indexOf("is too long") >= 0) throw error;
    return "";
  }
}

function labeledValues(person, property, label) {
  const entries = person[property]();
  if (!Array.isArray(entries) || entries.length > MAX_VALUES_PER_KIND)
    throw new Error("too many " + label + " values on one card");
  return entries.map(function(entry) {
    const value = optionalString(entry.value(), label + " value", 320);
    let entryLabel = "";
    try { entryLabel = optionalString(entry.label(), label + " label", 80); }
    catch (_) { entryLabel = ""; }
    return { label: entryLabel, value: value };
  }).filter(function(entry) { return entry.value !== ""; });
}

function addressValues(person) {
  const entries = person.addresses();
  if (!Array.isArray(entries) || entries.length > MAX_VALUES_PER_KIND)
    throw new Error("too many address values on one card");
  return entries.map(function(entry) {
    function piece(property, label) {
      try { return optionalString(entry[property](), label, 320); }
      catch (_) { return ""; }
    }
    return {
      label: piece("label", "address label"),
      street: piece("street", "street"),
      city: piece("city", "city"),
      state: piece("state", "state"),
      postalCode: piece("zip", "postal code"),
      country: piece("country", "country"),
      countryCode: piece("countryCode", "country code")
    };
  }).filter(function(entry) {
    return entry.street || entry.city || entry.state || entry.postalCode || entry.country;
  });
}

function birthDateValue(person) {
  let value;
  try { value = person.birthDate(); } catch (_) { return ""; }
  if (value === null || value === undefined) return "";
  const date = new Date(value);
  if (isNaN(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const year = date.getFullYear();
  return year < 1800 ? "--" + month + "-" + day : String(year).padStart(4, "0") + "-" + month + "-" + day;
}

function describePerson(person) {
  return {
    displayName: personString(person, "name", "display name", 160),
    firstName: personString(person, "firstName", "first name", 160),
    middleName: personString(person, "middleName", "middle name", 160),
    lastName: personString(person, "lastName", "last name", 160),
    nickname: personString(person, "nickname", "nickname", 160),
    organization: personString(person, "organization", "organization", 320),
    department: personString(person, "department", "department", 320),
    jobTitle: personString(person, "jobTitle", "job title", 320),
    birthday: birthDateValue(person),
    note: personString(person, "note", "note", 1000),
    phones: labeledValues(person, "phones", "phone"),
    emails: labeledValues(person, "emails", "email"),
    urls: labeledValues(person, "urls", "URL"),
    addresses: addressValues(person)
  };
}

function sameCard(person, expected) {
  const actual = describePerson(person);
  const keys = ["displayName", "firstName", "middleName", "lastName", "nickname",
    "organization", "department", "jobTitle", "birthday", "note", "phones",
    "emails", "urls", "addresses"];
  for (let i = 0; i < keys.length; i++) {
    if (JSON.stringify(actual[keys[i]]) !== JSON.stringify(expected[keys[i]])) return false;
  }
  return true;
}

function removeAll(contacts, person, property) {
  // The remove-from-person Apple event errors with "Message not understood"
  // on current macOS (verified live 2026-09-03); deleting the entry
  // specifier is the pattern that works.
  const entries = person[property]();
  for (let i = entries.length - 1; i >= 0; i--)
    contacts.delete(entries[i]);
}

// When every existing entry survives the edit, return just the additions so
// setCard can skip the removal pass entirely — removing a damaged stored row
// fails ("Message not understood") where additions still work, and existing
// entries keep their stable field ids. Returns null when anything is removed
// or relabeled, which forces the full replace path.
function addedEntries(existing, desired) {
  const pool = existing.map(function(entry) { return entry.label + "\u0000" + entry.value; });
  const added = [];
  for (let i = 0; i < desired.length; i++) {
    const key = desired[i].label + "\u0000" + desired[i].value;
    const at = pool.indexOf(key);
    if (at >= 0) pool.splice(at, 1);
    else added.push(desired[i]);
  }
  return pool.length === 0 ? added : null;
}

function sameCollection(actual, desired) {
  return JSON.stringify(actual) === JSON.stringify(desired);
}

function birthdayDate(value) {
  if (!value) return null;
  const yearless = value.slice(0, 2) === "--";
  const year = yearless ? 1604 : Number(value.slice(0, 4));
  const month = Number(value.slice(yearless ? 2 : 5, yearless ? 4 : 7));
  const day = Number(value.slice(yearless ? 5 : 8, yearless ? 7 : 10));
  const date = new Date(year, month - 1, day, 12, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day)
    throw new Error("birthday is invalid");
  return date;
}

function cardStep(label, action) {
  try {
    action();
  } catch (error) {
    const detail = String(error && error.message ? error.message : error)
      .replace(UNSAFE, " ").replace(/\s+/g, " ").trim().slice(0, 120);
    throw new Error("Contacts could not update " + label + (detail ? ": " + detail : ""));
  }
}

function setCard(contacts, person, card) {
  const scalar = ["firstName", "middleName", "lastName", "nickname", "organization",
    "department", "jobTitle", "note"];
  for (let i = 0; i < scalar.length; i++) {
    const property = scalar[i];
    cardStep(property, function() { person[property].set(card[property]); });
  }
  cardStep("birthday", function() { person.birthDate.set(birthdayDate(card.birthday)); });
  // Preserve collection objects (and their stable field ids) when an edit
  // changes only a scalar such as middle name. When replacement is needed,
  // remove the concrete specifiers returned by Contacts; calling `.at()` on
  // the property function produces a malformed Apple event on current macOS.
  const existingPhones = labeledValues(person, "phones", "phone");
  const existingEmails = labeledValues(person, "emails", "email");
  const phonesChanged = !sameCollection(existingPhones, card.phones);
  const emailsChanged = !sameCollection(existingEmails, card.emails);
  const urlsChanged = !sameCollection(labeledValues(person, "urls", "URL"), card.urls);
  const addressesChanged = !sameCollection(addressValues(person), card.addresses);
  const phonesAdded = phonesChanged ? addedEntries(existingPhones, card.phones) : [];
  const emailsAdded = emailsChanged ? addedEntries(existingEmails, card.emails) : [];
  if (phonesChanged && phonesAdded === null)
    cardStep("phone numbers", function() { removeAll(contacts, person, "phones"); });
  if (emailsChanged && emailsAdded === null)
    cardStep("email addresses", function() { removeAll(contacts, person, "emails"); });
  if (urlsChanged)
    cardStep("websites", function() { removeAll(contacts, person, "urls"); });
  if (addressesChanged)
    cardStep("postal addresses", function() { removeAll(contacts, person, "addresses"); });
  const phonesToWrite = phonesAdded === null ? card.phones : phonesAdded;
  const emailsToWrite = emailsAdded === null ? card.emails : emailsAdded;
  for (let i = 0; phonesChanged && i < phonesToWrite.length; i++) {
    const field = phonesToWrite[i];
    cardStep("phone number " + String(i + 1), function() { addField(contacts, person, "phone", field); });
  }
  for (let i = 0; emailsChanged && i < emailsToWrite.length; i++) {
    const field = emailsToWrite[i];
    cardStep("email address " + String(i + 1), function() { addField(contacts, person, "email", field); });
  }
  for (let i = 0; urlsChanged && i < card.urls.length; i++) {
    const field = card.urls[i];
    cardStep("website " + String(i + 1), function() {
      const properties = { value: field.value };
      if (field.label) properties.label = field.label;
      person.urls.push(contacts.Url(properties));
    });
  }
  for (let i = 0; addressesChanged && i < card.addresses.length; i++) {
    const source = card.addresses[i];
    cardStep("postal address " + String(i + 1), function() {
      const properties = { street: source.street, city: source.city, state: source.state,
        zip: source.postalCode, country: source.country, countryCode: source.countryCode };
      if (source.label) properties.label = source.label;
      person.addresses.push(contacts.Address(properties));
    });
  }
}

function createPerson(contacts, card) {
  const person = contacts.Person({ firstName: card.firstName });
  contacts.people.push(person);
  setCard(contacts, person, card);
  return person;
}

function sameFieldSet(actual, expected) {
  if (actual.length !== expected.length) return false;
  const left = actual.map(function(field) { return field.id; }).sort();
  const right = expected.map(function(field) { return field.id; }).sort();
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}

function addField(contacts, person, kind, field) {
  const properties = { value: field.value };
  if (field.label) properties.label = field.label;
  const entry = kind === "email" ? contacts.Email(properties) : contacts.Phone(properties);
  // The add-to-person Apple event errors with "No error. (0)" on
  // current macOS; pushing onto the person's own collection is the pattern
  // that works (verified live 2026-09-03, macOS 15.5).
  person[kind === "email" ? "emails" : "phones"].push(entry);
}

function perform(request) {
  if (request.operation === "available") {
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
  const Contacts = Application("Contacts");
  if (request.operation === "discard-unsaved") {
    if (!Contacts.running() || !Contacts.unsaved())
      return { ok: true, discarded: false };
    // This is reachable only from Blip's explicit destructive confirmation.
    // `saving: "no"` closes Contacts without committing its in-memory edit.
    Contacts.quit({ saving: "no" });
    return { ok: true, discarded: true };
  }
  if (request.operation === "describe") {
    const cards = request.personUids.map(function(uid) {
      return describePerson(peopleForId(Contacts, uid));
    });
    return { ok: true, cards: cards };
  }
  if (request.operation === "restore") {
    if (Contacts.unsaved())
      throw new Error("Contacts has unsaved changes; finish or discard them on the Mac first");
    const restored = createPerson(Contacts, request.card);
    Contacts.save();
    return { ok: true, restored: true, card: describePerson(restored) };
  }
  if (request.operation === "undo-consolidate") {
    const target = peopleForId(Contacts, request.targetUid);
    if (!sameCard(target, request.expectedCard))
      throw new Error("the merged card changed; refresh before undoing");
    if (Contacts.unsaved())
      throw new Error("Contacts has unsaved changes; finish or discard them on the Mac first");
    setCard(Contacts, target, request.card);
    for (let i = 0; i < request.restoreCards.length; i++) createPerson(Contacts, request.restoreCards[i]);
    Contacts.save();
    return { ok: true, restored: true, card: describePerson(target),
      sourceCount: request.restoreCards.length };
  }
  if (request.operation === "delete-fallback") {
    // CNContactStore deletion faults with Cocoa 134092 when a card holds a
    // damaged stored row; Contacts.app itself can still remove it (verified
    // live 2026-09-03). Native deletion stays the primary path — the caller
    // reaches this only after it failed on exact, already-confirmed uids.
    if (Contacts.unsaved())
      throw new Error("Contacts has unsaved changes; finish or discard them on the Mac first");
    const doomed = request.personUids.map(function(uid) { return peopleForId(Contacts, uid); });
    for (let i = 0; i < doomed.length; i++) Contacts.delete(doomed[i]);
    Contacts.save();
    return { ok: true, deletedCount: doomed.length };
  }
  if (request.operation === "consolidate") {
    const people = [peopleForId(Contacts, request.targetUid)].concat(
      request.sourceUids.map(function(uid) { return peopleForId(Contacts, uid); })
    );
    for (let i = 0; i < people.length; i++) {
      if (!sameCard(people[i], request.expectedCards[i]))
        throw new Error("a selected card changed; refresh before merging");
    }
    if (Contacts.unsaved())
      throw new Error("Contacts has unsaved changes; finish or discard them on the Mac first");
    return { ok: true, readyToConsolidate: true, sourceCount: request.sourceUids.length };
  }
  if (request.operation === "edit" || request.operation === "delete") {
    const editable = peopleForId(Contacts, request.personUid);
    if (!sameCard(editable, request.expectedCard))
      throw new Error("the selected card changed; refresh before saving");
    if (Contacts.unsaved())
      throw new Error("Contacts has unsaved changes; finish or discard them on the Mac first");
    if (request.operation === "delete") {
      return { ok: true, readyToDelete: true };
    }
    const before = describePerson(editable);
    try { setCard(Contacts, editable, request.card); Contacts.save(); }
    catch (error) {
      try { setCard(Contacts, editable, before); Contacts.save(); } catch (_) { /* original error wins */ }
      throw error;
    }
    return { ok: true, edited: true, card: describePerson(editable) };
  }
  const person = peopleForId(Contacts, request.personUid);
  const current = matchingFields(person, request.kind, request.key);

  if (request.operation === "inspect") {
    if (current.length < 1) throw new Error("this handle is no longer on the selected card");
    return { ok: true, fieldCount: current.length, fields: publicFields(current) };
  }

  if (Contacts.unsaved())
    throw new Error("Contacts has unsaved changes; finish or discard them on the Mac first");

  if (request.operation === "remove") {
    if (!sameFieldSet(current, request.fields))
      throw new Error("the selected card changed; review it again before removing anything");
    // delete-the-specifier: the remove-from-person event is broken on
    // current macOS ("Message not understood")
    for (let i = current.length - 1; i >= 0; i--)
      Contacts.delete(current[i].specifier);
    try {
      Contacts.save();
    } catch (error) {
      for (let i = 0; i < request.fields.length; i++) addField(Contacts, person, request.kind, request.fields[i]);
      try { Contacts.save(); } catch (_) { /* preserve the original failure */ }
      throw error;
    }
    if (matchingFields(person, request.kind, request.key).length !== 0)
      throw new Error("Contacts did not remove the selected handle");
    return { ok: true, removed: true, fieldCount: current.length };
  }

  if (current.length > 0)
    return { ok: true, restored: true, alreadyPresent: true, fieldCount: current.length };
  for (let i = 0; i < request.fields.length; i++) addField(Contacts, person, request.kind, request.fields[i]);
  Contacts.save();
  const restored = matchingFields(person, request.kind, request.key);
  if (restored.length < 1) throw new Error("Contacts did not restore the selected handle");
  return { ok: true, restored: true, alreadyPresent: false, fieldCount: restored.length };
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
      || "Contacts repair failed";
    return JSON.stringify({ ok: false, error: message });
  }
}
