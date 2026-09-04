# Blip — agent notes

Blip is an Omarchy (QuickShell/QML) bar plugin that puts iMessage on Linux by
treating a Mac as the gateway. Read this before touching anything.

## Shape

```
(Mac side)    bridge/mac/           VENDORED from claude-on-mac with documented Blip extensions (pin in bridge/BRIDGE-VERSION; refresh with
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
preferences.ts                      bounded schema + atomic ~/.config/blip/preferences.json I/O.
BlipPreferences.qml                 one shared live preference source; QML never parses the writable file.
identities.ts                       bounded ~/.config/blip/identities.json choices + Mac candidate broker.
BlipIdentities.qml                  QML helper client; handles travel to the bridge over stdin, never argv.
BlipSettings.qml                    in-app editor for appearance and ambiguous contact names.
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
  **Never cut a consent-triggering probe short.** macOS gives the Automation
  Allow prompt ~2 minutes; a prompt nobody answers is recorded in TCC as a
  DENIAL (`auth_value 0, auth_reason 9` = Prompt Timeout), and on macOS 26 the
  Settings switch for that record may refuse to turn on (#36, 26.5.2 and
  26.6.2). `blip-check` waits 150 s and warns first; `blip-setup` sends the
  user to the Mac's screen before the check. Recovery: `tccutil reset
  AppleEvents` (Apple's tool, SIP intact; it clears every app's Automation
  grants — a path-identified client like sshd-keygen-wrapper cannot be reset
  alone), then re-run and click Allow in time.
- **Cache file extensions follow the gated MIME**, never the sender's name —
  `xdg-open` dispatches on extension (war room #49).
- **Pass `--` before message text** to `notify-send`.
- **A security code lives five minutes in BarWidget memory, nowhere else.**
  `selectCodes()` (collector) spots it; `noteCode()` holds the newest and
  toasts THAT A CODE ARRIVED — never the digits. Omarchy's daemon persists
  every displayed toast's body to `~/.local/state/omarchy/notifications/
  history/`; its `transient` hint only decides whether a DND-silenced one is
  recorded (Service.qml says so itself). 2.3.3 put the code in the body on
  the strength of that hint and was wrong. The message's ordinary preview
  toast is dropped for the same reason;
  `copycode` hands it to wl-copy via an env var and stdin, `typecode` sends
  it to the focused window as `send_key_state` events over Hyprland's socket.
  Never argv. NEVER wtype for this: Hyprland merges a virtual keyboard's keys
  with the physical modifiers still held from the hotkey, and the digits
  fired Super+Shift+<digit> binds (found the hard way, 2026-09-04). Never a
  group, never the self-thread, once per message through the `code:` ring.
- **No message content in state.json.** `~/.local/state/blip/state.json` holds
  timestamps, counts, opaque SHA-256 toast keys, self-chat ids, and group
  metadata. It is atomic and `0600`; no message bodies are allowed. EXCEPTION
  (Fred, 2026-08-31): fetched MEDIA caches as plain files in
  `~/.cache/blip/att` (0700/0600, 500 MB LRU) — the Linux box's disk is LUKS-encrypted
  at rest. Message text still never lands on disk. `push-read.log` beside
  state.json records each read-push's exit code and `imsg-read`'s status
  line — never content.
- **The Linux shims' ssh preflight must use `ssh -n`.** A bare
  `ssh <mac> true` connectivity probe EATS STDIN, which silently empties
  `imsg-send --file-stdin` payloads. Fixed 2026-08-31.
- **Pins belong to Messages.app.** The ordered pin list lives in
  `com.apple.messages.pinning.plist`, not `chat.db`. `imsg chats` resolves its
  bounded pD/pP tokens to canonical chat identifiers and emits pin state and
  order; Blip must not create a divergent Linux-only favorites list.
- **Preferences cross a bounded helper.** QML never feeds
  `~/.config/blip/preferences.json` into `FileView`. `preferences.ts` rejects
  symlinks/FIFOs/wrong owners/oversized or invalid JSON and writes 0600 via a
  pinned directory fd + atomic rename. Keep the schema portable and versioned.
- **Ambiguous contact names are explicit choices, never guesses.**
  `~/.config/blip/identities.json` is a portable, versioned, owner-only map
  validated and written by `identities.ts`. Candidate lookups are bounded on
  both sides of ssh and carry the handle via stdin. A display-name preference
  is optional and separate from contact management. Session-only candidate
  selection must be enough to compare, edit, delete, consolidate, link, or
  repair cards; those operations must never require or create an
  `identities.json` entry. Saving a display preference remains an explicit,
  separately labeled action. Mac review uses
  opaque per-card tokens to open an exact validated `addressbook://` record in
  Contacts.app. Card comparison returns bounded selected-card fields and opaque
  content revisions with raw ids retained on the Mac. Full-card edits,
  deletions, and consolidations require a hashed preview, revalidate every
  exact revision at apply time, and write a private bounded undo receipt before
  Contacts.app saves. Edits preserve the target photo; deletion and
  consolidation receipts cannot guarantee restored account placement, links,
  or photos, so the destructive confirmation must keep saying so. Gated narrow
  repair can remove an exact revalidated
  phone/email with confirmation and an undo receipt. Cross-NAME
  consolidation exists but only with BOTH owner tokens presented explicitly
  (the user declared the two names the same person); it is merge-only —
  per-card edit/delete/link keep single-person authority — and the union
  renumbers account numbers so they stay unique. Gated linking uses only
  Contacts' allowlisted enabled menu action, pins the previewed action through
  execution, and requires another confirmation. Blip never edits the private
  AddressBook SQLite database.
