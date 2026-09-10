# Security — threat model and the 2026-08-31 audit

Blip's trust boundary is simple and worth stating plainly: **the Mac is part
of the trusted computing base.** It holds your Messages history, your
Contacts, and the Automation grant that sends. A compromised Mac can read,
alter, fabricate, or redirect everything Blip shows or sends, and no
Linux-side code can change that. If the Mac is ever compromised: disconnect
it, rotate the ssh key, reinstall the bridge on a clean machine.

The threats Blip *does* defend against are: a hostile sender (attachments,
message bodies, names), a corrupted or stale local state file, a bad
`bridge.conf`, and mistakes in the client that would send to the wrong person.

## Codex audit, 2026-08-31 (read-only, full repo, 178k tokens)

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | critical | A hostile Mac is unsatisfiable as a threat | **Documented** above — by design |
| 2 | critical | Any ssh login to the Mac account inherits Full Disk Access + Automation | **Fixed** 1.10.0 — `blip-setup` enrols `~/.ssh/blip_ed25519` on the Mac as `restrict,command="$HOME/.blip/bin/blip-dispatch"`; that key can run only the bridge tools (no shell, no forwarding, no pty), with its own ssh mux so it never rides the general key's master |
| 3 | critical | `qs ipc … compose --yes` / `goto` / `bubbles` let any local process send or read | **Mitigated** 1.10.0 — `goto`/`compose`/`bubbles`/`threads`/`find`/`newchat`/`windowgoto`/`read` require `automation=on` in `bridge.conf` (default off; live-reloaded). Honest scope: this closes the *shell-IPC* deputy only. Any process running as you can still call `~/bin/imsg-send` directly, exactly as it could run `ssh` — that boundary is your user account, not Blip. `status`/`open`/`close`/`toggle`/`window`/`app` expose nothing and stay open |
| 4 | high | Bodies travel in argv (Linux `/proc`, Mac `osascript -e`) and `imsg-send` echoed 120 chars of body to stderr | **Fixed** 1.9.4 (stderr) + 1.11.0: bodies ride stdin end to end — `--text-stdin` / `--text-stdin-bytes N` (caption ahead of file bytes), and `osascript` reads its script from stdin. Only `notify-send` toasts still carry a preview in argv, by the daemon's design — and a link you CLICK reaches `xdg-open` and your browser as an argument, because that is the only way to open one |
| 5 | high | Stale contact/search result shown as clickable rows under a newer query | **Fixed** 1.9.4 — generation bumps when a query is queued, results cleared |
| 6 | high | Group GUIDs are trusted from state/bridge | Accepted — same trust as #1; the Mac resolves them anyway |
| 7 | high | `bridge.conf` was `source`d; a hostile `host=` runs shell | **Fixed** 1.9.4 — parsed key=value, three keys only, `[user@]host` validated, `ssh --` |
| 8 | high | Contact names keyed by last ten digits can show the wrong person | **Fixed** 1.9.4 — collisions resolve to *no* name (raw handle shown) |
| 9 | medium | Auto-download trusted claimed size, not actual bytes | **Fixed** 1.9.4 — auto jobs carry a hard 5 MB transfer cap |
| 10 | medium | Clicked attachments went straight to `xdg-open` regardless of type | **Fixed** 1.9.4 — only image/video/audio/pdf/text/vcard/ics open; others are saved and named |
| 11 | medium | Symlink in cache followed; `window.json.tmp` could be 0644 | **Fixed** 1.9.4 — `lstat`+regular-file check; `umask 077` |
| 12 | medium | Catch-up fetch doubled without bound | **Fixed** 1.9.4 — capped at 8192 rows |
| 13 | medium | A copy of `blip_ed25519` works from any machine — the confinement protects the Mac, not the messages | **Fixed** Unreleased — over Tailscale `blip-setup` pins the key with `from=<this node's addresses>` (both families); a leaked key file is refused from anywhere else. A LAN address is not an identity, so there the key is left unpinned (manual pin below). The Blip key cannot re-enrol itself: `blip-setup` needs the everyday key, which is a shell anyway |

Your everyday ssh key to the Mac still carries Full Disk Access (that grant is per
`sshd-keygen-wrapper`, not per key) — Blip just no longer *needs* it.

Privacy-inventory items from the same audit are folded into
[PRIVACY.md](PRIVACY.md).

## War room, 2026-09-01 (ten expert lenses, 114 findings, 2.1.0)

Fixed in 2.1.0: attachment-cache eviction had silently stopped (missing
import); a DM thread admitted that person's group messages; file-send
captions rode argv; a cut ssh stream could deliver a truncated file (now an
exact byte count is enforced on the Mac); the cache file extension now
follows the gated MIME type, not the sender's filename; link cards refuse
userinfo host-spoofing; `tcc-check` is no longer reachable through the
confined key; `blip-setup` no longer sources `bridge.conf`, no longer echoes
a message body, and diagnoses a missing Xcode CLT; transient bridge
failures no longer poison the avatar negative cache; the consent banner no
longer logs recipients into journald; a real phone number was removed from
a test fixture. Deferred items are listed in ROADMAP.md.

Still open and honest about it: drafts in `$XDG_RUNTIME_DIR/blip` are swept
lazily rather than deleted on cancel; cache file names include the Mac
attachment ROWID.

## Hardening by hand

- **Pin the Blip key on a LAN.** `blip-setup` pins the key (`from=`) only when
  the Mac is reached over Tailscale, where the address is a stable per-node
  identity (finding 13). On a LAN, give the Linux box a reserved address and
  prepend `from="192.168.1.0/24",` (or the one address) to the key's line in
  `~/.ssh/authorized_keys` on the Mac; a re-run of `blip-setup` rewrites that
  line, so re-add it afterwards.
- **Or close port 22 one layer down.** On a tailnet, an ACL that lets only the
  Blip node reach the Mac's port 22 protects every key on that Mac, not just
  Blip's, and needs no `from=` at all.

## Read-only contact review

`contact-review.ts` bounds request stdin and helper output to 48 KiB, validates
Mac responses, and supplies plain display rows to QML. The Mac response cap is
also 48 KiB; lookups/open time out after 15 seconds and scans after 35 seconds.
Candidates are capped at eight names and 64 source cards; scans at 200 distinct
handles. Control and bidirectional characters are removed before display.

The bridge accepts only candidates, fingerprint, audit, and exact-card open.
Handles and opaque tokens travel through stdin. Opening a card revalidates it
and calls `/usr/bin/open` with a fixed argument array; private database IDs stay
on the Mac. No contact mutation or compiled Swift helper is introduced.

The optional scan cache is bounded to 512 KiB and accessed through no-follow,
nonblocking descriptors with owner/type checks. Writes use a private staging
file and descriptor-relative atomic rename. It holds contact summaries, never
messages, and requires matching handle-set and live store fingerprints before
reuse. It is a cache, not user configuration.

## Draft contact write boundary

The optional `contact-management.ts` helper accepts bounded stdin requests.
Writes require `contact_writes=on` in owner-controlled `bridge.conf` plus an
independent Mac write gate. Preview/apply uses exact card tokens, content
revisions and plan hashes; only validated native operations reach Contacts.
The optional Swift helper performs Contacts-framework mutations. The Apple
UI handoff pins the selected cards and the exact enabled Link/Merge action,
requiring Automation and Accessibility. Undo receipts stay private on the Mac.

This draft still needs Mac integration validation of mutation failure and
recovery behavior before merge. Linux checks use synthetic fixtures only.
