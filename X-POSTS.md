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
| 4 | DRAFT, ready | 2026-09-26 | Blip 2.6.2: all 35 PRs from 13 people since Post 1. Text docs/x-post-2026-09-26.txt, image docs/img/x-post-2026-09-26.png |

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
