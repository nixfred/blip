import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
test("shipping JXA never walks an open emoji catalogue", () => {
  const source = readFileSync(new URL("./bridge/mac/imsg-react", import.meta.url), "utf8");
  const jxa = source.slice(source.indexOf('JXA = r"""'), source.indexOf('class NativeAX'));
  expect(jxa).not.toContain("function picker(");
  expect(jxa).not.toContain("function emojiPicker(");
  expect(jxa).not.toContain('q.mode === "emoji"');
});
