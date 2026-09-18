import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { enqueueRefresh, parseReadSnapshot, parseReadIntents, queueReadIntent, reconcileReadIntents, retryReadIntent } from "./read-sync";

const chat = "+15551234567";
const old = "2026-09-01T10:00:00Z";
const recent = "2026-09-01T11:00:00Z";
const snapshot = (unread = 1, latest = old) => ({ version: 1, chats: [{ chat, unread, max_id: latest === old ? 1 : 2, oldest: unread ? old : "", latest }] });

describe("read sync state machine", () => {
  test("partial or malformed snapshots cannot clear the ledger", () => {
    expect(parseReadSnapshot({ chats: [] })).toBeNull();
    expect(parseReadSnapshot({ version: 1, chats: [{ chat, unread: -1 }] })).toBeNull();
    expect(parseReadSnapshot({ version: 1, chats: [] })).toEqual({});
    expect(parseReadIntents({ [chat]: { unread: false, seen: old, attempts: -1, retryAt: 0 } })).toEqual({});
  });
  test("failed action survives identical polls and uses bounded backoff", () => {
    const pending = queueReadIntent({}, chat, false, old);
    pending[chat] = retryReadIntent(pending[chat]!, 1000);
    expect(queueReadIntent(pending, chat, false, old)).toBe(pending);
    expect(pending[chat]!.retryAt).toBe(3000);
    expect(retryReadIntent({ ...pending[chat]!, attempts: 100 }, 1000).retryAt).toBe(61000);
    expect(reconcileReadIntents(pending, parseReadSnapshot(snapshot())!)).toEqual(pending);
    expect(reconcileReadIntents(pending, parseReadSnapshot(snapshot(0))!)).toEqual({});
  });
  test("later intent wins, and a stale read cannot clear a new inbound", () => {
    const pending = queueReadIntent(queueReadIntent({}, chat, false, old), chat, true);
    expect(pending[chat]!.unread).toBe(true);
    expect(reconcileReadIntents(queueReadIntent({}, chat, false, old), parseReadSnapshot(snapshot(1, recent))!)).toEqual({});
  });
  test("a later per-chat gesture supersedes a failed global action", () => {
    const pending = queueReadIntent(queueReadIntent({}, "*", false, old), chat, true);
    expect(pending["*"]).toBeUndefined();
    expect(pending[chat]!.unread).toBe(true);
  });

  test("coalescing preserves read-unread-read order", () => {
    const read = { readChat: chat, seen: old, deep: false, markRead: false, unreadChat: "", deleteChat: "", act: "" };
    const unread = { ...read, readChat: "", unreadChat: chat };
    const q = enqueueRefresh(enqueueRefresh([read], unread), { ...read, seen: recent });
    expect(q.map(r => r.unreadChat ? "unread" : "read")).toEqual(["read", "unread", "read"]);
    expect(enqueueRefresh([read], { ...read, seen: recent })).toHaveLength(1);
  });
});

/** A complete collector process with an isolated HOME and synthetic bridge.
 * Nothing here calls the real Mac or reads the user's state. */
