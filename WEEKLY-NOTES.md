# Blip weekly contributor notes

Working notes for the PUBLIC weekly Blip update that @nixfred posts. One section
per ISO week, newest first. Notes go in the same turn the work lands, never
reconstructed on Sunday from memory.

**How these notes are kept (Fred, standing, 2026-09-18)**
- Every merged PR gets a line THE DAY IT MERGES: number, one sentence a
  non-contributor understands, the contributor's real name, and their X handle
  as a link when it is verified (rules and the verified list: `CHANGE.log`).
- Record what was actually verified and the real numbers, because that is what
  makes the post worth reading: measured before/after, tests run, what was NOT
  checked.
- Credit the reporter of a bug as well as its fixer.
- EVERY contributor is paired with an X account. If the lookup cannot verify
  one, ask Fred THE SAME DAY the PR merges (standing, 2026-09-18), never at
  post time: he often knows the person or can just ask them. Open questions
  live in "Handles Fred still needs to answer" below until they are answered.
- Anything a contributor should know that is not in the diff (a trade-off, a
  follow-up left open, a decision that went against their PR) goes here too.
- On Sunday the week's section becomes one post, drafted into `X-POSTS.md`, and
  the section is marked POSTED with the link. Nothing is posted by Larry; Fred
  reads and posts.
- A week with no merges still gets a section saying so. Silence is data.

---

## 2026-W39 (Mon 21 Sep to Sun 27 Sep): OPEN, post due Sun 27 Sep

2 PRs merged so far, from 2 people.

### Wed 23 Sep: one merge

- **#113 turning the monitor off no longer takes Hyprland down.** Brad Larson
  (github.com/followbl; X handle likely @followbl, same login and name, asked
  Fred 2026-09-23, not tagged until answered). With the Blip window open,
  powering off the only monitor, or a DisplayPort monitor dropping off when
  it sleeps (his Samsung C49HG9x), segfaulted Hyprland 0.56.2 on four separate
  nights. Qt swaps the lost output for a placeholder screen with no name and
  no size, Omarchy builds a bar on it, and Blip's widget on that bar crowned
  itself leader and restored the app window, mapped with nowhere to put it.
  The leader rule moved into a pure TypeScript module (`screen-leader.ts`,
  built to `ScreenLeader.mjs`) and a widget now leads only on a real screen.
  Verified here in Test Drive on the same Hyprland 0.56.2 / Quickshell 0.3.1:
  an instrumented build showed the placeholder arriving as `["",0,0]` and the
  new rule answering `leader=false` with no window, where the old rule led
  and mapped one (its second IPC handler showed up in the shell log). Not
  verified: the segfault itself. Hyprland in the VM stands up a FALLBACK
  output in the same event, so the window landed there; Brad's DisplayPort
  race is what leaves Hyprland with no output at all. gus logged the same
  placeholder event twice on 20 Sep. Deployed on gus and vic with the merge.
  Trade-off he accepted: no polling or toasts while there is no screen, and
  nothing could show them anyway.

### Tue 22 Sep: one merge

- **#111 the deploy recipe in CLAUDE.md stops dropping files.** Ian Swope (no
  verified X handle). Four stale facts, two of which silently cost working
  features on any machine deployed by following it: the `cp` line left out
  `otp-desktop.py`, which the autofill helper spawns from the installed plugin
  directory, and the shim list stopped at four names when `blip-setup` has
  installed a fifth, `contact-save`, since #91. It was not hypothetical here.
  vic had been taken from 2.5.0 to 2.6.1 with that exact recipe on 20 Sep, so
  its helper was still the 2.5.0 copy and #110's Zen/Firefox fix never reached
  it. Neither gus nor vic had `contact-save`, so Save-as-contact failed on both,
  and all five shims on both machines dated from 1 Sep. Fixed on both machines
  with the merge. Verified: `contact-save` now reaches the Mac and gets the
  tool's own refusal for empty input, where it used to be refused locally with
  exit 64, and `imsg` still exits 0 through the refreshed shim.
