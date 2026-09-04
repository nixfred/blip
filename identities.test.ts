import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyIdentityOverrides, applyThreadIdentityOverrides, type Thread } from "./collector";
import {
  auditContactsOnMac,
  identityKey,
  identityNameFor,
  MAX_BRIDGE_CONFIG_BYTES,
  MAX_IDENTITIES_BYTES,
  MAX_IDENTITY_REQUEST_BYTES,
  normalizeBridgeCandidates,
  normalizeContactAudit,
  normalizeIdentityConfig,
  parseIdentities,
  readBoundedIdentityFile,
  readBoundedBridgeConfig,
  readIdentities,
  resolveOnMac,
  safeReadIdentityConfig,
  writeIdentities,
  type IdentityConfig,
} from "./identities";

const roots: string[] = [];
function fixture(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "blip-identities-"));
  roots.push(root);
  return { root, path: join(root, "blip", "identities.json") };
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const token = "sha256:" + "a".repeat(64);
const cardToken = (character: string) => "sha256:" + character.repeat(64);
const config: IdentityConfig = {
  schemaVersion: 1,
  identities: {
    "+15550100001": { name: "Alex Rivera", source: "contacts", contactToken: token },
    "quiet@example.com": { name: "Quiet Person", source: "custom" },
  },
};

describe("identity schema", () => {
  test("normalizes valid contact and custom choices", () => {
    expect(normalizeIdentityConfig(config)).toEqual(config);
  });

  test("phone variants and email case share one identity key", () => {
    expect(identityKey("+1 (555) 010-0001")).toBe(identityKey("5550100001"));
    expect(identityKey("QUIET@EXAMPLE.COM")).toBe(identityKey("quiet@example.com"));
    expect(identityNameFor("5550100001", config)).toBe("Alex Rivera");
  });

  test("rejects wrong top-level types, versions, sources, and tokens", () => {
    for (const value of [null, [], "x", 1, true])
      expect(() => normalizeIdentityConfig(value)).toThrow("JSON object");
    expect(() => normalizeIdentityConfig({ ...config, schemaVersion: 2 })).toThrow("schemaVersion");
    expect(() => normalizeIdentityConfig({ schemaVersion: 1, identities: {
      "+15550100001": { name: "Alex", source: "guessed" },
    } })).toThrow("source");
    expect(() => normalizeIdentityConfig({ schemaVersion: 1, identities: {
      "+15550100001": { name: "Alex", source: "contacts", contactToken: "bad" },
    } })).toThrow("token");
  });

  test("rejects equivalent duplicate handles", () => {
    expect(() => normalizeIdentityConfig({ schemaVersion: 1, identities: {
      "+1 (555) 010-0001": { name: "Alex", source: "custom" },
      "5550100001": { name: "Someone else", source: "custom" },
    } })).toThrow("equivalent duplicate");
  });

  test("caps before sanitizing and strips dangerous display controls", () => {
    const normalized = normalizeIdentityConfig({ schemaVersion: 1, identities: {
      "+15550100001": { name: "Alex\u202e HTML <b>x</b>", source: "custom" },
    } });
    expect(normalized.identities["+15550100001"]!.name).toBe("Alex HTML <b>x</b>");
    expect(() => normalizeIdentityConfig({ schemaVersion: 1, identities: {
      "+15550100001": { name: "x".repeat(161), source: "custom" },
    } })).toThrow("too long");
  });

  test("malformed JSON is reported without echoing content", () => {
    expect(() => parseIdentities('{"private":"do not echo"')).toThrow("not valid JSON");
  });
});

