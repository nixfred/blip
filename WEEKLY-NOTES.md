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

## 2026-W46 (Mon 9 Nov to Sun 15 Nov): OPEN, post due Sun 15 Nov

### What people said this week (quote with attribution in the post)

- **Ian Swope (https://x.com/ianfs) on #132, Mon 9 Nov**, answering Fred's question about the Pin gap: "the claim in
  #150 was mine to check. My round trips used a chat whose row was already on screen, so "`open imessage:` brings a
  row into view" was never actually tested." Then he tested it and sent the fix (#154).
- **Matt (https://x.com/MattDbrow) on #152, Sun 8 Nov 23:11Z**: "Thanks — my X handle is @MattDbrow."
- **Marcus Vorwaller (github.com/marcus, no X found 9 Nov) on #156, Mon 9 Nov**: "I'm opening it to start a
  conversation, not expecting a merge as-is. Happy to split it, drop parts, or keep the UI in my fork and send only the features you want."
- Comment sweep Mon 9 Nov (since 8 Nov): the three notes above, nothing else from outside.
- **Marcus Vorwaller (github.com/marcus) on #156, Tue 10 Nov**, after splitting it into six PRs: "The restyle stays in my fork.
  The extractions keep your theme, controls, banner and mark-all-read link... I'll handle the follow-on rebases as earlier PRs
  merge rather than leaving those conflicts for you."

### Tue 10 Nov: #158 and #161 merged, #159 #160 #162 #163 sent back with specifics, and a poll that is 4x faster

- **#158 a sent message shows Delivered until it is Read.** Marcus Vorwaller (github.com/marcus; X: none found 10 Nov, asked
  Fred; first merged PR). Blip showed nothing under your newest message until it was read; now it says Delivered, then Read.
  Only the newest sent message owns the receipt, failed, withdrawn and scheduled rows never claim it, and a message you send
  yourself keeps its receipt. One of his six splits of #156, the first in the order I asked for.
- **#161 a searchable emoji picker beside Send.** Marcus Vorwaller (same). A smiley opens a Unicode catalogue with search by
  name and categories; choosing an emoji inserts it at the caret and never sends. Rendered in a clean VM on invented data
  before merging.
- **The other four are sent back, with reasons, not refused.** An independent review of each (read-only, nothing sent to the
  Mac) found real problems and I reproduced the worst ones. #162 stickers: ffmpeg guessed the file format from a stranger's
  bytes, so a two-line text file sent as a video came out as a different cached picture. #163 inline voice messages: Qt plays
  bytes the safety check never saw, a machine without QtMultimedia would lose the whole view, and any incoming message cuts
  off the voice message you are playing. #160 native replies: three failure paths after Return say "nothing sent", so a retry
  could send the reply twice, and the recipient is never checked before Return. #159 reactions: the macOS 27 path that ships
  has no test and a look-alike message can attract the reaction. Each comment lists what to change; replies and reactions
  will be tried on the real 27.2 gateway (self-thread only) once they are fixed.
- **The speed-up (Larry, nixfred): 0.77 s to 0.2 s for a poll, 2.1 s to 1.0 s while the window is open.** Measured, not
  guessed: every poll ran a query over every message ever received, and the chat list scanned each conversation whole. Both
  now use Apple's own indexes. On the real 282,650-message database the answers are identical (compared byte for byte), and
  the old code is kept as the test oracle.

### Mon 9 Nov: #154, #157 and #155 merged, #156 asked to split

- **#157 a tapback that has to start Messages lands on the first try.** Gerald LaMontagne (github.com/lama7; X: none
  found 9 Nov, asked on the PR; first PR). Every first tapback after Messages had quit failed with exit 77 and worked a
  minute later: the tool called Messages ready once its process existed, but a background launch registers its menu bar
  seconds later, so the next probe answered -1719. He found it in the Mac's unified log (the tool's own `open` and the
  dying `osascript` 0.7 s apart, twice). The gate now waits for the menus; a denial or locked screen never waits. He ran
  the Mac suite on the Mac's own Python 3.9.6, which is where the last two PRs broke. Verified by Larry: whole diff read,
  the four new tests all fail on the old code, the four Mac suites pass on the gateway's 3.9.6. NOT verified: the
  cold-launch tapback itself (author: landed in 5.8 s).
- **#155 a tapback failure names its real reason.** Gerald LaMontagne, second PR the same day. "tapback: Mac
  unreachable" was shown for days on a reachable Mac with a locked screen, because exit 69 is two failures (the shim's
  255 translation and imsg-react's own unavailable) and the code treated both as transport. Now only the shim's own
  marker, or no imsg-react line at all, counts as unreachable. Verified by Larry: the marker equals blip-shim line 132
  byte for byte, the built .mjs equals a fresh build. The classifier called it one-way on a code comment containing
  "ssh "; Fred approved from the literal diff.
