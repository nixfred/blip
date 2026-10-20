import { expect, test } from "bun:test";
import { attachmentActions, bubbleIndexByGuid, quotedDraft, quoteText, saveableMime } from "./message-actions";

test("quote an older message without replacing or normalizing the draft", () => {
  expect(quotedDraft({ text: "An older\nmessage" }, "My reply\n  in progress"))
    .toBe("> An older message\n\nMy reply\n  in progress");
});
test("an empty composer is ready to type beneath the quote", () => {
  expect(quotedDraft({ text: "Hello" }, "")).toBe("> Hello\n\n");
});
test("link-only messages can be quoted", () => {
  expect(quotedDraft({ link: { url: "https://example.com/video" } }, "Yes"))
    .toBe("> https://example.com/video\n\nYes");
});
test("empty and withdrawn messages leave drafts alone", () => {
  for (const message of [{}, { text: "  " }, { text: "Withdrawn", retracted: true }]) {
    expect(quoteText(message)).toBe("");
    expect(quotedDraft(message, "Keep this")).toBe("Keep this");
  }
});
test("long quotations show truncation without splitting an emoji", () => {
  expect(quotedDraft({ text: "🙂".repeat(201) }, "Draft"))
    .toBe("> " + "🙂".repeat(200) + "…\n\nDraft");
});

test("the selected bubble is found again by guid after a reload renumbers the rows", async () => {
  const rows = [{ guid: "A" }, { guid: "" }, { guid: "B" }];
  expect(bubbleIndexByGuid(rows, "B")).toBe(2);
  expect(bubbleIndexByGuid(rows, "C")).toBe(-1);
  expect(bubbleIndexByGuid(rows, "")).toBe(-1);
  expect(bubbleIndexByGuid([], "A")).toBe(-1);
  // the QML module is rebuilt from this file
  const runtime = await import("./MessageActions.mjs");
  expect(runtime.bubbleIndexByGuid(rows, "B")).toBe(2);
});

test("a right-clicked picture offers open, copy and save; a document open and save", async () => {
  expect(attachmentActions({ id: "7", mime: "image/heic" }))
    .toEqual({ open: true, copy: true, save: true, saveLabel: "Save image…" });
  expect(attachmentActions({ id: "8", mime: "application/pdf" }))
    .toEqual({ open: true, copy: false, save: true, saveLabel: "Save…" });
  expect(attachmentActions({ id: "9", mime: "video/quicktime" }).save).toBe(true);
  // anything openableMime would not hand to xdg-open is not written out either
  for (const mime of ["application/x-desktop", "application/octet-stream", "text/x-shellscript", ""])
    expect(attachmentActions({ id: "10", mime })).toEqual({ open: true, copy: false, save: false, saveLabel: "Save…" });
  for (const att of [null, undefined, {}, { id: "", mime: "image/png" }])
    expect(attachmentActions(att as any)).toEqual({ open: false, copy: false, save: false, saveLabel: "" });
  expect(saveableMime("IMAGE/PNG")).toBe(true);
  const runtime = await import("./MessageActions.mjs");
  expect(runtime.attachmentActions({ id: "7", mime: "image/png" }).copy).toBe(true);
});
