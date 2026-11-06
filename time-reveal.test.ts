import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ABANDON_MS, HOLD_OPEN_MS, idleGesture, nextOffset, routeWheel, settleDelay } from "./time-reveal";
import * as runtime from "./TimeReveal.mjs";

function run(events: [number, number][]) {
  let gesture = idleGesture(), dx = 0, dy = 0;
  for (const [x, y] of events) {
    const routed = routeWheel(gesture, x, y);
    gesture = routed.gesture; dx += routed.dx; dy += routed.dy;
  }
  return { axis: gesture.axis, dx, dy };
}

test("a sideways swipe commits to x and never scrolls the transcript", () => {
  expect(run([[-4, 0], [-4, 1], [-4, 0], [-30, 6]])).toEqual({ axis: "x", dx: -42, dy: 1 });
});

test("a vertical scroll with drift keeps every vertical delta and never reveals", () => {
  expect(run([[1, 8], [-3, 12], [-6, 20], [-40, 20]])).toEqual({ axis: "y", dx: 0, dy: 60 });
});

test("one hi-res wheel notch commits immediately on either axis", () => {
  expect(run([[-120, 0]])).toEqual({ axis: "x", dx: -120, dy: 0 });
  expect(run([[0, -120]])).toEqual({ axis: "y", dx: 0, dy: -120 });
});

test("non-finite deltas are treated as no movement", () => {
  expect(run([[NaN, Infinity]])).toEqual({ axis: "", dx: 0, dy: 0 });
  expect(nextOffset(NaN, NaN, 72)).toBe(0);
});

test("the offset follows the swipe and stays within the time column", () => {
  expect(nextOffset(0, -30, 72)).toBe(30);
  expect(nextOffset(30, 10, 72)).toBe(20);
  expect(nextOffset(70, -30, 72)).toBe(72);
  expect(nextOffset(5, 30, 72)).toBe(0);
  expect(nextOffset(5, -30, 0)).toBe(0);
});

test("a committed reveal stays readable and an abandoned one closes", () => {
  expect(settleDelay(72, 72)).toBe(HOLD_OPEN_MS);
  expect(settleDelay(36, 72)).toBe(HOLD_OPEN_MS);
  expect(settleDelay(20, 72)).toBe(ABANDON_MS);
  expect(settleDelay(0, 0)).toBe(ABANDON_MS);
});

test("the QML module matches its TypeScript source", () => {
  expect(runtime.routeWheel(idleGesture(), -12, 0)).toEqual(routeWheel(idleGesture(), -12, 0));
  expect(runtime.nextOffset(10, -5, 72)).toBe(nextOffset(10, -5, 72));
  expect(runtime.settleDelay(72, 72)).toBe(settleDelay(72, 72));
});

test("the conversation uses the swipe and no longer shows a time tooltip", () => {
  const view = readFileSync(new URL("./BlipView.qml", import.meta.url), "utf8");
  expect(view).toContain("timeReveal.route(sideways, vertical)");
  expect(view).not.toContain("ToolTip.text: String(modelData.time");
});