const fixtureHomes: string[] = [];
afterAll(() => { for (const home of fixtureHomes) rmSync(home, { recursive: true, force: true }); });
function fixture(unread = 1) {
  const home = mkdtempSync(join(tmpdir(), "blip-sync-"));
  fixtureHomes.push(home);
  mkdirSync(join(home, "bin"));
  mkdirSync(join(home, ".config/blip"), { recursive: true });
  mkdirSync(join(home, ".local/state/blip"), { recursive: true });
  writeFileSync(join(home, ".config/blip/bridge.conf"), "push_read=thread\n");
  const put = (file: string, v: unknown) => writeFileSync(join(home, file), JSON.stringify(v));
  put("remote.json", snapshot(unread));
  put("control.json", {});
  const bridge = `#!/usr/bin/env python3
import json,os,sys
home=os.environ['HOME']; args=sys.argv[1:]
ctl=json.load(open(home+'/control.json'))
if ctl.get('offline'): sys.exit(69)
if 'read-state' in args:
 if ctl.get('snapshot_fail'): sys.exit(64)
 print(open(home+'/remote.json').read())
elif 'groups' in args: print('[]')
elif 'chats' in args: print(json.dumps([{'id':'${chat}','last':'${old}','last_text':'fixture','last_from_me':False,'muted':ctl.get('muted',False)}]))
else:
 print(json.dumps([{'id':1,'chat':'${chat}','handle':'${chat}','name':None,'service':'iMessage','ts':ctl.get('latest','${old}'),'from_me':False,'text':'fixture','read':False}]))
`;
  writeFileSync(join(home, "bin/imsg"), bridge, { mode: 0o755 });
  writeFileSync(join(home, "bin/imsg-read"), `#!/usr/bin/env python3
import json,os,sys,time
home=os.environ['HOME']; args=sys.argv[1:]
with open(home+'/actions.jsonl','a') as f: f.write(json.dumps(args)+'\\n')
ctl=json.load(open(home+'/control.json'))
if ctl.get('delay'): time.sleep(ctl['delay'])
if ctl.get('fail'):
 print('imsg-read: Accessibility is not granted',file=sys.stderr); sys.exit(77)
if args[0] in ('--pin','--unpin','--mute','--unmute'): print('verified'); sys.exit(0)
data=json.load(open(home+'/remote.json'))
if '--through' in args:
 boundary=args[args.index('--through')+1]
 scoped=[r for r in data['chats'] if '--all' in args or r['chat']==args[1]]
 if any(r['latest']>boundary for r in scoped): sys.exit(75)
if '--through-row' in args:
 if any(r.get('max_id',0)>int(args[args.index('--through-row')+1]) for r in data['chats']): sys.exit(75)
for r in data['chats']:
 if '--all' in args or r['chat']==args[1]:
  r['unread']=1 if '--unread' in args else 0
  r['oldest']=r['latest'] if r['unread'] else ''
with open(home+'/remote.json','w') as f: json.dump(data,f)
print('verified')
`, { mode: 0o755 });
  const statePath = join(home, ".local/state/blip/state.json");
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));
  const raw = (...args: string[]) => {
    const result = spawnSync(process.execPath, [join(import.meta.dir, "collector.ts"), "--deep", ...args], {
      encoding: "utf8", env: { ...process.env, HOME: home }, timeout: 10000,
    });
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.error).not.toContain("TypeError");
    return out;
  };
  const drain = () => {
    const dir = join(home, ".local/state/blip/read-worker");
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      let job;
      try { job = JSON.parse(readFileSync(join(dir, "job.json"), "utf8")); } catch { return raw(); }
      try {
        const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
        if (result.id === job.id) return raw();
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    throw new Error("synthetic worker did not finish");
  };
  const run = (...args: string[]) => {
    const out = raw(...args);
    try { readFileSync(join(home, ".local/state/blip/read-worker/job.json")); }
    catch { return out; }
    return drain();
  };
  const actions = () => { try { return readFileSync(join(home, "actions.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  return { home, put, run, raw, drain, state, actions, save: (s: unknown) => writeFileSync(statePath, JSON.stringify(s)) };
}

describe("collector read sync lifecycle", () => {
  test("opening an unread chat pushes once, even if a local mark already hid it", () => {
    const f = fixture(); f.run();
    f.save({ ...f.state(), readMarks: { [chat]: recent }, unreadCounts: {} });
    expect(f.run("--read", chat, "--seen", old).unread).toBe(0);
    expect(f.actions()).toEqual([["--chat", chat, "--through", old]]);
    f.run("--read", chat, "--seen", old);
    expect(f.actions()).toHaveLength(1);
    expect(f.state().pendingReads).toEqual({});
  });
  test("failure stays queued, survives restart, then clears on verified retry", () => {
    const f = fixture(); f.put("control.json", { fail: true });
    expect(f.run("--read", chat, "--seen", old).error).toContain("Accessibility");
    expect(f.state().pendingReads[chat].attempts).toBe(1);
    f.run("--read", chat, "--seen", old);
    expect(f.actions()).toHaveLength(1);
    f.put("control.json", {});
    const st = f.state(); st.pendingReads[chat].retryAt = 0; f.save(st);
    f.run();
    expect(f.actions()).toHaveLength(2);
    expect(f.state().pendingReads).toEqual({});
  });
  test("offline mark-unread survives and a subsequent Mac read clears Blip", () => {
    const f = fixture(0); f.put("control.json", { offline: true });
    expect(f.run("--mark-unread", chat).online).toBe(false);
    expect(f.state().pendingReads[chat].unread).toBe(true);
    f.put("control.json", {});
    expect(f.run().unread).toBe(1);
    expect(f.actions()).toEqual([["--unread", chat]]);
    f.put("remote.json", snapshot(0));
    expect(f.run().unread).toBe(0);
    expect(f.state().unreadSince).toEqual({});
  });
  test("new inbound beyond --seen remains unread and cancels an old retry", () => {
    const f = fixture(); f.run();
    f.save({ ...f.state(), pendingReads: queueReadIntent({}, chat, false, old) });
    f.put("remote.json", snapshot(1, recent));
    expect(f.run("--read", chat, "--seen", old).unread).toBe(1);
    expect(f.actions()).toHaveLength(0);
  });
  test("Mac mark-unread bypasses a historical local read mark; Mac read retires old unread override", () => {
    const f = fixture(); f.run();
    f.save({ ...f.state(), readMarks: { [chat]: recent }, unreadSince: { [chat]: old } });
    expect(f.run().unread).toBe(1);
    f.put("remote.json", snapshot(0));
    expect(f.run().unread).toBe(0);
  });
  test("old chats outside previews are present in the complete unread metadata", () => {
    const f = fixture(0);
    const data = snapshot(0);
    data.chats.push({ chat: "+15557654321", unread: 1, oldest: "2020-01-01T00:00:00Z", latest: "2020-01-01T00:00:00Z" });
    f.put("remote.json", data);
    const out = f.run();
    expect(out.unreadCounts["+15557654321"]).toBe(1);
    expect(out.unread).toBe(1);
  });
  test("push_read=off never calls the Mac, including explicit menu reads", () => {
    const f = fixture();
    writeFileSync(join(f.home, ".config/blip/bridge.conf"), "push_read=off\n");
    f.run("--act", "read", "--target", chat, "--read", chat, "--seen", old);
    expect(f.actions()).toHaveLength(0);
  });
});


describe("policy and ordering integration", () => {
  test("local-only mark unread survives later snapshots without a Mac action", () => {
    const f = fixture(0);
    writeFileSync(join(f.home, ".config/blip/bridge.conf"), "push_read=off\n");
    expect(f.run("--mark-unread", chat).unread).toBe(1);
    expect(f.run().unread).toBe(1);
    expect(f.actions()).toHaveLength(0);
  });
  test("gesture-only policy keeps a local read of an old message across polls", () => {
    const f = fixture();
    writeFileSync(join(f.home, ".config/blip/bridge.conf"), "push_read=all\n");
    f.run();
    expect(f.run("--read", chat, "--seen", old).unread).toBe(0);
    expect(f.run().unread).toBe(0);
    expect(f.actions()).toHaveLength(0);
  });
  test("offline unread then read sends only the last requested state", () => {
    const f = fixture(); f.put("control.json", { offline: true });
    f.run("--mark-unread", chat);
    f.run("--act", "read", "--target", chat, "--read", chat, "--seen", old);
    f.put("control.json", {}); f.run();
    expect(f.actions()).toEqual([["--chat", chat, "--through", old]]);
  });
  test("unread after offline mark-all cancels the stale global action", () => {
    const f = fixture(); f.put("control.json", { offline: true });
    f.run("--mark-read"); f.run("--mark-unread", chat);
    f.put("control.json", {}); f.run(); f.run();
    expect(f.actions()).toEqual([]);
    expect(f.run().unread).toBe(1);
  });
  test("fallback snapshot failure does not consume a newer unseen inbound", () => {
    const f = fixture(); f.run();
    f.put("control.json", { snapshot_fail: true, latest: recent });
    expect(f.run("--read", chat, "--seen", old).unread).toBe(1);
    expect(f.actions()).toHaveLength(0);
  });
});


describe("repeated read/unread convergence", () => {
  test("every four-click offline read/unread sequence converges to the last click", () => {
    for (let mask = 0; mask < 16; mask++) {
      const f = fixture(mask % 2);
      f.put("control.json", { offline: true });
      let wantUnread = false;
      for (let bit = 0; bit < 4; bit++) {
        wantUnread = Boolean(mask & (1 << bit));
        if (wantUnread) f.run("--mark-unread", chat);
        else f.run("--act", "read", "--target", chat, "--read", chat, "--seen", old);
      }
      f.put("control.json", {});
      f.run();
      const out = f.run();
      expect(out.unread).toBe(wantUnread ? 1 : 0);
      expect(f.state().pendingReads).toEqual({});
      expect(f.actions().length).toBeLessThanOrEqual(1);
    }
  }, 20000);
  test("alternating local and Mac gestures converge without stale overrides", () => {
    const f = fixture(0);
    const steps = ["unread", "read", "mac-unread", "mac-read", "unread", "mac-read", "mac-unread", "read"];
    for (const step of steps) {
      const wantUnread = step.endsWith("unread");
      if (step.startsWith("mac-")) f.put("remote.json", snapshot(wantUnread ? 1 : 0));
      else if (wantUnread) f.run("--mark-unread", chat);
      else f.run("--read", chat, "--seen", old);
      const out = f.run();
      expect(out.unread).toBe(wantUnread ? 1 : 0);
      expect(out.threads.filter((t: { unread: number }) => t.unread > 0).length).toBe(out.unread);
      expect(f.state().pendingReads).toEqual({});
    }
  }, 10000);
});

test("a due retry cannot jump ahead of a fresh action for another chat", () => {
  const other = "+15557654321";
  const f = fixture(); f.run();
  const remote = snapshot(1);
  remote.chats.push({ chat: other, unread: 1, oldest: old, latest: old });
  f.put("remote.json", remote);
  f.save({ ...f.state(), pendingReads: {
    [chat]: { unread: false, seen: old, attempts: 2, retryAt: Date.now() - 1 },
    [other]: { unread: false, seen: old, attempts: 0, retryAt: 0 },
  } });
  f.run();
  expect(f.actions()[0]).toEqual(["--chat", other, "--through", old]);
});

test("local group unread survives complete Mac snapshots until explicitly read", () => {
  const f = fixture(0);
  const group = "chat900000000000000001";
  f.run();
  f.run("--mark-unread", group);
  expect(f.run().unreadCounts[group]).toBe(1);
  expect(f.actions()).toHaveLength(0);
  expect(f.run("--mark-read").unreadCounts[group]).toBeUndefined();
});


describe("background action races", () => {
  test("a slow read worker does not block polling newer messages", () => {
    const f = fixture(); f.run();
    f.put("control.json", { delay: 1.2 });
    const start = Date.now();
    f.raw("--read", chat, "--seen", old);
    expect(Date.now() - start).toBeLessThan(900);
    f.put("remote.json", snapshot(1, recent));
    const poll = Date.now();
    expect(f.raw().unread).toBe(1);
    expect(Date.now() - poll).toBeLessThan(900);
    f.drain();
    expect(f.run().unread).toBe(1);
  });
  test("an in-flight read cannot acknowledge a later unread gesture", () => {
    const f = fixture(); f.run(); f.put("control.json", { delay: 0.5 });
    f.raw("--read", chat, "--seen", old);
    const until = Date.now() + 2000;
    while (f.actions().length === 0 && Date.now() < until)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    expect(f.actions()).toHaveLength(1);
    f.raw("--mark-unread", chat);
    f.drain(); f.drain();
    expect(f.run().unread).toBe(1);
    expect(f.actions().map(a => a[0])).toEqual(["--chat", "--unread"]);
    expect(f.state().pendingReads).toEqual({});
  });
  test("offline global read is cancelled for a same-second newer inbound", () => {
    const f = fixture(); f.run();
    f.put("control.json", { offline: true }); f.run("--mark-read");
    const newer = snapshot(1); newer.chats[0]!.max_id = 2;
    f.put("remote.json", newer); f.put("control.json", {});
    expect(f.run().unread).toBe(1);
    expect(f.actions()).toHaveLength(0);
    expect(f.state().pendingReads).toEqual({});
  });
  test("a failed global action cannot starve a later per-chat read", () => {
    const f = fixture(); f.run(); f.put("control.json", { fail: true });
    f.run("--mark-read");
    expect(f.state().pendingReads["*"].attempts).toBe(1);
    f.put("control.json", {});
    f.run("--act", "read", "--target", chat, "--read", chat, "--seen", old);
    expect(f.actions().map(a => a[0])).toEqual(["--all", "--chat"]);
    expect(f.state().pendingReads).toEqual({});
  });
  test("gesture-only policy preserves a newer inbound after a stale mark-all", () => {
    const f = fixture();
    writeFileSync(join(f.home, ".config/blip/bridge.conf"), "push_read=all\n");
    f.run();
    const newer = snapshot(1); newer.chats[0]!.max_id = 2;
    f.put("remote.json", newer);
    expect(f.run("--mark-read").unread).toBe(1);
    expect(f.run().unread).toBe(1);
    expect(f.actions()).toHaveLength(0);
  });
});

test("menu actions use the durable worker and honor a custom shim directory", () => {
  const f = fixture();
  mkdirSync(join(f.home, "custom"));
  for (const tool of ["imsg", "imsg-read"]) {
    writeFileSync(join(f.home, "custom", tool), readFileSync(join(f.home, "bin", tool)), { mode: 0o755 });
    rmSync(join(f.home, "bin", tool));
  }
  writeFileSync(join(f.home, ".config/blip/bridge.conf"), "push_read=off\nbin_dir=$HOME/custom\n");
  f.run("--act", "pin", "--target", chat);
  expect(f.actions()).toEqual([["--pin", chat]]);
  expect(f.state().pendingReads).toEqual({});
  expect(f.run().unread).toBe(1);
});

test("Hide Alerts suppresses local toasts while preserving the conversation", () => {
  const f = fixture(); f.run();
  f.put(".config/blip/allowlist.json", [chat]);
  f.put("control.json", { latest: recent, muted: true });
  f.put("remote.json", snapshot(1, recent));
  const quiet = f.run();
  expect(quiet.threads.some((t: { chat: string }) => t.chat === chat)).toBe(true);
  expect(quiet.unread).toBe(1);
  expect(quiet.toast).toEqual([]);
  f.save({ ...f.state(), watermark: old, toasted: [] });
  f.put("control.json", { latest: recent, muted: false });
  expect(f.run().toast).toHaveLength(1);
});
