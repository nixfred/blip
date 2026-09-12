Blip puts iMessage on Linux by treating a Mac you already own as the gateway. It went from a toy to something I use every hour of every day in about ten days, and almost none of that was me.

51 pull requests merged. 11 people wrote them. 5 more filed issues that changed the code. Together they added 12,262 lines and deleted 1,173. More importantly they found the things I could not find, because I was staring at my own code and they were staring at their own Macs.

Every one of them, and what they actually built.

━━━━━━━━━━

Fileri — Erik Fillipsveen, Oslo
22 merged PRs. +2,503. The largest contributor to this project and it is not close.

Contacts saved without a country code. Blip matched a phone number to a contact card on the last ten digits. That is a whole national number in North America and nothing anywhere else, so a Norwegian card saved as "123 45 678" never matched the handle +4712345678 and that person showed as a bare number. On one Norwegian address book, 99 of 386 numbers were saved that way. Erik found it because it was happening to his own card. He generated a region-to-calling-code table for 245 regions from libphonenumber, left the regeneration one-liner in the header, and implemented SHORT_NSN_MATCH with a floor of seven shared digits plus one refusal Contacts itself does not make: a North American card shorter than ten digits is missing its area code, so he refuses it rather than guessing. The exact key still wins whenever it hits, so nothing that already resolved could change. He understood the danger was not "no match" but "confidently wrong match."

An unsend is not an edit. On macOS 26, Undo Send never sets date_retracted. It stamps date_edited, clears the body, and records the withdrawn parts as "rp" in message_summary_info, while a real edit carries "ec" and keeps its body. He read both, made retracted win, and produced a tombstone instead of an empty bubble labelled "Edited."

Announcements are not messages. Joins, leaves and renames share the message table with item_type != 0 and Apple never marks them read. Let one through and it is an empty bubble that counts as unread forever.

Then he did the entire keyboard. A cursor that scrolls to follow itself and stops at the ends instead of wrapping. A bubble cursor inside a conversation with copy, open and quote actions and PgUp/PgDn paging. Per-conversation drafts that survive thread switches, in memory only, because message text never lands on disk. And a sidebar peek that previews the thread under your cursor without marking it read — he routed both read-marking call sites through one function gated on one flag, then wrote the test asserting the old direct call is gone, not merely unused.

He also found that Omarchy's own panel hotkeys never worked on Blip at all. The bar finds a widget's panel through open(), close() and an "opened" property. Blip had the first two, so every SUPER+CTRL+n silently skipped it. One readonly property.

He is not finished. He has an open issue arguing, with a measured log of 160 confirmed reactions and latency percentiles, that outbound tapbacks do NOT need SIP disabled, because the Accessibility line we already crossed reaches them. He built it, measured it, listed its failure modes honestly, then asked whether I wanted it before sending a PR. That is how you file a feature request.

Erik has no X account I can find. Send me one and it goes at the top.

━━━━━━━━━━

@jondkinney — Jon Kinney, De Pere WI
10 merged PRs. +5,332. The most code in the project.

Jon shipped more lines than anyone while being repeatedly told to split things up, including by me, more than once. He never pushed back badly. He just came back with smaller, cleaner, independent PRs based on current main. That is a professional.

Retina media. A 144-DPI iPhone screenshot is a 2x image, but Qt sized it by decoded pixels so it rendered as a near-full-width wall. He made the fetcher read the image header at fetch time — PNG pHYs density plus pixel dimensions for PNG, JPEG, GIF and WebP — and report a pixel ratio alongside the cached file, including on cache hits, because the 800-unit texture cap makes implicit width unreliable for exactly the large images where it matters.

Read-only contact review, the biggest single feature in Blip: a cross-source duplicate scan, a fingerprint cache, and a card review surface opened from a conversation. What makes it worth studying is what it does not do. The bridge exposes only list, find, lookup, resolve, dump and sources, and the helper accepts exactly one operation. No writes, no Swift compile step, no Contacts mutation. The cache is bounded, opened through no-follow descriptors with owner and type checks, written through a private staging file and an atomic rename. I asked for this PR three times in three shapes. He delivered it three times.

Failed sends stop vanishing. A failed send used to lose its bubble entirely. He retains it with a bounded reason, distinguishes sends by local ID so two identical messages in the same second cannot collide, and rejects thread snapshots that predate the local send, so a reload that started first cannot erase the failure that came after.

Composite avatars for unnamed groups, where short names come from the contact's given-name or nickname field and never by splitting a full name — because splitting a full name is how you get "Van" out of "Van Der Berg."

Plus composer accessibility with optional local spellcheck that keeps draft text off disk and argv, a resizable panel that remembers its size but preserves your preference when a smaller display temporarily limits it, Ctrl+1-9 shortcuts, and vCard export where the save path cannot overwrite an existing file or follow a link.

