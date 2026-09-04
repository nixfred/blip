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
| 2 | critical | Any ssh login to the Mac account inherits Full Disk Access + Automation | **Fixed** 1.10.0 — `blip-setup` enrols `~/.ssh/blip_ed25519` on the Mac as `restrict,command="$HOME/.blip/bin/blip-dispatch"`; that key can run only the five bridge tools (no shell, no forwarding, no pty), with its own ssh mux so it never rides the general key's master |
| 3 | critical | `qs ipc … compose --yes` / `goto` / `bubbles` let any local process send or read | **Mitigated** 1.10.0 — `goto`/`compose`/`bubbles`/`threads`/`find`/`newchat`/`windowgoto`/`read` require `automation=on` in `bridge.conf` (default off; live-reloaded). Honest scope: this closes the *shell-IPC* deputy only. Any process running as you can still call `~/bin/imsg-send` directly, exactly as it could run `ssh` — that boundary is your user account, not Blip. `status`/`open`/`close`/`toggle`/`window`/`app` expose nothing and stay open |
| 4 | high | Bodies travel in argv (Linux `/proc`, Mac `osascript -e`) and `imsg-send` echoed 120 chars of body to stderr | **Fixed** 1.9.4 (stderr) + 1.11.0: bodies ride stdin end to end — `--text-stdin` / `--text-stdin-bytes N` (caption ahead of file bytes), and `osascript` reads its script from stdin. Only `notify-send` toasts still carry a preview in argv, by the daemon's design |
| 5 | high | Stale contact/search result shown as clickable rows under a newer query | **Fixed** 1.9.4 — generation bumps when a query is queued, results cleared |
| 6 | high | Group GUIDs are trusted from state/bridge | Accepted — same trust as #1; the Mac resolves them anyway |
| 7 | high | `bridge.conf` was `source`d; a hostile `host=` runs shell | **Fixed** 1.9.4 — parsed key=value, three keys only, `[user@]host` validated, `ssh --` |
| 8 | high | Contact names keyed by last ten digits can show the wrong person | **Fixed** 1.9.4 — collisions resolve to *no* name (raw handle shown) |
| 9 | medium | Auto-download trusted claimed size, not actual bytes | **Fixed** 1.9.4 — auto jobs carry a hard 5 MB transfer cap |
| 10 | medium | Clicked attachments went straight to `xdg-open` regardless of type | **Fixed** 1.9.4 — only image/video/audio/pdf/text/vcard/ics open; others are saved and named |
| 11 | medium | Symlink in cache followed; `window.json.tmp` could be 0644 | **Fixed** 1.9.4 — `lstat`+regular-file check; `umask 077` |
| 12 | medium | Catch-up fetch doubled without bound | **Fixed** 1.9.4 — capped at 8192 rows |

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

## Identity resolver boundary (2026-09-02)

Ambiguous Contacts matches remain fail-closed: the bridge returns no guessed
name. The settings resolver is a separate, explicit path with these limits:

- Linux request stdin: 4 KiB; local `identities.json`: 48 KiB, 64 choices,
  320 characters per handle, 160 per name; helper output: 48 KiB.
- Mac scan: 64 Contacts account stores, 64 matching records, eight distinct
  candidate names; a selected comparison is limited to eight active cards and
  16 values per field kind; response: 48 KiB; Linux bridge deadline is 15
  seconds for lookup/open and 35 seconds for Contacts automation.
- Controls and bidirectional overrides are removed before display; QML checks
  the bounded helper schema again before retaining it.
- The handle crosses the process/ssh boundary on stdin, never argv. A choice
  is revalidated against a fresh Mac candidate set before the owner-only,
  descriptor-relative atomic config write.
- **Open card on Mac** accepts only a revalidated opaque per-card token and
  invokes `/usr/bin/open` with a percent-encoded `addressbook://` persistent id
  via a fixed argument array. Source UUIDs and record ids stay on the Mac. It
  never writes Apple’s private SQLite stores.
- Candidate cards are intersected with the current Contacts object layer, so
  inactive per-account cache rows are not presented as editable contacts.
- Candidate and audit responses carry only bounded, sanitized display fields
  with opaque card tokens; raw source and record identifiers stay on the Mac.
  The QML layer revalidates the full schema before rendering it as plain text.
The Bun and Python suites exercise malformed types, oversize sentinels,
symlinks, FIFOs, equivalent-handle collisions, hostile display fields,
stdin-not-argv transport, candidate caps, and the fixed open argument shape.
