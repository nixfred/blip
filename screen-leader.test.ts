import { expect, test } from "bun:test";
import { isLeader, isRealScreen } from "./screen-leader";

const dp1 = { name: "DP-1", width: 3840, height: 1080 };
const dp2 = { name: "DP-2", width: 2560, height: 1440 };
// What Qt hands QML when the last output disappears: QPlatformPlaceholderScreen.
const placeholder = { name: "", width: 0, height: 0 };

test("Qt's placeholder screen is not a real screen", () => {
  expect(isRealScreen(dp1)).toBe(true);
  expect(isRealScreen(placeholder)).toBe(false);
  expect(isRealScreen({ name: "DP-1", width: 0, height: 0 })).toBe(false);
  expect(isRealScreen(null)).toBe(false);
});

test("the only real screen leads, resolved or not", () => {
  expect(isLeader(dp1, [dp1])).toBe(true);
  expect(isLeader(null, [dp1])).toBe(true);
});

test("with several screens the first leads and an unresolved widget waits", () => {
  expect(isLeader(dp1, [dp1, dp2])).toBe(true);
  expect(isLeader(dp2, [dp1, dp2])).toBe(false);
  expect(isLeader(null, [dp1, dp2])).toBe(false);
});

// The bar Omarchy builds on the placeholder used to crown itself and restore
// the app window with no output to map it on, which crashed Hyprland.
test("nobody leads when every monitor is gone", () => {
  expect(isLeader(placeholder, [placeholder])).toBe(false);
  expect(isLeader(null, [placeholder])).toBe(false);
  expect(isLeader(null, [])).toBe(false);
});

test("a placeholder next to a real screen never outranks it", () => {
  expect(isLeader(placeholder, [placeholder, dp1])).toBe(false);
  expect(isLeader(dp1, [placeholder, dp1])).toBe(true);
  expect(isLeader(null, [placeholder, dp1])).toBe(true);
});

test("the deployed QML module agrees with screen-leader.ts", async () => {
  const runtime = await import("./ScreenLeader.mjs");
  const cases: [typeof dp1 | null, (typeof dp1)[]][] = [
    [dp1, [dp1]], [null, [dp1]], [dp2, [dp1, dp2]], [null, [dp1, dp2]],
    [placeholder, [placeholder]], [null, []], [null, [placeholder, dp1]],
  ];
  for (const [own, screens] of cases) expect(runtime.isLeader(own, screens)).toBe(isLeader(own, screens));
  expect(runtime.isRealScreen(placeholder)).toBe(false);
});