- **Contacts saves are async to every read path.** A CNContactStore commit is
  not instantly visible to Contacts.app's JXA view (`describe`) or the
  abcddb, so read-your-write verification must settle-poll
  (`settled_card_detail`); comparing a fresh save against an immediate
  read-back falsely reports "Contacts changed the card". Saves can also throw
  transient Cocoa 134092 while contactsd rebuilds its graph or refreshes
  CardDAV accounts — and Blip's own consolidation preflight launches
  Contacts.app, which triggers those refreshes — so every mutating stage in
  contact-delete.swift retries on a fresh store session. Google CardDAV also
  REWRITES person UIDs shortly after a card is created or synced; never cache
  a Gmail-container uid across user think-time without revalidating.
- **Never rebuild a card's labeled-value collections wholesale.** Replacing a
  value Contacts already has forces contactsd to fault the old row out, and
  ONE damaged stored row then fails the whole save with Cocoa 134092 —
  persistently ("Unhandled error occurred during faulting"). apply() reuses
  the contact's own CNLabeledValue objects for unchanged label+value pairs
  and leaves an equal birthday untouched (synced birthdays carry
  calendar/timezone the drafts' bare components lack). Beware the label
  round-trip: Contacts.app's scripting layer reports UNLABELED values under
  default kind names ("Email", "Phone"), which must normalize back to nil —
  matching on the literal name both misses the source row and mints a custom
  label. When the native path faults anyway, Contacts.app's own write path
  still works — the pipeline recovers the reviewed plan through setCard and a
  guarded delete-fallback (native stays primary). Two scripting regressions
  on macOS 15.5: the add-to-person Apple event fails with "No error. (0)" —
  push onto the person's collection specifiers instead — and removals can
  fail with "Message not understood", so add-only edits must never take the
  remove-all path.
- **`bridge.conf` is data, never `source`d.** The shim parses an allowlisted schema and
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
  source as ambiguous. Got this wrong twice (2.0.0 photos, 1.9.4 names →
  "Rob T shows as a number").
  **Phone numbers match the way Contacts matches them.** The last-ten key is
  exact, tried first, and decides whenever it hits. Only when it finds nothing
  does the region-aware rule run (`_same_number`): a card saved without a
  country code gets the Mac's region (`AppleLocale`, via
  `calling_codes.py`), and two numbers are the same when their calling codes
  are equal and one national number ends with the other — libphonenumber's
  SHORT_NSN_MATCH, with a floor of seven digits and one refusal Contacts does
  not make: a North American card shorter than ten digits has no area code and
  matches nothing. "123 45 678" is how numbers are saved outside North
  America; before this, every such person, the owner included, was a bare number.
  **Sources are RANKED, never counted** (`_source_ranks`, read from
  `~/Library/Accounts/Accounts4.sqlite`): `0` the local "On My Mac" store,
  which has no backing account and is what the owner typed; `1` the owner's
  own iCloud (CardDAV owned by Apple ID settings); `2` every other synced
  source. The lowest rank offering a name wins outright, and the most common
  spelling only breaks ties WITHIN a rank. Counting sources equally let a
  synced directory of thousands rename people by sheer volume. An unreadable
  Accounts db ranks everything the same, i.e. the old behaviour.
  `_ab_sources()` returns paths IN RANK ORDER, which is also what makes
  `cmd_avatar` — "first source with a photo wins" — prefer the owner's
  picture over a corporate headshot.
  EXCEPTION on top of that: a Family Sharing child's address book (Screen
  Time ▸ Manage Contacts) is mirrored to the parent's Mac as its OWN CardDAV
  store, flagged `isChildDelegate` in the same Accounts db. Contacts.app hides
  those from All Contacts; `_ab_sources()` drops them entirely, or two sons'
  "Mom" cards outvote your own "Monica Gamble" for the same number.
