/** Durable single-slot action mailbox. Only the collector writes state.json.
 * The worker writes a result tagged with the request id, never collector state.
 * flock excludes duplicate workers after a collector/shell restart.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { shimPath } from "./shim-path";
import { retryReadIntent, type ReadIntents } from "./read-sync";

interface Job { id: string; chat: string; intentId: string; args: string[] }
interface Result { id: string; ok: boolean; cancelled?: boolean; error: string }
const directory = (home: string) => join(home, ".local/state/blip/read-worker");
function read<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}
function readJob(dir: string): Job | null {
  const v = read<Job>(join(dir, "job.json"));
  return v && typeof v.id === "string" && typeof v.chat === "string" && typeof v.intentId === "string" &&
    Array.isArray(v.args) && v.args.length <= 8 && v.args.every(a => typeof a === "string" && a.length <= 512) ? v : null;
}
function readResult(dir: string): Result | null {
  const v = read<Result>(join(dir, "result.json"));
  return v && typeof v.id === "string" && typeof v.ok === "boolean" && typeof v.error === "string" ? v : null;
}
function atomic(path: string, value: unknown) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, path);
}

/** A result for a superseded gesture cannot acknowledge the current gesture. */
export function finishReadJob(pending: ReadIntents, job: Job, result: Result): ReadIntents {
  if (result.id !== job.id || pending[job.chat]?.id !== job.intentId) return pending;
  const next = { ...pending };
  if (result.ok || result.cancelled) delete next[job.chat];
  else next[job.chat] = retryReadIntent(next[job.chat]!, Date.now(), result.error);
  return next;
}

export function readWorkerState(home: string, pending: ReadIntents) {
  const dir = directory(home);
  const job = readJob(dir);
  const result = readResult(dir);
  const completed = job && result?.id === job.id;
  return { pending: completed ? finishReadJob(pending, job, result!) : pending,
    notice: completed && result?.cancelled ? result.error : "",
    busy: !!job && !completed, completed: completed ? job.id : "" };
}

/** Called only after the collector commits the updated pending intents. */
export function scheduleReadJob(home: string, pending: ReadIntents, completed = ""): void {
  const dir = directory(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let job = readJob(dir);
  if (job && completed === job.id) {
    unlinkSync(join(dir, "job.json"));
    try { unlinkSync(join(dir, "result.json")); } catch {}
    job = null;
  }
  if (!job) {
    const due = Object.entries(pending).filter(([chat, r]) => r.retryAt <= Date.now() && r.id &&
      (chat !== "*" || r.throughRow !== undefined) && (r.action || r.unread || r.seen))
      .sort((a, b) => a[1].retryAt - b[1].retryAt)[0];
    if (!due) return;
    const [chat, intent] = due;
    // Legacy unbounded reads are never dispatched by this worker.
    if ((chat === "*" && intent.throughRow === undefined) || !intent.id || (!intent.action && !intent.unread && !intent.seen)) return;
    job = { id: randomUUID(), chat, intentId: intent.id,
      args: intent.action ? [`--${intent.action}`, chat.slice(chat.indexOf("|") + 1)] : chat === "*" ? ["--all", "--through", intent.seen, "--through-row", String(intent.throughRow)]
        : [intent.unread ? "--unread" : "--chat", chat,
          ...(!intent.unread ? ["--through", intent.seen] : [])] };
    atomic(join(dir, "job.json"), job);
  }
  // Re-launching a busy job is harmless: flock exits immediately while its
  // existing worker owns the lock. This also recovers a crashed worker.
  const child = spawn("flock", ["-n", join(dir, "lock"), process.execPath,
    join(import.meta.dir, "read-worker.ts"), home], { detached: true, stdio: "ignore" });
  child.on("error", () => {}); // durable job is retried by the next poll
  child.unref();
}

if (import.meta.main) {
  const home = process.argv[2]!;
  const dir = directory(home);
  const job = readJob(dir);
  if (job && readResult(dir)?.id !== job.id) {
    const state = read<{ pendingReads?: ReadIntents }>(join(home, ".local/state/blip/state.json"));
    // A queued job may have been superseded before flock could start us.
    if (state?.pendingReads?.[job.chat]?.id !== job.intentId) {
      atomic(join(dir, "result.json"), { id: job.id, ok: true, error: "" });
      process.exit(0);
    }
    let result: Result;
    try {
      const r = spawnSync(shimPath("imsg-read", home), job.args,
        { encoding: "utf8", timeout: 180000, maxBuffer: 65536 });
      result = { id: job.id, ok: r.status === 0, cancelled: r.status === 76, error: r.status === 0 ? "" :
        String(r.stderr || r.stdout || "Mac read action failed").replace(/[\x00-\x1f\x7f]/g, " ").slice(-240) };
    } catch { result = { id: job.id, ok: false, error: "Mac read action could not start" }; }
    atomic(join(dir, "result.json"), result);
    try {
      const log = join(home, ".local/state/blip/push-read.log");
      appendFileSync(log, `${new Date().toISOString()} ${job.args.join(" ")} ${result.ok ? "verified" : result.error}\n`, { mode: 0o600 });
      const contents = readFileSync(log, "utf8");
      if (contents.length > 65536) writeFileSync(log, contents.split("\n").slice(-101).join("\n"), { mode: 0o600 });
    } catch { /* result is durable even if diagnostics cannot be saved */ }
  }
}