- **#154 Pin works on a conversation far down the list.** Ian Swope. Messages builds only the ~15 sidebar rows near the
  viewport, so for a chat 58th of 496 nothing was selected and Pin stopped. The helper pages the sidebar down with its
  own scroll action until the selected row exists, acts on it, and pages back. Ian found this gap in his own #150.
  Verified by Larry: five tests run the real JS under bun; mutations fail them. LIVE ON FRED'S 27.2 GATEWAY (self-thread
  only): paging reached the chat and Pin fired, then Messages answered "You can pin up to 9 conversations", because the
  pin list was already full, so nothing was pinned. So the fix reaches the row on 27.2; a pin landing there is still
  unproven, and #132 stays open. The tool reports this as "clicked but the conversation is not pinned" and leaves the
  alert open on the Mac: a message naming the 9-pin limit is a follow-up. Lesson for the post, twice now: a fix is not
  done until the thing it is for has happened on the machine it is for.
- **Follow-up, Tue 10 Nov (202f600, Larry's own change): the tool names the 9-pin limit.** When Messages refuses a tenth
  pin, `imsg-read --pin` now reports Messages' own sentence and dismisses that one alert instead of saying "clicked but
  not pinned" and leaving it open. Live on the 27.2 gateway: the full pin list produced the sentence, nothing changed.
  A pin actually landing on 27.2 is still the open question on #132.
- **#156 a Messages-style restyle plus features, Marcus Vorwaller, 17,403 lines, NOT merged.** He asked "interested?"
  first. Fred decided: the restyle and per-conversation backgrounds stay in his fork (Blip is one opinionated look);
  the features are welcome as separate PRs in this order: Delivered, tapbacks on any message on macOS 27, native
  replies (`imsg-reply`, `replies=on`), then the emoji picker, stickers and voice messages. The PR stays open until the
  first split PR arrives. Larry checked CI, gitleaks and that it merges cleanly on today's main; he did NOT read all
  17k lines. Say nothing in the post until a split PR lands.

### Handles Fred still needs to answer (9 Nov)
- **Gerald LaMontagne** (github.com/lama7, #155 and #157): nothing published. Asked him on #157. If Fred knows him, ask.
- **Marcus Vorwaller** (github.com/marcus, #158 and #161 merged 10 Nov): nothing on his GitHub profile or social accounts, and his site marcus.pictures lists no X. Four more PRs under review. If Fred knows him, ask.

---

## 2026-W45 (Mon 2 Nov to Sun 8 Nov): OPEN, post due Sun 8 Nov (this one also covers W44)

### What people said this week (quote with attribution in the post)

- **Ian Swope (https://x.com/ianfs) on #132, Wed 4 Nov**, answering the invitation to take Pin: "Fred, I'll
  take Pin. Next I'll see what a pinned tile exposes through Accessibility." His PR (#150) arrived the same day.
- **Ian Swope on #151, Thu 5 Nov**, reviewing Dima's fix before Fred had: "This is the mirror of the #97 guard,
  and the loop it describes is real", then traced the window side, groups and prefer_imessage against it.
- **Danny Cecil (https://x.com/jefehoser) on #48, Thu 5 Nov**, answering Fred's late thank-you for his two PRs:
  "I'm happy I could contribute to Blip, it's a terrific app and makes Omarchy much more useful for me."
- Comment sweeps of issues and PRs: Wed 4 Nov and Sun 8 Nov. Nothing else new from outside.

### Sun 8 Nov: #151, #153, #150 and #152 merged

- **#151 a green DM is not turned back to iMessage.** Dima Grigorchuk (github.com/dimagrigorchuk; X: none
  found 8 Nov, asked on the PR). A contact who moves from iPhone to Android leaves the old iMessage chat row in
  the same cluster. One send that went out as iMessage and failed (error 22) became the cluster's newest
  row, so the chat list called the DM iMessage and every later send failed the same way, with no way back.
  The list may now move a green DM onto iMessage only when the newest row is inbound. Ian Swope reviewed it
  first. Verified by Larry: 10 lines of code, `last_from_me` is a field `imsg chats` really emits, and the
  new test fails when the fix line is removed. NOT verified: a live send to an Android contact.
- **#153 the bar glyph is sized like stock bar icons.** Jason Meller (github.com/terracatta,
  https://x.com/jmeller, from his GitHub profile; X name matches). The speech bubble sat visibly smaller than
  every other icon because Nerd Font glyphs carry padding inside the em box; stock widgets scale the glyph's
  ink instead. Larry found in a Test Drive VM on Omarchy 4.0.2 that the PR as written took Blip OFF the bar
  there: that release's OpticalGlyph has no paintedSize, and a QML file that assigns an unknown property does
  not compile (log: `Plugin widget nixfred.blip failed ... Cannot assign to non-existent property
  "paintedSize"`). Folded into the merge: the optical glyph lives in OpticalBarGlyph.qml behind a Loader, with
  the old text as fallback, so 4.0.2 shows Blip as before and 4.5 gets his sizing; three tests keep the
  assignment out of BarWidget.qml. Checked on 4.0.2 (fallback) and with a 4.5 OpticalGlyph overlaid (loaded
  path). The sizing itself rests on his before/after screenshots on Omarchy 4.5.0: Fred's own bar runs a dev-linked
  shell whose OpticalGlyph also lacks paintedSize, so on gus the PR as written would have removed Blip from
  the bar, and with the fallback it looks exactly as before (before and after strips compared 8 Nov).
- **#150 Pin and Unpin work on macOS 27.** Ian Swope (https://x.com/ianfs). On 27 the Conversation menu has
  neither item; the sidebar offers both as Accessibility custom actions on the selected conversation (`Pin
  <name>` on a row, `Unpin` on a pinned tile). He took Pin on #132 on 4 Nov and wrote it, with six live
  round trips on his 27.0.1 mini, each verified against the pin list (it trails the action by 4.4 to 5.5 s,
  so pins now wait up to 15 s). A message bubble also offers a bare `Pin` that pins the MESSAGE, so the code
  acts only on the sidebar entry Messages reports as selected. Verified by Larry: all 20 bridge suites and 794
  bun tests pass, and undoing the fallback, the longer wait or the selected-only filter each fails his tests.
  THEN THE LIVE TEST ON FRED'S 27.2 GATEWAY (8 Nov, same day, self-thread only, Fred's go) FAILED, twice,
  and found two separate things. (1) Over ssh on that build NSRunningApplication and NSWorkspace cannot see
  GUI apps (25 background apps, no Finder, no Messages) and JXA returns `count` as a string, so the helper
  threw `objectAtIndex: index 0 beyond bounds` instead of finding Messages. Fixed the same day by taking the
  pid from pgrep (two tests, three mutations). (2) Still open: Messages renders only 15 sidebar rows and
  `open imessage:` did not bring the test chat's row (54th of 397) into view, so nothing is selected and Pin
  stops with "0 conversations are selected". The pin list was identical before and after. No Pin has
  succeeded on a 27.2 gateway yet. #132 was closed earlier that day on Ian's 27.0.1 evidence and is
  REOPENED. Lesson for the post: a fix is not done until it ran on the machine it is for.
- **#152 a friend's Find My shared city under their name, MERGED late Sun 8 Nov.** Matt (github.com/mmdisbrow,
  X https://x.com/MattDbrow, which he gave on the PR; first PR). Off by default (`shared_city=on`). The Mac reads
  Find My's People list through the Accessibility API and sends back only a coarse city and two timestamps;
  older locations carry their age, over 24 hours are hidden. Larry's one ask on the PR: a stale row brings Find My
  to the front for two seconds and Blip looks once a minute, so a friend with their phone off would have pulled
  it forward every minute. He delivered within hours: once per handle per 15 minutes, kept in a private hashed
  file, failed attempts counted, and Paused rows no longer bounce at all. Verified by Larry: read the whole diff,
  806 bun tests, 41 Mac-side tests and both QtTest view checks pass, the generated City.mjs equals a fresh build.
  NOT verified by Larry: the real Find My window (the author reports macOS 27.2).

### Tue 3 Nov: #149 merged

- **#149 Hide Alerts works on macOS 27.** Ian Swope (https://x.com/ianfs). On 27 Messages writes nothing to
  chat.properties when you mute; it keeps the mute in `com.apple.MobileSMS.CKDNDList` (handle to expiry,
  distantFuture for "until I turn it back on"). Blip read only the old flag, so every 27 mute looked
  unmuted and a Hide Alerts that had worked was reported as "clicked but the conversation is not muted",
  which is how Fred's own 28 Oct round trip on 27.2 read. Fix: `imsg chats` reads the DND list as well as the
  flag, `imsg-read` verifies through `defaults export` because the plist file trails the change by a few
  seconds, and 27's single Hide Alerts item is treated as a toggle that is clicked only after the state has
  been read. The story is Ian's end to end: he reported #132 after testing #122 on 27.0.1, found the mute's
  real home with an Accessibility round trip on his own mini, and wrote and live-tested the fix. His PR:
  10 new tests, each part of the fix undone in turn makes at least one fail, and a four-step live table
  (mute, mute again, unmute, unmute again, all exit 0, front app unchanged). Checked by Larry after the
  merge: 790 bun tests and the bridge suites pass, and the gateway Mac's imsg, imsg-read and read_state.py
  are byte-identical to main. NOT checked: a Hide Alerts click on Fred's own 27.2 gateway since #149 (the
  only live round trip there was before the fix). Groups stay DM-only. Pin on 27 is still open on #132: Ian
  found each sidebar row carries custom actions (`Pin <name>`, Mark as Unread, Hide Alerts, Delete...)
  readable with Messages in the background; the list is lazy, so only rows in view carry them, and he found no
  Unpin action. Asked him on #132 whether he wants to take Pin as a PR.

### Wed 4 Nov: late thanks and triage

- Late thank-you comments posted on five PRs that merged on 6 and 10 Sep without a visible comment from
  Fred: Fileri on #68 (14 PRs: #37 #38 #41 #42 #46 #56 #57 #58 #63 #64 #65 #66 #67 #68), jondkinney on #61 (8 PRs:
  #50 #51 #52 #53 #55 #59 #60 #61), jefehoser on #48 (#40 #48), zachwilke on #43, joshuaswarren on #49.
  One comment per person, each listing what their PRs did, so nobody got 14 notifications.
- Still waiting on people: #129 (mikev1963, four questions asked 8 Oct, checked in again 8 Nov), and an X
  handle from Dima Grigorchuk (#151). Parked on purpose: #125, #112, #78.

## 2026-W44 (Mon 26 Oct to Sun 1 Nov): ROLLED INTO W45, no separate post

### What people said this week (quote with attribution in the post)

- **Ian Swope (https://x.com/ianfs) on #132, Wed 28 Oct.** On why he digs into this: "I want you to know
  how much I actually use what you've built: Blip is open on my desk every single day, it's how I do iMessage
  now, and BurnBar sits in my bar right next to it, also literally daily." And, after a live round trip on his
  macOS 27.0.1 mini, the finding that became #149: "Hide Alerts does work on macOS 27; the mute just isn't
  stored in chat.db anymore."
- A reply from @coltonfitzgerald on #146 is awaited (X handle asked, 28 Oct).

### Wed 28 Oct: #132 half fixed (issue stays open)

- **#132 Hide Alerts is readable again on macOS 27 chats with a year-1 date.** Reported and
  diagnosed by Ian Swope (https://x.com/ianfs), who tested #122 on macOS 27.0.1. macOS 27 stores
  `upiExpiryDate` as Foundation's distantPast, two days older than the oldest date Python's
  `datetime` holds, so the Mac's stock Python 3.9 dropped the WHOLE chat.properties dictionary and
  the chat could never be listed as muted or verified. Fix: out-of-range dates in the binary plist
  are clamped in place before the read (no offsets move), used by the mute check and the
  group-photo lookup. Verified: Ian's trace reproduced on Linux, tests that fail on the old code,
  all 19 bridge/mac suites, and the real macOS 27.2 gateway counted against its live chat.db
  (counts only): 3,309 chat rows with properties, 164 unreadable before and 0 after, muted
  count unchanged at 2, so nothing was falsely muted. Ian saw 85 of 1,542. Deployed to the shared
  Mac bridge (only `imsg` changed). NOT fixed: Pin is missing from the Conversation menu on
  macOS 27 (it lives in the sidebar right-click menu there), and Ian's observation that the flag
  stayed unset after a Hide Alerts click is now answered: Fred approved a live round trip on his
  self-thread only (a chat that carries `upiExpiryDate`, alerts on before), and on macOS 27.2
  Hide Alerts was clicked but the conversation was not muted (exit 75), no `ignoreAlertsFlag`
  appeared in chat.properties, chat.db has no mute column or table, and the following Show Alerts
  found "'Show Alerts' was not available", so Messages itself did not toggle. The self-thread
  ended exactly as it started (alerts on, same property keys). So on 27.x Hide Alerts and Pin both
  need a different path than the Conversation menu; neither is designed yet. Asked Ian to re-run
  mute and unmute once on the updated bridge.

### Wed 28 Oct: #146 merged

- **#146 right-click a photo to open, copy or save it.** Colton Fitzgerald
  (github.com/coltonfitzgerald; X: none found, asked on the PR). Right-click a picture
  for Open, Copy image and Save image...; media and PDF chips get Open and Save....
  Save fetches the full original, never the preview, opens a zenity picker in Downloads
  with the attachment's own name (a HEIC is offered as .jpg), writes mode 0600 and never
  replaces a file: a taken name becomes "name (2).ext". Verified: reviewed 21 Oct, merged
  28 Oct onto main in a detached worktree, suite 790 passing, door classifier two-way, and
  the merged tree run in a Test Drive VM through the real plugin with real right-click
  input: Copy image put a 32,438-byte image/jpeg on the clipboard, Save image... wrote
  ridge-1.jpg at 0600, and a second save to the same name wrote "ridge-1 (2).jpg" and
  left the first file untouched (same mtime, byte-identical copies). Changed in the merge,
  because the PR sat 7 days waiting on the author and main moved under it: the CHANGELOG
  conflict with #148, the literal bidirectional characters in two regexes rewritten as
  escapes (his 21 Oct review ask), and one new test, because deleting that bidi range left
  all four of his save tests green. The screenshot his template asked for was taken by me,
  docs/img/photo-context-menu.png. NOT verified: the Open row and the PDF file-chip menu
  were not clicked (the demo fixtures only carry photos). gus has no zenity, so Save is not
  usable on the live desktop until it is installed.

## 2026-W43 (Mon 19 Oct to Sun 25 Oct): OPEN, post due Sun 25 Oct

### What people said this week (quote with attribution in the post)

- **Mark B (https://x.com/_FailSafe) on #148, Sat 25 Oct, 01:53 UTC.** He tested
  the question I could not: "Checked on two connected displays at 200% (internal
  MacBook) and 125% (external via USB-C) scaling, using Blip components in an
  isolated QuickShell with fictional contacts." Clicking the secondary bar opens
  Blip on that display, the popout still uses the primary widget as its host,
  "Allow Blip Notifications" is enabled, not "Unavailable", enabling and removing a
  fictional sender from the secondary display saves correctly, and reopening from
  the primary display shows both changes. On why he builds for Omarchy: "the Omarchy
  community is by far the most brilliant, eager, and giving Linux community I've ever
  associated with." He also gave his X handle (https://x.com/_FailSafe) and said he
  would contribute more if time allowed. Recorded 28 Oct, three days after he wrote it.
- Nothing from @coltonfitzgerald on #146 in the 7 days after the 21 Oct review (screenshot
  and escape fix asked for). Merged 28 Oct with both done in the merge, see W44.

### Sat 24 Oct: #148 merged

- **#148 allow or stop Blip notifications from a conversation's menu.**
  Mark B (github.com/Fail-Safe, https://x.com/_FailSafe, given by him on the PR 25 Oct). Right-click a
  direct conversation or pinned avatar, or use the thread header's ... button, to Allow or
  Stop Blip Notifications, instead of hand-editing allowlist.json. It edits that same file:
  atomic 0600 writes, refuses to overwrite a file that does not parse, one conversation's
  phone or email only, never a group's last speaker. Verified: reviewed in a detached
  worktree, suite 783 passing with it merged, read-ui QtTest 6/6, door classifier two-way,
  and a mutation check (matching on the chat only fails 3 of his 14 new tests). His
  screenshot is genuine harness output with fictional contacts. Changed in the merge: he had
  deleted two existing tests (the README's allowlist and mutelist examples load as written;
  the conversation menu matches Messages), both still pass against his code, so both were
  restored. NOT verified at merge: nobody clicked the menu on a live desktop, and it was
  unknown whether a popout from a second monitor's bar (not the leader) can reach the
  allowlist process; it would read "Blip Notifications Unavailable". He then tested
  two displays himself on 25 Oct and it works (see "What people said"). He builds Omarchy plugins
  himself (omarchy-veil, omarchy-audiogram-eq, omarchy-dexcom). Live on gus after the
  merge (shell restarted, `status` healthy, the DEPLOYED toast-allowlist.ts exercised
  against a temp file: create at mode 0600, idempotent set leaves the file byte-identical,
  remove, group refused, malformed JSON refused and left alone; the real allowlist was not
  touched). Not deployed to vic.

### Wed 21 Oct: #145 and #147 merged, #143 fixed, #146 asked for changes

- **#145 setup finishes on a Mac whose login shell is fish; fixes #144.**
  Jared Moody (https://x.com/jaredmoody), reporter AND fixer. sshd runs the
  remote command under the Mac user's login shell and fish rejects
  `${SSH_CONNECTION%% *}`, so the wizard stopped after the Mac install but
  before the dedicated key was written: `blip-check` green, bridge failing
  with `Permission denied`. Verified: reviewed and approved, suite 769
  passing with it merged. NOT verified: the patched wizard has not been run
  end to end on a fish Mac (Jared reproduced the failure on macOS 27.0.1 and
  enrolled the key by hand). The added test only asserts source text, so a
  test that executes the read under fish, bash and zsh is an open ask on
  the PR. The door classifier calls this one-way (it touches
  `scripts/blip-setup` and adds an `ssh` call). Larry merged it before
  running the classifier, and ran it afterwards; the process miss is
  recorded here so the post does not overstate the review.

- **#147 a unified SMS row cannot turn an iMessage DM green (test only).**
  Barry Jones (https://x.com/brightball). Locks the #97 guard for the case
  where the merged 1:1 is stored as SMS, which showed up on an install
  pinned to v2.5.0. Verified by mutation: with the `greenDowngrade` guard
  removed both the RCS test and his fail.

- **#143 security-code toasts for alphanumeric senders.** Reported by
  edmooredop (github.com/edmooredop; no X account found, asked Fred), fixed
  by Larry. A UK text from `msverify` never produced the toast because
  `isGroupChat()` calls any non-phone, non-email id a group. That catch-all
  is deliberate (an unknown id shape must never become a send target), so
  the fix is in the code gate only: a chat that IS the speaker's handle is a
  sender. Verified: the issue's exact repro failed before and passes after,
  on the deployed copy on gus too. Ordinary toasts were never affected.
  Not deployed to vic. A brief `online=false` on gus right after the copy
  recovered on the next poll (cause unproven; the copy was in place).

- **#146 right-click a photo to open, copy or save it.** Colton Fitzgerald
  (github.com/coltonfitzgerald, X not looked up yet), OPEN. Code review found
  nothing blocking (772 tests, generated module matches a fresh build, same
  no-overwrite write path as Save vCard). Asked for the screenshot the PR
  template requires and for literal bidi characters in a regex to become
  `\u` escapes. Picker and live QML NOT run by Larry (no `zenity` on gus).

## 2026-W42 (Mon 12 Oct to Sun 18 Oct): backfilled 21 Oct from CHANGE.log, no post drafted

### What people said this week (quote with attribution in the post)

- **John Zetterman** (https://x.com/jzetterman), on #140, 16 Oct: "It's just
  something I ran into and I figured contributing will help others as well!
  I'm glad it was so useful. My X handle is @jzetterman." (Found 21 Oct by
  the comment sweep; it sat unrecorded for five days.)

### Thu 15 Oct and Mon 12 Oct: #140, #141, #142

- **#140 a host's ssh agent can no longer defeat the confined key.** John
  Zetterman (https://x.com/jzetterman). `IdentityAgent=none` on every
  dedicated-key ssh call, and `blip-setup` catches a bun the bar cannot see.
- **#142 mark all read works while Blip says ALL CAUGHT UP.** Larry and
  Fred. Under the default `push_read=all` the phone could show unread dots
  beside a caught-up Blip, and the gesture that reaches the phone was hidden
  exactly then.
- **#141 seven fixes from a whole-project review.** Larry and Fred (muted
  chat badge, stale codes after sleep, repeated "ok", tab/newline file
  names, setup with no terminal, toast click on a phone-number chat).

## 2026-W41 (Mon 5 Oct to Sun 11 Oct): OPEN, post due Sun 11 Oct

### What people said this week (quote with attribution in the post)

- **Ian Swope** (https://x.com/ianfs), on #138, 7 Oct: "Thanks Fred, and
  thanks for Blip itself. I use it all day and really love it, so it's a
  pleasure to help where I can. Glad this one brought tapbacks back on your
  27.2 gateway too." Then found the cause of the silent tapback failure the
  same night and sent it as #139.
- **Damon Janis** (https://x.com/damonjanis), on #120, 7 Oct: "Happy to be
  tagged, I'm @damonjanis on X. Thanks for getting the whole series merged
  and deployed!" (His read-sync series #120, #121, #122 is complete.)
- **Brandon Smith** (https://x.com/bndnsmth), on #134, 7 Oct: "Appreciate
  the quick review and merge. Feel free to tag @bndnsmth in your post."
- Ian Swope sent six PRs this week (#133, #135, #136, #137, #138, #139),
  three of them the same evening, two of them closing review notes Larry
  left on his previous PR within the hour.

### Wed 7 Oct: #135, #136, #137, #138, #139

- **#139 a failed tapback is never silent.** Ian Swope (https://x.com/ianfs).
  A run takes 15-75 s on macOS 27; closing Blip meanwhile lost the reason.
  The run now lives in the bar widget and the failure waits for the chat.

- **#138 tapbacks on macOS 27.** Ian Swope (https://x.com/ianfs). Every
  tapback failed on a 27 gateway: no per-user TCC.db, and bubbles there
  offer no tapback actions. Now the permission is asked of macOS without a
  prompt, and the newest message is reacted to through Messages' own
  Tapback Picker, only after its label matches. Older messages are refused
  on 27. Fred's Mac is on 27.2: the check now passes there.

- **#137 the toast click no longer leaks unread state.** Ian Swope
  (https://x.com/ianfs), following the review note on #136: the reply is
  always "opened", so another program cannot learn which chats are unread.

- **#136 clicking a message toast opens the conversation.** Ian Swope
  (https://x.com/ianfs). With the default automation=off a click only
  dismissed it, because the toast ran the gated goto. A new IPC opens only
  chats Blip toasted or that are still unread, otherwise the list.

- **#135 the deploy line copies the menu icons.** Ian Swope
  (https://x.com/ianfs). The copy line in CLAUDE.md, AGENTS.md and
  CONTRIBUTING.md left out icons/, so a by-the-book deploy showed the
  conversation menu without icons. Docs only.

### Tue 6 Oct: #133, #134

- **#133 a read survives a locked Mac.** Ian Swope (https://x.com/ianfs).
  A gateway Mac's screen saver locks it about 25 minutes after last use;
  Messages then has no reachable window, and after 5 failed tries the read
  was dropped and the dot came back (441 attempts in one night on his Mac).
  Per-chat reads now retry once a minute until the Mac confirms, and the
  error names the lock. His test change also fixed 15 read-sync tests that
  failed on any machine running the #83 warm channel.
- **#134 the sidebar shows which chat is open.** Brandon Smith
  (github.com/bndnsmth, new contributor; X https://x.com/bndnsmth, confirmed on the PR). In the two-pane window
  the highlight could sit on a different chat than the one shown. Verified
  live on gus with a screenshot: the open chat's tile stays selected with
  the mouse elsewhere.

## 2026-W40 (Mon 28 Sep to Sun 4 Oct): post missed 4 Oct, folded into Post 5 with W41 (Sun 11 Oct)

13 PRs merged so far, from 7 people (#131 cherry-picked).

### Sun 4 Oct: #127, #122, #83 merged; #131's Mac fix taken

All four were one-way doors (they change the Mac bridge or CI), which is
why they sat open: that rule means Fred reads the diff before merge, and
no session waives it. Fred approved each on 4 Oct.

- **#127 tapbacks can't land on the neighbouring message.** Erik
  Fillipsveen (github.com/Fileri). Testing #116 on macOS 26.6 he got a
  heart on the wrong message twice: scrolling renumbers transcript rows
  between the scroll and the press. Now a pass that scrolls never presses,
  label and frame are read in one event, no retry, stray check always.
  Tapbacks stay off on Fred's machines.
- **#122 Pin and Hide Alerts in the conversation menu.** Damon Janis
  (https://x.com/damonjanis). Through Messages' own menu, verified over the
  whole conversation cluster; the four review fixes were added on top by
  another Larry session. Completes the #120/#121/#122 series.
- **#83 a warm channel to the Mac.** Zach Wilke
  (https://x.com/zachwilke_1). A helper keeps the ssh link open: a poll
  query took a median 18 ms against 166 ms one-shot on gus, measured live.
  Killing the link on purpose: queries fell back with no errors and the bar
  restarted the helper within 30 s. Real Wi-Fi loss not tested.
- **#131 a send now waits for the Automation prompt.** David Benedic
  (github.com/daveyb, new contributor; X asked). imsg-send gave up after
  15 s, shorter than the Allow prompt; now 150 s. His Windows tray client
  was declined for this repo with an offer to link it as its own project.

### Sat 4 Oct: #128

- **#128 a sleeping monitor no longer crashes Hyprland a second way.** Brad
  Larson (github.com/followbl, X https://x.com/followbl), his second fix in
  this area: #113 stopped Blip mapping its window with no output; this stops
  it MOVING the window home while the only monitor is gone, which hit the same
  null-monitor segfault in Hyprland 0.56 (symbolized core from his own crash on
  2 Oct, reproduced in a nested Hyprland). The move now waits for a real
  output; the bug is in Hyprland and still unguarded on their main. Verified:
  716 tests pass, CI green, door_classify two-way. Not yet checked by anyone: a
  real display sleep with the fix in place. Merged 4 Oct, deploy pending.

### Thu 1 Oct and Fri 2 Oct: #120 and #121

- **#126 search keeps a reply that matches your own.** Greyforge Labs
  (github.com/GreyforgeLabs, new contributor; X https://x.com/GreyforgeLabs,
  published on the GitHub profile). In a group, your "yes" and another
  member's "yes" in the same second showed as one search hit, because
  search's echo key ignored the sender; a note to yourself could show as
  incoming. Search now reuses the echo rules the conversation view already
  had. Verified: all four new tests fail on the old code, 676 pass with the
  PR. Measured on Fred's Mac, four queries of 400 rows each: every other
  conversation's hits are identical before and after. **Our follow-up:** his
  self-thread holds 3 or 4 incoming copies of each note (iCloud re-sync), and
  search answers newest first, so one copy still survived as an incoming
  hit; search now hands outgoing rows to the dedupe first. Query "test":
  340 hits before, 286 with the PR, 196 with the follow-up. Not seen in live
  data: the same-second group case itself, which only the tests cover.

- **#116 + #117 outbound tapbacks (closes #69).** Erik Fillipsveen
  (github.com/Fileri). Pick a tapback in the message menu and the Mac
  performs it on that exact bubble through Accessibility, with SIP on;
  chat.db is the referee. Off unless `tapbacks=on`; groups refused; no new
  permission prompt. Before merging we fixed the one review finding
  ourselves (1fbc737): an identical message at the same time of day on a
  LATER day could take the reaction, because the transcript shows HH:MM
  only. 709 tests; deployed everywhere, switched off by default.

- **#120 read state syncs through a durable, verified queue.** Damon Janis
  (https://x.com/damonjanis), replaces his #103. Every read is saved before
  any Mac call, retried with backoff, and retired only when chat.db confirms
  it. Merged 1 Oct with Fred's OK, deployed 2 Oct with the new Mac bridge.
  Watcher-alive poll restored from 10 s to 60 s; the per-poll snapshot cost
  and a blocking 180 s Mac call are open in #125.
- **#121 Mark as Unread / Mark as Read.** Damon again. Right-click or U;
  DMs through Messages' own menu item, verified in chat.db; groups local.
  672 tests green; deployed gus, vic and the Mac bridge.

### Wed 30 Sep: three merges, two reviews

- **#124 blip-setup kept host=192.168.x.x intact.** Chad Stovern (github.com/chadhs,
  new contributor; X https://x.com/chadstovern, confirmed on the PR). `tr -d '"\x27 '` is not
  a hex escape to tr, so it deleted every 2, 7 and x from bridge.conf values:
  host=chadhs@192.168.110.106 came back as 19.168.110.106 and was written back,
  so every re-run failed. Reproduced both halves by hand before merging.
- **#123 Up/Down in the compose field keep the selected bubble.** Erik
  Fillipsveen (github.com/Fileri), closes #118 as agreed with Jon Kinney.
- **#119 one sentence in CLAUDE.md again.** Ian Swope (https://x.com/ianfs).
- **Our own:** CI was red on main from 26 to 30 Sep because the voice-message
  change read a column one test fixture did not have; the file is named
  `*_test.py` and was never in my local run. Fixed, all 15 bridge test files
  now run by both name patterns.
- **In review, changes requested:** Erik's tapbacks (#116/#117, answers #69):
  opt-in, no new prompts, 673 + 146 tests green, one cross-day wrong-message
  case to close first. Damon Janis's read-sync series (#120-#122, replaces
  #103): sound design; a focus bug in Pin/Mute, a per-poll cost, blocking
  Mac calls and an unhealthy state on old bridges to fix.

## 2026-W39 (Mon 21 Sep to Sun 27 Sep): post due Sun 27 Sep

4 PRs merged so far, from 3 people.

### Fri 25 Sep: two merges, both Guido

- **#115 opt-in glide for mouse-wheel notches.** Guido Jouret again
  (github.com/gjouret; X https://x.com/gjouret), filed the same afternoon
  as #114 merged. With `smooth_scroll=on` in bridge.conf a wheel notch glides
  180 ms (OutCubic) to its place instead of landing at once; a notch that
  arrives mid-glide moves the target rather than restarting the easing, so a
  fast spin keeps its full distance; keys, paging, the bottom-stick, the
  scrollbar and any touchpad event cancel it; image growth above the
  viewport carries a running glide along. Touchpads never animate. **What
  changed in the merge:** the PR shipped the glide ON for everyone behind a
  shell.json setting and rewrote the "never animate wheel scroll" invariant.
  Fred chose opt-in, default off, as a bridge.conf key, for two reasons:
  bridge.conf is Blip's one config surface, and the invariant came from his
  own MX Master, whose single click is four notches in 0.13 s (measured
  today), while Guido tested on a plain wheel and an offscreen Qt Quick Test
  harness only. Fred had approved the direct feel at scroll_gain=0.25 an hour
  before the PR arrived; the default flips on his hand, not on a harness.
  632 tests green; deployed on gus and vic with the key absent, so nothing
  changed for anyone yet. Not verified: the glide on real hardware here.
  Next pass: Fred runs `smooth_scroll=on` on gus for a few days.

- **#114 one wheel notch scrolls one notch, not half a screen.** Guido Jouret
  (github.com/gjouret; X https://x.com/gjouret, declared on his GitHub
  profile, name matches). The conversation and the thread list multiplied
  every wheel event by 4.5, so a standard notch (angleDelta 120) moved about
  540 px, and touchpad deltas by 3, on top of the scroll factor Hyprland had
  already applied. Blip was the one app on the desktop scrolling 4.5× faster
  than everything else, and anyone who tuned `input:scroll_factor` got that
  tuning multiplied only here. Both handlers now apply the delta 1:1 through
  two BlipView properties (`wheelMultiplier`, `touchpadMultiplier`, default
  1.0). The 4.5 dated from Fred's own 1.3.4 scroll fix, where the real bugs
  were a WheelHandler that never fired, chips growing above the viewport and
  Repeater rebuilds; the gain was never measured against another app. Fred
  chose 1:1 over keeping the old defaults and judges the feel by hand; if it
  is too slow the next step is a bridge.conf key, not a constant. Deployed on
  gus and vic with the merge, shell logs clean on both: the MX Master 4 goes
  from 540 to 120 px per notch, the laptop touchpad (scroll_factor 0.4) from
  1.2 to 0.4 px per px. Still `MouseArea.onWheel`, unanimated, and the
  conversation still goes through `scrollConversation()`, so the bottom-stick
  is untouched. 630 tests green; a new test pins both handlers and fails
  against the old file. Not verified by hand: touchpad feel (Guido has no
  touchpad on his machine; Fred's Elan is the first real test).

- **Follow-up the same afternoon: `scroll_gain=` in bridge.conf (direct,
  Fred / Larry).** Fred's first hand test came back "way too fast, a whole
  page per click". A raw evdev capture of the MX Master 4 showed why: one
  physical click of that wheel is FOUR notches (bursts of 4, 4, 4, 3 in 0.13 s
  each), so even at 1:1 one click is 480 px in a 609 px window. Rather than
  put a constant back, `scroll_gain=` and `touchpad_scroll_gain=` (0.05–10,
  default 1, re-read on save, reported by `status`) went in as bridge.conf
  keys per the config rule, and gus and vic run 0.25: one click ≈ 120 px.
  Guido's 1:1 default stands for everyone else. 631 tests.
  **Correction to the two entries above.** The "deployed on gus and vic"
  claims for #113 and #114 were not true until 25 Sep. The #113 deploy on
  23 Sep left its backup as `nixfred.blip.bak-113-<ts>` INSIDE
  `~/.config/omarchy/plugins/` on both hosts; the registry scans that folder
  in glob order and the last manifest with an id wins, so the backup (the
  pre-#113 build) was what actually ran, on both machines, while three
  deploys reported `healthy=true`. Found because `status` never printed the
  new `scroll_gain=` field the file on disk contained. Fred's "too fast" test
  was therefore the OLD 4.5× code (2160 px per click), never Guido's 1:1.
  Backups now live in `~/.local/state/omarchy/plugin-backups/`; CLAUDE.md's
  deploy recipe says so. Brad's #113 fix and Guido's #114 are live on both
  hosts as of 25 Sep, verified by the `scroll_gain=0.25` field in `status`.
  Fred's hand verdict the same evening: "I like the scrolling." 0.25 stays
  on gus and vic; nothing left to tune here.

### Wed 23 Sep: one merge

- **#113 turning the monitor off no longer takes Hyprland down.** Brad Larson
  (github.com/followbl; X https://x.com/followbl, confirmed by Brad on
  #113, 2026-09-26). With the Blip window open,
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
  https://x.com/badenpiland. One RCS inbound turned every later send green and the
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
