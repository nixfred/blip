import { expect, test } from "bun:test";
import { conversationInitials, conversationName } from "./conversation-appearance";
test("header uses resolved names and never substitutes phone or email identifiers", () => {
  expect(conversationName({ name: "Jamie Rivera", chat: "+15551234567" })).toBe("Jamie Rivera");
  for (const name of ["", "+15551234567", "+1 (555) 123-4567", "person@example.com"]) {
    expect(conversationName({ name, chat: "+15551234567" })).toBe("Conversation");
    expect(conversationInitials({ name, chat: "+15551234567" })).toBe("?");
  }
  expect(conversationName({name:"chat1234", chat:"chat1234"})).toBe("Conversation");
  expect(conversationName({name:"Trail Crew", chat:"chat1234"})).toBe("Trail Crew");
  expect(conversationInitials({name:"Jamie Rivera"})).toBe("JR");
  expect(conversationInitials(null)).toBe("?");
  expect(conversationInitials({name:"🚀 Rocket"})).toBe("🚀R");
});
