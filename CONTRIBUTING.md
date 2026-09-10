# Contributing to Blip

Thanks for looking. Blip is small enough to read in an evening; please do
before opening anything — `CLAUDE.md` lists the invariants that are easy to
break and expensive to rediscover.

## Ground rules

- **Pull requests are the front door.** Fork, branch, PR against `main`. CI
  runs `bun test`, byte-compiles the Mac tools, and shellchecks the shims;
  it must be green.
- **Your first PR's checks wait for a maintainer.** This repo requires approval
  before workflows run on a fork PR from a first-time contributor, so your run
  sits at *action required* with zero jobs until someone clicks Approve. If
  nobody does, GitHub eventually marks it **failed** with "This workflow run
  required approval but was not approved before it expired" — that is the
  approval expiring, not your code. It has no job logs because no job ever ran.
  Ping the PR and it will be approved; re-running after approval gives a real
  result. Maintainers: approve the run *before* merging, so the PR carries a
  genuine green tick rather than an expiry (#44).
- **Logic lives in TypeScript, QML only renders.** If you are adding
  behavior, it goes in a `.ts` file with a test in the matching
  `*.test.ts`. QML gets a binding, not an algorithm.
- **Never test against real people.** Blip sends real iMessages. Use your
  own number (the self-thread) for anything that sends; never a contact,
  never a group. Tests must not shell out to `imsg-send` — inject a runner
  (see `send-file.ts` / `tier2.test.ts` for the pattern).
- **No message content on disk, ever.** `state.json` holds timestamps,
  counts, and opaque keys. If your change needs to persist text, it needs a
  different design — open an issue first.
- **No hostnames or personal paths in code.** The Mac host comes from
  `~/.config/blip/bridge.conf`; `$HOME` comes from the environment.
- **Message text stays off argv.** Bodies travel on stdin (`--text-stdin`,
  `--text-stdin-bytes`). Keep it that way on both machines.

## Running it

```sh
bun test                                   # unit tests, ~70 ms
bun collector.ts --deep | jq .unread       # live poll through your bridge
bun thread.ts <chat-id> 40 | jq .bubbles   # one conversation
cp *.qml *.ts *.mjs manifest.json ~/.config/omarchy/plugins/nixfred.blip/
omarchy-restart-shell                      # QML changes need a restart, not a hot-reload (see CLAUDE.md)
```

UI changes: screenshot them (`grim`) and look. Every layout bug so far was
found with eyes, not by reading code.

## Commit messages

Subject under 72 characters, then a body that says WHAT changed and WHY —
the log is the project's memory. Reference the invariant you touched if
you touched one.

## Mac-side tools

`bridge/mac/*` is vendored from [claude-on-mac](https://github.com/nixfred/claude-on-mac)
(pinned in `bridge/BRIDGE-VERSION`). Fixes to `imsg`, `imsg-send`, or
`contacts` are welcome here; Blip-only tools (`blip-check`, `blip-dispatch`)
live only here.

## Security

See [docs/SECURITY.md](docs/SECURITY.md) for the threat model and the audit
history. To report a vulnerability privately, use GitHub's
"Report a vulnerability" on the Security tab rather than a public issue.
