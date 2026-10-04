import { expect, test } from "bun:test";
import { planTextSend } from "../send-file";
import { toolFile } from "../shim-path";

const bin = "C:/Tools/blip";
const cmd = toolFile(bin, "imsg-send");
const group = "chat900000000000000001";
const guid = "any;+;chat900000000000000001";

test("a direct message addresses the handle and the body is not an argument", () => {
  const plan = planTextSend("+15551234567", "iMessage", {}, bin);
  expect(plan.ok).toBe(true);
  if (!plan.ok) return;
  expect(plan.cmd).toBe(cmd);
  expect(plan.args).toEqual(["--to", "+15551234567", "--yes", "--text-stdin", "--keep-dashes"]);
  expect(plan.args.join("\n")).not.toContain("hello from the desk");
});

test("sms is added only on a direct message", () => {
  const plan = planTextSend("+15551234567", "sms", {}, bin);
  expect(plan.ok).toBe(true);
  if (!plan.ok) return;
  expect(plan.args).toEqual([
    "--to", "+15551234567", "--service", "SMS", "--yes", "--text-stdin", "--keep-dashes",
  ]);
});

test("a group with no cached guid is refused", () => {
  const plan = planTextSend(group, "iMessage", {}, bin);
  expect(plan).toEqual({ ok: false, error: "group id unknown — refusing to send" });
});

test("a group sends by chat id and does not take the last speaker or a service", () => {
  const plan = planTextSend(group, "RCS", { [group]: { guid } }, bin);
  expect(plan.ok).toBe(true);
  if (!plan.ok) return;
  expect(plan.cmd).toBe(cmd);
  expect(plan.args).toEqual(["--chat-id", guid, "--yes", "--text-stdin", "--keep-dashes"]);
});