- **Configuration is `bridge.conf` keys, not a settings system.** Blip has one
  config file (`~/.config/blip/bridge.conf`, parsed not sourced) carrying
  `host`, `remote_bin`, `automation`, `ui_font_size`, `ui_font_theme`,
  `link_previews`, `push_read`, plus the mute list. Anything worth configuring
  becomes another key. Settled 2026-09-04 against PR #21, which proposed a
  `preferences.json` with eleven knobs and a ~1300-line settings panel: it was
  careful work (atomic, 0600, ownership and size validated) and was still the
  wrong shape. Blip inherits Omarchy's theme (foreground, background, font)
  and aims at ONE opinionated iMessage look — the accent is NOT the theme's:
  bubbles and the bar icon's unread dot are iMessage blue `#0a84ff` on every
  theme, white text on the bubbles (Fred, 2026-09-04: "Blue Bubbles"); a second config system with per-user bubble colors, density,
  avatar size and corner scale multiplies the states every layout bug can hide
  in. The concrete warning: that PR defaulted `hideShortCodeConversations` to
  true, which would have silently hidden the GA Power SMS from 99123 that took
  a day to make arrive at all. A default that hides messages is not a
  preference.
- **An iMessage-app card is text, in the payload, not in the text column.**
  Ask to Buy, Fitness sharing, Find My and friends store U+FFFD as the message
  text and an MSMessage archive in `payload_data`; `ldtext` there is the
  sentence Messages itself shows when it cannot render the app, then the
  caption, then the app name (`_app_card_text`). Link cards are the one
  balloon that is not an app; they stay links.
- **A read of a canonical conversation covers its aliases.** The unread
  ledger counts on ORIGINAL chat keys and `foldChatRecord` merges afterwards,
  so `--read <canonical>` also marks every alias (`aliasesOf`), or an alias's
  unread survives the read and reappears under the conversation just read.
  Likewise `thread.ts` keeps every group row the bridge returns for a
  `thread --chat` — the bridge scoped it to the cluster, and the alias rows
  keep their own ids (9 rows from the Mac, 6 bubbles shown, until 2.3.4).
- **`chat:null` exists.** Use `chatKey()`; never `String(m.chat)`. A row with
  neither chat nor handle is a leftover of a deleted conversation (iCloud keeps
  the row, the chat and the join are gone); `fetchMessages` drops it
  (`hasIdentity`), or it becomes a nameless, unopenable thread. Rows with a
  handle stay — some SMS senders only ever exist that way.
- **Group ids come in two shapes**: 32 hex, or `chat<digits>`. `isGroupChat()` is
  "not a phone/email" — never a positive regex on one shape.
- **An unsend is not an edit, and on macOS 26 it never sets `date_retracted`.**
  Undo Send stamps `date_edited`, clears the body, and records the withdrawn
  parts as `rp` in `message_summary_info`; a real edit carries `ec` and keeps
  its body. `_edit_flags` reads both, retracted wins, so the tombstone shows
  instead of an empty bubble marked "Edited". In the SELF-THREAD an unsend
  withdraws only the sent copy and the echo keeps its text — the echo shape
  inverted — so `dedupeSelfEcho` keeps the retracted outbound row and drops
  the echo, instead of the other way round.
