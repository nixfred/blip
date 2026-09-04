# Privacy — what Blip touches, and where

Blip has no server, no telemetry, no accounts. Everything runs between your
Linux machine and a Mac you own, over your own ssh. This is the complete
inventory of what lands on disk.

## On the Linux machine

| Path | Contains | Never contains |
|---|---|---|
| `~/.config/blip/bridge.conf` (0600) | Mac ssh target, remote tool dir, path of Blip's key, `automation=` switch | credentials |
| `~/.ssh/blip_ed25519` | Blip's dedicated ssh key — confined on the Mac to the bridge tools | — |
| `~/.config/blip/allowlist.json` | handles allowed to raise desktop toasts | message text |
| `~/.config/blip/mutelist.json` | handles and phrases you typed, whose conversations Blip hides entirely | message text Blip received |
| `~/.local/state/blip/state.json` (0600, atomic) | poll watermark, read marks, per-chat unread counts and oldest-unread timestamps, self-chat ids, group names/members, opaque SHA-256 toast keys | **message bodies — ever** |
| `~/.local/state/blip/window.json` | whether the app window was open, its size | anything else |
| `~/.cache/blip/att/` (0700, files 0600, 500 MB LRU, no expiry) | attachments you viewed, plus images ≤ 5 MB and link-preview thumbnails in any conversation you *open* (they render inline, so they are fetched when the thread is). HEIC arrives converted to JPEG. File names carry the Mac's attachment row id and a sanitized name whose extension follows the MIME type | attachments in conversations you never opened |
| `~/.cache/blip/linkpreview/` (0700, files 0600, 7-day TTL) | title, description and picture of pages linked in your messages, for links Messages did not decorate | anything from a page nobody linked you to |
| `~/.cache/blip/avatars/` (0700, files 0600, 7-day TTL) | contact photos for people in your thread list, named by a hash of the handle; an empty `.none` marker for contacts without one | names, numbers |
| `$XDG_RUNTIME_DIR/blip/` (tmpfs, 0700) | images pasted into the compose box; a 60s AddressBook dump (`contacts-dump.json`, names, phones, emails) for live new-message search; swept after an hour and gone at logout | message bodies |
| `~/bin/imsg`, `~/bin/imsg-send`, `~/bin/contacts` | the bridge shim (a bash script) | — |

**Marking a conversation read is visible to the sender.** Blip can now tell
Messages on the Mac that you have read something (`push_read=` in
`bridge.conf`, default `all` — the explicit mark-all-read gesture only). It does
that by clicking Messages' own menu item, so it behaves exactly like reading on
the Mac: if you have read receipts enabled, the sender sees one. Set
`push_read=off` to keep Blip's read state entirely local, which is what it did
before.

**Link previews reach out to the web.** Messages decorates some URLs with a
preview card and leaves most bare. For a bare one Blip fetches the page itself
— from THIS machine, never the Mac — and reads its Open Graph tags. That
contacts the site, so the site (and anyone who sent you a link) can tell the
page was loaded, exactly as Messages.app's own preview does on the Mac. No
cookies are sent, no JavaScript runs, only http(s) is followed, at most three
redirects, and a host that resolves into your LAN or to a cloud metadata
address is refused. Turn it off with `link_previews=off` in
`~/.config/blip/bridge.conf`.

Message text lives only in memory while the panel or window is open. Desktop
toasts show a sender name and a preview through your notification daemon,
gated by the allowlist — and your notification daemon may keep its own
history. Blip itself logs nothing; the shell's stderr (journald) sees
recipients and exit codes, never bodies (`imsg-send` prints a byte count).
Message bodies do pass through process arguments on both machines, visible
to other processes running as you.

Threat model and the audit findings behind these notes: [SECURITY.md](SECURITY.md).

## On the Mac

| Path | Contains |
|---|---|
| `~/.blip/bin/` | the bridge tools (`imsg`, `imsg-send`, `contacts`, `tcc-check`, `blip-check`) |
| `~/.blip/src/` | the installer's copy of the same files |
| `~/Pictures/.blip-outbox/<id>/` | a file you are sending, for the seconds until Messages copies it into its own store; then moved to `~/.blip/sent` (leftovers older than an hour are swept) |
| `~/.blip/sent/<id>/` (200 MB LRU) | files Blip sent — kept because Messages often leaves the attachment record pointing at the staging path instead of copying it, and Blip would otherwise never be able to show your own photo again |

The tools read `~/Library/Messages/chat.db`, the AddressBook database, and
Messages' pinning preferences read-only, and drive Messages.app through
AppleScript. They write nothing else. Messages.app itself keeps your
conversation history exactly as it always has.

## Permissions the Mac asks for

- **Full Disk Access** for `/usr/libexec/sshd-keygen-wrapper` — so an ssh
  session can read `chat.db`.
- **Automation → Messages** for the same — so an ssh session can send.

Both are one-time grants in System Settings; `blip-check` reports which are
missing. Blip never asks for Contacts, Camera, Microphone, or Location.

## What crosses the network

Only ssh between the two machines: message queries and previews, ordered
conversation-pin metadata, attachment bytes you request, and files you send.
Push notifications use a
content-free "something changed" ping — a watcher on the Mac emits a
timestamp when `chat.db` changes; the client then fetches privately.

## What Blip cannot do

Send read receipts, send tapbacks, edit or unsend, see typing indicators.
Those need Apple private APIs that Blip deliberately does not use.
