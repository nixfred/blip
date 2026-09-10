import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./bridge/mac/contact-repair.js", import.meta.url), "utf8")
  .replace(/^#![^\n]*\n/, "");
let contactsApplication: any = null;
const repair = new Function(
  "ObjC",
  "Application",
  source + "\nreturn { normalizeRequest: normalizeRequest, perform: perform, setCard: setCard };",
)({ import() {} }, () => contactsApplication) as {
  normalizeRequest: (request: any) => any;
  perform: (request: any) => any;
  setCard: (contacts: any, person: any, card: any) => void;
};

function scalar(initial = "") {
  let value = initial;
  const property = (() => value) as (() => string) & { set: (next: string) => void };
  property.set = (next: string) => { value = next; };
  return property;
}

function labeled(label: string, value: string) {
  return { label: () => label, value: () => value };
}

function fixture() {
  const originalPhone = labeled("_$!<Mobile>!$_", "+1 (404) 555-0101");
  const phones = [originalPhone];
  const removed: any[] = [];
  const added: any[] = [];
  // JXA collection specifiers are callable AND support .push (the add
  // pattern that works on current macOS); mirror that shape here.
  function collection(entries: any[]) {
    const property = (() => entries) as any;
    property.push = (entry: any) => { added.push(entry); entries.push(entry); };
    return property;
  }
  const person: any = {
    firstName: scalar("Alex"), middleName: scalar(""), lastName: scalar("Rivera"),
    nickname: scalar(), organization: scalar(), department: scalar(), jobTitle: scalar(),
    note: scalar(), birthDate: scalar(), phones: collection(phones),
    emails: collection([]), urls: collection([]), addresses: collection([]),
  };
  const contacts: any = {
    // field removal deletes the entry specifier (the remove-from-person
    // Apple event is broken on current macOS)
    delete(entry: any) {
      removed.push(entry);
      phones.splice(phones.indexOf(entry), 1);
    },
    Phone(properties: any) {
      return labeled(properties.label || "", properties.value);
    },
    Email(properties: any) { return labeled(properties.label || "", properties.value); },
    Url(properties: any) { return labeled(properties.label || "", properties.value); },
    Address(properties: any) { return properties; },
    // the add-to-person Apple event is broken on current macOS; entries
    // arrive through the collection specifiers' push instead
  };
  const card = {
    firstName: "Alex", middleName: "Morgan", lastName: "Rivera",
    nickname: "", organization: "", department: "", jobTitle: "",
    birthday: "", note: "",
    phones: [{ label: "_$!<Mobile>!$_", value: "+1 (404) 555-0101" }],
    emails: [], urls: [], addresses: [],
  };
  return { contacts, person, card, originalPhone, removed, added };
}

describe("Contacts.app edit reconciliation", () => {
  test("discarding a pending edit explicitly quits Contacts without saving", () => {
    let quitArgument: any = null;
    contactsApplication = {
      running: () => true,
      unsaved: () => true,
      quit: (argument: any) => { quitArgument = argument; },
    };
    expect(repair.perform(repair.normalizeRequest({ operation: "discard-unsaved" })))
      .toEqual({ ok: true, discarded: true });
    expect(quitArgument).toEqual({ saving: "no" });
  });

  test("a scalar-only edit preserves the existing phone field", () => {
    const f = fixture();
    repair.setCard(f.contacts, f.person, f.card);
    expect(f.removed).toEqual([]);
    expect(f.added).toEqual([]);
    expect(f.person.middleName()).toBe("Morgan");
  });

  test("a changed collection removes the concrete field object before replacing it", () => {
    const f = fixture();
    f.card.phones[0].value = "+1 (404) 555-0199";
    repair.setCard(f.contacts, f.person, f.card);
    expect(f.removed).toEqual([f.originalPhone]);
    expect(f.added).toHaveLength(1);
    expect(f.added[0].value()).toBe("+1 (404) 555-0199");
  });

  test("an add-only collection change keeps existing fields and pushes the additions", () => {
    // removing a damaged stored row fails where additions still work, so an
    // edit that only ADDS values must never take the remove-all path
    const f = fixture();
    f.card.phones.push({ label: "_$!<Home>!$_", value: "+1 (404) 555-0102" });
    repair.setCard(f.contacts, f.person, f.card);
    expect(f.removed).toEqual([]);
    expect(f.added).toHaveLength(1);
    expect(f.added[0].value()).toBe("+1 (404) 555-0102");
    expect(f.person.phones()).toHaveLength(2);
  });
});
