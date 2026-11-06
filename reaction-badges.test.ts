import { expect, test } from "bun:test";
import { badgeEntries } from "./reaction-badges";
const sticker = { reaction: true, attachment: { id: "synthetic-sticker" } };
test("emoji and native sticker reactions share a badge without wrapping placed stickers", () => {
  expect(badgeEntries([{emoji:"❤️"}], [sticker, {attachment:{id:"decoration"}}], 5))
    .toEqual([{emoji:"❤️"}, {sticker}]);
  expect(badgeEntries([], [{reaction:false, attachment:{id:"decoration"}}], 5)).toEqual([]);
});
test("narrow bubbles show a bounded count instead of overflowing their message", () => {
  expect(badgeEntries([{emoji:"❤️"},{emoji:"👍"},{emoji:"🎉"}], [sticker], 2)).toEqual([{emoji:"❤️"},{count:3}]);
  expect(badgeEntries([{emoji:"❤️"},{emoji:"👍"}], [], 1)).toEqual([{count:2}]);
  expect(badgeEntries([{emoji:"🌄"}], [], 1)).toEqual([{emoji:"🌄"}]);
});
test("empty and invalid capacity inputs remain bounded", () => {
  expect(badgeEntries(undefined, undefined, NaN)).toEqual([]);
  expect(badgeEntries(Array.from({length:20},()=>({emoji:"👍"})), [], 100).length).toBe(5);
  expect(badgeEntries([{emoji:"👍"},{emoji:"🎉"}], [], -10)).toEqual([{count:2}]);
});

test("QML model-role array-like sequences retain emoji reactions", () => {
  expect(badgeEntries({0:{emoji:"🌄"},length:1} as any, [], 5)).toEqual([{emoji:"🌄"}]);
});