━━━━━━━━━━

@adamgamble — Adam Gamble, Birmingham AL
5 merged PRs. +816. He finds the bugs where the data model is wrong, which is the hardest kind to see.

Family Sharing was renaming his wife. With Screen Time's Manage Contacts, each child's address book is mirrored onto the parent's Mac as its own CardDAV store. Contacts.app hides those, but Blip globbed every database on disk and let each one vote on a name. With two sons, the number saved in Adam's own contacts as Monica Gamble rendered as "Mom" in every thread, tile and group name. Two votes to one. He found the Accounts database flags those stores as child delegates, and dropped them before building the name index. Unreadable Accounts database falls back to exactly the previous behaviour.

EXIF orientation, fixed at both layers. iPhone photos render sideways because rotation is an EXIF tag, sips preserves it converting HEIC, Qt ignores it by default, and imv — Omarchy's default viewer, what xdg-open launches — has no EXIF support at all. He set autoTransform so Qt applies the transform at decode time and the bubble sizes to the rotated shape, AND baked the orientation into the cached file with a bounds-checked walk of the JPEG markers that reads orientation without decoding pixels, then piped through jpegtran. Lossless, ~50ms on a 12MP photo, keeps the Display P3 profile, drops the EXIF block so nothing double-rotates later. He included a measured before/after table.

Pinned tiles stopped popping in. Pin metadata only arrives on a deep poll, so every shallow poll rebuilt the list unpinned and the widget swapped its model for that. He cached pins (ids only, no content), re-applied them to shallow polls, made the widget overlay rather than replace, and made the first poll after a restart go deep so the pinned list is in memory before you ever open the panel.

Security codes. A detector that requires a trigger word and takes the 4-8 digit token nearest it, so money, percentages and phone numbers never qualify. The code lives in memory five minutes and nowhere else — not in state, not in argv, and deliberately not in the notification daemon's on-disk history. And the typing path is the detail I still think about: he sends the code as key-state events over Hyprland's socket rather than using wtype, because Hyprland merges a virtual keyboard's keys with the modifiers still held from your hotkey, so digits typed while Super+Shift were down fired workspace binds instead. He found that the hard way and wrote it down so nobody reaches for wtype again.

━━━━━━━━━━

jefehoser
5 merged PRs. +915. Five bugs found by actually living with the software.

Copied files attach instead of pasting a path. File managers put text/uri-list on the clipboard, not image/png, so Ctrl+V on a photo you copied sent the local file path as an iMessage. He made the clipboard helper treat a local file URI as an attachment, exactly like drag-and-drop. Same PR replaced the single-line compose field with a wrapping one, because typing a normal sentence ran off the right edge.

Group photos, and two stacked misses. Messages stores a group's photo on an announcement row, and the bridge hides announcement rows so they never become phantom unread bubbles — so the photo lookup joined through that same filter and could never see it. A multi-megabyte PNG also blew the avatar cap. Then the second miss: the first "no photo" was cached for a day, so a picture set a minute later was ignored until tomorrow.

Re-keyed group pins. Messages can give a group a new chat row after a re-invite and leave the pin on the retired row, so a pinned group silently vanished from Favorites. Separately it folds a phone SMS row and an email iMessage row under one group id while keeping two identifiers, so one person showed up as two conversations with the pin stuck on the stale handle.

The app window restores where you left it instead of stealing focus onto your current workspace. He identifies his own window by process ID and a unique temporary title, because title-matching alone has burned this project before — a foreign window called "Blip…" once counted as ours.

jefehoser has no X account published. Send me one.

━━━━━━━━━━

@jmythoren — Johan Thorén, Manila
3 merged PRs. +1,321. He made the full app window feel like an app instead of a bigger popout.

Live search, and a ranking bug underneath it. The window ignored n, / and Esc that the popout already handled, and both searches waited for Enter. He fixed that and made search run as you type. But the real find was underneath: a lowercase query missed newer iMessage bodies entirely, because those live only in attributedBody, so a May hit could outrank an August one. He made the Mac-side search scan lower, upper and title-case needles, then ranked whole-word matches above substrings and then by timestamp. He also discovered the text field's change signal simply does not fire in that window, so it has to be polled — the kind of thing you only learn by fighting it.

Jump to a thread with 1-9. macOS Messages uses Super+number, Omarchy already owns Super+1-9 for workspaces, so he used a bare digit. The care is in the exclusions: a digit is typed, not eaten, when the compose box has text, when search is open, when a file is queued, or when Shift is held.

And he read the upstream history. Omarchy 4.x turned off Hyprland's blur in a "Simplify rendering" commit, and a later revert restated that windows already sit at 0.985 opacity so blur was GPU work for almost nothing. Blip's window still mixed a background colour with a 0.70 backdrop alpha assuming blur was on, so the wallpaper showed through. He cited the upstream commit and the PR that discussed it, and deleted the alpha. Three lines. He had to read someone else's project history to justify them.

