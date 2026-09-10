import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,  chmodSync,
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
import {
  auditContactsOnMac,
  contactWritesEnabled,
  contactMutationOnMac,
  exportContactVCard,
  identityKey,
  MAX_BRIDGE_CONFIG_BYTES,
  MAX_IDENTITY_REQUEST_BYTES,
  normalizeBridgeCandidates,
  normalizeContactComparison,
  normalizeContactAudit,
  normalizeContactDraft,
  normalizeRepairPreview,
  readBoundedBridgeConfig,
  resolveOnMac,
} from "./contact-management";

const roots: string[] = [];
function fixture(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "blip-contact-management-"));
  roots.push(root);
  return { root, path: join(root, "blip", "bridge.conf") };
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const token = "sha256:" + "a".repeat(64);
const cardToken = (character: string) => "sha256:" + character.repeat(64);
describe("contact-write opt-in", () => {
  test("is disabled by default and accepts only an explicit on value", () => {
    const { root } = fixture();
    const path = join(root, "blip", "bridge.conf");
    mkdirSync(join(root, "blip"), { recursive: true, mode: 0o700 });
    writeFileSync(path, "host=mac\ncontact_writes=off\n");
    expect(contactWritesEnabled(path)).toBe(false);
    writeFileSync(path, "contact_writes='on'\n");
    expect(contactWritesEnabled(path)).toBe(true);
    writeFileSync(path, "contact_writes=on\ncontact_writes=off\n");
    expect(contactWritesEnabled(path)).toBe(false);
  });

  test("fails closed for oversized, symlinked, and group-writable config", () => {
    const first = fixture();
    const path = join(first.root, "blip", "bridge.conf");
    mkdirSync(join(first.root, "blip"), { recursive: true, mode: 0o700 });
    writeFileSync(path, Buffer.alloc(MAX_BRIDGE_CONFIG_BYTES + 1, 0x20));
    expect(contactWritesEnabled(path)).toBe(false);
    expect(() => readBoundedBridgeConfig(path)).toThrow("too large");
    writeFileSync(path, "contact_writes=on\n");
    chmodSync(path, 0o622);
    expect(contactWritesEnabled(path)).toBe(false);

    const second = fixture();
    const target = join(second.root, "target.conf");
    const link = join(second.root, "blip", "bridge.conf");
    mkdirSync(join(second.root, "blip"), { recursive: true, mode: 0o700 });
    writeFileSync(target, "contact_writes=on\n");
    symlinkSync(target, link);
    expect(contactWritesEnabled(link)).toBe(false);
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

  test("vCard export stays on stdin and creates a real owner-only .vcf file", () => {
    let bridgeInput = "";
    const runtime = fixture().root;
    const card = Buffer.from(
      "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Alex Rivera\r\nEND:VCARD\r\n",
      "utf8",
    );
    const runner = ((_command: string, args: string[], options: any) => {
      expect(args).toEqual(["--json", "resolve"]);
      bridgeInput = options.input;
      return { status: 0, signal: null, output: [], pid: 1, stderr: "", error: undefined,
        stdout: JSON.stringify({ ok: true, name: "Alex Rivera", vcard: card.toString("base64") }) };
    }) as any;
    const result = exportContactVCard("+15550100001", runner, runtime);
    expect(result).toEqual({
      handle: "+15550100001", name: "Alex Rivera", bytes: card.length,
      fileName: "Alex Rivera.vcf",
      fileUri: expect.stringContaining("/Alex%20Rivera.vcf"),
    });
    expect(JSON.parse(bridgeInput)).toEqual({
      operation: "vcard", handle: "+15550100001",
    });
    const copiedPath = decodeURIComponent(new URL(result.fileUri).pathname);
    expect(readFileSync(copiedPath)).toEqual(card);
    expect(lstatSync(copiedPath).mode & 0o077).toBe(0);
  });

  test("discard-unsaved sends no contact identifier and validates the result", () => {
    let bridgeInput = "";
    const runner = ((_command: string, args: string[], options: any) => {
      expect(args).toEqual(["--json", "resolve"]);
      bridgeInput = options.input;
      return { status: 0, signal: null, output: [], pid: 1, stderr: "", error: undefined,
        stdout: JSON.stringify({ ok: true, discarded: true }) };
    }) as any;
    expect(resolveOnMac("discard-unsaved", undefined, undefined, runner))
      .toEqual({ discarded: true });
    expect(JSON.parse(bridgeInput)).toEqual({ operation: "discard-unsaved" });
  });

  test("validates repair previews and rejects inconsistent metadata", () => {
    const preview = {
      handle: "+15550100001", name: "Pat Rivera", kind: "phone",
      fieldCount: 1, labels: ["mobile"], cardNumber: 1, cardCount: 2,
      accountNumber: 1, sourceName: "iCloud", writeEnabled: true,
    };
    expect(normalizeRepairPreview(preview, "5550100001")).toEqual(preview);
    expect(() => normalizeRepairPreview({ ...preview, labels: [] }, preview.handle))
      .toThrow("field-label");
    expect(() => normalizeRepairPreview({ ...preview, cardNumber: 3 }, preview.handle))
      .toThrow("inconsistent card");
    expect(() => normalizeRepairPreview({ ...preview, name: "x".repeat(161) }, preview.handle))
      .toThrow("too long");
  });

  test("validates bounded contact-card comparisons", () => {
    const comparison = {
      handle: "+15550100001", name: "Alex Rivera", cardCount: 2,
      sourceCount: 2, writeEnabled: true,
      cards: [1, 2].map((number) => ({
        token: cardToken(number === 1 ? "b" : "c"), revision: cardToken(number === 1 ? "d" : "e"), cardNumber: number,
        accountNumber: number, sourceName: number === 1 ? "iCloud" : "Google",
        hasPhoto: number === 1,
        displayName: "Alex Rivera", firstName: "Alex", middleName: "", lastName: "Rivera",
        nickname: "", organization: "Example", department: "", jobTitle: "",
        birthday: "--09-02", note: "",
        phones: [{ label: "mobile", value: "+1 555 010 0001" }],
        emails: number === 1 ? [{ label: "home", value: "alex@example.com" }] : [],
        urls: [], addresses: number === 2 ? [{ label: "home", street: "1 Main St",
          city: "Madison", state: "WI", postalCode: "53703", country: "US",
          countryCode: "US" }] : [],
      })),
    };
    expect(normalizeContactComparison(comparison, "5550100001")).toEqual(comparison);
    expect(() => normalizeContactComparison({ ...comparison, cards: [
      comparison.cards[0], { ...comparison.cards[1], token: comparison.cards[0]!.token },
    ] }, comparison.handle)).toThrow("duplicate comparison card");
    expect(() => normalizeContactComparison({ ...comparison, cards: [
      comparison.cards[0], { ...comparison.cards[1], cardNumber: 3 },
    ] }, comparison.handle)).toThrow("card numbers");
    expect(() => normalizeContactComparison({ ...comparison, cards: [
      { ...comparison.cards[0], phones: Array(17).fill({ label: "x", value: "1" }) },
      comparison.cards[1],
    ] }, comparison.handle)).toThrow("phone list");
    expect(() => normalizeContactComparison({ ...comparison, cards: [
      { ...comparison.cards[0], note: "x".repeat(1001) }, comparison.cards[1],
    ] }, comparison.handle)).toThrow("note");
  });

  test("comparison and link operations stay on stdin and validate Apple actions", () => {
    const comparison = {
      handle: "+15550100001", name: "Alex Rivera", cardCount: 2,
      sourceCount: 2, writeEnabled: true,
      cards: [1, 2].map((number) => ({
        token: cardToken(number === 1 ? "b" : "c"), revision: cardToken(number === 1 ? "d" : "e"), cardNumber: number,
        accountNumber: number, sourceName: number === 1 ? "iCloud" : "Google",
        hasPhoto: false, displayName: "Alex Rivera",
        firstName: "Alex", middleName: "", lastName: "Rivera", nickname: "",
        organization: "", department: "", jobTitle: "", birthday: "", note: "",
        phones: [], emails: [], urls: [], addresses: [],
      })),
    };
    const captured: Array<{ args: string[]; input: string }> = [];
    const responses = [
      { ok: true, ...comparison },
      { ok: true, handle: comparison.handle, name: comparison.name, cardCount: 2,
        sourceCount: 2, writeEnabled: true, ready: true, action: "Link Selected Cards" },
      { ok: true, handle: comparison.handle, name: comparison.name, cardCount: 2,
        sourceCount: 2, writeEnabled: true, linked: true, action: "Link Selected Cards" },
    ];
    const runner = ((_command: string, args: string[], options: any) => {
      captured.push({ args, input: options.input });
      return { status: 0, signal: null, output: [], pid: 1,
        stdout: JSON.stringify(responses.shift()), stderr: "", error: undefined };
    }) as any;
    expect(resolveOnMac("compare", comparison.handle, token, runner).comparison?.cardCount).toBe(2);
    expect(resolveOnMac("link-prepare", comparison.handle, token, runner).linkPreview?.ready).toBe(true);
    expect(resolveOnMac(
      "link", comparison.handle, token, runner, undefined, "Link Selected Cards",
    ).linkResult?.linked).toBe(true);
    expect(captured.every(({ args }) => args.join(" ").includes("15550100001") === false)).toBe(true);
    expect(captured.map(({ input }) => JSON.parse(input))).toEqual([
      { operation: "compare", handle: comparison.handle, ownerToken: token },
      { operation: "link-prepare", handle: comparison.handle, ownerToken: token },
      { operation: "link", handle: comparison.handle, ownerToken: token,
        expectedAction: "Link Selected Cards" },
    ]);
    const badRunner = (() => ({ status: 0, signal: null, output: [], pid: 1,
      stdout: JSON.stringify({ ...responses[0], ok: true, handle: comparison.handle,
        name: comparison.name, cardCount: 2, sourceCount: 2, writeEnabled: true,
        ready: true, action: "Delete Cards" }), stderr: "", error: undefined })) as any;
    expect(() => resolveOnMac("link-prepare", comparison.handle, token, badRunner))
      .toThrow("invalid link action");
    expect(() => resolveOnMac(
      "link", comparison.handle, token, runner, undefined, "Delete Cards",
    )).toThrow("confirmed Contacts action");
  });

  test("contact edits are bounded, revision-pinned, previewed, and confirmed", () => {
    const exactToken = cardToken("b");
    const revision = cardToken("c");
    const planHash = cardToken("d");
    const draft = normalizeContactDraft({
      firstName: "Alex", middleName: "", lastName: "Rivera", nickname: "Lex",
      organization: "Example", department: "", jobTitle: "", birthday: "--09-02",
      note: "", phones: [{ label: "mobile", value: "+1 555 010 0001" }],
      emails: [], urls: [], addresses: [],
    });
    const metadata = {
      action: "edit", handle: "+15550100001", name: "Alex Rivera", cardNumber: 1,
      cardCount: 2, accountNumber: 1, sourceName: "iCloud", sourceCardCount: 0,
      changedFields: ["nickname"], planHash, writeEnabled: true,
    };
    const captured: string[] = [];
    const responses = [
      { ok: true, preview: metadata },
      { ok: true, ...metadata, applied: true, undoToken: "undo:" + "f".repeat(32),
        revision: cardToken("e"), displayName: "Alex Rivera" },
    ];
    const runner = ((_command: string, args: string[], options: any) => {
      expect(args).toEqual(["--json", "resolve"]);
      captured.push(options.input);
      return { status: 0, signal: null, output: [], pid: 1,
        stdout: JSON.stringify(responses.shift()), stderr: "", error: undefined };
    }) as any;
    const input = { handle: metadata.handle, ownerToken: token, token: exactToken, revision, card: draft };
    expect(contactMutationOnMac("edit-prepare", input, runner).preview?.action).toBe("edit");
    expect(contactMutationOnMac("edit", { ...input, planHash }, runner).result?.applied).toBe(true);
    expect(JSON.parse(captured[0]!)).toEqual({ operation: "edit-prepare", ...input });
    expect(JSON.parse(captured[1]!)).toEqual({ operation: "edit", ...input, planHash });
    expect(() => contactMutationOnMac("edit", { ...input, planHash: "sha256:bad" }, runner))
      .toThrow("revision");
  });

  test("cross-name merge threads the second owner token and rejects a duplicate", () => {
    const token = "sha256:" + "1".repeat(64);
    const otherToken = "sha256:" + "2".repeat(64);
    const captured: string[] = [];
    const comparison = {
      handle: "+15550100001", name: "Alex Rivera", cardCount: 2,
      sourceCount: 2, writeEnabled: true,
      cards: [1, 2].map((number) => ({
        token: "sha256:" + String(number).repeat(63) + "a",
        revision: "sha256:" + String(number).repeat(63) + "b", cardNumber: number,
        accountNumber: number, sourceName: number === 1 ? "iCloud" : "Google",
        hasPhoto: false, displayName: "Alex Rivera",
        firstName: "Alex", middleName: "", lastName: "Rivera", nickname: "",
        organization: "", department: "", jobTitle: "", birthday: "", note: "",
        phones: [], emails: [], urls: [], addresses: [],
      })),
    };
    const runner = ((_command: string, _args: string[], options: any) => {
      captured.push(options.input);
      return { status: 0, signal: null, output: [], pid: 1,
        stdout: JSON.stringify({ ok: true, ...comparison }), stderr: "", error: undefined };
    }) as any;
    resolveOnMac("compare", comparison.handle, token, runner, undefined, undefined, otherToken);
    expect(JSON.parse(captured[0]!)).toEqual({
      operation: "compare", handle: comparison.handle, ownerToken: token, otherOwnerToken: otherToken,
    });
    expect(() => resolveOnMac(
      "compare", comparison.handle, token, runner, undefined, undefined, token,
    )).toThrow("different candidate");
    const draft = {
      firstName: "Alex", middleName: "", lastName: "Rivera", nickname: "",
      organization: "", department: "", jobTitle: "", birthday: "", note: "",
      phones: [], emails: [], urls: [], addresses: [],
    };
    const revisions = comparison.cards.map((card) => ({ token: card.token, revision: card.revision }));
    expect(() => contactMutationOnMac("merge-prepare", {
      handle: comparison.handle, ownerToken: token, otherOwnerToken: token,
      targetToken: comparison.cards[0]!.token, revisions, card: draft,
    }, runner)).toThrow("different candidate");
  });

  test("inspect, removal, and undo keep contact data on stdin and validate receipts", () => {
    const exactToken = cardToken("e");
    const undoToken = "undo:" + "f".repeat(32);
    const preview = {
      handle: "+15550100001", name: "Pat Rivera", kind: "phone",
      fieldCount: 1, labels: ["mobile"], cardNumber: 1, cardCount: 2,
      accountNumber: 1, sourceName: "iCloud", writeEnabled: true,
    };
    const captured: Array<{ args: string[]; input: string }> = [];
    const responses = [
      { ok: true, preview },
      { ok: true, ...preview, removed: true, undoToken },
      { ok: true, restored: true, alreadyPresent: false, handle: preview.handle,
        name: preview.name, action: "field-removal", cardCount: 1, fieldCount: 1 },
    ];
    const runner = ((_command: string, args: string[], options: any) => {
      captured.push({ args, input: options.input });
      return { status: 0, signal: null, output: [], pid: 1,
        stdout: JSON.stringify(responses.shift()), stderr: "", error: undefined };
    }) as any;
    expect(resolveOnMac("inspect", preview.handle, exactToken, runner, token).preview).toEqual(preview);
    expect(resolveOnMac("remove", preview.handle, exactToken, runner, token).removal?.undoToken).toBe(undoToken);
    expect(resolveOnMac("undo", undefined, undoToken, runner).undo?.restored).toBe(true);
    expect(captured.every(({ args }) => args.join(" ").includes("15550100001") === false)).toBe(true);
    expect(JSON.parse(captured[0]!.input)).toEqual({
      operation: "inspect", handle: preview.handle, token: exactToken, ownerToken: token,
    });
    expect(JSON.parse(captured[2]!.input)).toEqual({ operation: "undo", undoToken });
    expect(() => resolveOnMac("undo", undefined, "undo:bad", runner)).toThrow("undo token");
  });
});


describe("contact workspace CLI", () => {
  test("removed name preferences cannot create a local display override", () => {
    const { root } = fixture();
    for (const operation of ["choose", "custom", "clear"]) {
      const result = spawnSync(process.execPath, ["contact-management.ts", operation], {
        cwd: import.meta.dir,
        env: { ...process.env, HOME: root },
        input: JSON.stringify({ handle: "+15551234567", name: "Example", token }),
        encoding: "utf8", timeout: 1500,
      });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).ok).toBe(false);
      expect(existsSync(join(root, ".config", "blip", "identities.json"))).toBe(false);
    }
  });

  test("oversized streaming input is rejected before a native request", () => {
    const { root } = fixture();
    const result = spawnSync(process.execPath, ["contact-management.ts", "edit"], {
      cwd: import.meta.dir, env: { ...process.env, HOME: root },
      input: "x".repeat(MAX_IDENTITY_REQUEST_BYTES + 1), encoding: "utf8", timeout: 1500,
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain("too large");
  });
});


test("initial contact view skips only an unambiguous person, never writes", async () => {
  const { initialContactToken } = await import("./contact-management");
  const candidate = { token, name: "Sample Contact", recordCount: 2, sourceCount: 2,
    hasPhoto: false, cards: [] };
  expect(initialContactToken([])).toBe("");
  expect(initialContactToken([candidate])).toBe(token);
  expect(initialContactToken([candidate, { ...candidate, token: "sha256:" + "b".repeat(64) }])).toBe("");
});
