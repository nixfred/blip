import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeArgv, EXTRA_SOURCES, IMESSAGE, sourceFor, type Source } from "./source-id";
import { bridgeFor, shimPath } from "./shim-path";
import { buildThreads, chatKey, fetchChatRows, unreadCounts, type ImsgMessage } from "./collector";
import { DEFAULT_FORMATS, loadThread } from "./thread";

const DIR = "/home/u/bin";
const TOOLS = ["imsg", "imsg-send", "imsg-read", "imsg-react"] as const;
// Every id shape the Mac hands out (DM phone, DM email, group GUID, chat<rowid>,
// short-code SMS), and shapes it never does.
const MAC_IDS = ["+15551234567", "15551234567", "someone@example.com", "0123456789abcdef0123456789abcdef", "chat123456789", "Vhi"];
const FOREIGN_IDS = ["42@example.invalid", "room@g.us", "src:123", "", "  ", "../../etc/passwd", "a b"];

function msg(over: Partial<ImsgMessage> = {}): ImsgMessage {
  return {
    ts: "2026-08-30T12:00:00Z",
    from_me: false,
    handle: "+15551234567",
    name: "Test Person",
    service: "iMessage",
    chat: "+15551234567",
    text: "hello",
    ...over,
  };
}

function recorder() {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const runner = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return { status: 0, stdout: "[]", stderr: "" };
  }) as never;
  return { calls, runner };
}

describe("stock Blip: every conversation goes to the Mac", () => {
  test("no extra source is registered", () => {
    expect(EXTRA_SOURCES).toHaveLength(0);
  });

  test("bridgeArgv is exactly the shim in bin_dir, for every id and every tool", () => {
    for (const chat of [...MAC_IDS, ...FOREIGN_IDS]) {
      expect(sourceFor(chat)).toBe(IMESSAGE);
      for (const tool of TOOLS) expect(bridgeArgv(chat, tool, DIR)).toEqual([`${DIR}/${tool}`]);
    }
  });

  test("bridgeFor is shimPath with nothing in front, bin_dir included", () => {
    const home = mkdtempSync(join(tmpdir(), "blip-source-"));
    for (const tool of TOOLS) {
      expect(bridgeFor("+15551234567", tool, home)).toEqual({ cmd: shimPath(tool, home), args: [] });
    }
    mkdirSync(join(home, ".config", "blip"), { recursive: true });
    writeFileSync(join(home, ".config", "blip", "bridge.conf"), "host=me@mac\nbin_dir=~/.local/bin\n");
    for (const tool of TOOLS) {
      const ext = process.platform === "win32" ? ".exe" : "";
      expect(bridgeFor("chat1", tool, home)).toEqual({ cmd: `${home}/.local/bin/${tool}${ext}`, args: [] });
    }
  });

  test("the per-conversation spawns hand the shim the same argv as before", () => {
    const t = recorder();
    loadThread("+15551234567", 40, "2026-08-30", DEFAULT_FORMATS, t.runner);
    fetchChatRows("chat99", 25, t.runner);
    expect(t.calls).toEqual([
      { cmd: shimPath("imsg"), args: ["--json", "--rich", "thread", "--chat", "+15551234567", "40"] },
      { cmd: shimPath("imsg"), args: ["--json", "thread", "--chat", "chat99", "25"] },
    ]);
  });

  test("the deployed QML module agrees with source-id.ts", async () => {
    const runtime = await import("./SourceId.mjs");
    for (const chat of [...MAC_IDS, ...FOREIGN_IDS]) {
      for (const tool of TOOLS) expect(runtime.bridgeArgv(chat, tool, DIR)).toEqual(bridgeArgv(chat, tool, DIR));
    }
  });
});

describe("a source Blip does not know round-trips untouched", () => {
  const CHAT = "42@example.invalid";
  const TEST_SOURCE: Source = {
    id: "test",
    owns: (chat) => chat.endsWith("@example.invalid"),
    argv: (tool, binDir) => ["bun", `${binDir}/test-bridge.ts`, tool],
  };

  test("its ids route to it; every other id still reaches the Mac", () => {
    expect(sourceFor(CHAT, [TEST_SOURCE])).toBe(TEST_SOURCE);
    expect(bridgeArgv(CHAT, "imsg-send", DIR, [TEST_SOURCE])).toEqual(["bun", `${DIR}/test-bridge.ts`, "imsg-send"]);
    for (const chat of MAC_IDS) {
      for (const tool of TOOLS) expect(bridgeArgv(chat, tool, DIR, [TEST_SOURCE])).toEqual([`${DIR}/${tool}`]);
    }
  });

  test("the first source that claims an id wins", () => {
    const greedy: Source = { id: "greedy", owns: () => true, argv: () => ["greedy"] };
    expect(sourceFor(CHAT, [TEST_SOURCE, greedy]).id).toBe("test");
    expect(sourceFor("+15551234567", [TEST_SOURCE, greedy]).id).toBe("greedy");
  });

  test("its rows key, count and thread like any Mac conversation", () => {
    const rows = [
      msg({ chat: CHAT, handle: CHAT, service: "Test", ts: "2026-08-30T12:00:01Z", text: "one" }),
      msg({ chat: CHAT, handle: CHAT, service: "Test", ts: "2026-08-30T12:00:02Z", text: "two" }),
      msg({ ts: "2026-08-30T12:00:03Z", text: "from the Mac" }),
    ];
    expect(rows.map(chatKey)).toEqual([CHAT, CHAT, "+15551234567"]);
    const mark = "2026-08-30T00:00:00Z";
    const counts = unreadCounts(rows, mark, {});
    expect(counts).toEqual({ [CHAT]: 2, "+15551234567": 1 });
    const threads = buildThreads(rows, mark, {}, {}, counts);
    // Not `service`: a DM thread's service is its SEND service, and
    // normalizeSendService still maps anything it does not know to iMessage —
    // item 2 of #70, deliberately outside this seam.
    expect(threads.find((t) => t.chat === CHAT)).toMatchObject({
      chat: CHAT, handle: CHAT, last_text: "two", last_ts: "2026-08-30T12:00:02Z", count: 2, unread: 2,
    });
    expect(threads.find((t) => t.chat === "+15551234567")).toMatchObject({ last_text: "from the Mac", unread: 1 });
  });
});
