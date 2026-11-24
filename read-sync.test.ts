import { describe, expect, test } from "bun:test";
import { expandFailedMarkAll, readActionGraceMs } from "./collector";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { classifyReadSync, enqueueRefresh, isScreenLockedError, parseReadSnapshot, parseReadIntents, queueReadIntent, reconcileReadIntents, retryReadIntent, settleReadAction, parseReadAction, READ_ACTION_DEADLINE_MS } from "./read-sync";

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
import json,os,sys,time
home=os.environ['HOME']; args=sys.argv[1:]
with open(home+'/actions.jsonl','a') as f: f.write(json.dumps(args)+'\\n')
while json.load(open(home+'/control.json')).get('hang'): time.sleep(0.05)
ctl=json.load(open(home+'/control.json'))
if ctl.get('inspect_attempt'):
 with open(home+'/attempt.json','w') as f: json.dump(json.load(open(home+'/.local/state/blip/state.json'))['pendingReads'],f)
if ctl.get('locked'):
 print("imsg-read: the Mac's screen is locked, so System Events can reach no window; unlock it",file=sys.stderr); sys.exit(77)
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
  const extraEnv: Record<string, string> = {};
  const run = (...args: string[]) => {
    // HOME isolates the shims; the runtime dir isolates the live accelerator.
    const result = spawnSync(process.execPath, [join(import.meta.dir, "collector.ts"), "--deep", ...args], {
      encoding: "utf8", env: { ...process.env, HOME: home, XDG_RUNTIME_DIR: home, ...extraEnv }, timeout: 10000,
    });
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.error).not.toContain("TypeError");
    return out;
  };
  const actions = () => { try { return readFileSync(join(home, "actions.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  return { home, put, run, state, actions, extraEnv, save: (s: unknown) => writeFileSync(statePath, JSON.stringify(s)) };
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

  test("push_read=all never expands a failed mark-all into per-chat --chat runs", () => {
    const f = fixture(); f.run();
    writeFileSync(join(f.home, ".config/blip/bridge.conf"), "push_read=all\n");
    f.put("control.json", { fail: true });
    f.run("--mark-read");
    f.put("control.json", {});
    const st = f.state(); for (const k of Object.keys(st.pendingReads)) st.pendingReads[k].retryAt = 0; f.save(st);
    f.run(); f.run();
    expect(f.actions().every((a: string[]) => a[0] === "--all")).toBe(true);
    expect(f.actions().some((a: string[]) => a.includes("--chat"))).toBe(false);
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

describe("read sync status classification", () => {
  const lockedErr = "imsg-read: the Mac's screen is locked, so System Events can reach no window; unlock it";
  const snap = parseReadSnapshot(snapshot(0))!;

  test("identifies screen-locked errors without conflating permission errors", () => {
    expect(isScreenLockedError(lockedErr)).toBe(true);
    expect(isScreenLockedError("the Mac's screen is locked")).toBe(true);
    expect(isScreenLockedError("imsg-read: Accessibility is not granted")).toBe(false);
    expect(isScreenLockedError("")).toBe(false);
  });

  test("classifies locked and queued states as compact notices while hard errors stay errors", () => {
    expect(classifyReadSync({ persisted: true, remoteReads: snap, pendingReads: {}, syncError: "" }))
      .toEqual({ error: "", notice: null });
    expect(classifyReadSync({ persisted: false, remoteReads: snap, pendingReads: {}, syncError: "" }))
      .toEqual({ error: "state write failed; notifications paused", notice: null });
    expect(classifyReadSync({ persisted: true, remoteReads: null, pendingReads: {}, syncError: "" }))
      .toEqual({ error: "Read sync snapshot unavailable; update/check the Mac bridge", notice: null });

    const oneLocked = classifyReadSync({
      persisted: true,
      remoteReads: snap,
      pendingReads: { [chat]: { unread: false, seen: old, attempts: 1, retryAt: 5000, error: lockedErr } },
      syncError: lockedErr,
    });
    expect(oneLocked.error).toBe("");
    expect(oneLocked.notice?.reason).toBe("locked");
    expect(oneLocked.notice?.pending).toBe(1);
    expect(oneLocked.notice?.label).toBe("Read sync paused (1)");
    expect(oneLocked.notice?.detail).toContain("The Mac's screen is locked");

    const bulkLocked = classifyReadSync({
      persisted: true,
      remoteReads: snap,
      pendingReads: { "*": { unread: false, seen: old, attempts: 1, retryAt: 5000, error: lockedErr } },
      syncError: "",
    });
    expect(bulkLocked.error).toBe("");
    expect(bulkLocked.notice?.label).toBe("Read sync paused");

    const queuedNoErr = classifyReadSync({
      persisted: true,
      remoteReads: snap,
      pendingReads: {
        [chat]: { unread: false, seen: old, attempts: 0, retryAt: 0 },
        "+15557654321": { unread: false, seen: old, attempts: 0, retryAt: 0 },
      },
      syncError: "",
    });
    expect(queuedNoErr.error).toBe("");
    expect(queuedNoErr.notice).toEqual({
      pending: 2,
      reason: "pending",
      label: "Read sync pending (2)",
      detail: "2 read updates are queued and retrying automatically.",
    });

    const mixedHard = classifyReadSync({
      persisted: true,
      remoteReads: snap,
      pendingReads: {
        [chat]: { unread: false, seen: old, attempts: 1, retryAt: 5000, error: lockedErr },
        "+15557654321": { unread: false, seen: old, attempts: 1, retryAt: 5000, error: "imsg-read: Accessibility is not granted" },
      },
      syncError: "",
    });
    expect(mixedHard.error).toContain("Accessibility");
    expect(mixedHard.notice).toBeNull();

    const orphanSyncErr = classifyReadSync({
      persisted: true,
      remoteReads: snap,
      pendingReads: {},
      syncError: lockedErr,
    });
    expect(orphanSyncErr.error).toBe(lockedErr);
    expect(orphanSyncErr.notice).toBeNull();
  });

  test("locked Mac reports a compact readSync notice instead of a hard error and clears on unlock", () => {
    const f = fixture();
    f.put("control.json", { locked: true });
    const paused = f.run("--read", chat, "--seen", old);
    expect(paused.unread).toBe(0);
    expect(paused.error).toBe("");
    expect(paused.readSync).toMatchObject({
      pending: 1,
      reason: "locked",
      label: "Read sync paused (1)",
    });
    expect(paused.readSync.detail).toContain("screen is locked");

    // Subsequent poll during backoff keeps the compact notice without re-running imsg-read.
    const backoff = f.run();
    expect(backoff.error).toBe("");
    expect(backoff.readSync?.label).toBe("Read sync paused (1)");
    expect(f.actions()).toHaveLength(1);

    // Unlocking drains the queued read and clears the notice.
    f.put("control.json", {});
    const st = f.state(); st.pendingReads[chat].retryAt = 0; f.save(st);
    const cleared = f.run();
    expect(cleared.unread).toBe(0);
    expect(cleared.error).toBe("");
    expect(cleared.readSync).toBeUndefined();
    expect(f.state().pendingReads).toEqual({});
    expect(f.actions()).toHaveLength(2);
  });
});

describe("the read action runs off the poll path (#125 item 2)", () => {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  test("a hung imsg-read does not hold up polling, and its result is picked up later", async () => {
    const f = fixture(); f.run();
    f.extraEnv.BLIP_READ_GRACE_MS = "200";
    f.put("control.json", { hang: true });
    // Before this change the poll waited on imsg-read for up to 180 s (here, until
    // the harness killed it at 10 s and `run` failed on the exit status).
    let t = Date.now();
    const first = f.run("--read", chat, "--seen", old);
    expect(Date.now() - t).toBeLessThan(4000);
    expect(first.unread).toBe(0);
    expect(f.state().pendingReads[chat].attempts).toBe(1);
    // Polls while it hangs return at once, start nothing else, and keep the intent.
    t = Date.now();
    const second = f.run();
    expect(Date.now() - t).toBeLessThan(4000);
    expect(second.unread).toBe(0);
    expect(f.actions()).toHaveLength(1);
    expect(f.state().pendingReads[chat]).toBeDefined();
    // The Mac answers; the next poll folds the result in and retires the intent.
    f.put("control.json", {});
    const marker = join(f.home, ".local/state/blip/read-action.json");
    for (let i = 0; i < 100 && !(existsSync(marker) && JSON.parse(readFileSync(marker, "utf8")).done); i++) await sleep(50);
    expect(JSON.parse(readFileSync(marker, "utf8")).done.ok).toBe(true);
    f.run();
    expect(f.state().pendingReads).toEqual({});
    expect(existsSync(marker)).toBe(false);
    expect(f.actions()).toHaveLength(1);
  }, 20000);

  test("a failure that ends after the poll left is kept with its error and retried", async () => {
    const f = fixture(); f.run();
    f.extraEnv.BLIP_READ_GRACE_MS = "0";
    f.put("control.json", { hang: true, fail: true });
    f.run("--read", chat, "--seen", old);
    f.put("control.json", { fail: true });
    const marker = join(f.home, ".local/state/blip/read-action.json");
    for (let i = 0; i < 100 && !(existsSync(marker) && JSON.parse(readFileSync(marker, "utf8")).done); i++) await sleep(50);
    const out = f.run();
    expect(out.error).toContain("Accessibility");
    expect(f.state().pendingReads[chat].attempts).toBe(1);
    expect(f.state().pendingReads[chat].error).toContain("Accessibility");
    expect(existsSync(marker)).toBe(false);
  }, 20000);

  test("grace period is bounded and configurable", () => {
    expect(readActionGraceMs({})).toBe(5000);
    expect(readActionGraceMs({ BLIP_READ_GRACE_MS: "250" })).toBe(250);
    expect(readActionGraceMs({ BLIP_READ_GRACE_MS: "-1" })).toBe(5000);
    expect(readActionGraceMs({ BLIP_READ_GRACE_MS: "junk" })).toBe(5000);
    expect(readActionGraceMs({ BLIP_READ_GRACE_MS: "9999999" })).toBe(60000);
  });
});

describe("settleReadAction", () => {
  const a = { chat, unread: false, seen: old, startedAt: 1000 };
  const pend = { [chat]: { unread: false, seen: old, attempts: 1, retryAt: 3000 } };
  test("a running action changes nothing and blocks the next", () => {
    expect(settleReadAction(pend, a, 5000)).toEqual({ pending: pend, settled: false, error: "" });
  });
  test("success retires the intent", () => {
    const r = settleReadAction(pend, { ...a, done: { ok: true, error: "", at: 2000 } }, 5000);
    expect(r).toEqual({ pending: {}, settled: true, error: "" });
  });
  test("failure keeps the intent, with backoff counted from when the action ended", () => {
    const r = settleReadAction(pend, { ...a, done: { ok: false, error: "imsg-read: Accessibility is not granted", at: 181000 } }, 182000);
    expect(r.settled).toBe(true);
    expect(r.error).toContain("Accessibility");
    expect(r.pending[chat]).toMatchObject({ attempts: 1, retryAt: 183000 });
    expect(r.pending[chat]!.error).toContain("Accessibility");
  });
  test("a worker that never reports is a failure after the deadline, never a lost intent", () => {
    expect(settleReadAction(pend, a, 1000 + READ_ACTION_DEADLINE_MS).settled).toBe(false);
    const r = settleReadAction(pend, a, 1001 + READ_ACTION_DEADLINE_MS);
    expect(r.settled).toBe(true);
    expect(r.pending[chat]).toBeDefined();
    expect(r.pending[chat]!.error).toContain("did not finish");
  });
  test("a result for an intent a newer gesture replaced is ignored", () => {
    const newer = { [chat]: { unread: true, seen: "", attempts: 0, retryAt: 0 } };
    const r = settleReadAction(newer, { ...a, done: { ok: true, error: "", at: 2000 } }, 5000);
    expect(r).toEqual({ pending: newer, settled: true, error: "" });
  });
  test("parseReadAction rejects junk and strips control characters", () => {
    expect(parseReadAction({ chat: "", unread: false, seen: "", startedAt: 1 })).toBeNull();
    expect(parseReadAction({ chat, unread: "no", seen: "", startedAt: 1 })).toBeNull();
    expect(parseReadAction({ ...a, done: { ok: true, error: "x\u0007y", at: 1 } })!.done!.error).toBe("x y");
  });
});
