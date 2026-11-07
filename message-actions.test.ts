import { expect, test } from "bun:test";
import { attachmentActions, bubbleIndexByGuid, canReply, quotedDraft, quoteText, replyTarget, saveableMime } from "./message-actions";

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

test("replies are offered only where imsg-react's sibling tool has been proven", () => {
  const text = { guid: "G", text: "hello" };
  const picture = { guid: "G", text: "", attachments: [{ id: "1", mime: "image/heic" }] };
  expect(canReply(text, false)).toBe(true);
  expect(canReply(picture, false)).toBe(true);
  expect(canReply(text, true)).toBe(false);
  expect(canReply(null, false)).toBe(false);
  expect(canReply({ text: "no guid" }, false)).toBe(false);
  expect(canReply({ guid: "G", text: "see https://example.com" }, false)).toBe(false);
  expect(canReply({ ...text, link: { url: "https://example.com" } }, false)).toBe(false);
  for (const flag of ["retracted", "audio", "pending", "failed", "scheduled"])
    expect(canReply({ ...text, [flag]: true }, false)).toBe(false);
  expect(canReply({ ...picture, text: "caption" }, false)).toBe(false);
  expect(canReply({ guid: "G", attachments: [{ mime: "image/png" }, { mime: "image/png" }] }, false)).toBe(false);
  expect(canReply({ guid: "G", attachments: [{ mime: "video/mp4" }] }, false)).toBe(false);
  expect(canReply({ guid: "G", attachments: [{ mime: "image/png", sticker: {} }] }, false)).toBe(false);
});

test("a reply target carries what the banner and the pending bubble show", () => {
  expect(replyTarget({ guid: "G", text: "hello  there", from_me: true, name: "" }))
    .toEqual({ guid: "G", text: "hello there", mine: true, name: "", attachment: null });
  const file = { id: "7", mime: "image/png" };
  expect(replyTarget({ guid: "G", text: "", name: "Ann", attachments: [file] }))
    .toEqual({ guid: "G", text: "Photo", mine: false, name: "Ann", attachment: file });
});

test("the QML runtime's reply rules are the same build", async () => {
  const runtime = await import("./MessageActions.mjs");
  expect(runtime.canReply({ guid: "G", text: "hello" }, false)).toBe(true);
  expect(runtime.replyTarget({ guid: "G", text: "x" }).guid).toBe("G");
});