- Not merged, for the record: Ian also filed #112. Chrome, and Blink generally,
  never exposes HTML `autocomplete` over AT-SPI, so security-code detection on
  Chromium-family browsers is label-only. Left open on purpose (Fred,
  2026-09-22). A missed label still gets the weaker "Select a field, then fill"
  prompt; it is not silent.

## 2026-W38 (Mon 14 Sep to Sun 20 Sep): OPEN, post due Sun 20 Sep

27 PRs merged so far, from 8 people.

### Mon 15 Sep: ten merges, the Codex-audit backlog cleared

- **#80 stamps cross the bridge as UTC, local time is a display concern.** Zach
  Wilke, https://x.com/zachwilke_1. Reported by cjoh (GitHub, no handle found).
  The Mac's naive clock compared against a Linux clock meant nothing counted as
  unread one way and the backlog re-toasted the other, and in the DST fall-back
  hour two messages an hour apart carried the same stamp. Consequence for
  anyone still on an old bridge: stamps are normalised at the two fetch doors,
  so a half-upgraded pair keeps working.
- **#81 animated GIFs arrive as their own bytes.** Zach Wilke. The Mac
  resampled every image with sips, so a 1.4 MB GIF reached Linux as a 198 KB
  still, motion gone before the panel saw it.
- **#82 a message carries every file you drop.** Zach Wilke. Dropping five
  photos attached one and discarded four silently. Capped at ten, caption on
  the first part only.
- **#84 docs: outbound tapbacks are half possible on macOS 26.** Zach Wilke.
  Menu items exist and are scriptable; what is unsolved is selecting a bubble
  remotely. Do not quote the old "impossible" note.
- **#75 a 3-4 digit short code is a DM, not a group.** Ian Swope (no verified X
  handle). 611 and 2536 opened read-only, so you could not reply STOP.
- **#76 no toast for the conversation you already have open.** Ian Swope.
- **#77 README allowlist and mutelist examples now parse.** Ian Swope. Copied as
  shown, they configured nothing and said nothing.
- **#85 follower bars stop toasting on every extra monitor.** Ian Swope. Docked
  to two externals, every message fired three toasts. Every bar crowned itself
  leader for the first few hundred ms after a hotplug.
- **#88 the panel no longer hangs half-faded.** Ian Swope. Measured with a
  frame-gap probe: 441 to 627 ms of blocked GUI thread per open, because the
  list rendered all 300 rows when ten are on screen.
- **#87 the app window stays on its workspace after idle.** Danny Cecil,
  https://x.com/jefehoser.

### Tue 16 Sep: four merges

- **#95 a message read on another device never toasts.** Ian Swope, fixing #89
  reported by Marshall Huss, https://x.com/mwhuss. Waking the laptop replayed
  the night as up to twenty toasts, including messages already read on the
  iPhone.
- **#93 Super+M only ever touches the real Blip window.** Danny Cecil,
  https://x.com/jefehoser. It matched any title starting with "Blip", so a
  browser tab called "Blip documentation" got closed instead. Users must
  re-copy the binding from the README; updating the plugin cannot change a
  Hyprland config.
- **#94 right-click a message to quote or copy it.** Danny Cecil. Behaviour
  change worth flagging in the post: right-click on text used to copy
  instantly, now it opens a menu.
- **#92 a security code offered beside the field that wants it.** Brenden
  Bishop, https://x.com/bbishdotdev. Opt in with `otp_autofill=on`. Tested in a
  VM before merge: the labelled field and six separate digit boxes both filled,
  a field labelled Message got no prompt, the clipboard never held a code. Be
  honest in the post: a plain unlabelled field gets a manual prompt and a click
  puts the code there, which is documented design, not a defect.

### Wed 17 Sep: five merges

- **#98 one never-opened unread no longer slows every poll.** Ian Swope. The
  fetch boundary was one global minimum, so a single dot nobody opened set the
  depth for every poll: 150 rows doubling to 8192 across that many sequential
  ssh calls. His measurement, a 45-day dot: 6 calls, 4798 rows, 3.18 s against a
  6 s timer. Re-measured here on a crafted six-week-old dot against the live
  bridge, twice each: 1.8 s to 0.63 s, same unread count. Follow-up left open
  and worth saying out loud: `imsg thread` bounds by rows, not date, so a
  `--since` on the bridge would make each of these one exact call.
