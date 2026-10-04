// The bridge shim to spawn. Every Linux-side call to the Mac goes through here,
// so `bin_dir=` in bridge.conf moves all of them at once.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseBinDir } from "./bin-dir";
import { bridgeArgv, type BridgeTool } from "./source-id";

export type ShimTool = "imsg" | "imsg-send" | "imsg-read" | "imsg-react" | "contacts" | "contact-save";

/** The shim directory: `bin_dir=` in bridge.conf, default ~/bin. */
export function shimDir(home: string = process.env.HOME ?? homedir()): string {
  let conf = "";
  try { conf = readFileSync(`${home}/.config/blip/bridge.conf`, "utf8"); } catch { /* no conf: the default */ }
  return parseBinDir(conf, home);
}

/** CreateProcess runs `imsg.exe`. An extensionless file is ENOENT on Windows.
 *  Linux keeps the bare name the bash shim is installed as. */
export function toolFile(dir: string, tool: string): string {
  const path = `${dir}/${tool}`;
  return process.platform === "win32" ? `${path}.exe` : path;
}

export function shimPath(tool: ShimTool, home: string = process.env.HOME ?? homedir()): string {
  return toolFile(shimDir(home), tool);
}

/** What to spawn for `tool` on one conversation (or handle), routed by
 *  source-id.ts. In stock Blip this is always `{ cmd: shimPath(tool), args: [] }`,
 *  so a call site's argv is byte-identical to calling the shim directly. */
export function bridgeFor(
  chat: string,
  tool: BridgeTool,
  home: string = process.env.HOME ?? homedir(),
): { cmd: string; args: string[] } {
  const [cmd, ...args] = bridgeArgv(chat, tool, shimDir(home));
  const file = cmd && process.platform === "win32" && !cmd.endsWith(".exe") ? `${cmd}.exe` : cmd!;
  return { cmd: file, args };
}
