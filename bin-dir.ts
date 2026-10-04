// Where the Linux-side bridge shims live: `bin_dir=` in bridge.conf, default ~/bin.
// Pure (no fs) so the QML renderer and the TypeScript spawners agree on one answer.
// Rebuild the QML module: bun build bin-dir.ts --target browser --format esm --outfile BinDir.mjs

/** The shim directory named by bridge.conf text. Parsed, never sourced:
 *  whitespace is dropped (as the shim drops it), quotes stripped, and `~`,
 *  `~/…`, `$HOME/…`, `${HOME}/…` expand to `home`. Anything that is not then a
 *  plain absolute path (no `..`, no shell characters) means the default. */
export function parseBinDir(conf: string, home: string): string {
  const fallback = home + "/bin";
  const m = /^[ \t]*bin_dir[ \t]*=[ \t]*(.*?)[ \t]*$/m.exec(String(conf || ""));
  if (!m) return fallback;
  let v = m[1]!.replace(/\s+/g, "").replace(/^(['"])(.*)\1$/, "$2");
  if (v === "~" || v === "$HOME" || v === "${HOME}") v = home;
  else {
    const pre = /^(~|\$HOME|\$\{HOME\})\//.exec(v);
    if (pre) v = home + v.slice(pre[1]!.length);
  }
  v = v.replace(/[\/\\]+$/, "");
  // A `..` segment is rejected on either slash. `foo..bar` is a name, not a climb.
  if (/(^|[\\/])\.\.([\\/]|$)/.test(v)) return fallback;
  if (/^\/[A-Za-z0-9._\/-]+$/.test(v)) return v;
  // CreateProcess and bridge.conf on Windows use a drive path. The unix rule
  // would ignore `bin_dir` and fall back to ~/bin.
  if (/^[A-Za-z]:[\\/][A-Za-z0-9._\\/-]+$/.test(v)) return v;
  return fallback;
}