- **#101 a read dot no longer returns while the badge says zero.** Damon Janis,
  https://x.com/damonjanis. The no-op cache did not move when an optimistic
  read mutated the model. First real QML regression test in the repo: it runs
  the shipping bar code under Qt, 6 pass, and 2 fail against the old code
  (verified both ways here).
- **#102 a read push is done only when the Mac's count reaches zero.** Damon
  Janis. 3 to 2 exited 0, and so did "cannot verify". Trade-off for the post: a
  message landing inside the three-second settle now reports failure for a push
  that cleared what it could. Neither of us tested it live, because that means
  marking every conversation read on a real account.
- **#96 `prefer_imessage=on` keeps a mixed 1:1 on iMessage.** Baden,
  https://x.com/bhp35. One RCS inbound turned every later send green and the
  Mac logged SMS error 4 while the iPhone had delivered. Off by default. Say
  plainly: an old successful iMessage counts, so a contact who moved to Android
  is tried on iMessage until a send fails.
- **#99 CLAUDE.md records rank-then-size for contact sources.** Ian Swope,
  catching our own note going stale the same day the code changed.

### Fri 18 Sep: four merges, one fix of ours

- **#104 one Linux-shim line in the shape diagram.** Ian Swope (no verified X
  handle). Our own bin_dir merge left two versions of the same line, one
  already stale. He caught it the same day.
- **#106 a group read reaches the Mac.** Jon Kinney, https://x.com/jondkinney.
  Per-thread read push was DMs only because a group id has no `imessage://`
  form. Messages has a second deep link, `imessage:open?groupid=`, so a group
  read in Blip now clears on the phone with `push_read=thread`. This overturns
  our own "a group cannot be addressed at all" note. VERIFIED LIVE here on
  macOS 27 before merging: opened a real group by URL and read back Messages'
  front window title, which was the group's participant list, then restored the
  front app. Not tested end to end, because that marks a real conversation read
  on a live account.
- **#105 a source-routing seam, and nothing else changes.** David Reinecke
  (github dreinecke, no verified X handle). Every per-conversation spawn asks
  which bridge answers for that id; stock Blip has one source and resolves
  exactly as before, pinned by tests. Fred agreed to the seam alone on #70 with
  the contributor's second messenger staying in his fork. Checked here:
  SourceId.mjs is byte-identical to a fresh build of source-id.ts, and a live
  collector run on the branch gave the same counts as main.
- **bin_dir= really moves every shim now.** Found by Kb2uka (github, no
  verified handle) while rebasing #91: exact-card details and vCard export
  still called ~/bin/contacts directly, so moving the shims broke both. The
  guard test missed it because its regex matched only double quotes and two
  tool names. Fixed and widened on main (4134bbf), separately from his PR, so
  the fix is not waiting on a feature review.

- **#108 a read push counts the whole conversation, not one chat row.** Ian
  Swope. imsg-read verified with an exact match on one chat row, but Messages
  splits a conversation across rows: with the unread on an alias it printed
  "nothing unread" and silently never pushed, and settle() agreed. This is our
  own cluster invariant that the verification was not following, and it sits
  directly on #102's "the count is the referee". Not reproducible on our own
  Mac (no identifier there currently has more than one row); his tests carry it.

### Sat 20 Sep: 2.6.0 and 2.6.1

- **2.6.0 cut**, 27 PRs this week from 8 people. Headline: security codes fill
  themselves, an unknown sender can be saved as a contact, right-click quotes a
  reply, a group read in Blip clears the phone, Send Later shows as Scheduled,
  GIFs arrive as GIFs, stamps cross the bridge as UTC.
