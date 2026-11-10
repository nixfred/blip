import { test, expect } from "bun:test";
import { decorate } from "./thread";
import { dedupeSelfEcho } from "./collector";
const base = { id: 1, ts: "2026-08-31T10:00:00Z", from_me: true, text: "hello", chat: "self", handle: "+15551234567", service: "iMessage" };
test("Delivered becomes Read only on the newest sent message", () => {
  const first = { ...base, delivered: true, read_at: "2026-08-31T10:01:00Z" };
  const last = { ...base, id: 2, ts: "2026-08-31T10:02:00Z", delivered: true };
  expect(decorate([first, last], "2026-08-31").map(b => b.receipt)).toEqual(["", "Delivered"]);
  expect(decorate([{...last, read_at: "2026-08-31T10:03:00Z"}], "2026-08-31")[0]!.receipt).toBe("Read 10:03 AM");
  for (const extra of [{delivered: false}, {error: 22}, {retracted: true}, {scheduled: true}])
    expect(decorate([{...last, ...extra}], "2026-08-31")[0]!.receipt).toBe("");
});
test("self echo preserves sent receipt in either order, including empty text", () => {
  for (const text of ["hello", ""]) {
    const sent = {...base, text, delivered: true, read_at: "2026-08-31T10:01:00Z"};
    const echo = {...base, id: 2, text, from_me: false};
    for (const rows of [[sent, echo], [echo, sent]])
      expect(dedupeSelfEcho(rows, ["self"])[0]).toMatchObject({from_me: true, delivered: true, read_at: sent.read_at});
  }
});
