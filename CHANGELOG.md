# Changelog

## Unreleased

- **Location-sharing notices no longer show up as empty unread messages.**
  Messages.app writes its own announcements — someone joined or left, a
  rename, location sharing started or stopped — into the message table with
  `item_type != 0`, and never marks them read. The bridge passed them through,
  so each one became an empty bubble that counted as unread forever and pulled
  its conversation to the top; an iCloud re-sync after a restart lands several
  at once. `imsg` now hides them at the source, next to Recently Deleted, so
  every query agrees. Group names are unaffected: rename rows are still read
  for that. Mac side: re-run the install one-liner so `~/.blip/bin/imsg` picks
  it up.
- **Reads now reach the Mac, and your phone.** Blip's "mark all read" cleared
  the badge on Linux and nothing else; the iPhone kept its red dots. The old
  note called this impossible because `open imessage://<handle>` does not flip
  `is_read` — true, but Messages has a **Conversation ▸ Mark All as Read** menu
  item, and menu items are scriptable. `imsg-read` on the Mac clicks it, and
  the collector calls that after the local marks are committed. Verified by
  round trip on a real Mac: unread → Blip's mark-all-read → read, on both
  machines. Because it goes through Messages rather than writing `chat.db`, the
  change syncs to every device the way any read does.
  - Needs **Accessibility** for `/usr/libexec/sshd-keygen-wrapper` alongside the
    Full Disk Access it already had. `blip-check` reports it; without it
    everything else still works.
  - `push_read=` in `bridge.conf`: `all` (default — only the explicit
    mark-all-read gesture), `thread` (also every conversation you open), `off`.
    The default is `all` because `--all` provably does not disturb the Mac,
    while pushing one conversation has to open it, which pulls Messages to the
    front of whatever the Mac is doing.
  - **If you have read receipts turned on, senders will now see them.** That is
    what marking a message read means; it was previously impossible for Blip to
    do, and now it is not.

- **A re-keyed group is one conversation again.** Messages re-keys a group
  (a re-invite, an iCloud re-sync, a service move) by writing a NEW chat row
  with the same name and the same members — Messages.app shows one thread,
  Blip listed one per row ("2x Sportsball!", twice again as a pinned tile).
  The bridge now clusters group rows by (name, members), lists the row
  Messages is writing to now, sums the message count, names the older rows as
  `aliases`, and `thread --chat` loads every row so the history is whole. The
  collector folds threads, unread counts and oldest-unread stamps onto the
  live id, and caches the map in `state.json` so a shallow poll folds the same
  way. Apple agrees: the pinning plist's alias for one Sportsball! row points
  at the other row's original group id.
- **Group photos, and no more borrowed faces.** A group row bound its
  picture to whoever spoke last, so it showed that member's cached contact
  photo one minute and initials the next. Groups now bind to their own chat
  id and the bridge streams the group's own photo (`imsg avatar --chat <id>`,
  PNG/JPEG as-is, anything else through sips). Messages keeps that photo as
  an attachment whose name ends in `GroupPhotoImage`; the carrier message's
  `group_action_type` is 3 for photos set up to April 2025 and 1 after, so
  the lookup matches the FILENAME, not the action type, and searches every
  chat row of the conversation — a re-keyed group can keep its photo on the
  row Messages retired. Groups without one show initials.
- **"No photo" is remembered for a day, not a week.** A photo that appears
  later — a new group picture, a Contacts card, or a bridge fix that starts
  finding one — now shows up within a day instead of after the 7-day cache
  expired.
- **Every link gets its card, not just the ones Apple decorated.** Messages
  builds an `LPLinkMetadata` preview for some URLs and leaves most bare — on
  this Mac 7 of 27. For the bare ones Blip now fetches the page itself and
  builds the same card from its Open Graph tags: picture, title, description,
  host. The fetch happens on the Linux box, never the Mac; http(s) only, at
  most three redirects, and a host resolving into your LAN or to a cloud
  metadata address is refused, so a link from a stranger cannot make Blip
  probe your network. Cached for a week (a page with no card, for a day) under
  `~/.cache/blip/linkpreview`. `link_previews=off` in `bridge.conf` turns it
  off. A message that is only a URL shows just the card, like Messages.
