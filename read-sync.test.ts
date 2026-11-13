import { describe, expect, test } from "bun:test";
import { expandFailedMarkAll } from "./collector";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { enqueueRefresh, parseReadSnapshot, parseReadIntents, queueReadIntent, reconcileReadIntents, retryReadIntent } from "./read-sync";

const chat = "+15551234567";
const old = "2026-09-01T10:00:00Z";
const recent = "2026-09-01T11:00:00Z";
const snapshot = (unread = 1, latest = old) => ({ version: 1, chats: [{ chat, unread, oldest: unread ? old : "", latest }] });

describe("read sync state machine", () => {
  test("a group id is a durable read intent", () => {
    const group = "ce5a593a78af408282d61461ade89135";
    const pending = queueReadIntent({}, group, false, old);
    expect(parseReadIntents(pending)[group]!.unread).toBe(false);
    expect(parseReadIntents({ "not a chat": pending[group]! })).toEqual({});
  });
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
  test("a mark-all does not cover a message that arrives after the click", () => {
    const pending = queueReadIntent({}, "*", false, old);
    const later = { version: 1, chats: [
      { chat, unread: 0, oldest: "", latest: old },
      { chat: "+15550001111", unread: 1, oldest: recent, latest: recent },
    ]};
    expect(reconcileReadIntents(pending, parseReadSnapshot(later)!)).toEqual({});
    const still = { version: 1, chats: [
      { chat, unread: 1, oldest: old, latest: old },
      { chat: "+15550001111", unread: 1, oldest: recent, latest: recent },
    ]};
    expect(reconcileReadIntents(pending, parseReadSnapshot(still)!)["*"]).toBeTruthy();
  });
  test("mark-all followed by unread keeps the unread until mark-all lands", () => {
    const pending = queueReadIntent(queueReadIntent({}, "*", false), chat, true);
    expect(reconcileReadIntents(pending, parseReadSnapshot(snapshot(1))!)).toEqual(pending);
    expect(reconcileReadIntents(pending, parseReadSnapshot(snapshot(0))!)).toEqual({ [chat]: pending[chat]! });
  });
  test("coalescing preserves read-unread-read order", () => {
    const read = { readChat: chat, seen: old, deep: false, markRead: false, unreadChat: "", act: "" };
    const unread = { ...read, readChat: "", unreadChat: chat };
    const q = enqueueRefresh(enqueueRefresh([read], unread), { ...read, seen: recent });
    expect(q.map(r => r.unreadChat ? "unread" : "read")).toEqual(["read", "unread", "read"]);
    expect(enqueueRefresh([read], { ...read, seen: recent })).toHaveLength(1);
  });
});

/** A complete collector process with an isolated HOME and synthetic bridge.
 * Nothing here calls the real Mac or reads the user's state. */