- **2.6.1, our own fix, found while verifying #109.** Every follower-to-leader
  forward ran `qs -p /usr/share/omarchy/shell`, and `qs` matches instances by
  config path, so on any machine running the shell from a checkout
  (`omarchy dev link`, which is this one) all six forwards exited 255 with
  "No running instances". The shell's own summon still returned ok, so a second
  monitor's bar icon and its hotkey did nothing and said nothing. Four of the
  six calls predate #109; joshhattan's two matched the house style and were
  right to. Now `Quickshell.shellDir`, which IS the stock path on a stock box.
  Worth saying plainly: #109 was correct and its own test passed, and the
  feature was still inert here. A guard test now fails on any re-hardcoded path,
  and it was checked against the old file to prove it can fail.

### Fri 19 Sep: two merges

- **#110 the security code fills in Zen and Firefox.** joshhattan (github, no
  handle published; asked on the PR how he wants to be credited). Clicking
  "Fill code" in Zen did nothing and said nothing: Gecko's accessibility layer
  returns success from `set_text_contents()` and writes nothing, and the helper
  returned straight after the call without ever reading the field back. It now
  re-reads, and types the code through the same Hyprland key path Chromium
  already uses when the field is still empty; a write that did land keeps the
  early return, so the digits are never entered twice. Verified here on the
  merge: 621 bun tests and 8 python tests green, and his new fallback test
  fails on main without the change. NOT reproduced on our own screen, because
  neither Zen nor Firefox is the browser here; his evidence is a live sign-in
  page in Zen 1.22.2b plus a test page counting `input` events. One thing left
  open for him: Gecko's write is synchronous, so a late-landing write plus the
  typed keys would double the code, and nothing re-checks between the two.

- **#109 a window you move stays put, and the popout follows the icon you
  clicked.** joshhattan (github, no handle published; asked on the PR, still
  open). Three fixes in one PR. The first is the good one: `sameAddress()`
  compared the window's own address, `0x5b1604b31bf0`, against the address
  Hyprland puts on the event socket, `5b1604b31bf0`, as plain strings. They
  never matched, so the `reason: "move"` path added by #87 was dead code from
  the day it shipped and `strayReturn` undid every deliberate move about 400 ms
  later. Nothing covered it: the #87 devlog proved a stray move is returned but
  never that a real move is saved, and `ui.test.ts` only asserted the string
  `sameAddress` existed. Both address formats confirmed here on gus against
  socket2 and `hyprctl clients`. The other two are the multi-monitor bar: only
  the first screen's widget owns a panel, so a click on any other bar, and
  `SUPER+CTRL+<n>` on any other screen, went to the leader's copy or nowhere at
  all, silently, with the shell counting it as success. Followers now forward
  their screen name, and the leader re-anchors the panel to that bar. He chose
  a separate open-only verb (`openon`, not `toggleon`) so a hotkey meaning
  "open" cannot close a panel that is already up, which is the right call and
  meshes with Omarchy's own routing: `BarModel.pickPanelSlot` prefers an open
  copy, so the next press still reaches the leader and closes it. Verified here
  by deploying onto the live shell and driving every verb, plus a screenshot.
  NOT verified here: gus has one monitor attached, so the follower path was
  only exercised through IPC, not across two physical bars. His DP-1/DP-2
  testing carries that half. His base was three commits old, so it was
  cherry-picked onto current main first; only CHANGELOG conflicted. 622 tests
  green.

### Waiting on people, Fri 18 Sep
- **#103** Damon Janis, https://x.com/damonjanis: CI failed on a GitHub 504
  downloading bun, nothing to do with his code; re-triggered. Now conflicts
  with #106 in the same helper, so it needs a rebase. Fred answered his open
  question: the badge counts unread CONVERSATIONS, as he proposed.
- **#91 MERGED** Kb2uka (no verified handle, asked on the PR): saving a NEW
  contact to the Mac. Breaks our "nothing is ever written to Contacts"
  invariant, so Fred decided it after a full read of the write path: create
  only (no delete or modify path exists in the helper), duplicate-refusing,
  reads the card back before reporting success, handle must match the saved
  identity, fields on stdin, fails closed without the Contacts grant. Not
  exercised live: creating a real contact needs the prompt answered at the Mac.
