import { describe, expect, test } from "bun:test";
import {
  hasRealMonitor,
  moveIsSafe,
  workspaceLives,
  homeRule,
  isLiveBlipTitle,
  luaString,
  restoreRule,
  silentMove,
  windowAddress,
  workspaceDecision,
  workspaceSelector,
} from "./window-restore";

test("restores numbered, named and special workspaces without relative selectors", () => {
  expect(workspaceSelector("2")).toBe("2");
  expect(workspaceSelector("work")).toBe("name:work");
  expect(workspaceSelector("+1")).toBe("name:+1");
  expect(workspaceSelector("special:scratchpad")).toBe("special:scratchpad");
  expect(workspaceSelector(null)).toBeNull();
  expect(workspaceSelector("bad\nvalue")).toBeNull();
});
test("quiet mapping applies only to the unique restoration window", () => {
  const rule = restoreRule("7", "Blip-restore-abcd-1234");
  expect(rule).toContain('title = "^Blip-restore-abcd-1234$"');
  expect(rule).toContain("no_initial_focus = true");
  expect(rule).toContain(`workspace = ${luaString("7 silent")}`);
  expect(restoreRule(undefined, "Blip-restore-abcd")).not.toContain("workspace =");
  expect(() => restoreRule("2", 'Blip"')).toThrow();
});
test("workspace names cannot inject Lua", () => {
  expect(luaString('"\\\n')).toBe('"\\034\\092\\010"');
  expect(restoreRule('x"}); os.execute("bad', "Blip-restore-abcd")).not.toContain("os.execute");
  expect(homeRule('x"}); os.execute("bad')).not.toContain("os.execute");
  expect(silentMove('x"}); os.execute("bad', "0xabc")).not.toContain("os.execute");
});

test("the live home rule matches Blip and Blip (N), not a restore title", () => {
  expect(isLiveBlipTitle("Blip")).toBe(true);
  expect(isLiveBlipTitle("Blip (3)")).toBe(true);
  expect(isLiveBlipTitle("Blip-restore-abcd-1234")).toBe(false);
  expect(isLiveBlipTitle("Blip documentation")).toBe(false);
  const rule = homeRule("2");
  expect(rule).toContain('name = "blip-session-home"');
  expect(rule).toContain(`title = ${luaString("^Blip( \\([0-9]+\\))?$")}`);
  expect(rule).toContain(`workspace = ${luaString("2 silent")}`);
  expect(homeRule(undefined)).not.toContain("workspace =");
});

test("a remap or monitor churn returns home; a user move is the new home", () => {
  expect(workspaceDecision("2", "5", "map")).toBe("return");
  expect(workspaceDecision("2", "5", "monitor")).toBe("return");
  expect(workspaceDecision("2", "5", "report")).toBe("ignore");
  expect(workspaceDecision("2", "5", "move")).toBe("save");
  expect(workspaceDecision("2", "2", "map")).toBe("ignore");
  // With no home yet, only a deliberate move claims one: a map must not make
  // wherever the window landed its home (2026-09-19).
  expect(workspaceDecision("", "5", "move")).toBe("save");
  expect(workspaceDecision("", "5", "map")).toBe("ignore");
  expect(workspaceDecision("", "5", "monitor")).toBe("ignore");
  expect(workspaceDecision("", "5", "report")).toBe("ignore");
  expect(workspaceDecision("2", "", "move")).toBe("ignore");
});

test("silent return requires a real address and a real workspace", () => {
  expect(windowAddress("0xabcDEF")).toBe("0xabcDEF");
  expect(windowAddress("abc")).toBeNull();
  const lua = silentMove("2", "0x1234abcd");
  expect(lua).toContain(`workspace = ${luaString("2")}`);
  expect(lua).toContain("follow = false");
  expect(lua).toContain(`window = ${luaString("address:0x1234abcd")}`);
  expect(silentMove("2", "not-an-address")).toBeNull();
  expect(silentMove("", "0x1234abcd")).toBeNull();
});

describe("a home workspace that no longer exists", () => {
  const live = [{ id: 1, name: "1" }, { id: 4, name: "4" }, { id: 7, name: "work" }];
  test("an id or name still on screen is alive", () => {
    expect(workspaceLives("4", live)).toBe(true);
    expect(workspaceLives("work", live)).toBe(true);
  });
  test("a workspace that is gone is not restored to", () => {
    // plonk renumbers, empty workspaces disappear: restoring here would CREATE
    // workspace 6 and drag the reader to it.
    expect(workspaceLives("6", live)).toBe(false);
  });
  test("an unreadable workspace list keeps the home rather than dropping it", () => {
    expect(workspaceLives("6", null)).toBe(true);
  });
  test("no saved home is not a live one", () => {
    expect(workspaceLives("", live)).toBe(false);
  });
});

test("no stray return while every output is gone", () => {
  expect(hasRealMonitor([{ name: "DP-1", width: 3840, height: 1080, disabled: false }])).toBe(true);
  expect(hasRealMonitor([])).toBe(false);
  expect(hasRealMonitor(null)).toBe(false);
  expect(hasRealMonitor([{ name: "FALLBACK", width: 1920, height: 1080 }])).toBe(false);
  expect(hasRealMonitor([{ name: "DP-1", width: 3840, height: 1080, disabled: true }])).toBe(false);
  expect(hasRealMonitor([{ name: "", width: 0, height: 0 }])).toBe(false);
});

test("a floating move waits until the target workspace has a live monitor", () => {
  const dp1 = [{ name: "DP-1", width: 3840, height: 1080 }];
  const homed = [{ id: 1, name: "1", monitor: "DP-1" }];
  const orphaned = [{ id: 1, name: "1", monitor: "?" }, { id: 11, name: "11", monitor: "FALLBACK" }];
  expect(moveIsSafe("1", dp1, homed)).toBe(true);
  expect(moveIsSafe("4", dp1, homed)).toBe(true);
  expect(moveIsSafe("1", dp1, orphaned)).toBe(false);
  expect(moveIsSafe("1", [{ name: "FALLBACK", width: 1920, height: 1080 }], orphaned)).toBe(false);
  expect(moveIsSafe("1", dp1, null)).toBe(false);
  expect(moveIsSafe("", dp1, homed)).toBe(false);
});
