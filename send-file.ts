#!/usr/bin/env bun
/**
 * Blip file sender — ships one local file (plus optional caption) to a chat
 * through `imsg-send --file-stdin` on the Mac. Prints {ok, error} JSON.
 *
 *   bun send-file.ts <chat> <path> [caption...]
 *
 * Target resolution is centralized HERE, not re-derived in QML: a group chat
 * sends via its full AppleScript GUID from the collector's group cache and is
 * REFUSED when the guid is unknown — never a fallback to the handle (a
 * group's handle is whichever member spoke last; sending to it DMs one
 * person). The file crosses to the Mac on stdin: imsg-send accepts no Mac
 * filesystem paths, so a remote caller can never exfiltrate Mac files.
 */

import { bridgeFor, toolFile } from "./shim-path";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { openSync, readSync, closeSync, statSync } from "node:fs";
import { basename } from "node:path";
import { isGroupChat, loadState } from "./collector";

const HOME = process.env.HOME ?? homedir();
export const SEND_MAX_BYTES = 100 * 1024 * 1024;

export interface SendTarget { args: string[]; error: string }

/** ["--chat-id", guid] for a known group, ["--to", chat] for a DM. */
export function resolveTarget(
  chat: string,
  groups: Record<string, { guid?: string } | undefined>,
): SendTarget {
  if (isGroupChat(chat)) {
    const guid = groups[chat]?.guid ?? "";
    if (!guid) return { args: [], error: "group id unknown — refusing to send" };
    return { args: ["--chat-id", guid], error: "" };
  }
  return { args: ["--to", chat], error: "" };
}

export type TextSendPlan =
  | { ok: true; cmd: string; args: string[] }
  | { ok: false; error: string };

/** Argv for one text send. The body is not an argument.
 *  A group with no cached guid is a refusal, never `--to` the last speaker. */
export function planTextSend(
  chat: string,
  service: string,
  groups: Record<string, { guid?: string } | undefined>,
  binDir: string,
): TextSendPlan {
  const target = resolveTarget(chat, groups);
  if (target.error) return { ok: false, error: target.error };
  const sms = !target.args.includes("--chat-id") && /^(SMS|RCS)$/i.test(service)
    ? ["--service", service.toUpperCase()]
    : [];
  return {
    ok: true,
    cmd: toolFile(binDir, "imsg-send"),
    args: [...target.args, ...sms, "--yes", "--text-stdin", "--keep-dashes"],
  };
}

export interface SendFileResult { ok: boolean; online: boolean; error: string }

export function sendFile(
  chat: string,
  path: string,
  caption: string,
  runner = spawnSync,
  service = "",
): SendFileResult {
  const fail = (error: string, online = true): SendFileResult => ({ ok: false, online, error });

  let st;
  try {
    st = statSync(path);
  } catch {
    return fail(`no such file: ${path}`);
  }
  if (!st.isFile()) return fail("not a regular file");
  if (st.size === 0) return fail("file is empty");
  if (st.size > SEND_MAX_BYTES) return fail(`file exceeds ${SEND_MAX_BYTES} bytes`);

  const target = resolveTarget(chat, loadState().groups ?? {});
  if (target.error) return fail(target.error);

  // Read the whole file up front: the size is already capped, and handing
  // spawnSync a buffer keeps the stdin pipe binary-clean end to end.
  const fd = openSync(path, "r");
  let buf: Buffer;
  try {
    buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    if (off !== st.size) return fail("short read — file changed mid-send");
  } finally {
    closeSync(fd);
  }

  // Caption rides on stdin ahead of the file bytes (--text-stdin-bytes N), so
  // message text never appears in any process's argv on either machine.
  const cap = Buffer.from(caption.trim(), "utf8");
  const args = [
    ...target.args,
    // green-bubble threads go out on their own service, never silently as iMessage
    ...(!target.args.includes("--chat-id") && /^(SMS|RCS)$/i.test(service) ? ["--service", service.toUpperCase()] : []),
    "--file-stdin",
    "--name", basename(path),
    "--yes",
    "--file-bytes", String(buf.length),      // the Mac refuses a short stream (cut ssh) instead of sending a truncated file
    "--keep-dashes",                          // users' punctuation is theirs
    ...(cap.length > 0 ? ["--text-stdin-bytes", String(cap.length)] : []),
  ];
  const bridge = bridgeFor(chat, "imsg-send");
  const res = runner(bridge.cmd, [...bridge.args, ...args], { input: cap.length > 0 ? Buffer.concat([cap, buf]) : buf, timeout: 180000 });
  if (res.status === 69 || res.status === 255) return fail("Mac unreachable", false);
  if (res.status !== 0) {
    const err = (res.stderr || "").toString().trim().split("\n").pop() || `imsg-send exit ${res.status}`;
    return fail(err);
  }
  return { ok: true, online: true, error: "" };
}

if (import.meta.main) {
  const chat = process.argv[2] ?? "";
  const path = process.argv[3] ?? "";
  const svcIdx = process.argv.indexOf("--service");
  const service = svcIdx > 0 ? String(process.argv[svcIdx + 1] ?? "") : "";
  // Caption arrives on stdin (--caption-stdin) so it never sits in this process's argv.
  const caption = process.argv[4] === "--caption-stdin"
    ? readFileSync(0, "utf8")
    : process.argv.slice(4).join(" ");
  try {
    console.log(JSON.stringify(sendFile(chat, path, caption, undefined, service)));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, online: true, error: String(e) }));
  }
}
