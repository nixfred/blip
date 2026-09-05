#!/usr/bin/env bash
# Refresh bridge/mac from a pinned claude-on-mac revision.
#
# claude-on-mac (github.com/nixfred/claude-on-mac) stays the general Mac
# toolkit; Blip vendors an exact copy so the plugin is ONE source for users.
#
#   scripts/sync-bridge.sh <sha-or-tag>      # e.g. scripts/sync-bridge.sh v1.11.0
set -euo pipefail
rev="${1:?usage: sync-bridge.sh <sha-or-tag>}"
repo="https://raw.githubusercontent.com/nixfred/claude-on-mac/$rev/bin"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="$here/bridge/mac"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for t in imsg imsg-send contacts tcc-check; do
  curl -fsSL "$repo/$t" -o "$tmp/$t"
  head -1 "$tmp/$t" | grep -q python3 || { echo "sync-bridge: $t from $rev does not look like a tool" >&2; exit 1; }
  python3 -c "import ast,sys; ast.parse(open('$tmp/$t').read())"
  # Blip carries local fixes in these files (rich links, avatars, sent store…).
  # Never overwrite silently: stage the upstream copy beside it for a diff.
  if [[ -f "$dest/$t" ]] && ! cmp -s "$tmp/$t" "$dest/$t"; then
    install -m 0644 "$tmp/$t" "$dest/$t.upstream"
    echo "• $t differs from $rev — upstream copy left at bridge/mac/$t.upstream (diff, merge, delete)"
    continue
  fi
  install -m 0755 "$tmp/$t" "$dest/$t"
done
printf 'claude-on-mac %s (synced %s)\nvendored: imsg imsg-send contacts tcc-check\nblip extensions: NONE after sync; reapply pin-order and identity-resolver patches\nsync: scripts/sync-bridge.sh <sha-or-tag>\n' \
  "$rev" "$(date +%F)" > "$here/bridge/BRIDGE-VERSION"
echo "! Reapply the Blip pin-order and identity-resolver extensions named in bridge/BRIDGE-VERSION before committing." >&2
echo "✓ bridge/mac synced to claude-on-mac $rev"
git -C "$here" status --short bridge/
