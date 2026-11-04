# Blip X posts

The queue of posts for @nixfred about Blip. Larry drafts, Fred reads and posts.

CADENCE: a contributor update goes out WEEKLY (Sunday). It is drafted from that
week's section of `WEEKLY-NOTES.md`, which is written as the work lands, never
reconstructed on the day. `CHANGE.log` is the raw running log underneath both
and holds the handle-verification rules. A bigger post can still go out between
Sundays when something warrants it.

Rules: every contributor is named, and tagged with their verified X handle
when one exists (see CHANGE.log for how it was verified). Facts, real numbers,
no pomp, no em dashes. Plain text below the marker; X renders no markdown.

| # | Status | Date | Covers |
|---|--------|------|--------|
| 1 | POSTED | 2026-09-11 | Everyone through 2.4.x: CONTRIBUTORS-X-POST.md |
| 2 | SUPERSEDED by 4 (never posted) | 2026-09-16 | 19 merged PRs since Post 1, 2.5.0 and Unreleased |
| 3 | SUPERSEDED by 4 | 2026-W38 | Weekly contributor update, notes in WEEKLY-NOTES.md |
| 4 | POSTED (Fred confirmed 2026-10-08; link not recorded) | 2026-09-26 | Blip 2.6.2: all 35 PRs from 13 people since Post 1. Text docs/x-post-2026-09-26.txt, image docs/img/x-post-2026-09-26.png |
| 5 | DRAFT 2026-10-28 (was due Sun 11 Oct) | 2026-W40 + W41 | Mon 28 Sep to Sun 11 Oct: 19 PRs from 8 people, plus 1 cherry-picked (tapbacks, warm channel, durable read sync, macOS 27), incl. the "What people said" quotes |
| 6 | DRAFT 2026-10-28 (was due Sun 18 Oct) | 2026-W42 | Mon 12 Oct to Sun 18 Oct: #140 ssh agent fix (John Zetterman), #141 and #142 (ours) |
| 7 | DRAFT 2026-10-28 (was due Sun 25 Oct) | 2026-W43 | Mon 19 Oct to Sun 25 Oct: #145, #147, #143, #148, and #146 (merged 28 Oct), incl. quotes |
| W44 | ROLLED INTO W45 (Larry, 2026-11-04): nothing outside merged after Post 7's PRs, only the #132 half fix | 2026-W44 | notes in WEEKLY-NOTES.md |
| W45 | OPEN, post due Sun 8 Nov (covers W44 + W45) | 2026-W45 | #149 Hide Alerts on macOS 27 (Ian Swope) and the #132 story from his report to the fix; notes in WEEKLY-NOTES.md |

---

## Post 2 (DRAFT, 2026-09-16)

----- paste below this line -----

Blip update. Blip puts iMessage on the Omarchy desktop, using a Mac you already own as the gateway.

Since the last post: 19 pull requests merged, from five people, plus two fixes of mine. This is what changed and who did it.

IAN SWOPE (github ianswope), 10 merged PRs

The panel froze half-faded on open. He measured it with a frame-gap probe: 441 to 627 ms of blocked GUI thread per open, because the conversation list rendered all 300 rows when about ten are on screen. The list now builds only the rows near the viewport and grows as you scroll. The fade runs clean.

Docked to two external monitors, every message fired three toasts, one per screen. Every bar crowned itself leader for the first few hundred milliseconds after a hotplug, and a follower's watcher restarted itself without checking. Fixed both. One toast.

No toast for the conversation you already have open. The same poll that cleared the badge still fired the notification.

A carrier short code like 611 or 2536 was treated as a group and opened read-only, so you could not reply STOP. It is a DM now. He found the rule lived in four places and changed all four.

A security code you copied sat in /proc for as long as the clipboard held it, because it went to wl-copy through an environment variable. It goes on stdin now.

Waking the laptop replayed the night's messages as toasts, up to twenty, including ones already read on the iPhone. Now a message read on another device never toasts. Reported by @mwhuss.

Also: blip-setup no longer dies at "Press Enter" when ssh drains its stdin, every text label is forced to plain text, the README allowlist example actually parses (copied as shown, it configured nothing and said nothing), and the README now says how to remove Blip and what it leaves behind.

ZACH WILKE @zachwilke_1, 4 merged PRs

Time crosses the bridge as UTC. Stamps used to be the Mac's wall clock compared against the Linux clock. A Mac one timezone ahead meant nothing ever counted as unread; one behind and the backlog re-toasted. In the DST fall-back hour two messages an hour apart carried the same stamp. Local time is now a display concern, day dividers break at your midnight, and a half-upgraded Mac and Linux pair keeps working. Reported by cjoh (github).

GIFs move. The Mac resampled every image to JPEG, so a 1.4 MB GIF arrived as a 198 KB still. Animated formats now cross as their own bytes and render animated.

A message carries every file you drop. Dropping five photos used to send one and silently discard four. Now all of them go, one part each, caption on the first, capped at ten.

