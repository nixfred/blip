# For AI agents working in this repository

You are probably here because a human asked you to install, fix, or extend
Blip. Read this first; it is short and every line has cost someone an evening.

## Non-negotiable

1. **Blip sends real iMessages to real people.** For any test that sends,
   the only acceptable target is the user's *own* number (their self-thread).
   Never a contact, never a group. Ask for the number if you do not have it.
2. **Never open, read, or quote a real conversation** to debug. Work from
   code, tests, and `bun collector.ts --deep | jq` shapes (metadata).
3. **Message text never touches disk on Linux and never rides argv** on
   either machine. If your change needs either, stop and redesign.
4. **No hostnames, user names, phone numbers, or home paths in code, tests,
   docs, or commit messages.** Use `+15551234567`, `you@your-mac`, `$HOME`.
5. **Logic in TypeScript with a test; QML only renders.** `bun test` must be
   green (CI enforces it). QML has no unit tests — screenshot UI changes
   with `grim` and look at the image.

## Where things are

- `CLAUDE.md` — architecture map and the invariants (read-marks, group
  sends, the hot-reload IPC zombie, scrolling, window lifecycle). Read it
  before editing `BarWidget.qml`, `BlipView.qml`, or `collector.ts`.
- `docs/SECURITY.md` — threat model and audit findings. `docs/PRIVACY.md` —
  what lands on disk.
- `bridge/mac/` — the Mac tools (Python, stdlib only). `bridge/linux/blip-shim`
  — the ssh shim. `scripts/blip-setup` — the wizard.
- `ROADMAP.md` — what is done, what is deferred and why.

## Installing for a human

Follow README "Install" exactly. Stop at step 3 and wait for the human to
click the two macOS prompts; `blip-check` tells you when they have. Do not
try to grant TCC permissions programmatically — it is not possible, and
attempts trigger prompts on the Mac's screen.

## Deploying a change locally

```sh
bun test
cp *.qml *.ts *.mjs manifest.json ~/.config/omarchy/plugins/nixfred.blip/
omarchy-restart-shell        # NOT a hot-reload: IPC would stay on the old instance
qs -p /usr/share/omarchy/shell ipc call nixfred.blip status
```

Mac-side tool changes: `scp bridge/mac/<tool> you@your-mac:~/.blip/bin/`.

## Commit messages

Subject under 72 chars; body says WHAT and WHY, and names any invariant you
touched. The log is the project's memory.
