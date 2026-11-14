// Which bridge answers for a conversation. Blip ships ONE source, the Mac, and
// every conversation id routes to it — iMessage is the only source Blip ships,
// tests and answers bug reports for. The seam exists so a fork can add a second
// source by adding an entry to EXTRA_SOURCES, without re-deriving a spawn at
// every call site (#70). It is not a plugin system and carries no guarantees
// beyond "stock Blip resolves exactly as it did before".
//
// Pure (no fs) so the QML renderer and the TypeScript spawners agree on one
// answer. Rebuild the QML module:
//   bun build source-id.ts --target browser --format esm --outfile SourceId.mjs

/** The Mac-side tools a conversation is read, sent, marked read and
 *  tapbacked through. */
export type BridgeTool = "imsg" | "imsg-send" | "imsg-read" | "imsg-react" | "imsg-reply";

export interface Source {
  /** Stable lowercase name, e.g. "imessage". */
  readonly id: string;
  /** True when this source answers for the conversation (or handle) id. */
  owns(chat: string): boolean;
  /** The argv a caller puts IN FRONT of its own arguments, given the shim dir. */
  argv(tool: BridgeTool, binDir: string): string[];
}

/** The Mac bridge: the shim of the same name in `bin_dir`. Owns every id no
 *  other source claims, which in stock Blip is every id. */
export const IMESSAGE: Source = {
  id: "imessage",
  owns: () => true,
  argv: (tool, binDir) => [`${binDir}/${tool}`],
};

/** Consulted in order, before iMessage. Empty in Blip. */
export const EXTRA_SOURCES: readonly Source[] = [];

export function sourceFor(chat: string, extra: readonly Source[] = EXTRA_SOURCES): Source {
  const id = String(chat || "");
  for (const s of extra) if (s.owns(id)) return s;
  return IMESSAGE;
}

/** The argv prefix for `tool` on `chat`. Callers append exactly the arguments
 *  they passed before, so a source that is one program with subcommands and a
 *  source that is three programs look the same from the call site. */
export function bridgeArgv(
  chat: string,
  tool: BridgeTool,
  binDir: string,
  extra: readonly Source[] = EXTRA_SOURCES,
): string[] {
  return sourceFor(chat, extra).argv(tool, binDir);
}
