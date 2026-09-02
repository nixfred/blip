<p align="center">
  <img src="docs/hero.svg" alt="Blip — iMessage in the Omarchy bar" width="920">
</p>

<h1 align="center">Blip</h1>

<p align="center">
  <b>iMessage. On Linux. For real.</b><br>
  Read, send, group chats, blue dots, desktop toasts — from an Omarchy bar widget.<br>
  Your Mac does the talking. Your Linux box does the living.
</p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-2.0-0a84ff?style=flat-square">
  <img alt="Omarchy" src="https://img.shields.io/badge/Omarchy-plugin-5fd7ff?style=flat-square">
  <img alt="QuickShell" src="https://img.shields.io/badge/QuickShell-QML-0a84ff?style=flat-square">
  <img alt="bun" src="https://img.shields.io/badge/bun-TypeScript-f9f1e1?style=flat-square">
  <img alt="tests" src="https://img.shields.io/badge/tests-177%20passing-2ea043?style=flat-square">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-lightgrey?style=flat-square">
</p>

---

> ### ⚠️ You need a Mac. That is the whole trick.
> Blip does **not** reimplement iMessage. Apple's protocol only runs on Apple
> hardware, so Blip uses a Mac you already own — any Mac signed into your
> Apple ID, awake and reachable over SSH — as the gateway. The Linux side is a
> thin client. **No Mac, no Blip.** When the Mac sleeps, Blip dims and waits.

## Blip 2.0

Version 2.0 (2026-08-31) is the "this is what I wanted" release. Since 1.0:

- **The app.** A Messages-style window — sidebar of every conversation,
  the open thread, compose — next to the bar popout. `SUPER+M`,
  double-click the bar icon, or `qs ipc … app`. Remembers size and whether
  it was open across shell restarts; title shows the unread count.
- **Contact photos** from the Mac's Contacts in the sidebar.
- **Link cards** with preview image, title, and host, like Messages.
- **Real-time push** — messages land in ~2 s via a watcher on the Mac.
- **Attachments both ways** — photos inline, files as chips, send by
  Ctrl+V / drag-and-drop / `/attach`, with captions; your own sent photos
  stay showable.
- **Search** across every message ever; **new conversation** from a
  contact search; **reply from a toast**; failed-delivery flags.
- **One source.** The Mac-side tools ship in this repo; `blip-setup`
  installs everything including a dedicated ssh key the Mac confines to
  the five bridge tools.
- **Audited.** A full security + privacy audit, every finding fixed or
  documented — [docs/SECURITY.md](docs/SECURITY.md), [docs/PRIVACY.md](docs/PRIVACY.md).
  Message text never touches argv or disk on either machine.

Full history: [CHANGELOG.md](CHANGELOG.md).

## Why this exists

iMessage is macOS-only. Everyone who lives on Linux and owns an iPhone knows the
dance: pick up the phone, unlock it, type on glass, put it down, lose the
thread. BlueBubbles wants SIP off. AirMessage wants a server and a prayer.

Blip does something simpler. **The Mac you already own is the gateway.** It
holds `chat.db` and it can drive Messages.app with AppleScript. Everything else
is one multiplexed SSH socket and a bar widget that looks like it belongs.

No SIP disabled. No daemon on the Mac. No private API. No message cache on the
Linux side. If the Mac is asleep, the widget dims and says so.

## What you get

<table>
<tr>
<td width="50%" valign="top">

**In the bar**
- unread count across every thread
- dims with a slashed glyph when the Mac is unreachable
- left-click panel · **double-click opens the app window** · middle-click refresh · right-click mark all read