- **Deleted messages stay in chat.db for 30 days** (`chat_recoverable_message_join`).
  claude-on-mac's `imsg` hides them (1.4.0+); Blip assumes that.
- **Announcements are not messages.** Joins, leaves, renames and location-sharing
  notices share the message table with `item_type != 0`, and Apple never marks
  them read. `imsg` hides them at the source; let one through and it is an
  empty bubble that counts as unread forever. Group names still come from
  rename rows (`cmd_groups` reads the raw table).
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
- **EXIF orientation is baked at fetch time, and every `Image` sets
  `autoTransform: true`.** iPhone photos carry rotation as an EXIF tag;
  `sips` preserves it when converting HEIC, Qt ignores it by default, and imv
  (Omarchy's default viewer, what `xdg-open` launches) ignores it always —
  a portrait photo rendered on its side in both places (4032×3024 pixels
  tagged "Rotate 90 CW"). `fetch.ts` rotates the JPEG losslessly with
  `jpegtran -copy icc` (libjpeg-turbo, a hard dependency of Qt) before
  caching, dropping the EXIF block so nothing double-rotates; the QML flag
  covers files cached before that, and the fall-back when jpegtran fails.
  Never move this to the Mac side: `sips` cannot auto-orient.
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

- Tapbacks, edits, typing indicators out. Needs SIP-off code injection; rejected.
- Selecting a GROUP on the Mac from Linux. `imessage://` addresses a handle;
  a group's `chat<digits>` id has no URL form. So per-conversation read-push
  is DMs only; groups clear through `--all`.

## Things that ARE possible (verified)

- **Marking read ON THE MAC** (2026-09-03, macOS 26.6). The old note said this
  was impossible because `open imessage://<handle>` does not flip `is_read` —
  true, and still true. But Messages has a **Conversation ▸ Mark All as Read**
  menu item, and a menu item is scriptable through System Events. Proved by
  round trip: `is_read` 1 → "Mark as Unread" → 0 → "Mark All as Read" → 1.
  `bridge/mac/imsg-read` does it; the collector calls it after the local marks
  are committed. Never write `is_read` into chat.db directly — going through
  Messages is what makes the change reach the iPhone.
  - `--all` does NOT steal focus: no window raised, no selection changed,
    frontmost app unchanged (measured). `--chat` MUST open the conversation,
    which pulls Messages forward — that is why `push_read` defaults to `all`.
  - **The menu is DORMANT while Messages is in the background** (2026-09-04).
    With a real unread and the Dock badge at 1, EVERY Conversation-menu item
    read `enabled=false` through System Events, even with the menu forced
    open — AppKit validates menus against the responder chain of the ACTIVE
    app. `imsg-read` used to read "disabled" as "nothing unread" and exit 0,
    so every push was a silent no-op unless you happened to be using
    Messages. Now it counts what Messages itself calls unread in chat.db
    (inbound, non-tapback, `item_type=0`, newer than the chat's
    `last_read_message_timestamp` — the Dock-badge definition) before and
    after; when the menu is dormant it activates Messages for 0.7 s, clicks,
    hands focus straight back, and exits 75 with a reason if the count did
    not move. The collector records every push in
    `~/.local/state/blip/push-read.log` (exit code + status line, no content).
    A disabled menu item is NOT evidence of anything; chat.db is the referee.
  - With `push_read=all` a per-thread read pushes NOTHING by design — only
    mark-all does. Conversations read in Blip stay unread on the phone until
    the next mark-all. Documented trade-off, not a bug.
  - Needs **Accessibility** for `/usr/libexec/sshd-keygen-wrapper`, on top of
    the Full Disk Access it already has. Optional: `blip-check` reports it as
    a ➖ rather than failing.
  - The menu item is disabled when nothing is unread, and the per-conversation
    item is NAMED for what it will do ("Mark as Read" only appears while the
    chat is unread) — treat an absent item as success, not an error.

## Things that ARE possible (verified 2026-08-31)

- **Attachments out.** `send POSIX file` works on Sequoia IF the file is staged
  in `~/Pictures/` — from anywhere else Messages fails silently (`error=25`,
  "Not Delivered"). Verified delivered for PNG and PDF. See ROADMAP.md.
