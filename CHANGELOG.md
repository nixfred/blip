# Changelog

## Unreleased

- **iPhone photos rendered on their side — inline AND in the viewer.** A
  camera photo stores its rotation as an EXIF orientation tag, and `sips`
  keeps that tag when the bridge converts HEIC to JPEG — so the pixels
  arrive landscape with a "rotate 90°" note that Qt only honours on request
  and imv (Omarchy's default viewer) never does. Two fixes: every `Image` in
  the conversation sets `autoTransform: true`, and `fetch.ts` now bakes the
  orientation into the cached JPEG losslessly with `jpegtran` (libjpeg-turbo,
  already on every Qt box) — colour profile kept, EXIF dropped so nothing
  double-rotates. Files cached before this release stay as they were; clear
  `~/.cache/blip/att` to re-fetch them upright. (Adam Gamble)

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
