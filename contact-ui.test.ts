import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
const identitySettings = readFileSync(new URL("./ContactManagement.qml", import.meta.url), "utf8");
const identities = readFileSync(new URL("./ContactOperations.qml", import.meta.url), "utf8");
const contactCompare = readFileSync(new URL("./ContactCardCompare.qml", import.meta.url), "utf8");
const contactEditor = readFileSync(new URL("./ContactCardEditor.qml", import.meta.url), "utf8");
  test("Mac contact writes require preview, confirmation, and expose undo", () => {
    expect(identitySettings).toContain('label: "Remove this " + root.handleNoun() + "…"');
    // the undo offer shows only in the workspace of the contact it changed
    expect(identitySettings).toContain("root.handleKey(root.resolver.undoHandle)");
    // the conflict flow speaks in outcomes, not implementation terms: picking
    // a person opens their cards; "session"/identities.json stay out of it
    expect(identitySettings).toContain('"WORKING ON: "');
    expect(identitySettings).toContain("Review cards");
    expect(identitySettings).toContain("Choose a person to review their cards.");
    expect(identitySettings).not.toContain("Select for this session");
    expect(identitySettings).not.toContain("SELECTED FOR THIS SESSION");
    expect(identitySettings).toContain('label: "Remove from Mac Contacts"');
    expect(identitySettings).toContain("An undo receipt will be saved on the Mac");
    expect(identitySettings).toContain('label: "Undo Mac change"');
    expect(identities).toContain("function inspectOnMac(handle, token, ownerToken)");
    expect(identities).toContain("function removeOnMac()");
    expect(identities).toContain("function undoOnMac()");
    expect(identities).toContain("repairPreview.writeEnabled");
    expect(identities).toContain("validToken(repairPreview.ownerToken)");
  });

  test("contact comparison is local and linking has a separate upstream confirmation", () => {
    expect(identitySettings).toContain("Manage " + '" + sourceCandidate.modelData.recordCount');
    expect(identitySettings).toContain("ContactCardCompare");
    expect(contactCompare).toContain('title: "Compare source cards"');
    expect(contactCompare).toContain('title: "Consolidate into one card"');
    expect(contactCompare).toContain('title: "Or link cards · optional"');
    expect(contactCompare).not.toContain("step: \"");
    expect(contactCompare).toContain("Reload cards");
    expect(contactCompare).toContain("Choose another person");
    expect(contactCompare).toContain("DIFFERENCES ONLY");
    expect(contactCompare).toContain("sharedRowMap");
    expect(contactCompare).toContain("MERGED PREVIEW");
    expect(contactCompare).toContain("function displayFieldLabel(fieldType, value)");
    expect(contactCompare).toContain('detail.toLowerCase() === fieldType.toLowerCase()');
    expect(contactCompare).toContain("displayFieldLabel(group.name, item.label)");
    expect(contactCompare).toContain('displayFieldLabel("Address", address.label)');
    expect(contactCompare).toContain("Prepare link in Contacts…");
    expect(contactCompare).toContain("CONFIRM AN UPSTREAM CONTACTS CHANGE");
    expect(contactCompare).toContain("Checking makes no changes");
    expect(contactCompare).toContain("Edit contact…");
    expect(contactCompare).toContain("cardBox.modelData.sourceName");
    expect(identitySettings).toContain("sourceCard.modelData.sourceName");
    expect(contactCompare).toContain("Text.PlainText");
    expect(contactCompare).not.toContain("Array.isArray(card.phones)");
    expect(identities).toContain("function compareCards(handle, ownerToken, otherOwnerToken)");
    expect(identities).toContain("function prepareLink()");
    expect(identities).toContain("function linkCards()");
    expect(identities).toContain("linkPreview.ready");
    expect(identities).toContain("expectedAction: linkPreview.action");
  });

  test("the contact workspace edits, deletes, and consolidates only after preview", () => {
    expect(contactCompare).toContain("ContactCardEditor");
    expect(contactCompare).toContain("Merge into \" + modelData.sourceName");
    expect(contactEditor).toContain("Review changes…");
    expect(contactEditor).toContain("Delete this source card…");
    expect(contactEditor).toContain("Review merged contact…");
    expect(contactEditor).toContain("REVIEW CONSOLIDATION");
    expect(contactEditor).toContain("This is a read-only preview. Nothing below has been saved to Contacts.");
    expect(contactEditor).toContain("MERGED CONTACT TO KEEP");
    expect(contactEditor).toContain("DELETE AFTER MERGE");
    expect(contactEditor).toContain("FINAL CONFIRMATION");
    expect(contactEditor).toContain("Back to edit");
    expect(contactEditor).toContain("Save to Mac Contacts");
    expect(contactEditor).toContain("Merge and delete source cards");
    expect(contactEditor).toContain("function cleanLabel(value)");
    expect(contactEditor).toContain("originalLabel: text(item.label)");
    expect(contactEditor).toContain('value === cleanLabel(original) ? original : value');
    expect(contactEditor.indexOf('label: valueList.emptyLabel')).toBeGreaterThan(
      contactEditor.indexOf('model: parent.model'),
    );
    expect(contactEditor.indexOf('label: "Add address"')).toBeGreaterThan(
      contactEditor.indexOf('model: root.previewOpen ? null : addresses'),
    );
    expect(contactEditor).toContain("Text.PlainText");
    expect(identities).toContain("function prepareCardEdit(card, draft)");
    expect(identities).toContain("function prepareCardDelete(card)");
    expect(identities).toContain("function prepareConsolidation(targetCard, draft)");
    expect(identities).toContain("function applyMutation()");
    expect(identities).toContain("mutationPreview.planHash");
  });