function fixture(unread = 1) {
  const home = mkdtempSync(join(tmpdir(), "blip-sync-"));
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
elif 'chats' in args: print(json.dumps([{'id':'${chat}','last':'${old}','last_text':'fixture','last_from_me':False}]))
else:
 print(json.dumps([{'id':1,'chat':'${chat}','handle':'${chat}','name':None,'service':'iMessage','ts':ctl.get('latest','${old}'),'from_me':False,'text':'fixture','read':False}]))
`;
  writeFileSync(join(home, "bin/imsg"), bridge, { mode: 0o755 });
  writeFileSync(join(home, "bin/imsg-read"), `#!/usr/bin/env python3
import json,os,sys
home=os.environ['HOME']; args=sys.argv[1:]
with open(home+'/actions.jsonl','a') as f: f.write(json.dumps(args)+'\\n')
ctl=json.load(open(home+'/control.json'))
if ctl.get('inspect_attempt'):
 with open(home+'/attempt.json','w') as f: json.dump(json.load(open(home+'/.local/state/blip/state.json'))['pendingReads'],f)
if ctl.get('fail'):
 print('imsg-read: Accessibility is not granted',file=sys.stderr); sys.exit(77)
data=json.load(open(home+'/remote.json'))
for r in data['chats']:
 if '--all' in args or r['chat']==args[1]:
  r['unread']=1 if '--unread' in args else 0
  r['oldest']=r['latest'] if r['unread'] else ''
with open(home+'/remote.json','w') as f: json.dump(data,f)
print('verified')
`, { mode: 0o755 });
  const statePath = join(home, ".local/state/blip/state.json");
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));
  const run = (...args: string[]) => {
    // HOME isolates the shims; the runtime dir isolates the live accelerator.
    const result = spawnSync(process.execPath, [join(import.meta.dir, "collector.ts"), "--deep", ...args], {
      encoding: "utf8", env: { ...process.env, HOME: home, XDG_RUNTIME_DIR: home }, timeout: 10000,
    });
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.error).not.toContain("TypeError");
    return out;
  };
  const actions = () => { try { return readFileSync(join(home, "actions.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  return { home, put, run, state, actions, save: (s: unknown) => writeFileSync(statePath, JSON.stringify(s)) };
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
  test("a prolonged Mac failure keeps the read intent and dot suppressed until recovery", () => {
    const f = fixture(); f.put("control.json", { fail: true });
    expect(f.run("--read", chat, "--seen", old).unread).toBe(0);
    for (let attempt = 2; attempt <= 7; attempt++) {
      const st = f.state(); st.pendingReads[chat].retryAt = 0; f.save(st);
      const out = f.run();
      expect(out.unread).toBe(0);
      expect(out.error).toContain("Accessibility");
      expect(f.state().pendingReads[chat]?.attempts).toBe(attempt);
    }
    // Polls during backoff neither reopen the dot nor hammer Messages.
    expect(f.run().unread).toBe(0);
    expect(f.actions()).toHaveLength(7);
    f.put("control.json", {});
    const st = f.state(); st.pendingReads[chat].retryAt = 0; f.save(st);
    expect(f.run().unread).toBe(0);
    expect(f.state().pendingReads).toEqual({});
    expect(f.run().unread).toBe(0);
    expect(f.actions()).toHaveLength(8);
  }, 15000);
  test("a newer inbound cancels a prolonged read retry and remains unread", () => {
    const f = fixture(); f.run();
    f.save({ ...f.state(), pendingReads: {
      [chat]: { unread: false, seen: old, attempts: 7, retryAt: 0 },
    } });
    f.put("remote.json", snapshot(1, recent));
    expect(f.run().unread).toBe(1);
    expect(f.state().pendingReads).toEqual({});
    expect(f.actions()).toHaveLength(0);
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
  test("unread queued after offline mark-all lands after mark-all", () => {
    const f = fixture(); f.put("control.json", { offline: true });
    f.run("--mark-read"); f.run("--mark-unread", chat);
    f.put("control.json", {}); f.run(); f.run();
    expect(f.actions()).toEqual([["--all"], ["--unread", chat]]);
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
  // 16 sequences x 6 collector spawns, each starting bun and several Python
  // shims: 10-16 s on an idle 16-core box, over 20 s with anything else running.
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
  }, 60000);
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


describe("failed mark-all recovery", () => {
  test("failed bulk reads survive polls and retry only bounded conversations", () => {
    const f = fixture(); f.run(); f.put("control.json", { fail: true });
    expect(f.run("--mark-read").unread).toBe(0);
    expect(f.state().pendingReads["*"].attempts).toBe(1);
    expect(f.run().unread).toBe(0);
    expect(f.state().pendingReads[chat].seen).toBe(old);
    expect(f.state().pendingReads["*"]).toBeUndefined();
    expect(f.actions()).toEqual([["--all"]]);
    let st = f.state(); st.pendingReads[chat].retryAt = 0; f.save(st);
    expect(f.run().unread).toBe(0);
    expect(f.actions()).toEqual([["--all"], ["--chat", chat, "--through", old]]);
    f.put("control.json", {});
    st = f.state(); st.pendingReads[chat].retryAt = 0; f.save(st);
    expect(f.run().unread).toBe(0);
    expect(f.state().pendingReads).toEqual({});
    expect(f.run().unread).toBe(0);
  }, 15000);

  test("messages arriving after a failed bulk read stay unread", () => {
    const f = fixture(); f.run(); f.put("control.json", { fail: true });
    f.run("--mark-read");
    const later = new Date(Date.now() + 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
    f.put("remote.json", snapshot(1, later));
    expect(f.run().unread).toBe(1);
    expect(f.state().pendingReads).toEqual({});
    expect(f.actions()).toEqual([["--all"]]);
  });

  test("without a snapshot a failed bulk action is retained but never repeated", () => {
    const f = fixture(); f.run();
    f.put("control.json", { fail: true, snapshot_fail: true });
    f.run("--mark-read");
    const st = f.state(); st.pendingReads["*"].retryAt = 0; f.save(st);
    f.run();
    expect(f.state().pendingReads["*"].attempts).toBe(1);
    expect(f.actions()).toEqual([["--all"]]);
    f.put("control.json", {}); f.run();
    expect(f.actions()).toEqual([["--all"], ["--chat", chat, "--through", old]]);
    expect(f.run().unread).toBe(0);
  });

  test("bounded fallback preserves newer explicit gestures and skips new activity", () => {
    const other = "+15557654321", alias = "reader@example.com", newer = "chat12345";
    const all = retryReadIntent(queueReadIntent({}, "*", false, recent)["*"]!, 1000, "locked");
    const pending = { "*": all, [alias]: { unread: true, seen: "", attempts: 0, retryAt: 0 } };
    const expanded = expandFailedMarkAll(pending, {
      [chat]: { unread: 2, oldest: old, latest: old },
      [other]: { unread: 1, oldest: old, latest: old, aliases: [alias] },
      [newer]: { unread: 1, oldest: recent, latest: "2026-09-01T12:00:00Z" },
    });
    expect(expanded).toEqual({ [chat]: { ...all, seen: old }, [alias]: pending[alias] });
    expect(pending["*"]).toBe(all);
  });
});


test("a business-thread bulk marker neither resurfaces nor blocks later gestures", () => {
  const f = fixture();
  const business = "urn:biz:00000000-0000-0000-0000-000000000000";
  const data = snapshot(1);
  data.chats.push({ chat: business, unread: 1, oldest: old, latest: old });
  f.put("remote.json", data); f.run();
  f.put("control.json", { fail: true }); f.run("--mark-read");
  expect(f.run().unread).toBe(0);
  expect(f.state().pendingReads["*"].attempts).toBe(1);
  expect(f.state().pendingReads[business]).toBeUndefined();
  const alreadyRead = snapshot(0);
  alreadyRead.chats.push({ chat: business, unread: 1, oldest: old, latest: old });
  f.put("remote.json", alreadyRead);
  f.put("control.json", {});
  expect(f.run("--mark-unread", chat).unread).toBe(1);
  expect(f.actions()).toEqual([["--all"], ["--unread", chat]]);
  expect(f.run().unread).toBe(1);
  const later = new Date(Date.now() + 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const fresh = snapshot(1); fresh.chats.push({ chat: business, unread: 1, oldest: old, latest: later });
  f.put("remote.json", fresh);
  expect(f.run().unread).toBe(2);
  expect(f.state().pendingReads["*"]).toBeUndefined();
});


test("a scoped bulk marker survives reload and cannot override other chats", () => {
  const business = "urn:biz:00000000-0000-0000-0000-000000000000";
  const marker = { unread: false, seen: recent, attempts: 1, retryAt: 0, chats: [business] };
  const parsed = parseReadIntents({ "*": marker });
  expect(parsed["*"]).toEqual(marker);
  expect(parseReadIntents({ "*": { ...marker, chats: ["bad\nidentifier"] } })).toEqual({});
  expect(parseReadIntents({ [chat]: marker })).toEqual({});
  expect(reconcileReadIntents(parsed, {
    [business]: { unread: 0, oldest: "", latest: old },
    [chat]: { unread: 1, oldest: old, latest: old },
  })).toEqual({});
  expect(expandFailedMarkAll(parsed, {
    [business]: { unread: 1, oldest: old, latest: old },
    [chat]: { unread: 1, oldest: old, latest: old },
  })).toEqual(parsed);
});


test("the bulk attempt is durable before the Mac action starts", () => {
  const f = fixture(); f.run();
  f.put("control.json", { inspect_attempt: true, fail: true });
  f.run("--mark-read");
  const atAction = JSON.parse(readFileSync(join(f.home, "attempt.json"), "utf8"));
  expect(atAction["*"].attempts).toBe(1);
  expect(atAction["*"].seen).not.toBe("");
});

test("an interrupted bulk action resumes with a bounded read, never another all", () => {
  const f = fixture(); f.run();
  const st = f.state();
  st.pendingReads = { "*": { unread: false, seen: recent, attempts: 1, retryAt: 0 } };
  f.save(st);
  expect(f.run().unread).toBe(0);
  expect(f.actions()).toEqual([["--chat", chat, "--through", old]]);
  expect(f.state().pendingReads).toEqual({});
});