And the docs no longer say outbound tapbacks are impossible. On macOS 26 they are half possible.

DANNY CECIL @jefehoser, 3 merged PRs

Right-click a message: Quote and reply, or Copy message. Right-click a link: Open, Copy, Share. Quoting keeps whatever you had already typed and never sends.

Super+M closed the wrong window. It matched any window whose title started with "Blip", so a browser tab called "Blip documentation" got closed. It matches only the real app now. If you copied the binding from the README, copy the new one.

The app window stays on its workspace after the screen idles off instead of jumping to whatever workspace is showing.

BRENDEN BISHOP @bbishdotdev, 1 merged PR

A security code offered right beside the field that wants it. Blip already spotted codes; now, with otp_autofill=on, a small prompt appears at the focused field and one click fills it through Linux accessibility, including sites with six separate digit boxes. The code never touches the clipboard, a command line or the disk, and it is gone after five minutes. Off by default. I tested it in a VM before merging and turned it on on my own machine today.

JON KINNEY @jondkinney, 1 merged PR

Sending a link no longer throws the share sheet over the conversation.

MINE

Contact photos stopped reloading every time the window opened. Every photoless contact went back to the Mac on every open, about 45 seconds of pictures trickling in. One batch and a cache, and they are there at once. And blip-setup no longer aborts on a stray __pycache__ folder.

Thank you, all five of you.

github.com/nixfred/blip

----- end -----

Handle notes for Fred before posting:
- Ian Swope: an @IanSwope account exists with his name, but it is dormant (school supply tweets, no Linux, no GitHub link). Not tagged. If you know his handle, add it to CHANGE.log and here.
- cjoh: no handle found.

---

## Post 5 (DRAFT, 2026-10-28), W40 + W41

----- paste below this line -----

Blip update for 28 Sep to 11 Oct. Blip puts iMessage on the Omarchy desktop, using a Mac you already own as the gateway.

19 pull requests merged in two weeks, from 8 people, plus one change cherry-picked from a ninth. Newest-useful first.

Erik Fillipsveen (github Fileri), #116 and #117, #123, #127
You can now send tapbacks from Blip. Pick one in the message menu and the Mac performs it on that exact bubble through Accessibility, with SIP on. chat.db is the referee. Off unless tapbacks=on, groups refused, no new permission prompt. Before merging we fixed one review finding: an identical message at the same time of day on a later day could take the reaction. Then his #127: testing on macOS 26.6 he got a heart on the wrong message twice, because scrolling renumbers transcript rows. A pass that scrolls never presses now. Also #123, Up and Down in the compose field keep the selected bubble.