- **The share sheet opens itself for a link, sent or received.** Send a
  message containing a URL and the sheet comes up on it; a link that ARRIVES
  does the same — but only onto a Blip surface that is already open, because
  Omarchy runs `focus_on_activate=false` and a bank alert must not throw a
  panel over full-screen work. One sheet, the newest link only, and each
  message fires exactly once through a persisted `link:` ring, so a catch-up
  after sleep cannot stack modals and yesterday's links never pop tomorrow.
  The self-thread never triggers it.
- **Open the app from the panel.** A ⇱ button beside ＋ in the panel header
  opens the full app window, the same thing SUPER+M does.
- **Share sheet for links.** Right-click a link in a bubble, or a link card,
  and Blip opens a sheet: open in browser, copy, a QR code your phone can
  scan, and "send to a device" through LocalSend — Omarchy's own share sheet,
  fed the way `omarchy-menu-share clipboard` feeds it. The URL travels on
  stdin to qrencode and to the temp file; left-click still opens the link.
- **Pinned conversations, mirrored from Messages.** The Mac's ordered pin
  list (`com.apple.messages.pinning.plist`, `pD.pP`) rides along on the
  `chats` call and Blip renders those conversations as avatar tiles above the
  list, in Messages' order. Read-only: Blip has no pin control and writes
  nothing back. (Erik Zachrisen, #11) Follow-ups on main: groups are pinned
  by their chat.db `group_id` / `original_group_id`, not the chat identifier,
  so pinned groups resolve too; the reader uses the ordered list (with the
  `pZ` alias map) instead of every string in the file, which had ranked a
  group ahead of every DM; and j/k highlight a pinned tile — the cursor walks
  pinned threads first and had no visible position on them.

## 2.2.3 — 2026-09-02

- **Received bubbles showed a lighter square in the tail corner.** The
  "tail" was a second translucent rectangle drawn over the corner, so the
  14 % fill composited twice. The corner is now squared with Qt 6.7
  per-corner radii and the extra rectangle is gone. (Adam Gamble, #10)
- **iPhone photos rendered on their side — inline AND in the viewer.** A
  camera photo stores its rotation as an EXIF orientation tag, and `sips`
  keeps that tag when the bridge converts HEIC to JPEG — so the pixels
  arrive landscape with a "rotate 90°" note that Qt only honours on request
  and imv (Omarchy's default viewer) never does. Two fixes: every `Image` in
  the conversation sets `autoTransform: true`, and `fetch.ts` now bakes the
  orientation into the cached JPEG losslessly with `jpegtran` (libjpeg-turbo,
  already on every Qt box) — colour profile kept, EXIF dropped so nothing
  double-rotates. Files cached before this release stay as they were; clear
  `~/.cache/blip/att` to re-fetch them upright. (Adam Gamble, #9)

## 2.2.2 — 2026-09-02

- **Group sends failed with -1728 on Macs that keep one chat row per
  service.** A group that moved between iMessage, SMS and RCS leaves several
  `chat` rows sharing one identifier; only one holds messages. `imsg groups`
  returned all of them, the empty shell sorted last and overwrote the live
  guid in Blip's group cache, and AppleScript could not resolve it. The bridge
  now keeps one row per identifier, newest first. Mac side: re-run the install
  one-liner so `~/.blip/bin/imsg` picks it up. (tolewis, #8)

## 2.2.1 — 2026-09-02

- **Short-code SMS threads opened empty.** Georgia Power (99123), 878478 and
  every other 5–8 digit sender showed in the list but loaded zero bubbles:
  the thread loader's CLI convenience turned any bare digits into an E.164
  number ("+99123"), and 2.2.0's exact chat-id query correctly found nothing.
  Only a full number (10+ digits) is "+"-prefixed now, in `thread.ts` and in
  the IPC `goto` alias. Short codes go through verbatim. Tests for both.
- **App window fills like other Omarchy windows.** The 0.70 backdrop alpha
  assumed Hyprland blur, which stock Omarchy 4.x ships off — the wallpaper
  showed through the Super+M window. Now `color: Color.background`, like the
  shell's dev gallery, with Hyprland's default-opacity rule doing the rest.
  (Johan Thorén, #7)

## 2.2.0 — 2026-09-02 — verified fixes

The war-room judge panel re-ran against 2.1.6 (three lenses per finding):
11 earlier fixes confirmed closed, 17 findings confirmed open. This release
fixes 13 of them; the rest stay listed in ROADMAP.md.

**Multi-monitor.** Omarchy builds one bar — and one Blip widget — per
screen. Only the widget on the first screen now polls, watches, toasts,
owns the app window and answers IPC; the others show the badge from
`state.json` and forward clicks to it. (Previously: N pollers, N ssh
watchers, duplicate toasts and windows.)

**Sends.** SMS/RCS conversations go out on their own service instead of
silently as iMessage (text and files). A refused send now shows the Mac's
reason ("message too long", "not authorized"…) instead of "exit 1".

**Reads.** The app window marks a conversation read only while it is the
focused window — visible on another workspace no longer clears dots.
Mark-all-read / middle-click / IPC refresh keep the full list when a
surface is open (a shallow run used to collapse it to the preview window).

**Correctness.** A DM loads by exact chat id (`thread --chat`) so a
contact's group posts no longer eat the history window. A DM is persisted
as a "self chat" only after two independent same-second twins, not one
coincidence. Failed-send toasts fired every poll for 15 minutes because the
dedupe ring dropped their `fail:` prefix on load.

**Robustness.** A `bun` that cannot start is reported as such (not "Mac
unreachable"); the offline poll backs off to 30 s; the push watcher's
liveness timer arms at start.

**Config.** `country_code=` in `bridge.conf` for numbers typed without a
country code outside North America.

**Docs.** README no longer promises a headless Mac without a logged-in
session; the last real-looking number left the code; a duplicated README
block removed.

## 2.1.6 — 2026-09-01

- **Duplicate toasts fixed.** The bridge now emits each message's ROWID and
  the toast key no longer includes the text: Messages can land a row before
  its decoded body, and a timestamp slightly ahead of the Linux clock kept
  the message above the watermark, so the same message toasted twice.

## 2.1.1 – 2.1.4 — 2026-09-01

- **Links open and come to the front.** Clicks were reaching `xdg-open`
  all along; Omarchy's `focus_on_activate=false` left the tab on the
  browser's workspace. Blip now focuses the browser after opening. (2.1.4)
- **Text selection + Ctrl+C in bubbles** — the conversation Flickable was
  grabbing every drag. (2.1.1)
- **Contact names regression** — one person across several Contacts
  sources ("Rob" / "Robert") is not a collision. (2.1.2)
- Repo scrubbed of maintainer machine names, a real group name, absolute
  paths. (2.1.3)
- README Install rewritten around `omarchy plugin add … --enable`, with
  notes for humans and for AI agents; `AGENTS.md` added. (2.1.4)

## 2.1.0 — 2026-09-01 — war room

Ten expert-lens reviewers swept the repo after the DHH retweet; 114
findings, the clear ones fixed here, the rest on the roadmap.

**Fixed — correctness**
- Attachment-cache eviction had silently never run since 1.9.4 (a missing
  `statSync` import threw inside the LRU). 500 MB cap is real again.
- A DM thread admitted that person's messages from *group* chats.
- Catch-up fetches could exceed Bun's default 1 MB `spawnSync` buffer and
  fail sticky; all bridge calls now allow 64 MB.
- A timed-out `imsg` (Mac asleep behind a live ssh mux) read as a bridge
  bug; it now reads as "Mac asleep" and greys the icon.
- Bridge errors show the *last* stderr line (Python puts the cause last),
  not "Traceback (most recent call last):".
- `state.json` is fsync'd before rename (a power cut no longer resets every
  read mark). Cache temp names carry entropy (no EEXIST after pid reuse).
- Link cards: `$null` titles, URLs with `(…)` (Wikipedia), and userinfo
  host-spoofing handled. Inline-reply snippets respect Recently Deleted.
- macOS 12 and earlier: `imsg` no longer dies on the missing
  Recently-Deleted table.
- Avatar initials for whitespace-only names; non-ASCII attachment names
  survive sanitizing; sent files keep their extension.
- `wait_for_copy` matches only attachment rows newer than the send
  (same-name re-sends no longer confuse it); a send whose copy was never
  observed is kept in `~/.blip/sent` instead of deleted an hour later.

**Fixed — security / privacy**
- File-send captions no longer appear in any process's argv
  (`--caption-stdin`). A cut ssh stream can no longer deliver a truncated
  file (`--file-bytes N` is enforced on the Mac).
- Cache file extensions follow the gated MIME type, not the sender's
  filename (`xdg-open` dispatches on extension).
- `tcc-check` removed from the confined key's allowlist.
- `blip-setup` no longer `source`s `bridge.conf`, no longer echoes a message
  body into the terminal, guards the `authorized_keys` append with a
  newline, keeps a hand-set `automation=` on re-run, drops the ssh master
  before re-checking grants, and names a missing Xcode CLT instead of
  misdiagnosing Full Disk Access. `install.sh` fails loudly on the CLT stub.
- Consent banner prints only on a TTY (recipients no longer reach journald).
- A real phone number and email were removed from a public test fixture.
- Transient bridge failures no longer write a 7-day "no photo" marker.

**Changed**
- Users' dashes are sent as typed (`--keep-dashes` everywhere).
- `xdg-open` and the window-state writer run detached (a blocking handler
  or a mid-write hide could swallow later clicks / the hidden state).
- IPC `compose` refuses when the popout is closed.
- The shim's offline message includes the ssh reason.
- `sync-bridge.sh` stages upstream copies beside locally-modified tools
  instead of overwriting them.
- Tests are isolated from the developer's real caches (`bunfig.toml`
  preload sets `XDG_CACHE_HOME`).

## 2.0.4 — 2026-09-01

**Fixed**
- `blip-check` probed a single, unordered Contacts source; a stale CardDAV
  `.abcddb` sorting first produced a false "contacts ❌ — grant Full Disk
  Access" during `blip-setup` even though contacts and avatars worked. It now
  probes every source like the `contacts` tool does and fails only when none
  opens. First outside contribution — **@jethrojones** (#2). Thank you.

**Repo**
- CI on every push and PR (bun test, Mac tools byte-compile, shellcheck),
  CONTRIBUTING, issue/PR templates, security policy, GitHub Releases.

## 2.0.0 — 2026-08-31

The "complete for Fred" release: everything on the roadmap that makes Blip
feel like Messages, plus the hardening a stranger needs.

**Added**
- Contact photos in the sidebar (`imsg avatar` streams the Contacts
  thumbnail; cached 7 days under `~/.cache/blip/avatars`, negative-cached).
- Rich-link cards: URL messages render title / summary / preview image /
  host, click opens the link; a message that is only the URL shows just the card.
- Unread count in the app window title (`Blip (3)`).
- App window: real gutters, no hero chip, looser sidebar (1.9.3, 1.10.1).
- Dedicated ssh key confined on the Mac to the five bridge tools
  (`blip-dispatch`), with its own ControlMaster socket (1.10.0).
- `automation=` switch in `bridge.conf` gating IPC send/read (1.10.0).
- `blip-check` on the Mac + honest failure states in the panel (1.9.0).
- Sent files are kept in `~/.blip/sent` so your own photos stay showable (1.11.0).

**Security / privacy** (Codex audit, `docs/SECURITY.md`)
- Message text never travels in argv on either machine (`--text-stdin`,
  `--text-stdin-bytes`, `osascript` script on stdin) (1.9.4, 1.11.0).
- `bridge.conf` is parsed, never sourced; host validated; `ssh --` (1.9.4).
- Only media/pdf/text attachments reach `xdg-open`; auto-fetch has a hard
  transfer cap; cache refuses symlinks; catch-up fetch bounded (1.9.4).
- Contact names keyed by the last ten digits never pick the wrong person (1.9.4).

**Fixed**
- SUPER+M dying after every plugin update: Omarchy hot-reload leaves the
  old widget answering `qs ipc` (reported upstream, omacom/omarchy#9533);
  the keybind now decides from Hyprland's client list (1.10.1).
- A hidden FloatingWindow is recreated, never re-shown (Quickshell never
  re-maps it) (1.8.3, 1.10.1).
- Four QML-invariant tests had silently failed since 1.8.0 (1.11.0).

## 1.0.0 → 1.8.x — 2026-08-31

Attachments in and out, tapbacks, read receipts, inline replies, edits,
search, new-conversation composer, reply-from-toast, real-time push, the
app window, one-source bridge (`bridge/`, `blip-setup`), failed-delivery
flags, scroll that works. See `git log` — every commit carries the story.
