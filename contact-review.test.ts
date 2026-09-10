import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, lstatSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditContactsOnMac, normalizeBridgeCandidates, normalizeContactAudit, resolveOnMac,
  conversationPeople, scanHandles, cardView, auditView, runReview, readStdinBounded,
  MAX_IDENTITY_REQUEST_BYTES, MAX_BRIDGE_OUTPUT_BYTES, MAX_AUDIT_CACHE_BYTES,
  readAuditCache, writeAuditCache } from "./contact-review";
let scratch: string;
let cachePath: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "blip-contact-review-"));
  cachePath = join(scratch, "audit-cache.json");
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));
const token = "sha256:" + "a".repeat(64);
const cardToken = (character: string) => "sha256:" + character.repeat(64);
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
    try {
      const result = auditContactsOnMac(
        ["+15550100001", "+15550100002", "+15550100003"], runner, cachePath,
      );
      expect(result.cached).toBe(false);
      expect(result.audit.noMatchCount).toBe(1);
      expect(result.audit.singleCards[0]?.candidates[0]?.name).toBe("Alex Rivera");
      expect(result.audit.duplicates[0]?.candidates[0]?.recordCount).toBe(2);
      expect(JSON.parse(capturedInput)).toEqual({
        operation: "audit", handles: ["+15550100001", "+15550100002", "+15550100003"],
      });
    } finally {
      // Scratch cache is removed by afterEach.
    }
  });

  test("an unchanged store fingerprint reuses the cached scan without re-scanning", () => {
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
      const first = auditContactsOnMac(["+15550100001"], runner, cachePath);
      expect(first.cached).toBe(false);
      const second = auditContactsOnMac(["+15550100001"], runner, cachePath);
      expect(second.cached).toBe(true);
      expect(second.audit.noMatchCount).toBe(1);
      // the second call only paid one cheap fingerprint round-trip
      expect(operations).toEqual(["audit", "fingerprint"]);
      // a different conversation set never reuses the cache
      const third = auditContactsOnMac(["+15550100002"], runner, cachePath);
      expect(third.cached).toBe(false);
      expect(operations).toEqual(["audit", "fingerprint", "audit"]);
    } finally {
      // Scratch cache is removed by afterEach.
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
    expect(() => auditContactsOnMac(["+15550100001"], wrongHandleRunner, cachePath)).toThrow("unrequested");
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


describe("review projection", () => {
  test("group review offers participants, never the last speaker by itself", () => {
    expect(conversationPeople({ chat: "chat123", handle: "+15551234567", name: "Group" })).toEqual([]);
    expect(conversationPeople({ chat: "chat123", participants: [
      { handle: "+15551234567", name: "Example Person" },
      { handle: "5551234567", name: "Duplicate" },
      { handle: "person@example.com", name: "<b>Example</b>\u202e" },
    ] })).toEqual([
      { handle: "+15551234567", name: "Example Person" },
      { handle: "person@example.com", name: "<b>Example</b>" },
    ]);
  });
  test("scans include named conversations and short codes", () => {
    expect(scanHandles([
      { chat: "+15551234567", name: "Example Person" },
      { chat: "99123", name: "Utility" },
      { chat: "chat123", handle: "+15559999999" },
    ])).toEqual(["+15551234567", "99123"]);
  });
  test("bad shapes and oversized batches cannot cause an unbounded scan", () => {
    for (const value of [null, 4, "x", {}]) expect(() => scanHandles(value)).toThrow();
    expect(() => scanHandles(Array(1001).fill({}))).toThrow();
    expect(conversationPeople({ chat: "chat1", participants: [null, {}, { handle: "x".repeat(321) }] })).toEqual([]);
    expect(conversationPeople({ chat: "chat1", participants: Array(1000).fill("person@example.com") })).toHaveLength(1);
  });
  test("card rows retain exact tokens and render source details without guessing", () => {
    const view = cardView("+15551234567", [{
      token, name: "Example Person", recordCount: 1, sourceCount: 1, hasPhoto: true,
      cards: [{ token: cardToken("b"), sourceName: "iCloud", accountNumber: 1, hasPhoto: true, matchCount: 2 }],
    }]);
    expect(view.rows[0]).toEqual({ handle: "+15551234567", name: "Example Person",
      token: cardToken("b"), action: "open", detail: "iCloud · Account 1 · 2 matching fields · Photo" });
  });
  test("the scan summary accounts for unmatched and single-card contacts", () => {
    expect(auditView({ handleCount: 2, noMatchCount: 2, singleCards: [], duplicates: [], conflicts: [] }))
      .toMatchObject({ view: "scan", rows: [], detail: "2 checked · 0 possible duplicates · 0 name conflicts · 0 single cards · 2 unmatched" });
  });
  test("no write or saved-choice operation is exposed", () => {
    for (const operation of ["choose", "custom", "clear", "edit", "delete", "merge"])
      expect(() => runReview(operation, {})).toThrow("operation must be");
  });
});

describe("cache and streaming boundary", () => {
  const entry = { storeFingerprint: cardToken("8"), handleFingerprint: cardToken("9"),
    audit: { handleCount: 1, noMatchCount: 1, singleCards: [], duplicates: [], conflicts: [] } };
  test("cache is private, bounded and rejects links and FIFOs", () => {
    writeAuditCache(entry, cachePath);
    expect(readAuditCache(cachePath)).toEqual(entry);
    expect(lstatSync(cachePath).mode & 0o777).toBe(0o600);
    const link = join(scratch, "link"); symlinkSync(cachePath, link);
    expect(() => readAuditCache(link)).toThrow();
    const fifo = join(scratch, "fifo");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    expect(readAuditCache(fifo)).toBeNull();
    const valid = readFileSync(cachePath);
    writeFileSync(cachePath, Buffer.concat([valid, Buffer.alloc(MAX_AUDIT_CACHE_BYTES - valid.length, 32)]));
    expect(readAuditCache(cachePath)).toEqual(entry);
    writeFileSync(cachePath, Buffer.alloc(MAX_AUDIT_CACHE_BYTES + 1, 32));
    expect(readAuditCache(cachePath)).toBeNull();
  });
  test("a changed Mac fingerprint invalidates an otherwise matching cache", () => {
    let fingerprint = cardToken("8");
    const operations: string[] = [];
    const runner = ((_cmd: string, _args: string[], options: any) => {
      const operation = JSON.parse(options.input).operation; operations.push(operation);
      return { status: 0, stdout: JSON.stringify(operation === "fingerprint" ? { ok: true, fingerprint }
        : { ok: true, fingerprint, ...entry.audit }), stderr: "" };
    }) as any;
    auditContactsOnMac(["+15551234567"], runner, cachePath);
    fingerprint = cardToken("7");
    expect(auditContactsOnMac(["+15551234567"], runner, cachePath).cached).toBe(false);
    expect(operations).toEqual(["audit", "fingerprint", "audit"]);
  });
  test("wrong response types and oversized output fail closed", () => {
    for (const value of [null, [], true, 1, "x"]) {
      const runner = (() => ({ status: 0, stdout: JSON.stringify(value) })) as any;
      expect(() => resolveOnMac("candidates", "+15551234567", undefined, runner)).toThrow();
    }
    const runner = (() => ({ status: 0, stdout: " ".repeat(MAX_BRIDGE_OUTPUT_BYTES + 1) })) as any;
    expect(() => resolveOnMac("candidates", "+15551234567", undefined, runner)).toThrow("too much data");
  });
  test("stdin accepts the exact cap and rejects the sentinel byte", async () => {
    async function* bytes(n: number) { yield Buffer.alloc(n, 32); }
    expect((await readStdinBounded(bytes(MAX_IDENTITY_REQUEST_BYTES))).length).toBe(MAX_IDENTITY_REQUEST_BYTES);
    expect(readStdinBounded(bytes(MAX_IDENTITY_REQUEST_BYTES + 1))).rejects.toThrow("too large");
  });
  test("CLI rejects an oversized producer before stdin closes", async () => {
    const child = Bun.spawn(["bun", join(import.meta.dir, "contact-review.ts"), "review"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    try {
      child.stdin.write(Buffer.alloc(MAX_IDENTITY_REQUEST_BYTES + 1, 32)); child.stdin.flush();
      const code = await Promise.race([child.exited, Bun.sleep(1500).then(() => -999)]);
      expect(code).not.toBe(-999); expect(code).not.toBe(0);
    } finally { child.kill(); try { child.stdin.end(); } catch { /* closed */ } }
  });
});

describe('batched contact scans', () => {
  const handles = Array.from({length: 451}, (_,i) => `+15551${String(i).padStart(6,'0')}`);
  const fingerprint = 'sha256:' + 'f'.repeat(64);
  const result = (body: unknown) => ({status:0,stdout:JSON.stringify(body),stderr:''});
  test('scans beyond 200 and reuses the complete cache on one fingerprint check', () => {
    const batches: number[] = [];
    const runner = ((_cmd: string, args: string[], options: any) => {
      expect(args).toEqual(['--json','resolve']);
      expect(Buffer.byteLength(options.input)).toBeLessThanOrEqual(MAX_IDENTITY_REQUEST_BYTES);
      const request = JSON.parse(options.input);
      if (request.operation === 'fingerprint') return result({ok:true,fingerprint});
      batches.push(request.handles.length);
      return result({ok:true,fingerprint,handleCount:request.handles.length,noMatchCount:request.handles.length,singleCards:[],duplicates:[],conflicts:[]});
    }) as any;
    expect(scanHandles(handles.map(chat => ({chat})))).toEqual(handles);
    expect(auditContactsOnMac(handles,runner,cachePath).audit.handleCount).toBe(451);
    expect(batches).toEqual([200,200,51]);
    expect(auditContactsOnMac(handles,runner,cachePath).cached).toBe(true);
    expect(batches).toHaveLength(3);
  });
  test('splits an oversized response instead of failing the whole scan', () => {
    const runner = ((_cmd: string,_args: string[],options:any) => {
      const hs = JSON.parse(options.input).handles;
      if (hs.length > 25) return {status:1,stdout:'',error:{code:'ENOBUFS'}};
      return result({ok:true,handleCount:hs.length,noMatchCount:hs.length,singleCards:[],duplicates:[],conflicts:[]});
    }) as any;
    expect(auditContactsOnMac(handles,runner,cachePath).audit.handleCount).toBe(451);
  });
  test('does not cache partial results or combine different Contacts snapshots', () => {
    let calls=0;
    const runner = ((_cmd: string,_args: string[],options:any) => {
      const hs=JSON.parse(options.input).handles;
      return result({ok:true,fingerprint:'sha256:'+(++calls===1?'a':'b').repeat(64),handleCount:hs.length,noMatchCount:hs.length,singleCards:[],duplicates:[],conflicts:[]});
    }) as any;
    expect(()=>auditContactsOnMac(handles,runner,cachePath)).toThrow('changed during');
    expect(readAuditCache(cachePath)).toBeNull();
  });
  test('pages every finding without silently dropping later contacts', () => {
    const duplicate = {token,name:'Example Person',recordCount:2,sourceCount:1,hasPhoto:false,cards:[]};
    const audit = {handleCount:451,noMatchCount:0,singleCards:[],conflicts:[],duplicates:handles.map(handle=>({handle,candidates:[duplicate]}))};
    const found = [];
    for(let page=0;page<12;page++) {
      const view=auditView(audit,page);
      expect(view.rows.length).toBeLessThanOrEqual(40);
      expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(MAX_BRIDGE_OUTPUT_BYTES);
      expect(view.pageCount).toBe(12);
      found.push(...view.rows.map(r=>r.handle));
    }
    expect(found).toEqual(handles);
    expect(()=>auditView(audit,-1)).toThrow();
    expect(runReview('audit',{conversations:[]})).toMatchObject({page:0,pageCount:1});
  });
});

test('splits the Mac size-contract error and long handle payloads',()=>{
  const handles=Array.from({length:201},(_,i)=>'p'+i+'x'.repeat(220)+'@example.com');
  const runner=((_cmd:string,_args:string[],options:any)=>{
    expect(Buffer.byteLength(options.input)).toBeLessThanOrEqual(MAX_IDENTITY_REQUEST_BYTES);
    const hs=JSON.parse(options.input).handles;
    if(hs.length>10) return {status:1,stdout:JSON.stringify({ok:false,error:'identity response exceeded its size contract'})};
    return {status:0,stdout:JSON.stringify({ok:true,handleCount:hs.length,noMatchCount:hs.length,singleCards:[],duplicates:[],conflicts:[]})};
  }) as any;
  expect(auditContactsOnMac(handles,runner,cachePath).audit.handleCount).toBe(201);
});
