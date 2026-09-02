# Changelog

## 2.0.4 — 2026-09-01

**Changed**
- New inbound messages fire a **system notification** by default (Omarchy's
  notification daemon via `notify-send`). The tiny bar badge is no longer
  the only alert. Click the toast to open that conversation.
- `~/.config/blip/allowlist.json` is now a toast *policy*, not a required
  gate. Missing file = notify everyone. `{ "mode": "off" }` is silence.
  A populated `{ "allow": ["+1…"] }` still filters to those senders.

**Upgrade note.** If you liked the old quiet default (badge only, no
toasts until you wrote an allowlist), write:

```json
{ "mode": "off" }
```

A legacy empty `{ "allow": [] }` or `[]` still means off. A missing file
does not.

**Fixed / hardened**
- Allowlist matching folds US numbers (`+1555…` / `(555) …`) and emails
  (case-insensitive). Hex group ids are never digit-folded into a phone.
- The conversation you have open is not toasted — you did not miss it.
- The self-thread is not toasted.
- A catch-up after sleep emits at most 20 newest toasts, oldest of that
  batch first.
- Attachment-only rows say "New message" instead of the U+FFFC placeholder.
- Group toasts read `Alice · Family`.
- Corrupt `allowlist.json` fails closed (off), not open (spam).
- Toasts stay on screen 15 s (`--urgency=normal`, `--category=im.received`).

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
