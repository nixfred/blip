// The bridge shim to spawn. Every Linux-side call to the Mac goes through here,
// so `bin_dir=` in bridge.conf moves all of them at once.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseBinDir } from "./bin-dir";
import { bridgeArgv, type BridgeTool } from "./source-id";

export type ShimTool = "imsg" | "imsg-send" | "imsg-read" | "imsg-react" | "imsg-reply" | "contacts" | "contact-save";

/** The shim directory: `bin_dir=` in bridge.conf, default ~/bin. */
export function shimDir(home: string = process.env.HOME ?? homedir()): string {
  let conf = "";
  try { conf = readFileSync(`${home}/.config/blip/bridge.conf`, "utf8"); } catch { /* no conf: the default */ }
  return parseBinDir(conf, home);
}

export function shimPath(tool: ShimTool, home: string = process.env.HOME ?? homedir()): string {
  return `${shimDir(home)}/${tool}`;
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
  return { cmd: cmd!, args };
}