**Thread list**
- contact photo (from the Mac's Contacts) or initials, name, preview, time
- **pinned conversations mirrored from Messages on the Mac**, kept in the same order at the top (read-only)
- **blue dot** that stays until you open *that* conversation — iMessage semantics, not "I glanced at the list"
- groups titled the way Messages.app titles them: the group's name, else its members

</td>
<td width="50%" valign="top">

**Conversation**
- real bubbles — yours blue on the right, theirs grey on the left
- grouped into runs with one timestamp per run, day dividers, squared "tail" corner
- sender names above each run in a group
- **tapbacks** — ❤️👍😂 pills on the bubble corner, custom emoji included
- **"Read 4:42 PM"** under the last message of yours they've read (display only — Blip never sends receipts)
- **inline replies** quoted above the bubble · **Edited** tags · "unsent a message" tombstones
- **link cards** — URL messages show the preview image, title, and host, like Messages; click opens the link
- **photos render inline** — images ≤5MB auto-fetch over SSH (HEIC converted on the Mac); click opens full-size. PDFs/videos are chips — click fetches and opens them
- **send files** — Ctrl+V an image into the compose box, type `/attach <path>`, or drag-and-drop; a caption rides along
- select text and Ctrl+C · right-click a bubble to copy it whole
- compose box at the bottom, Enter sends — **DMs and groups**

**Toasts**
- desktop notification only for senders on your allowlist
- everything else still counts and still shows; it just doesn't interrupt you

**Toast actions**
- click a toast and the panel opens ON that conversation with the compose
  box focused (the Omarchy daemon renders no action buttons, so click IS
  the reply path)

**The app**
- double-click the bar icon, press `SUPER+M`, or IPC `app` for a
  Messages-style window (IPC `window` is a plain toggle). For the keybind, add
  this to `~/.config/hypr/bindings.lua` — it asks **Hyprland** where the
  window is (front → close, elsewhere → focus, none → create) instead of
  the plugin, because after an Omarchy plugin update the plugin's IPC can
  answer from a stale instance until the shell restarts:
  ```lua
  o.bind("SUPER + M", "Blip messages", [[sh -c '
    blip() { hyprctl clients -j | jq -r ".[] | select(.title | startswith(\"Blip\")) | .address" | head -1; }
    a=$(blip)
    if [ -z "$a" ]; then
      qs -p /usr/share/omarchy/shell ipc call nixfred.blip app >/dev/null
      for i in 1 2 3 4 5 6 7 8 9 10 11 12; do a=$(blip); [ -n "$a" ] && break; sleep 0.15; done
      [ -n "$a" ] && hyprctl dispatch "hl.dsp.focus({ window = \"address:$a\" })"
    elif [ "$(hyprctl activewindow -j | jq -r .address)" = "$a" ]; then
      hyprctl dispatch "hl.dsp.window.close({ window = \"address:$a\" })"
    else
      hyprctl dispatch "hl.dsp.focus({ window = \"address:$a\" })"
    fi']])
  ```
  sidebar of every conversation + the open thread + compose, tiled by
  Hyprland like any app, sharing the bar widget's live data; the title
  carries the unread count (`Blip (3)`)

**Real-time**
- a push watcher on the Mac pings when chat.db changes — messages land in
  ~2 s, the open conversation refreshes itself, and the poll drops to a
  60 s safety net (`status` shows `push=true`)

</td>
</tr>
</table>

## Privacy

No server, no telemetry, no accounts. **Everything between the two machines
travels inside ssh** — message text, attachment bytes, the push ping — on a
dedicated key the Mac confines to Blip's five tools; nothing is ever sent in
the clear. The full inventory of what touches
disk on both machines is in [docs/PRIVACY.md](docs/PRIVACY.md) — short
version: message text never lands on disk; only attachments in conversations
you open are cached (inline images ≤ 5 MB and link previews fetch when the
thread does). The threat model and the findings of the 2026-08-31 security audit
are in [docs/SECURITY.md](docs/SECURITY.md).

## How it works

<p align="center">
  <img src="docs/architecture.svg" alt="architecture" width="920">
</p>

```
Linux                                         Mac
─────                                         ───
BarWidget.qml  ── push/poll ──▶ collector.ts ──▶ ssh ──▶ imsg --json recent 150+
                                                          (sqlite, read-only)
BlipView.qml   ── open thread ─▶ thread.ts   ──▶ ssh ──▶ imsg --json thread <id> 80
BlipView.qml   ── Enter ─────(body on stdin)──▶ ssh ──▶ imsg-send --to <id> --yes --text-stdin
                                                          imsg-send --chat-id "any;+;<guid>" …
                                                          (AppleScript → Messages.app)
```

The trick that makes it possible: **`sshd` on macOS inherits both Full Disk
Access and Automation consent.** `cron` gets neither. So a plain SSH session can
read `chat.db` and tell Messages.app to send, where every scheduled approach
dies at a TCC prompt nobody is there to click.

With `ControlMaster` in `~/.ssh/config`, a round trip is ~47 ms warm. Fast
enough to poll, fast enough that the panel feels local.

## Install

Blip is **one source**: the Mac-side tools ride along in `bridge/mac/`
(vendored from [claude-on-mac](https://github.com/nixfred/claude-on-mac),
pinned in `bridge/BRIDGE-VERSION`), and `blip-setup` wires everything.

**Requirements**

- A Mac on **macOS 13 Ventura or newer** (the Recently-Deleted table Blip
  filters on arrived there; Sequoia is what it is developed on), signed into
  Messages with your Apple ID, reachable from the Linux box over SSH with
  key auth — Tailscale recommended. *Messages in iCloud* on, so its `chat.db`
  mirrors your phone. Xcode Command Line Tools installed (`xcode-select
  --install`) — `python3` on a fresh Mac is a stub until then.
- A "Mac mini in a closet" works **after** the one-time grants: the two
  permission prompts and the first Automation approval need a screen (or
  Screen Sharing) once. After that it must stay in a **logged-in desktop
  session with Messages able to run** — enable auto-login, keep FileVault
  from prompting at boot (or accept a trip to the keyboard after every
  macOS update), and disable sleep. A Mac parked at the login window can
  read `chat.db` but cannot send.
- Linux: [Omarchy](https://omarchy.org) (Hyprland + the Omarchy shell), and on
  the box: `bun`, `jq`, `openssh`, `libnotify`, `wl-clipboard`, `xdg-utils`.
  `blip-setup` checks for each and prints the `pacman` line for what's missing.

> **Honest note on dependencies.** Blip is not a drop-in marketplace plugin
> the way a clock widget is: it needs `bun` on the Linux side, a Mac you own
> with two manual permission grants, and an ssh key between them. The
> plugin files install like any other; the *bridge* is what `blip-setup`
> exists for. Budget ten minutes and a trip to the Mac's System Settings.

> **If you are a human:** budget ten minutes, keep the Mac's screen reachable
> for two permission prompts, and use your *own* number for the first test
> message. Nothing below sends anything until you press Enter in a
> conversation.
>
> **If you are an AI agent installing this for someone:** run exactly the
> commands below, in order, and stop at step 3 until the human confirms the
> two grants on the Mac. Never send a test message to anyone but the user's
> own number. Do not edit `~/.ssh/config` beyond what `blip-setup` writes.
> Verify with `blip-check`, not by reading `chat.db` yourself. Before
> changing code, read [`AGENTS.md`](AGENTS.md) and [`CLAUDE.md`](CLAUDE.md).

**1. Install the plugin** (Omarchy's plugin manager clones it into
`~/.config/omarchy/plugins/nixfred.blip` and adds the bar widget)

```sh
omarchy plugin add https://github.com/nixfred/blip.git --enable
```

(Manual alternative: `git clone https://github.com/nixfred/blip
~/.config/omarchy/plugins/nixfred.blip`, then step 4.)

**2. Run the wizard** (idempotent — re-run any time; it prints the
`pacman` line for any missing Linux dependency and stops)

```sh
~/.config/omarchy/plugins/nixfred.blip/scripts/blip-setup you@your-mac
```

It writes `~/.config/blip/bridge.conf`, adds an ssh ControlMaster block
(polling costs ~50 ms instead of a handshake), installs the bridge shim as
`~/bin/imsg`, `~/bin/imsg-send`, `~/bin/contacts`, copies the Mac tools to
`~/.blip/bin` on the Mac and runs `install.sh` there, generates a
**dedicated ssh key** (`~/.ssh/blip_ed25519`) that the Mac confines to the
four bridge tools and nothing else, then smoke-tests the bridge without
printing any message content.

**3. Two grants on the Mac** (macOS won't let a script do these — the
wizard pauses here and re-checks when you press Enter)

- *Full Disk Access* → System Settings → Privacy & Security → Full Disk
  Access → add `/usr/libexec/sshd-keygen-wrapper` (⌘⇧G in the file picker).
  That is what lets an ssh session read `chat.db`.
- *Automation → Messages* → the first send from ssh pops an Allow prompt on
  the Mac's screen; click it once.

`ssh your-mac python3 ~/.blip/bin/blip-check` shows ✅/❌ per grant at any
time, with the fix for each ❌.

**4. Bar widget.** `omarchy plugin add --enable` already placed it. If you
cloned by hand: `omarchy plugin enable nixfred.blip --section right`, or add
`{ "id": "nixfred.blip" }` to `bar.layout.right` in
`~/.config/omarchy/shell.json`. Then `omarchy-restart-shell` — the speech
bubble is in your bar.

**5. (Optional) `SUPER+M` for the app window** — the Lua snippet under
"The app" above.

**Updating:** `omarchy plugin update nixfred.blip`, then `omarchy-restart-shell`
(a hot-reload alone leaves the plugin's IPC on a stale instance — see
`CLAUDE.md`). Re-run `blip-setup` after updates that touch `bridge/`; it is
safe to re-run.

**Toasts** — desktop notifications fire only for handles you list; everything
else still counts and still shows.

```jsonc
// ~/.config/blip/allowlist.json — re-read every poll, no restart
{ "allow": ["+15551234567", "them@icloud.com"] }
```

**Outside North America:** set `country_code=44` (etc.) in
`~/.config/blip/bridge.conf` so a number typed without a country code in
"New message" resolves correctly. Green-bubble (SMS/RCS) conversations
send on their own service automatically.

**Two or more monitors:** one bar widget per screen is normal; only the one
on the first screen polls and owns the app window, the others show the
badge and forward clicks to it.

## Keyboard

| where | key | does |
|---|---|---|
| list | `j` / `k` · `↑` / `↓` | move |
| list | `Enter` · `1`–`9` | open thread |
| list | `r` | refresh |
| list | `a` · *mark all read* link | clear every badge and dot (local only — iMessage itself is not told) |
| list | `/` | search every message ever — Enter runs it, click a hit to open its conversation, Esc backs out |
| list | `n` · *＋ new* link | start a conversation with anyone — search contacts by name, or type a number/email directly |
| thread | `Enter` | send (text, or the queued file with the text as caption) |
| thread | `Ctrl+V` | paste — an image on the clipboard becomes a queued file, text pastes normally |
| thread | `/attach <path>` + `Enter` | queue any file on this machine; drag-and-drop works too |
| thread | `Esc` | back to list (or clear a text selection first) |
| anywhere | `Esc` | close |

IPC, for scripts and other plugins:

```sh
qs -p /usr/share/omarchy/shell ipc call nixfred.blip status
qs -p /usr/share/omarchy/shell ipc call nixfred.blip goto 15551234567   # bare digits
qs -p /usr/share/omarchy/shell ipc call nixfred.blip read               # mark all read
```

Everything that sends or reads message content over IPC (`goto`, `compose`,
`bubbles`, `threads`, `find`, `newchat`, `read`) is **off by default** — any
local process could otherwise send as you. Turn it on with `automation=on`
in `~/.config/blip/bridge.conf` (re-read live). `status`, `open`, `close`,
`toggle`, `window`, `app` are always available.

## Design notes worth knowing

**Two read marks, not one.** The collector keeps `watermark` (highest timestamp
it has *seen* — drives toasts) separate from `readMark` and per-thread
`readMarks` (highest timestamp *you* have looked at — drives the badge and the
dots). Fold them together and the badge flashes to 1 and resets on the next
poll. Yes, that shipped once.

**Unread is a ledger, not a window.** The latest 150 rows are enough for normal
previews, but unread counts and oldest-unread timestamps live in a metadata-only
per-chat ledger. Blip expands the fetch to cover new arrivals and the oldest
outstanding unread, then rebuilds exact counts from that range. An unread cannot
fall off the preview window or remain counted after deletion.

**Groups send by GUID.** Message rows carry a group as a bare
`chat_identifier` (32 hex, or `chat<digits>`); AppleScript's `chat id` wants
the full `any;+;<id>`. A group's `handle` field is whichever member spoke last
— send to *that* and you DM one person while the panel shows the group.
`imsg groups` supplies the real GUID; a group whose GUID isn't cached yet is
read-only rather than guessed.

**The self-thread lies.** A message you send yourself lands twice: once
`from_me=true`, once `from_me=false`, same timestamp and text. Every counter and
every bubble runs through `dedupeSelfEcho()` first or your own notes light the
badge forever.

**Deleted means deleted.** macOS keeps deleted messages in a 30-day "Recently
Deleted" bin that is still in `chat.db`. claude-on-mac's `imsg` hides those rows, so
a conversation you delete on the phone disappears from Blip within one poll of
the iCloud sync. `IMSG_INCLUDE_DELETED=1` shows them again.

**No message bodies are stored on Linux.** `~/.local/state/blip/state.json`
holds timestamps, unread counts, SHA-256 toast-dedupe keys, inferred self-chat
ids, and group metadata. It is written atomically with mode `0600`; legacy
plaintext toast keys are hashed on migration. No message text is persisted.
The 273,000-message history stays on the Mac where it lives.

## What it can't do

- **Send read receipts.** Tested: opening the conversation on the Mac via
  `open imessage://…` does not flip `is_read`. Needs Apple's private API.
  (Showing *their* receipts on your messages works fine — that's in.)
- **Send tapbacks, edits, or threaded replies.** AppleScript can't; Blip
  *displays* all three. If you need to send them,
  [BlueBubbles](https://bluebubbles.app) is the right tool and requires
  disabling SIP.
- **Work without a Mac, or while the Mac sleeps.** Inherent to the approach.
  The widget dims and tells you.

## Development

```sh
bun test                                     # 177 tests, ~70 ms
bun collector.ts --deep | jq '.unread, (.threads|length)'
bun thread.ts +15551234567 40 | jq '.bubbles[-1]'
```

Logic lives in TypeScript where it can be tested; QML only renders. Every
layout bug so far was found with `grim` and eyeballs, not by reading code —
screenshot your changes. See [CLAUDE.md](CLAUDE.md) for the invariants.

## Contributing

Pull requests welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) (short; the
one rule that matters: never test sends against a real contact). Security
reports go through GitHub's private reporting, not issues.

## Credits

Built by Fred Nix and Larry (his Claude Code collaborator) — 1.0 in one
evening, 2.0 the next — on
[Omarchy](https://omarchy.org). The Mac side is entirely
[claude-on-mac](https://github.com/nixfred/claude-on-mac) — it predates Blip,
and it's the reason this took an evening, not a week.

**Contributors:** [@jethrojones](https://github.com/jethrojones) — `blip-check` across every Contacts source (#2).

MIT.
