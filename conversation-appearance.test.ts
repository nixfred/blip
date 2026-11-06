import { expect, test } from "bun:test";
import { conversationInitials, conversationName, pinnedName } from "./conversation-appearance";
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

test("favorite captions fit the grid without losing group or ambiguous names", () => {
  const jamie = {name:"Jamie Rivera"};
  expect(pinnedName(jamie, [jamie, {name:"Alex Chen"}])).toBe("Jamie");
  expect(pinnedName(jamie, [jamie, {name:"Jamie Smith"}])).toBe("Jamie R.");
  expect(pinnedName({name:"Trail Crew"}, [], true)).toBe("Trail Crew");
  expect(pinnedName({name:"Priya"})).toBe("Priya");
  expect(pinnedName({name:"+15551234567"})).toBe("Conversation");
});