describe("bounded identity file", () => {
  test("a missing file is an empty config", () => {
    const { path } = fixture();
    expect(readIdentities(path)).toEqual({ exists: false, config: { schemaVersion: 1, identities: {} } });
  });

  test("round-trips atomically with private modes", () => {
    const { root, path } = fixture();
    writeIdentities(path, config);
    expect(readIdentities(path)).toEqual({ exists: true, config });
    expect(lstatSync(join(root, "blip")).mode & 0o777).toBe(0o700);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain('"Alex Rivera"');
  });

  test("accepts the exact byte cap and rejects one byte over", () => {
    const { path } = fixture();
    writeIdentities(path, config);
    writeFileSync(path, Buffer.alloc(MAX_IDENTITIES_BYTES, 0x20));
    expect(readBoundedIdentityFile(path)?.length).toBe(MAX_IDENTITIES_BYTES);
    writeFileSync(path, Buffer.alloc(MAX_IDENTITIES_BYTES + 1, 0x20));
    expect(() => readBoundedIdentityFile(path)).toThrow("too large");
  });

  test("rejects symlinks and nonblocking FIFOs", () => {
    const first = fixture();
    const target = join(first.root, "target.json");
    writeIdentities(target, config);
    writeIdentities(join(first.root, "blip", "seed.json"), config);
    symlinkSync(target, first.path);
    expect(() => readBoundedIdentityFile(first.path)).toThrow();
    expect(() => writeIdentities(first.path, config)).toThrow("regular file");

    const second = fixture();
    writeIdentities(join(second.root, "blip", "seed.json"), config);
    expect(Bun.spawnSync(["mkfifo", second.path]).exitCode).toBe(0);
    expect(() => readBoundedIdentityFile(second.path)).toThrow("regular file");
  });

  test("tightens a permissive identity directory and fails closed on invalid config", () => {
    const { root, path } = fixture();
    writeIdentities(path, config);
    chmodSync(join(root, "blip"), 0o755);
    writeIdentities(path, config);
    expect(lstatSync(join(root, "blip")).mode & 0o777).toBe(0o700);
    writeFileSync(path, "not json");
    expect(safeReadIdentityConfig(path)).toEqual({ schemaVersion: 1, identities: {} });
  });
});

