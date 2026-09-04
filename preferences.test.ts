import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PREFERENCES,
  MAX_PREFERENCES_BYTES,
  normalizePreferences,
  parsePreferences,
  readBoundedPreferenceFile,
  readPreferences,
  writePreferences,
} from "./preferences";

const roots: string[] = [];
function fixture(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "blip-preferences-"));
  roots.push(root);
  return { root, path: join(root, "blip", "preferences.json") };
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("preference schema", () => {
  test("defaults normalize without changing appearance", () => {
    expect(normalizePreferences(DEFAULT_PREFERENCES)).toEqual(DEFAULT_PREFERENCES);
  });

  test("normalizes colors, integers, and bounded decimals", () => {
    expect(normalizePreferences({
      ...DEFAULT_PREFERENCES,
      outgoingBubbleColor: "#AABBCC",
      incomingBubbleColor: "#11223380",
      backgroundOpacity: 0.733,
      sidebarWidth: 333.8,
    })).toEqual({
      ...DEFAULT_PREFERENCES,
      outgoingBubbleColor: "#aabbcc",
      incomingBubbleColor: "#11223380",
      backgroundOpacity: 0.73,
      sidebarWidth: 334,
    });
  });

  test("hides short-code conversations by default and validates the toggle", () => {
    const legacy = { ...DEFAULT_PREFERENCES } as Record<string, unknown>;
    delete legacy.hideShortCodeConversations;
    expect(normalizePreferences(legacy).hideShortCodeConversations).toBe(true);
    expect(normalizePreferences({
      ...DEFAULT_PREFERENCES,
      hideShortCodeConversations: false,
    }).hideShortCodeConversations).toBe(false);
    expect(() => normalizePreferences({
      ...DEFAULT_PREFERENCES,
      hideShortCodeConversations: "yes",
    })).toThrow("boolean");
  });

  test("defaults legacy files to AM/PM conversation times and validates the choice", () => {
    const legacy = { ...DEFAULT_PREFERENCES } as Record<string, unknown>;
    delete legacy.use12HourConversationTimes;
    expect(normalizePreferences(legacy).use12HourConversationTimes).toBe(true);
    expect(normalizePreferences({
      ...DEFAULT_PREFERENCES,
      use12HourConversationTimes: false,
    }).use12HourConversationTimes).toBe(false);
    expect(() => normalizePreferences({
      ...DEFAULT_PREFERENCES,
      use12HourConversationTimes: "sometimes",
    })).toThrow("boolean");
  });

  test("rejects every wrong top-level JSON type", () => {
    for (const value of [null, [], "x", 1, true])
      expect(() => normalizePreferences(value)).toThrow("JSON object");
  });

  test("rejects wrong versions, malformed colors, types, and ranges", () => {
    expect(() => normalizePreferences({ ...DEFAULT_PREFERENCES, schemaVersion: 2 })).toThrow("schemaVersion");
    expect(() => normalizePreferences({ ...DEFAULT_PREFERENCES, outgoingBubbleColor: "red" })).toThrow("outgoingBubbleColor");
    expect(() => normalizePreferences({ ...DEFAULT_PREFERENCES, density: "1" })).toThrow("finite number");
    expect(() => normalizePreferences({ ...DEFAULT_PREFERENCES, avatarSize: 1000 })).toThrow("between");
  });

  test("malformed JSON is reported without echoing its content", () => {
    expect(() => parsePreferences('{"secret":"do not echo"')).toThrow("not valid JSON");
  });
});

describe("bounded preference file", () => {
  test("a missing file yields defaults", () => {
    const { path } = fixture();
    expect(readPreferences(path)).toEqual({
      exists: false,
      preferences: DEFAULT_PREFERENCES,
    });
  });

  test("round-trips atomically with private directory and file modes", () => {
    const { root, path } = fixture();
    const custom = { ...DEFAULT_PREFERENCES, fontScale: 1.2, density: 0.85 };
    writePreferences(path, custom);
    expect(readPreferences(path)).toEqual({ exists: true, preferences: custom });
    expect(lstatSync(join(root, "blip")).mode & 0o777).toBe(0o700);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain('"fontScale": 1.2');
  });

  test("accepts exactly the byte cap and rejects one byte over before parsing", () => {
    const { root, path } = fixture();
    const dir = join(root, "blip");
    writePreferences(path, DEFAULT_PREFERENCES);
    writeFileSync(path, Buffer.alloc(MAX_PREFERENCES_BYTES, 0x20));
    expect(readBoundedPreferenceFile(path)?.length).toBe(MAX_PREFERENCES_BYTES);
    writeFileSync(path, Buffer.alloc(MAX_PREFERENCES_BYTES + 1, 0x20));
    expect(() => readBoundedPreferenceFile(path)).toThrow("too large");
    expect(lstatSync(dir).isDirectory()).toBe(true);
  });

  test("rejects a symlink instead of following it", () => {
    const { root, path } = fixture();
    const target = join(root, "target.json");
    writePreferences(target, DEFAULT_PREFERENCES);
    const dir = join(root, "blip");
    writePreferences(join(dir, "seed.json"), DEFAULT_PREFERENCES);
    symlinkSync(target, path);
    expect(() => readBoundedPreferenceFile(path)).toThrow();
    expect(() => writePreferences(path, DEFAULT_PREFERENCES)).toThrow("regular file");
  });

  test("rejects a nonblocking FIFO", () => {
    const { root, path } = fixture();
    const dir = join(root, "blip");
    writePreferences(join(dir, "seed.json"), DEFAULT_PREFERENCES);
    expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
    expect(() => readBoundedPreferenceFile(path)).toThrow("regular file");
  });

  test("tightens a permissive preferences directory", () => {
    const { root, path } = fixture();
    const dir = join(root, "blip");
    writePreferences(path, DEFAULT_PREFERENCES);
    chmodSync(dir, 0o755);
    writePreferences(path, DEFAULT_PREFERENCES);
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe("CLI streaming boundary", () => {
  test("exits before an oversized producer closes stdin", async () => {
    const { path } = fixture();
    const child = Bun.spawn(["bun", join(import.meta.dir, "preferences.ts"), "write"], {
      env: { ...process.env, BLIP_PREFERENCES_PATH: path },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(Buffer.alloc(MAX_PREFERENCES_BYTES + 1, 0x20));
    child.stdin.flush();
    const result = await Promise.race([
      child.exited.then((code) => ({ code })),
      Bun.sleep(1500).then(() => ({ code: -999 })),
    ]);
    expect(result.code).not.toBe(-999);
    expect(result.code).not.toBe(0);
    try { child.stdin.end(); } catch { /* child already closed the pipe */ }
  });
});