━━━━━━━━━━

@zachwilke_1 — Zach, Texas
1 merged PR. +501. Two fixes that changed how Blip feels.

"Mom ❤️" and "Mom❤️" are the same person. The bridge treated two cards in one source sharing a number as ambiguity and named nobody — correct when the names differ, wrong when it is one card saved twice. A heavily used conversation was showing as a bare number because of it. He normalises through NFKC, casefold and whitespace stripping before calling a collision ambiguous, so the first spelling wins and two genuinely different names still resolve to nobody.

Sending became instant. A send used to be ssh, then osascript, then a fixed 1.5 second wait for Messages to write the row, then a reload — about three seconds under an unchanged compose box. He made the bubble appear the moment you press Enter, with the field cleared so you can type the next one. In-flight sends live in memory only and ride every reload on stdin, never argv, and a reconciler keeps each provisional bubble until a real outbound row with the same text lands, one row per send, refusing any row older than the send minus clock skew so an early reload cannot make it blink. He measured it: 81 milliseconds from the call to the bubble being in the model.

He also caught that our own CI was lying. A merged fork PR showed a failed workflow because the approval expired before any job ran — zero jobs, no logs, and an annotation that reads exactly like a test regression to whoever sent the PR. He filed it with run IDs and was careful to say he could not inspect our approval policy with a contributor token, so he would not assume what it was. That is a contributor protecting other contributors.

━━━━━━━━━━

@tlehmanifold — Tobi Lehman, Portland OR
1 merged PR. +241. He solved political fundraising spam, and the reasoning is better than most design docs I have been paid to read.

The insight: the number is disposable, it will be a different five-digit short code next week, so blocking it is whack-a-mole. What is NOT disposable is the platform's name and the opt-out footer the TCPA legally requires every one of those messages to carry. So the mute list matches phrases as well as handles, and that is the whole reason it works.

Every matching rule has a stated reason and each is a trap he saw coming. Handles match exactly, so a substring of a phone number can never take out an unrelated number. Phrases match case-insensitively with a two-character minimum, so one stray character cannot mute the world. Matching is inbound only, because forwarding "another one of these, unbelievable" to a friend must not mute your friend. One match mutes the whole conversation, because a blast carries its footer on some messages and not others and half a thread left in the sidebar is worse than none. A chat whose newest message is your own reply survives.

Then he put the cut in exactly the right place: before the unread ledger, the thread builder and the toast selector, and also on the chat rows a deep run merges in — because the chat list reaches back further than the message window, so without that second half a blast from a month ago reappears the moment you open the panel. The watermark still advances across muted rows, so unmuting later does not replay them as a pile of new toasts.

━━━━━━━━━━

@joshuaswarren — Joshua Warren, Dallas
1 merged PR. +278. He fixed the case where Blip's badge disagreed with the phone in your pocket.

iPhone Messages files Spam and Filter Unknown Senders as filtered chats, and the phone's badge ignores both. Blip read the same database and counted them, so the bar could show 3 unread while the phone showed 0. The mute list could not help, because that is per sender and per phrase — this is a folder.

Two config keys, and the thing I want to call out is that both default to off. He shipped a feature that hides messages and made you ask for it. There is a rejected PR in this repo's history that defaulted a hide-things setting to true and would have silently hidden an SMS from a five-digit code that took a full day to make arrive at all. A default that hides messages is not a preference. Joshua got that right without being told. He also shipped seven test cases that need neither macOS nor a real database.

━━━━━━━━━━

@ezachrisen — Espen Zachrisen, Chicago
1 merged PR. +304. He built pinned conversations — the Favorites row across the top of the list, mirroring the pins you already set in Messages. It is the first thing anybody notices about the panel and it landed as one clean PR with tests.

The care is in the places that bite. He made the pin-preference parsing tolerant, because that file is Apple's and its shape is not a contract you control. He merged pin metadata with backward-compatible defaults, so an older bridge that knows nothing about pins still works. He split the list into pinned and unpinned sections while preserving keyboard selection by chat identity rather than by row index, which is the detail that keeps the cursor from breaking when the sections reshuffle. And he documented that it is read-only: Blip mirrors your pins, it never writes them back.

━━━━━━━━━━

tolewis — "Unhook Dev"
1 merged PR. +17. Seventeen lines. Read this one anyway — best lines-to-impact ratio in the project.

Group sends were failing with "Can't get chat id (-1728)". Messages was right, that chat does not exist. macOS keeps a separate chat row per service, so a group that has moved between iMessage, SMS and RCS leaves several rows sharing one identifier and differing only by GUID. Exactly one holds messages. The others are empty shells, and AppleScript cannot resolve an empty one.