- **#83** Zach Wilke, https://x.com/zachwilke_1: no movement since 15 Sep,
  still conflicting with an unanswered review. Nudged, offered to close it.
- **#25** Jon Kinney: gated contact writes, still a draft; Fred's full review
  is on the PR and the delete path is refused.

### Ours this week, for context in the post, not credit
- Blip 2.5.0 shipped Sun 13 Sep.
- A waiting Send Later message showed as already sent and became a
  conversation's newest message; fixed 16 Sep. Found checking macOS 27.
- Everything Blip taught us about the Mac helpers went upstream as
  claude-on-mac v2.0.0 (16 Sep), including the group-send -1728 fix, macOS 26
  unsend detection, region-aware phone matching and UTC stamps.
- macOS 27 (27.0, 26A428) verified: every read path, contacts, photos, sending.
- vic ran an old Blip against the updated bridge and showed every message at
  12:00am. Our miss, not a contributor's: a bridge change has to reach every
  client in the same step.

- **The app window opens where you are (1b148f8, ours).** Blip's home-workspace
  restore (#87) claimed a home from wherever the window first landed and then
  restored onto it even when that workspace was gone, so Hyprland created it and
  moved the reader there; plonk renumbered it underneath. Now only a deliberate
  move claims a home, and a dead home is ignored. Traced on Hyprland's event
  socket, which is the quickest way to see this class of bug. Not a contributor
  issue, and worth a line in the post because anyone running a workspace
  compactor would hit it.

### Handles Fred still needs to answer (asked 2026-09-18)
- **Brad Larson** (github.com/followbl, #113), asked 2026-09-23. Nothing
  published on GitHub or his site metaintro.com. https://x.com/followbl has
  the same unique login and the same name, 905 followers, posts about AI
  models; no Omarchy/Blip/@NixFred post in the 7-day window. Likely him.
  Untagged until Fred answers; do not guess.
- **Ian Swope** (github.com/ianswope), 12 merged PRs, the most of anyone this
  week. Nothing published; @IanSwope on X carries his name but is dormant with
  no tie to Linux or GitHub. FRED IS ASKING HIM (2026-09-18). Untagged until he
  answers; do not guess.
- **Jethro Jones**: ANSWERED 2026-09-18, tag https://x.com/jethrojones.
- **cw228** (#100), **Kb2uka** (#90, #91) and **cjoh** (reported #86): asked on
  their own PRs/issue 2026-09-18 how they want to be credited, with "rather not
  be tagged" offered as an equally good answer. Waiting.
- **joshhattan** (#110, merged 19 Sep): nothing published at all, not even a
  real name (the GitHub profile name is "kj3h4g5"). Asked on the PR. Fred's
  call 2026-09-19 was to log "none found" and revisit at post time.
- **tolewis**, **jacobaross**, **apexbenny**,
  **dreinecke**, **znayer**, **Erik Fillipsveen**: nothing published, and Erik
  is the largest contributor to the project overall.

### Standing items to mention when they resolve
- Ian Swope has 12 merged PRs and no X handle anyone can verify. If someone
  knows it, we tag him properly.
- #83 (Zach Wilke, hold the Mac channel open) is still blocked on the socket
  ownership review and conflicts with main.
- #100 (cw228, `bin_dir=`) conflicts with main.
- #90 and #91 (Kb2uka, delete messages, save contacts) are still drafts.

---

## 2026-W37 (Mon 8 Sep to Sun 14 Sep): not posted weekly at the time

Covered by the long contributor post of 11 Sep (`CONTRIBUTORS-X-POST.md`, 51
PRs, 15 contributors) plus the 13 Sep merges: #54 (Jon Kinney,
https://x.com/jondkinney, sending a link no longer opens the share sheet), #71,
#72, #73, #74 (Ian Swope: `blip-setup` stdin, plain-text sinks, a copied
security code no longer lingering in /proc, README removal instructions).
Blip 2.5.0 shipped on 13 Sep.
