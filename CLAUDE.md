# Blip — agent notes

Blip is an Omarchy (QuickShell/QML) bar plugin that puts iMessage on Linux by
treating a Mac as the gateway. Read this before touching anything.

## Shape

```
(Mac side)    bridge/mac/           VENDORED from claude-on-mac (pin in bridge/BRIDGE-VERSION; refresh with
              imsg imsg-send        scripts/sync-bridge.sh <rev>). Installed to ~/.blip/bin on the Mac by
              contacts tcc-check    bridge/mac/install.sh. Blip is ONE source for release (Fred's rule).
              blip-dispatch         forced-command gate for ~/.ssh/blip_ed25519: only the five tools run.
                                    imsg: sqlite read of chat.db, `--rich` (tapbacks/read_at/reply_to/
                                    attachments/error), `watch`, `attachment`, `chats`; Recently Deleted hidden.
(Linux side)  bridge/linux/blip-shim installed as ~/bin/{imsg,imsg-send,contacts} by scripts/blip-setup;
                                    reads ~/.config/blip/bridge.conf (host=, remote_bin='$HOME/.blip/bin'
                                    — single-quoted, expands on the MAC). `ssh -n` preflight; exit 69 offline.
                                    Blip only ever calls ~/bin/imsg*. No hostnames in code, ever.
collector.ts                        poll → {threads, unread, toast}. Pure functions + one spawn.
thread.ts                           one conversation → decorated bubbles. Pure + one spawn.
fetch.ts                            attachment id → ~/.cache/blip/att (0700/0600, 500MB LRU).
send-file.ts                        local file + caption → imsg-send --file-stdin --text-stdin-bytes N
                                    (caption ahead of the bytes; NO message text in argv anywhere). Resolves
                                    group guid from state; REFUSES unknown groups.
avatar.ts                           handle → ~/.cache/blip/avatars (imsg avatar; JPEG/PNG magic
                                    checked; .none negative marker; 7-day TTL).
paste.ts                            clipboard snapshot → draft image in $XDG_RUNTIME_DIR/blip or text.
BarWidget.qml                       the single poller, badge, toasts, IPC.
Panel.qml                           list view + conversation view + compose. Renders only.
manifest.json                       plugin id nixfred.blip
```

Logic lives in TypeScript where it can be unit-tested (`bun test`). QML renders
what it is handed. Keep it that way.

## Invariants — do not break