Now the part that makes this great. The collector built its map keyed on the bare identifier, so the last row won. The query ended ORDER BY last_date DESC — and SQLite sorts NULL last on a DESC sort. An empty row has a NULL last_date. So the broken shell arrived last, overwrote the live entry, and got sent to.

He quantified it instead of asserting it. On one Mac with 489 group rows: 28 identifiers had more than one row, and 27 of those resolved to a row with zero messages. Twenty-seven conversations that could not send.

Seventeen lines, one NULL-ordering subtlety, twenty-seven broken conversations. No X account published — send me one, you have earned the tag.

━━━━━━━━━━

jethrojones — Jethro Jones
1 merged PR. +34. He fixed the setup checker, which matters more than it sounds, because it is the first thing a new user sees and it was lying to them.

The contacts check opened exactly one address book, and glob order is filesystem order, not sorted. Macs accumulate dead CardDAV sources whose database never opens no matter what permissions you grant. When a dead source happened to sort first, the wizard printed a red X and suggested a Full Disk Access fix that did nothing — because Full Disk Access was already granted, the check right above it passed, and contacts and avatars worked fine over the bridge. On his machine: 7 of 16 databases opened, contacts worked, and the checker said failure.

He made it iterate every source, sorted so it is deterministic instead of order-dependent flapping, and fail only when nothing opens, which is the real missing-permission signal. The line now reads like "13950 contacts readable (7/16 sources, 9 stale skipped)". He built a harness with a dead source deliberately sorted ahead of a good one to prove it.

No X account published. Send me one.

━━━━━━━━━━

THE PEOPLE WHO FILED THE ISSUES

An issue that comes with real diagnosis is worth as much as a patch, because it points at something the maintainer cannot see from where he is standing.

jacobaross filed the macOS 26.6.2 report where the Messages Automation grant could not be enabled — with the TCC database record attached, which was the whole diagnosis in one line: denied, reason Prompt Timeout. macOS gives that prompt about two minutes; our own checker killed its probe at 25 seconds and told you the prompt was "probably waiting on the Mac's screen." By the time anyone walked to the Mac the window had closed and macOS had written down a denial the Settings switch then refused to undo. He hypothesised exactly that, and he was right. Then he tested the fix, reported back that recovery worked with SIP still enabled, listed what he changed and what he left pinned so it was reproducible, and flagged that the checker had asked for an optional permission he never wanted and could not switch back off. That last note became a code change: Blip no longer fires a consent prompt nobody asked for.

dreinecke — David Reinecke, Johannesburg — filed that contact photos never showed, with the detail that the AddressBook stores the JPEG somewhere other than where we were looking. Contact photos are half of what makes Blip look like Messages instead of a terminal.

znayer — Zain Nayer, San Francisco — filed the case where a DM is labelled with the raw phone number when your own message is the newest in the thread. A naming bug that only appears in threads where you spoke last, which is exactly what a maintainer never trips over in his own testing.

apexbenny — Benny — filed that only five lines are visible when composing. He was right, and the cause was good: the compose box caps at five lines and clips, but a Qt text area only scrolls to follow its caret when it lives inside a flickable. Anchored to fill a clipped slot, it kept laying text out below the visible area, so past the fifth line you were typing blind. Fixed.

nova-centauri — Nova — sent the notification hardening PR: all/allow/off modes, skips for the open conversation and the self-thread, a batch cap so a catch-up after sleep cannot dump 150 cards at you, fail-closed parsing, and handle folding so +15550100011 and (555) 010-0011 are one person. It has not merged for one reason: I want a missing allowlist to stay badge-only, because this database is mostly bank alerts and 2FA codes and a fresh install must not fire twenty cards on its first catch-up. Every other idea in it is good and I still want it. Nova, the door is open.

━━━━━━━━━━

One more thing.

I am not a programmer. I am not a coder. I am an infrastructure guy by trade, enterprise storage arrays mostly, and what I actually bring is knowing what good looks like when I see it.

There is no chance I find bugs like SQLite sorting NULL last and silently selecting an empty chat row, or a Family Sharing child's address book outvoting your wife's contact card, or an EXIF tag that three separate pieces of software each ignore in a different way. I find those because these people found them, wrote them down properly, and were patient with a maintainer who kept asking them to split their PRs up.

And if not for @dhh, Omarchy and AI agents, I would still be designing enterprise storage arrays. Yawn.

51 pull requests. 11 authors. 5 more who filed issues that changed the code. 12,262 lines I did not write.

Thank you, all of you.

A note on handles: an @ here is a verified X account, taken from that person's own GitHub profile or their own site and checked. A bare name is their GitHub handle, because I could not find an X account for them and I will not @ a name I have not verified — that tags a stranger. If you are in here without a tag, send me your handle and I will add it.