describe("Mac candidate boundary", () => {
  test("validates a bounded candidate response", () => {
    const cards = [
      { token: cardToken("b"), accountNumber: 1, sourceName: "iCloud", hasPhoto: true, matchCount: 1 },
      { token: cardToken("c"), accountNumber: 2, sourceName: "Google", hasPhoto: false, matchCount: 1 },
      { token: cardToken("d"), accountNumber: 2, sourceName: "Google", hasPhoto: false, matchCount: 1 },
    ];
    expect(normalizeBridgeCandidates({
      ok: true,
      handle: "+15550100001",
      candidates: [{
        token, name: "Alex Rivera", recordCount: 3, sourceCount: 2, hasPhoto: true, cards,
      }],
    }, "+15550100001")).toEqual([
      { token, name: "Alex Rivera", recordCount: 3, sourceCount: 2, hasPhoto: true, cards },
    ]);
  });

  test("rejects wrong handles, oversized lists, and hostile fields", () => {
    expect(() => normalizeBridgeCandidates({ ok: true, handle: "+15550100002", candidates: [] }, "+15550100001"))
      .toThrow("different handle");
    expect(() => normalizeBridgeCandidates({ ok: true, handle: "+15550100001", candidates: Array(9).fill({
      token, name: "Alex", recordCount: 1, sourceCount: 1, hasPhoto: false,
    }) }, "+15550100001")).toThrow("too many");
    expect(() => normalizeBridgeCandidates({ ok: true, handle: "+15550100001", candidates: [{
      token: "bad", name: "<b>unsafe</b>", recordCount: 1, sourceCount: 1, hasPhoto: false,
    }] }, "+15550100001")).toThrow("token");
    expect(() => normalizeBridgeCandidates({ ok: true, handle: "+15550100001", candidates: [{
      token, name: "Alex", recordCount: 2, sourceCount: 1, hasPhoto: false,
      cards: [{ token: cardToken("b"), accountNumber: 1, sourceName: "iCloud", hasPhoto: false }],
    }] }, "+15550100001")).toThrow("source-card list");
    expect(() => normalizeBridgeCandidates({ ok: true, handle: "+15550100001", candidates: [{
      token, name: "Alex", recordCount: 1, sourceCount: 2, hasPhoto: false,
      cards: [{ token: cardToken("b"), accountNumber: 1, sourceName: "iCloud", hasPhoto: false }],
    }] }, "+15550100001")).toThrow("account metadata");
  });

  test("the handle travels through stdin, never argv", () => {
    let capturedArgs: string[] = [];
    let capturedInput = "";
    const runner = ((_command: string, args: string[], options: any) => {
      capturedArgs = args;
      capturedInput = options.input;
      return {
        status: 0,
        signal: null,
        output: [],
        pid: 1,
        stdout: JSON.stringify({
          ok: true,
          handle: "+15550100001",
          candidates: [{
            token, name: "Alex Rivera", recordCount: 1, sourceCount: 1, hasPhoto: false,
            cards: [{ token: cardToken("b"), accountNumber: 1, sourceName: "iCloud", hasPhoto: false }],
          }],
        }),
        stderr: "",
        error: undefined,
      };
    }) as any;
    const result = resolveOnMac("candidates", "+15550100001", undefined, runner);
    expect(capturedArgs).toEqual(["--json", "resolve"]);
    expect(capturedArgs.join(" ")).not.toContain("15550100001");
    expect(JSON.parse(capturedInput).handle).toBe("+15550100001");
    expect(result.candidates?.[0]?.name).toBe("Alex Rivera");
  });

  test("contact audit classifies a bounded handle batch through one bridge call", () => {
    let capturedInput = "";
    const single = {
      token, name: "Alex Rivera", recordCount: 1, sourceCount: 1, hasPhoto: false,
      cards: [{ token: cardToken("b"), accountNumber: 1, sourceName: "iCloud", hasPhoto: false }],
    };
    const duplicate = {
      token: cardToken("c"), name: "Pat Rivera", recordCount: 2, sourceCount: 2, hasPhoto: false,
      cards: [
        { token: cardToken("d"), accountNumber: 1, sourceName: "Gmail", hasPhoto: false },
        { token: cardToken("e"), accountNumber: 2, sourceName: "iCloud", hasPhoto: false },
      ],
    };
    const runner = ((_command: string, args: string[], options: any) => {
      capturedInput = options.input;
      return {
        status: 0, signal: null, output: [], pid: 1, stderr: "", error: undefined,
        stdout: JSON.stringify({
          ok: true, handleCount: 3, noMatchCount: 1,
          singleCards: [{ handle: "+15550100001", candidates: [single] }],
          duplicates: [{ handle: "+15550100002", candidates: [duplicate] }],
          conflicts: [],
        }),
      };
    }) as any;
    const savedHome = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), "blip-audit-test-"));
    try {
      const result = auditContactsOnMac(
        ["+15550100001", "+15550100002", "+15550100003"], runner,
      );
      expect(result.cached).toBe(false);
      expect(result.audit.noMatchCount).toBe(1);
      expect(result.audit.singleCards[0]?.candidates[0]?.name).toBe("Alex Rivera");
      expect(result.audit.duplicates[0]?.candidates[0]?.recordCount).toBe(2);
      expect(JSON.parse(capturedInput)).toEqual({
        operation: "audit", handles: ["+15550100001", "+15550100002", "+15550100003"],
      });
    } finally {
      process.env.HOME = savedHome;
    }
  });

  test("an unchanged store fingerprint reuses the cached scan without re-scanning", () => {
    const savedHome = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), "blip-audit-cache-"));
    const fingerprint = "sha256:" + "9".repeat(64);
    const operations: string[] = [];
    const runner = ((_command: string, _args: string[], options: any) => {
      const request = JSON.parse(options.input);
      operations.push(request.operation);
      if (request.operation === "fingerprint")
        return { status: 0, signal: null, output: [], pid: 1, stderr: "", error: undefined,
          stdout: JSON.stringify({ ok: true, fingerprint }) };
      return { status: 0, signal: null, output: [], pid: 1, stderr: "", error: undefined,
        stdout: JSON.stringify({
          ok: true, fingerprint, handleCount: 1, noMatchCount: 1,
          singleCards: [], duplicates: [], conflicts: [],
        }) };
    }) as any;
    try {
      const first = auditContactsOnMac(["+15550100001"], runner);
      expect(first.cached).toBe(false);
      const second = auditContactsOnMac(["+15550100001"], runner);
      expect(second.cached).toBe(true);
      expect(second.audit.noMatchCount).toBe(1);
      // the second call only paid one cheap fingerprint round-trip
      expect(operations).toEqual(["audit", "fingerprint"]);
      // a different conversation set never reuses the cache
      const third = auditContactsOnMac(["+15550100002"], runner);
      expect(third.cached).toBe(false);
      expect(operations).toEqual(["audit", "fingerprint", "audit"]);
    } finally {
      process.env.HOME = savedHome;
    }
  });

  test("contact audit rejects inconsistent totals and category shapes", () => {
    const single = {
      token, name: "Alex Rivera", recordCount: 1, sourceCount: 1, hasPhoto: false,
      cards: [{ token: cardToken("b"), accountNumber: 1, sourceName: "iCloud", hasPhoto: false }],
    };
    const base = {
      handleCount: 1, noMatchCount: 0,
      singleCards: [{ handle: "+15550100001", candidates: [single] }],
      duplicates: [], conflicts: [],
    };
    expect(() => normalizeContactAudit({ ...base, noMatchCount: 1 }, 1)).toThrow("totals");
    expect(() => normalizeContactAudit({
      ...base, singleCards: [], duplicates: [{ handle: "+15550100001", candidates: [single] }],
    }, 1)).toThrow("duplicate-card");
    expect(() => auditContactsOnMac(["+15550100001", "5550100001"])).toThrow("duplicate handle");
    const wrongHandleRunner = (() => ({
      status: 0, signal: null, output: [], pid: 1, stderr: "", error: undefined,
      stdout: JSON.stringify({
        ok: true, handleCount: 1, noMatchCount: 0,
        singleCards: [{ handle: "+15550199999", candidates: [single] }],
        duplicates: [], conflicts: [],
      }),
    })) as any;
    expect(() => auditContactsOnMac(["+15550100001"], wrongHandleRunner)).toThrow("unrequested");
  });

  test("exact-card open keeps its token on stdin and validates card metadata", () => {
    let capturedInput = "";
    const exactToken = cardToken("e");
    const runner = ((_command: string, args: string[], options: any) => {
      capturedInput = options.input;
      return {
        status: 0,
        signal: null,
        output: [],
        pid: 1,
        stdout: JSON.stringify({
          ok: true, opened: true, name: "Alex Rivera",
          cardNumber: 2, cardCount: 3, accountNumber: 1, sourceName: "iCloud",
        }),
        stderr: "",
        error: undefined,
      };
    }) as any;
    expect(resolveOnMac("open", "+15550100001", exactToken, runner)).toEqual({
      handle: "+15550100001", opened: true, name: "Alex Rivera",
      cardNumber: 2, cardCount: 3, accountNumber: 1, sourceName: "iCloud",
    });
    expect(JSON.parse(capturedInput)).toEqual({
      operation: "open", handle: "+15550100001", token: exactToken,
    });
  });
});