- **Never send to a handle for a group.** A group thread's `handle` is whichever
  member spoke last. `isSendable()` tests the *chat* id; groups send
  `--chat-id <full guid>` (`any;+;<32hex>`, or `<Service>;+;chat<digits>` on
  Macs that keep one chat row per service — `imsg groups` returns ONE row per
  identifier, the newest, so an empty shell never wins; #8), DMs send `--to <chat>`.
- **Two read marks.** `watermark` = what the collector has seen (drives toasts).
  `readMark` / `readMarks[chat]` = what the user has looked at (drives the badge
  and the blue dots). Collapsing them makes the badge flash and reset.
- **Unread = BOTH sides agree** (1.3.2): Apple-side `is_read`=0 (imsg ≥1.9.0
  `read`; phone-synced via Messages in iCloud) AND newer than the local mark.
  Phone-read clears Blip within a poll; Blip-read clears locally only.
  Tapback rows and the self-thread never count (no Apple client badges them).
  chat.db carries GHOST is_read=0 rows years old — never trust is_read alone.
- **Read marks are per-chat, clamped to now, and --seen-based.** A message
  can carry a FUTURE timestamp (tz skew); a mark taken from the global max
  once suppressed unrelated threads until "tomorrow". The panel passes the
  newest VISIBLE ts (`--seen`) so mid-round-trip arrivals stay unread.
- **Reads are optimistic-with-suppression.** Persistent read state moves only
  via collector runs (~1 s), so BarWidget applies reads to the local model
  IMMEDIATELY and remembers them in `localReads[chat]` (thread last_ts at
  read time, 60 s TTL). Every collector result is filtered through that
  ledger — a poll in flight when the user opened a thread must not resurrect
  the dot for one round-trip. A chat only shows unread again when a NEWER
  inbound exists. Refreshes carry `activeReadChat()` so a message landing in
  the conversation being READ is counted read in the same run — never
  flashed. Same-chat read refreshes coalesce in the queue.
- **Unread is ledger-backed.** `unreadCounts` and `unreadOldest` persist per-chat
  metadata without message bodies. Catch-up fetches cover new arrivals and the
  oldest outstanding unread so deletions are reconciled; never derive the total
  badge solely from the preview window.
- **Dedupe the self-thread before counting.** A message you send yourself lands
  twice (`from_me` true and false, same ts+text). `dedupeSelfEcho()` runs before
  `buildThreads()` and before `decorate()`.
- **`PanelKeyCatcher` eats keys before focused children.** Any editor that
  should receive typing must be covered by its `blocked:` binding.
- **Message text never rides argv, on either machine.** Text: `--text-stdin`.
  Caption + file: `--text-stdin-bytes N` ahead of the bytes, and BlipView
  hands send-file.ts the caption via `--caption-stdin`. `--file-bytes N`
  makes the Mac refuse a short stream. `--keep-dashes` always (imsg-send's
  dash scrubbing is a claude-on-mac house rule, not Blip's).
- **`tcc-check` is not reachable through the confined key** (it drives four
  other apps' Automation prompts); `blip-check` is what the wizard runs.
- **Cache file extensions follow the gated MIME**, never the sender's name —
  `xdg-open` dispatches on extension (war room #49).
- **Pass `--` before message text** to `notify-send`.
- **No message content in state.json.** `~/.local/state/blip/state.json` holds
  timestamps, counts, opaque SHA-256 toast keys, self-chat ids, and group
  metadata. It is atomic and `0600`; no message bodies are allowed. EXCEPTION
  (Fred, 2026-08-31): fetched MEDIA caches as plain files in
  `~/.cache/blip/att` (0700/0600, 500 MB LRU) — the Linux box's disk is LUKS-encrypted
  at rest. Message text still never lands on disk.
- **The Linux shims' ssh preflight must use `ssh -n`.** A bare
  `ssh <mac> true` connectivity probe EATS STDIN, which silently empties
  `imsg-send --file-stdin` payloads. Fixed 2026-08-31.
- **`bridge.conf` is data, never `source`d.** The shim parses four keys and
  validates them; keep it that way (audit #7). `automation=on` is what lets
  `qs ipc … goto/compose/bubbles` work — off, they return a refusal string.
- **Opening a link = `xdg-open` THEN focus the browser window.** Omarchy runs
  `focus_on_activate=false`, so a new tab in a browser on another workspace
  is invisible; `openLink()` finds the default handler's window by class and
  `hl.dsp.focus`es it. Verified 2.1.4 with journald breadcrumbs: taps and
  xdg-open were working the whole time — the tab was on workspace 3.
- **Only media/pdf/text mimes reach `xdg-open`** (`openableMime`). Anything
  else is saved and named, never launched (audit #10).
- **One person lives in several Contacts sources** (iCloud, Exchange, On My
  Mac) under slightly different spellings. That is NOT ambiguity — names
  (`name_for`) and photos (`cmd_avatar`) treat a collision only WITHIN one
  source as ambiguous; across sources the most common spelling wins. Got
  this wrong twice (2.0.0 photos, 1.9.4 names → "Rob T shows as a number").
- **`chat:null` exists.** Use `chatKey()`; never `String(m.chat)`.
- **Group ids come in two shapes**: 32 hex, or `chat<digits>`. `isGroupChat()` is
  "not a phone/email" — never a positive regex on one shape.
- **Deleted messages stay in chat.db for 30 days** (`chat_recoverable_message_join`).
  claude-on-mac's `imsg` hides them (1.4.0+); Blip assumes that.
- **The conversation Flickable is `interactive: false`.** An interactive
  Flickable grabs every drag, and drag IS text selection in a bubble; a
  slightly-moving click on a link became a flick. Wheel scrolling never
  needed it (next invariant). Ctrl+C in a bubble goes through `wl-copy`.
- **Wheel scrolling = `MouseArea.onWheel`, direct 1:1, and INSTRUMENT before
  tuning.** A `WheelHandler` on the Flickable received ZERO events on this
  stack (proved by logging after four "fixes" that were placebos — the
  Flickable's native decaying kinetic path was doing the scrolling the whole
  time). Omarchy's own panels use `MouseArea.onWheel`; so does Blip now.
  Never animate wheel scroll (two schemes collapsed under MX Master hi-res
  event floods). Two other scroll killers, both fixed and both invisible
  without logging: async image growth ABOVE the viewport cancels wheel motion
  (chipRow compensates contentY by its own height delta), and model
  reassignment rebuilds Repeaters and resets scroll (skip identical
  assignments; restore contentY after a list rebuild).
- **The app window is RECREATED on show, never re-mapped.** Quickshell does
  not re-map a `FloatingWindow` after `visible` has been false once: the
  property flips true, no client appears (SUPER+M "did nothing", 1.8.3).
  BarWidget's `ensureWindow()`/`hideWindow()` toggle the Loader's `active`;
  BlipWindow persists size + was-open in `~/.local/state/blip/window.json`
  and restores on creation. Do not "simplify" this back to `visible`.
- **After an Omarchy plugin HOT-RELOAD, `qs ipc` keeps serving the OLD
  BarWidget.** Proved 2026-08-31 with a build tag (A after reload to B; C
  after D): the destroyed widget's IpcHandler stays bound to the target,
  its child objects (Process, Timers) are dead, its window state drifts —
  "SUPER+M does nothing" after every plugin update. `ipc.enabled=false` in
  onDestruction does NOT release it; only omarchy-restart-shell does.
  Therefore: the SUPER+M bind decides from Hyprland's real client list
  (focused → hl.dsp.window.close, elsewhere → hl.dsp.focus, none → ipc
  `app`), `ensureWindow()` RECREATES a hidden window (Quickshell never
  re-maps one), and focus is fired via `Quickshell.execDetached` — a
  `Process` silently ignores `running=true` on the zombie. Deploy with a
  restart, never rely on hot-reload for anything IPC.
- **Every `Image` sets `autoTransform: true`.** iPhone photos carry rotation
  as an EXIF tag; `sips` preserves it when converting HEIC, and Qt ignores it
  by default — a portrait photo renders on its side (4032×3024 pixels tagged
  "Rotate 90 CW"). With the flag, implicit size follows the rotation and the
  `sourceSize` decode bound still applies. Verified on Qt 6.11.
- **Never let one delegate's implicit width exceed the panel.** A single
  RowLayout of N attachment chips summed implicit widths and silently
  stretched the whole conversation column to 2× panel width — every
  right-aligned element rendered off-panel, invisible, with no QML warning.
  Attachment chips are one per row for this reason. Debug trick: log
  `bubbleRow.width` per delegate; 1136 in a 560 panel = this bug.

## Working on it

```
bun test                                   # 90+ tests, ~40 ms
bun collector.ts --deep | jq .unread       # live against the Mac
bun thread.ts <chat-id> 40 | jq .bubbles   # one conversation
cp *.qml *.ts manifest.json ~/.config/omarchy/plugins/nixfred.blip/
omarchy-restart-shell                      # ALWAYS restart (hot-reload leaves IPC on a zombie)
# MANDATORY after every deploy — a QML syntax error kills BOTH surfaces silently (2.1.4 shipped one):
qs log /run/user/1000/quickshell/by-id/$(basename $(readlink /run/user/1000/quickshell/by-pid/$(pgrep -x quickshell)))/log.qslog -t 400 | grep -iE 'nixfred.blip.*(error|warn|unavailable|token)'
qs -p /usr/share/omarchy/shell ipc call nixfred.blip open   # and LOOK at it (grim)
qs -p /usr/share/omarchy/shell ipc call nixfred.blip status
qs -p /usr/share/omarchy/shell ipc call nixfred.blip goto 15550100001   # bare digits: qs rejects a leading "+"
```

IPC function names must not collide with `qs ipc` subcommands (`show` did).

## Verifying UI changes

Screenshot it: `grim -g "1300,40 620x860" out.png` with the panel open, then
look at the image. QML has no unit tests; every layout bug so far was found
that way, not by reading code.

Never inject keystrokes (`wtype`) unless the panel is confirmed open — they go
to whatever has focus otherwise.

## Things that are not possible

- Read receipts. `open imessage://<handle>` on the Mac does not flip `is_read`.
- Tapbacks, edits, typing indicators out. Needs SIP-off code injection; rejected.

## Things that ARE possible (verified 2026-08-31)

- **Attachments out.** `send POSIX file` works on Sequoia IF the file is staged
  in `~/Pictures/` — from anywhere else Messages fails silently (`error=25`,
  "Not Delivered"). Verified delivered for PNG and PDF. See ROADMAP.md.