Ian Swope @ianfs, 7 PRs (#119, #133, #135 to #139)
Tapbacks on macOS 27 (#138): every one failed on a 27 gateway. The permission is now asked of macOS without a prompt, and the newest message is reacted to through Messages' own Tapback Picker. Older messages are refused on 27. #139: a failed tapback is never silent, since a run takes 15 to 75 s. #133: a read survives a locked Mac. The Mac locks about 25 minutes after last use, and after 5 failed tries the read was dropped and the dot came back: 441 attempts in one night on his Mac. Reads now retry once a minute until the Mac confirms. #136 and #137: clicking a toast opens the conversation, without leaking which chats are unread. #135: the deploy line copies the menu icons. Three of them came the same evening, two of them closing review notes on his previous PR within the hour.

Damon Janis @damonjanis, #120, #121, #122
Read state syncs through a durable queue. Every read is saved before any Mac call, retried with backoff, and retired only when chat.db confirms it. Mark as Unread and Mark as Read (U), and Pin and Hide Alerts in the conversation menu. That completes his series.

Zach Wilke @zachwilke_1, #83
A warm channel to the Mac. A helper keeps the ssh link open, and a poll query took a median 18 ms against 166 ms one-shot, measured live. I killed the link on purpose: queries fell back with no errors and the bar restarted the helper within 30 s. Real Wi-Fi loss is not tested.

Brad Larson @followbl, #128
His second fix for a sleeping monitor crashing Hyprland. #113 stopped Blip mapping its window with no output; this stops it moving the window home while the only monitor is gone. The bug is in Hyprland 0.56 and still unguarded upstream. Merged and tests pass, but nobody has checked a real display sleep with the fix in place.

Greyforge Labs @GreyforgeLabs, #126
Search keeps a reply that matches your own. In a group, your "yes" and another member's "yes" in the same second showed as one hit. Our follow-up cut his self-thread test query from 340 hits to 196 by deduping outgoing rows first.

Brandon Smith @bndnsmth, #134
New contributor. The sidebar highlight could sit on a different chat than the one shown. Now the open chat's tile stays selected.

Chad Stovern @chadstovern, #124
New contributor. blip-setup deleted every 2, 7 and x from bridge.conf values, so an address with a 2 or a 7 in it came back mangled and every re-run failed. He found it.

David Benedic (github daveyb), #131, cherry-picked
New contributor. A send now waits for the Automation prompt: 150 s instead of 15.

What people said
Ian Swope on #138: "Thanks Fred, and thanks for Blip itself. I use it all day and really love it, so it's a pleasure to help where I can."
Damon Janis on #120: "Thanks for getting the whole series merged and deployed!"
Brandon Smith on #134: "Appreciate the quick review and merge."

Mine: CI sat red on main from 26 to 30 Sep because of a test fixture I never ran locally. Fixed, and CI now runs every bridge test file.

Mac side: re-run blip-setup after updating.

github.com/nixfred/blip

----- end -----

Handle notes for Fred before posting:
- Erik Fillipsveen (Fileri) and David Benedic (daveyb): no X account found, named without @.
- Damon's quote on #120 originally ends the first sentence with his handle; I quoted only the second sentence so his handle is tagged once.

---

## Post 6 (DRAFT, 2026-10-28), W42

----- paste below this line -----

Blip update for 12 to 18 Oct. Blip puts iMessage on the Omarchy desktop, using a Mac you already own as the gateway.

A short week: three PRs.

John Zetterman @jzetterman, #140
New contributor. A host's ssh agent could defeat the confined key Blip uses on the Mac. Every dedicated-key ssh call now sets IdentityAgent=none, and blip-setup catches a bun the bar cannot see. He said of it: "It's just something I ran into and I figured contributing will help others as well!"

Mine, #142
Mark all read now works while Blip says ALL CAUGHT UP. With the default push_read=all the phone could show unread dots beside a caught-up Blip, and the gesture that reaches the phone was hidden exactly then.

Mine, #141
Seven fixes from a whole-project review: a muted chat stays out of the badge when its rows leave the window, old codes and already-read links are not offered after a long sleep, a repeated "ok" is not resolved by the earlier one, file names with a tab or newline reach the Mac intact, blip-setup stops cleanly with no terminal, and a toast click works on a phone-number chat.

Thank you, John.

github.com/nixfred/blip

----- end -----

Handle notes for Fred before posting:
- John's quote on #140 continues "I'm glad it was so useful. My X handle is @jzetterman."; I quoted only the first sentence so the handle is tagged once. His comment sat unrecorded for five days (found 21 Oct).
- The notes do not say what was verified or not for #140, #141, #142, so no verification claim is made.

---

## Post 7 (DRAFT, 2026-10-28), W43

----- paste below this line -----

Blip update for 19 to 25 Oct. Blip puts iMessage on the Omarchy desktop, using a Mac you already own as the gateway.

Mark B @_FailSafe, #148
Allow or stop Blip notifications from a conversation's menu, instead of hand-editing allowlist.json. Right-click a direct conversation or pinned avatar, or use the thread header's ... button. It edits that same file: atomic 0600 writes, it refuses to overwrite a file that does not parse, and it never targets a group's last speaker. I could not test a second monitor's bar, so he did: two displays at 200% and 125% scaling, in an isolated QuickShell with fictional contacts. Clicking the secondary bar opens Blip there, notifications are not "Unavailable", and changes made from the secondary display show on the primary. Tested here: suite at 783 passing, and a mutation check where matching on the chat only fails 3 of his 14 new tests. Not tested: nobody has clicked the menu on a live desktop. He had deleted two existing tests, which I restored; both pass against his code.

Jared Moody @jaredmoody, #145 and #144
He reported the bug and fixed it. sshd runs the remote command under the Mac user's login shell, and fish rejects ${SSH_CONNECTION%% *}, so blip-setup stopped before the dedicated key was written: blip-check green, bridge failing with Permission denied. Not tested: the patched wizard has not been run end to end on a fish Mac, and the added test only checks source text.

Barry Jones @brightball, #147
A test that locks the guard against a unified SMS row turning an iMessage DM green. Checked by mutation: with the guard removed, both the RCS test and his fail.

edmooredop (github), #143
Reported that security-code toasts never fired for a text from an alphanumeric sender like msverify. Any non-phone, non-email id counts as a group, on purpose, so it can never become a send target. The fix is in the code gate only: a chat that is the speaker's own handle is a sender. I fixed it, and the exact repro failed before and passes after.

Colton Fitzgerald (github coltonfitzgerald), #146
Right-click a photo to open, copy or save it. Merged 28 Oct, just after this week ended. Save fetches the full original, offers a HEIC as .jpg, and never replaces a file: a taken name becomes "name (2).ext". Tested here in a throwaway VM with real right-click input: Copy put the image on the clipboard, and a second save to the same name became "name (2).jpg". Not tested: the Open row and the file-chip menu for a PDF.

What people said
Mark B on #148, on why he builds for Omarchy: "the Omarchy community is by far the most brilliant, eager, and giving Linux community I've ever associated with."

github.com/nixfred/blip

----- end -----

Handle notes for Fred before posting:
- edmooredop and Colton Fitzgerald: no X account found, named without @.
- Mark B's X handle is @_FailSafe, not @Fail_Safe (that is a different person).