// The consolidation draft's dedupe logic lives in ContactCardCompare.qml as
// plain-JS functions; extract and execute them so the collapse rules are
// tested for behaviour, not just presence. Brace-walking keeps the extraction
// honest when the functions change shape.
function extractQmlFunction(source: string, name: string): string {
  const marker = `  function ${name}(`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`function ${name} not found`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0)
      return source.slice(start, i + 1);
  }
  throw new Error(`function ${name} never closes`);
}

describe("consolidation draft dedupe (executed from QML source)", () => {
  const uniqueList: (cards: unknown[], property: string, address: boolean) => Record<string, string>[] =
    new Function(
      [
        extractQmlFunction(contactCompare, "addressFields"),
        extractQmlFunction(contactCompare, "addressField"),
        extractQmlFunction(contactCompare, "addressSubsumes"),
        extractQmlFunction(contactCompare, "uniqueList"),
        "return uniqueList;",
      ].join("\n"),
    )();

  const home = {
    label: "Home", street: "1234 Cherry Ln", city: "Springfield",
    state: "MN", postalCode: "55555", country: "United States",
  };

  test("an address differing only by an unset field collapses to the complete copy", () => {
    // The live case: countryCode "us" on one source card, unset on the other.
    const kept = uniqueList(
      [{ addresses: [{ ...home, countryCode: "us" }] }, { addresses: [{ ...home }] }],
      "addresses", true,
    );
    expect(kept.length).toBe(1);
    expect(kept[0].countryCode).toBe("us");
  });

  test("the more complete copy wins regardless of card order", () => {
    const kept = uniqueList(
      [{ addresses: [{ ...home }] }, { addresses: [{ ...home, countryCode: "us" }] }],
      "addresses", true,
    );
    expect(kept.length).toBe(1);
    expect(kept[0].countryCode).toBe("us");
  });

  test("addresses that disagree on a filled field both survive", () => {
    const kept = uniqueList(
      [{ addresses: [home] }, { addresses: [{ ...home, city: "Minneapolis" }] }],
      "addresses", true,
    );
    expect(kept.length).toBe(2);
  });

  test("an all-empty address never reaches the draft", () => {
    const kept = uniqueList(
      [{ addresses: [{ label: "Home", street: "", city: "" }] }, { addresses: [home] }],
      "addresses", true,
    );
    expect(kept.length).toBe(1);
    expect(kept[0].street).toBe("1234 Cherry Ln");
  });

  test("value-keyed lists keep exact-match semantics", () => {
    const kept = uniqueList(
      [
        { phones: [{ label: "Work", value: "(555) 010-4477" }] },
        { phones: [{ label: "Work", value: "(555) 010-4477" }, { label: "Mobile", value: "+15550104477" }] },
      ],
      "phones", false,
    );
    // Exact duplicates collapse; a differently formatted number is not our
    // call to merge.
    expect(kept.map((entry) => entry.value)).toEqual(["(555) 010-4477", "+15550104477"]);
  });
});

test("contact handoff creates the window once before selecting the contact", () => {
  const source = readFileSync(new URL("./BarWidget.qml", import.meta.url), "utf8");
  const loader: any = { item: null };
  const events: string[] = [];
  const showApp = () => {
    events.push("show");
    loader.item = { manageContact: (handle: string) => { events.push(handle); return true; } };
  };
  const handoff = new Function("showApp", "windowLoader",
    extractQmlFunction(source, "manageContact") + "; return manageContact;")(showApp, loader);
  expect(handoff("+15551234567")).toBe(true);
  expect(events).toEqual(["show", "+15551234567"]);
});

test("an existing contact editor survives a handoff for another person", () => {
  const source = readFileSync(new URL("./ContactWorkspace.qml", import.meta.url), "utf8");
  const operations = { activeHandle: "+15551234567", findCandidates: () => { throw new Error("must retain editor"); } };
  const review = new Function("operations", "opened", "forceActiveFocus",
    extractQmlFunction(source, "review") + "; return review;")(operations, true, () => {});
  expect(review("+15551234567")).toBe(true);
  expect(review("+15551234568")).toBe(false);
});

test("a first-window handoff queues behind the initial access check", () => {
  const state = new Function("worker", "currentOperation", "safeText",
    'let pendingReviewHandle = ""; ' + extractQmlFunction(identities, "findCandidates")
      + '; return { request: findCandidates, queued: () => pendingReviewHandle };')(
    { running: true }, "read", (s: string) => s);
  expect(state.request("+15551234567")).toBe(true);
  expect(state.queued()).toBe("+15551234567");
});
