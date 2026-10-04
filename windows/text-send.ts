#!/usr/bin/env bun
// One text send. The body stays on stdin. Argv comes from planTextSend.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { loadState } from "../collector";
import { planTextSend } from "../send-file";
import { shimDir } from "../shim-path";

function arg(flag: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? String(process.argv[i + 1] ?? "") : "";
}

function report(ok: boolean, online: boolean, error: string): void {
  console.log(JSON.stringify({ ok, online, error }));
}

if (import.meta.main) {
  const chat = arg("--chat");
  const service = arg("--service");
  const body = readFileSync(0);
  if (!chat) {
    report(false, true, "missing chat");
  } else {
    const plan = planTextSend(chat, service, loadState().groups ?? {}, shimDir());
    if (!plan.ok) {
      report(false, true, plan.error);
    } else {
      const res = spawnSync(plan.cmd, plan.args, { input: body, timeout: 180000, maxBuffer: 1024 * 1024 });
      if (res.error) report(false, false, "cannot run send");
      else if (res.status === 69 || res.status === 255) report(false, false, "Mac unreachable");
      else if (res.status !== 0) {
        const line = String(res.stderr || "").trim().split(/\r?\n/).pop() || `imsg-send exit ${res.status}`;
        report(false, true, line.slice(0, 180));
      } else report(true, true, "");
    }
  }
}