describe("collector identity application", () => {
  test("names messages and quiet DM rows without changing group titles", () => {
    const messages = applyIdentityOverrides([{
      ts: "2026-09-02 10:00:00", from_me: false, handle: "5550100001", name: null,
      service: "iMessage", chat: "+15550100001", text: "hello",
    }], config);
    expect(messages[0]!.name).toBe("Alex Rivera");

    const base: Thread = {
      chat: "+15550100001", guid: "", name: "+15550100001", handle: "+15550100001",
      service: "iMessage", last_ts: "", last_text: "", last_from_me: false, count: 0, unread: 0,
    };
    expect(applyThreadIdentityOverrides([base], config)[0]!.name).toBe("Alex Rivera");
    const group = { ...base, chat: "chat123", name: "Family", guid: "any;+;chat123" };
    expect(applyThreadIdentityOverrides([group], config)[0]!.name).toBe("Family");
  });
});

describe("identity CLI streaming boundary", () => {
  test("exits before an oversized producer closes stdin", async () => {
    const { path } = fixture();
    const child = Bun.spawn(["bun", join(import.meta.dir, "identities.ts"), "custom"], {
      env: { ...process.env, BLIP_IDENTITIES_PATH: path },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(Buffer.alloc(MAX_IDENTITY_REQUEST_BYTES + 1, 0x20));
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
