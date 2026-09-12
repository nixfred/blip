# The people who built Blip

Blip puts iMessage on Linux by treating a Mac you already own as the gateway. It
went from a toy to something I use every hour of every day in about ten days,
and **almost none of that was me.**

Fifty-one pull requests have merged. Eleven people wrote them. Five more filed
issues that changed the code. Between them they added **12,262 lines** and
deleted 1,173, and more importantly they found the things I could not find,
because I was staring at my own code and they were staring at their own Macs.

I want to name every single one of them and say exactly what they did, in
detail, because "thanks contributors" is a cop-out and these people did real
engineering.

Handles below are matched from what each person published themselves — their
GitHub profile's X field or their own website. Where someone has not published
one, I say so rather than guess. **If I have you wrong, or you have an account I
missed, tell me and I will fix it immediately.**

---

## @Fileri — Erik Fillipsveen — Oslo, Norway
**22 merged PRs. +2,503 / −299. No public X account that I could find.**

Erik is the single largest contributor to this project and it is not close. He
merged twenty-two pull requests. I want to walk through the ones that changed
how the thing works, because the range here is absurd — he went from SQLite
semantics on the Mac to keyboard focus handling in QML, in the same week.

**The one I keep telling people about: contacts saved without a country code.**
Blip matched a phone number to a contact card on the last ten digits. That is a
whole national number in North America and it is *nothing* anywhere else. A
Norwegian card saved as `123 45 678` never matched the handle `+4712345678`, so
that person showed up as a bare number with initials instead of a name and a
face. On one Norwegian address book, **99 of 386 numbers** were saved that way.
Erik found it because it was happening to his own card.

The fix is the most careful piece of code in the repository. He generated a
region-to-calling-code table for **245 regions** from libphonenumber v9.0.38, and
left the regeneration one-liner in the file header so it can be refreshed.
Because that set is prefix-free, splitting a `+` number into calling code and
national number is unambiguous. He then implemented libphonenumber's
SHORT_NSN_MATCH — two numbers match when their calling codes agree and one
national number ends with the other — with a floor of seven shared digits, and
one refusal that Contacts itself does not make: a North American card shorter
than ten digits is missing its area code, so he refuses it rather than guessing.
The exact last-ten key still wins whenever it hits, so nothing that already
resolved could change. That is a man who understood that the dangerous outcome
was not "no match" but "confidently wrong match."

**Announcements are not messages.** Joins, leaves, renames and location-sharing
notices live in the same table as real messages with `item_type != 0`, and Apple
never marks them read. Let one through and you get an empty bubble that counts as
unread *forever*. He killed them at the source.

**An unsend is not an edit.** On macOS 26, Undo Send never sets `date_retracted`
— it stamps `date_edited`, clears the body, and records the withdrawn parts as
`rp` in `message_summary_info`, while a real edit carries `ec` and keeps its
body. He read both, made retracted win, and produced a tombstone instead of an
empty bubble labelled "Edited." Then he found that in your *own* self-thread the
echo shape inverts, because an unsend withdraws only the sent copy.

**`chat:null` exists.** A row with neither chat nor handle is the leftover of a
conversation you deleted — iCloud keeps the row, the chat and the join are gone.
Without his fix it became a nameless, unopenable thread.

**iMessage app cards are text hiding in a payload.** Ask to Buy, Fitness
sharing, Find My and friends store U+FFFD as the message text and an MSMessage
archive in `payload_data`. He taught the bridge to read `ldtext` out of that
archive — the sentence Messages itself shows when it cannot render the app.
Quiet conversations stopped previewing as a replacement character.

**Then he did the entire keyboard.** A cursor that scrolls to follow itself and
stops at the ends instead of wrapping. A bubble cursor inside a conversation with
Enter, Ctrl+C and Ctrl+R actions, PgUp/PgDn/Home/End paging, and an edge rule so
the arrows still move the caret when there is a draft. Per-conversation drafts
that survive switching threads, in memory only, because message text never lands
on disk. A sidebar peek that previews the thread under the cursor **without
marking it read** — and the shape of that one is what impressed me: he routed
both read-marking call sites through a single function gated on one flag, and
wrote the test that asserts the old direct call is *gone*, not merely unused.

**And he found that Omarchy's own panel hotkeys never worked on Blip.** The bar
locates a widget's panel through `open()`, `close()` and an `opened` property.
Blip had the first two. Every `SUPER+CTRL+<n>` silently skipped it. One readonly
property, and a whole class of "why doesn't the hotkey work" vanished.

He also pinned the SSH key to the enrolling machine over Tailscale, taught the
tests to read their own config instead of the developer's, made list rows take
the theme's hover fill, made secondary text dim by alpha so it reads correctly on
light themes, fixed tapback pills on picture-only messages and on notes to
yourself, added `spell=` to pick dictionaries, and taught `imsg attachment` that
stickers live in the Messages StickerCache.

**And he is not finished.** He has an open issue arguing — with a measured log,
160 confirmed reactions, and latency percentiles — that outbound tapbacks do
**not** need SIP disabled, because the Accessibility line `imsg-read` already
crossed reaches them through AX custom actions. He built it, measured it, listed
its failure modes honestly, and then asked whether I wanted it before sending a
PR. That is how you file a feature request.

Erik: you have no X account I can find. Send me one and it goes at the top of
this file.

---

## @jondkinney — Jon Kinney — De Pere, WI — @headwayio
**10 merged PRs. +5,332 / −457. The largest volume of code in the project.**

Jon shipped more lines than anyone, and did it while being repeatedly told to
split things up — including by me, more than once. He never once pushed back
badly. He just came back with smaller, cleaner, independent PRs based directly
on current main. That is a professional.

**Retina media.** A 144-DPI iPhone screenshot is a 2x image. Qt sized it by
decoded pixels, so it rendered as a near-full-width wall in the conversation. He
made `fetch.ts` read the image header at fetch time — PNG `pHYs` density plus
pixel dimensions for PNG, JPEG, GIF and WebP — and report `pixelRatio` alongside
the cached file, including on cache hits. The QML then sizes from those metrics
instead of `implicitWidth`, which the 800-unit texture cap makes unreliable for
exactly the large images where it matters. He also caught that Qt's default link
blue was illegible on the accent bubble fill, and that tall link artwork was
being cropped to a shallow banner.

**Read-only contact review**, which is the biggest single feature in Blip: a
cross-source duplicate scan, a fingerprint cache, and a card review surface you
open from a conversation. What makes this one worth studying is what it *does
not* do. It is read-only and provably so — the bridge exposes only `list`,
`find`, `lookup`, `resolve`, `dump` and `sources`, and the JXA helper accepts
exactly one operation, `available`, which returns a filtered list of ids. No
writes, no Swift compilation step, no Contacts mutation. The scan cache is
bounded to 512 KiB, opened through no-follow non-blocking descriptors with owner
and type checks, and written through a private staging file and a
descriptor-relative atomic rename. I asked him for this PR three separate times
in three different shapes. He delivered it three times.

**Failed sends stop vanishing.** A send that fails used to lose its optimistic
bubble entirely. He retains it with a bounded Not Delivered reason, distinguishes
sends by local ID so two identical messages in the same second do not collide,
and rejects thread snapshots that predate the local send — so a reload that
started first cannot erase the failure that came after. Provisional bubbles never
advance read marks.

**Composer accessibility.** He exposed the compose field as named editable
multiline text for accessibility tools, and added optional Hunspell spellchecking
where the helper emits only UTF-16 ranges — the draft text itself never touches
disk or argv. He also documented that Hyprcorrect needs Quickshell's upstream
accessibility fix, because QML metadata alone cannot repair an unpatched shell.
Knowing the limit of your own patch and writing it down is rarer than it should
be.

**A resizable panel that remembers its size**, clamped to 80% of the current
display height and 500 logical pixels wide or the available space, whichever is
smaller — and it preserves your saved preference when a smaller display
temporarily limits it, instead of overwriting it. He also restored contiguous
conversation rows with text-aligned separators where hover hides both adjacent
separators.

**Composite avatars for unnamed groups.** Groups outside the recent window
showed opaque chat IDs. He used participant names in both list-merge paths,
joined with a final ampersand the way Messages does, and drew a composite of up
to four participant photos or initials. The detail I liked: short names come from
the contact's given-name or nickname field, **never by splitting a full name**,
because splitting a full name is how you get "Van" out of "Van Der Berg."

Plus Ctrl+1–9 pinned shortcuts and a back arrow, bounded-batch scanning past 200
contacts, full read-only source-card details, and vCard copy/save where the
clipboard receives an actual file through `text/uri-list` and the save path
cannot overwrite an existing file or follow a link.

**X: [@jondkinney](https://x.com/jondkinney)**

---

## @jefehoser
**5 merged PRs. +915 / −126. No name and no X account published.**

Five PRs, every one of them a bug found by actually living with the software.

**Copied files attach instead of pasting a path.** File managers put
`text/uri-list` on the clipboard, and often a `file://` path as `text/plain` —
not `image/png`. So Ctrl+V on a photo you copied in your file manager sent the
*local path* as an iMessage. He made the clipboard helper treat a local file
URI as an attachment, exactly like drag-and-drop. In the same PR he replaced the
single-line `TextField` compose box with a width-capped wrapping `TextArea`,
because typing a normal sentence ran off the right edge.

**Group photos, and two stacked misses.** Messages stores a group's photo on an
announcement row with `item_type = 3`. The bridge hides announcement rows so they
never become phantom unread bubbles — and the photo lookup joined through that
same filter, so it could never see `GroupPhotoImage`. A multi-megabyte PNG also
blew the 2 MB avatar cap. Then the *second* miss: the first "no photo" answer was
cached for a day on disk, so a picture you set a minute later was ignored until
tomorrow. He fixed both and kept the rule that a group never borrows a member's
face.

**Re-keyed group pins and merged DMs.** Messages can give a group a brand new
chat row after a re-invite or an iCloud shuffle, and leave the pin on the
*retired* row's `group_id` — so a pinned group silently vanished from Favorites.
Separately, Messages folds a phone SMS row and an email iMessage row under one
`group_id` while keeping two `chat_identifier`s, so your one conversation with a
person showed up as two, with the pin stuck on the stale SMS handle. He made pins
match every identifier in the cluster and made merged 1:1s fold like re-keyed
groups.

**The app window restores where you left it.** Blip's window is recreated
whenever the shell or plugin bar reloads, and it used to reappear on whatever
workspace you were on, stealing focus. He remembers workspace moves and places
the replacement quietly before mapping it. The part I checked hardest: he
identifies his own window by process ID *and* a unique temporary title, because
title-matching alone has burned this project before — a foreign window called
"Blip…" once counted as ours.

**No X account published.** Send me one.

---

## @adamgamble — Adam Gamble — Birmingham, AL — Eezy
**5 merged PRs. +816 / −35. Also filed the issue that started pinned conversations.**

Adam has a habit of finding the bug where the *data model* is wrong, not the
code, which is the hardest kind to see.

**Family Sharing was renaming his wife.** With Screen Time's Manage Contacts,
each child's address book is mirrored onto the parent's Mac as its own CardDAV
store. Contacts.app hides those from All Contacts — but Blip globbed every
`.abcddb` on disk and let each one vote on a name. With two sons, the number
saved in Adam's own contacts as **Monica Gamble** rendered as **Mom** in every
thread, every pinned tile and every group name. Two votes to one. He found that
the Accounts database flags those stores with `isChildDelegate = YES`, and that
the `Sources/<id>/` folder name is the account identifier, so the bridge can drop
them before it builds the name index. An unreadable Accounts database falls back
to exactly the previous behaviour. That is a beautiful bug and a beautiful fix.

**EXIF orientation, done properly, twice.** iPhone photos render sideways
because rotation is stored as an EXIF tag, `sips` preserves that tag when
converting HEIC, Qt ignores it by default, and imv — Omarchy's default viewer,
which is what `xdg-open` launches — has no EXIF support at all. Adam fixed both
layers: `autoTransform: true` on the QML images so Qt applies the transform at
decode time and the bubble sizes to the rotated shape, **and** he bakes the
orientation into the cached file with a pure, bounds-checked walk of the JPEG
markers that reads orientation without decoding pixels, then pipes through
`jpegtran -copy icc` on stdin/stdout. Lossless, about 50 ms on a 12 MP photo,
keeps the Display P3 colour profile, and drops the EXIF block so nothing can
double-rotate later. He included a measured before/after table.

**Pinned tiles stopped popping in.** Pin metadata only arrives on a deep poll,
so every shallow poll rebuilt the thread list with `pinned: false` and the widget
swapped its model for that — you would open the panel, see a dozen unpinned rows,
and watch them re-pin a second later. He cached pins in state (ids only, no
content), re-applied them to shallow polls, and made the widget *overlay* a
shallow result onto the last deep list instead of replacing it. Then he made the
first poll after a shell restart go deep, so the complete pinned list is already
in memory before you ever open the panel.

**Security codes.** This is Blip's answer to the macOS feature that reads a
one-time code out of an SMS. His detector requires a trigger word and picks the
4–8 digit token nearest it, so money, percentages, phone numbers and URLs never
qualify. The code lives in memory for five minutes and nowhere else — not in
state, not in argv, and deliberately not in the notification daemon's on-disk
history. And the typing path is the detail I still think about: he sends the code
as `send_key_state` events over Hyprland's socket rather than using `wtype`,
because Hyprland merges a virtual keyboard's keys with the physical modifiers
still held from your hotkey, so digits typed while Super+Shift were down fired
workspace binds instead. He found that the hard way and wrote it into the project
notes so nobody reaches for `wtype` again.

**X: [@adamgamble](https://x.com/adamgamble)**

---

## @johanthoren — Johan Thorén — Metro Manila, Philippines — @ITRS-Group
**3 merged PRs. +1,321 / −147.**

Johan did the work that made the full app window feel like an app instead of a
bigger popout.

**Live search, and a ranking bug underneath it.** The Super+M window ignored
`n`, `/` and Esc that the bar popout already handled, and both searches waited
for Enter. He made the window catch those keys, made search run as you type, and
put conversations above messages. But the real find was underneath: a lowercase
query **missed newer iMessage bodies entirely**, because those live only in
`attributedBody`, so a May hit could outrank an August one. He made the Mac-side
search scan lower, upper and title-case needles in `attributedBody`, and ranked
whole-word matches above substrings and then by message timestamp. He also cached
the contact dump for 60 seconds in the runtime dir, and discovered that
`TextField`'s `textChanged` simply does not fire in that window, so the field has
to be polled — the kind of thing you only learn by fighting it.

**Jump to a thread with 1–9.** macOS Messages uses Super+number; Omarchy already
owns Super+1–9 for workspaces, so he used a bare digit, consistent with `n` and
`/`. The care is in the exclusions: a digit is typed, not eaten, when the compose
box has text, when search or new-message is open, when a file is queued, or when
Shift is held — and a digit with no matching row is passed through rather than
swallowed.

**And he read the upstream history.** Omarchy 4.x turned off Hyprland's blur in a
"Simplify rendering" commit, and a later revert restated that windows already sit
at 0.985/0.96 opacity so blur was GPU work for almost nothing. Blip's window
still mixed a background colour with a 0.70 backdrop alpha on the assumption that
blur was on — so the wallpaper showed through. He cited the upstream commit *and*
the PR that discussed it, matched what the shell's other floating window does,
and deleted the alpha. Three lines changed. He had to read someone else's project
history to justify them.

**X: [@jmythoren](https://x.com/jmythoren)**

---

## @zachwilke — Zach — Texas — pinefall.dev
**1 merged PR. +501 / −44. Also filed the CI issue that fixed our own process.**

Zach's single PR is two fixes that between them changed how Blip *feels*.

**"Mom ❤️" and "Mom❤️" are the same person.** The bridge treated two cards in
one source sharing a number as ambiguity and named nobody — correct when the
names genuinely differ, wrong when it is one card saved twice. A heavily used
conversation was showing as a bare number with no photo because of it. He added a
name key that normalises through NFKC, casefold and whitespace stripping before
calling a collision ambiguous, so the first spelling wins and two genuinely
different names still resolve to nobody. Photos follow the same rule.

**Sending became instant.** A send used to be ssh, then osascript, then a fixed
1.5-second wait for Messages to write the row, then a thread reload — about three
seconds under an unchanged compose box. He made the bubble appear the moment you
press Enter, captioned "Sending…", with the field cleared so you can type the
next one. In-flight sends live in memory only and ride every thread reload on
stdin — never argv — and a reconciler keeps each provisional bubble until a real
outbound row with the same text lands, one row per send, refusing any row older
than the send minus clock skew so an early reload cannot make the bubble blink. A
failure drops the bubble and puts your text back. He measured it: **81
milliseconds** from the call to the bubble being in the model.

He also caught that our own CI was lying. A merged fork PR showed a failed
workflow because the approval expired before any job ran — zero jobs, no logs,
and an annotation that reads exactly like a test regression to whoever sent the
PR. He filed it with the run IDs and was careful to say he could not inspect our
approval policy with a contributor token, so he would not assume what it was.
That is a contributor protecting *other* contributors.

**X: [@zachwilke_1](https://x.com/zachwilke_1)**

---

## @tlehman — Tobi Lehman — Portland, OR — Perforce Software
**1 merged PR. +241 / −2.**

Tobi solved political fundraising spam, and the design reasoning in his PR is
better than most design documents I have been paid to read.

The insight: the *number* is disposable — it will be a different five-digit short
code next week, so blocking it is whack-a-mole. What is **not** disposable is the
platform's name and the opt-out footer that the TCPA legally requires every one
of those messages to carry. So his mute list matches **phrases** as well as
handles, and that is the whole reason it works.

Every matching rule has a stated reason, and each one is a trap he saw coming.
Handles match exactly, so a substring of a phone number can never take out an
unrelated number. Phrases match case-insensitively anywhere in the text with a
two-character minimum, so one stray character cannot mute the world. Matching is
**inbound only**, because forwarding "another one of these, unbelievable" to a
friend must not mute your friend. One match mutes the whole conversation, because
a blast carries its footer on some messages and not others and half a thread left
in the sidebar is worse than none. And a chat whose newest message is your own
reply survives.

Then he put the cut in exactly the right place: in the collector, on the deduped
window *before* the unread ledger, the thread builder and the toast selector —
and also on the chat rows a deep run merges in, because the chat list reaches
back further than the message window, so without that second half a blast from a
month ago would reappear the moment you opened the panel. Filtering upstream of
the ledger means there is no second filter in the QML to keep in sync and a muted
conversation cannot badge the bar. The watermark still advances across muted
rows, so unmuting later does not replay them as a pile of new toasts.

**X: [@tlehmanifold](https://x.com/tlehmanifold)**

---

## @joshuaswarren — Joshua Warren — Dallas, TX
**1 merged PR. +278 / −23.**

Joshua fixed the case where Blip's badge disagreed with the phone in your pocket.

iPhone Messages files Spam as `chat.is_filtered = 2` and Filter Unknown Senders
as `1`, and the phone's badge ignores both. Blip read the same database and
counted them, so the bar could show 3 unread while the phone showed 0. The mute
list could not help, because that is per sender and per phrase — this is a
*folder*.

Two `bridge.conf` keys, `hide_spam` and `hide_unknown`, and the thing I want to
call out is that **both default to off.** He shipped a feature that hides
messages and made you ask for it. There is a rejected PR in this repo's history
that defaulted a hide-things setting to true and would have silently hidden an
SMS from a five-digit code that took a full day to make arrive at all. A default
that hides messages is not a preference. Joshua got that right without being
told.

The rest is tidy: the Linux shim injects the flags on `imsg` only, the Mac query
drops those chats from `recent`, `chats` and `search` so there is no sidebar row,
no unread and no toast, while an explicit `thread` still loads the conversation if
you have its id. And when `chat.is_filtered` is missing on an older schema, no
predicate is added at all. He shipped seven test cases that need neither macOS nor
a real database.

**X: [@joshuaswarren](https://x.com/joshuaswarren)**

---

## @ezachrisen — Espen Zachrisen — Chicago, IL — Altice USA
**1 merged PR. +304 / −28.**

Espen built pinned conversations — the Favorites row of avatar tiles across the
top of the list, mirroring the pins you already set in Messages. It is the first
thing anybody notices about the panel and it landed as one clean PR with tests
and a documented privacy stance.

The implementation is careful in the places that bite. He extended the Mac chats
JSON with **tolerant** pin-preference parsing, because that preference file is
Apple's and its shape is not a contract you control. He kept pin ordering stable
rather than incidental. He merged pin metadata into the collector's thread model
with backward-compatible defaults, so an older bridge that knows nothing about
pins still works. He split the QML list into pinned and unpinned sections while
**preserving keyboard selection by chat identity** rather than by row index —
which is the detail that makes it not break the cursor when the sections
reshuffle. And he documented that the feature is read-only: Blip mirrors your
pins, it never writes them back.

**X: [@ezachrisen](https://x.com/ezachrisen)**

---

## @tolewis — "Unhook Dev"
**1 merged PR. +17 / −3. Seventeen lines. Read this one anyway.**

This is the best lines-to-impact ratio in the entire project.

Group sends were failing with `Can't get chat id "SMS;+;chat<digits>" (-1728)`.
Messages was right — that chat does not exist. macOS keeps a **separate chat row
per service**, so a group that has moved between iMessage, SMS and RCS leaves
several rows sharing one `chat_identifier`, differing only by GUID. Exactly one
of them holds messages. The others are empty shells, and AppleScript cannot
resolve an empty one.

Now the part that makes this a great bug report. `imsg groups` returned every
row, and the collector built its map keyed on the bare identifier — so the last
row won. The query ended `ORDER BY last_date DESC`, and **SQLite sorts NULL last
on a DESC sort**. An empty row has a NULL `last_date`. So the broken, empty shell
arrived last, overwrote the live entry, and got sent to.

He quantified it instead of asserting it. On one Mac with 489 group rows: 28
identifiers had more than one row, and **27 of those resolved to a row with zero
messages.** Twenty-seven conversations that could not send, in the panel and from
the command line.

Seventeen lines, one NULL-ordering subtlety, twenty-seven broken conversations.
**No X account published — send me one, you have earned the tag.**

---

## @jethrojones — Jethro Jones
**1 merged PR. +34 / −9.**

Jethro fixed the setup checker, which matters more than it sounds, because the
setup checker is the first thing a new user sees and it was lying to them.

`check_contacts()` opened exactly **one** address book — `glob(...)[0]` — and
glob order is filesystem order, not sorted. Macs accumulate disabled and stale
CardDAV sources whose database never opens no matter what permissions you grant.
The real contacts tool already handled this: it warns, skips, and moves on. But
when a dead source happened to sort first, the setup wizard printed a red X for
contacts and suggested a Full Disk Access fix that **did nothing**, because Full
Disk Access was already granted — the chat database check right above it passed.
Meanwhile contacts and avatars worked perfectly over the bridge.

On his machine: 7 of 16 source databases opened, contacts worked, and the checker
said failure.

He made it iterate every source, sorted so the result is deterministic instead of
order-dependent flapping, sum records across the ones that open, and fail only
when *nothing* opens — which is the real missing-permission signal. The detail
line now reads like `13950 contacts readable (7/16 sources, 9 stale source(s)
skipped)`, so stale sources are visible without being alarming. He even built a
local harness with a dead source deliberately sorted ahead of a good one to prove
it.

**No X account published. Send me one.**

---

# The people who filed the issues

An issue that comes with real diagnosis is worth as much as a patch, and
sometimes more, because it points at something the maintainer literally cannot
see from where he is standing.

## @jacobaross
Filed the macOS 26.6.2 report where the Messages Automation grant could not be
enabled — and he filed it **with the TCC database record attached**, which was the
entire diagnosis in one line: `auth_value 0, auth_reason 9`. Denied, reason
*Prompt Timeout*. macOS gives that Allow prompt about two minutes; our own
checker was killing its probe at 25 seconds and telling you the prompt was
"probably waiting on the Mac's screen." By the time anyone walked to the Mac, the
window had closed and macOS had written down a denial that the Settings switch
then refused to undo. He hypothesised exactly that in his own report, and he was
right. Then he tested the fix, reported back that the recovery worked with SIP
still enabled, listed precisely what he had changed and what he had left pinned
so the result was reproducible — **and** flagged one more thing: the checker had
asked for an optional System Events permission he never wanted and could not
switch back off. That last note became a code change. Blip no longer fires a
consent prompt nobody asked for.

## @dreinecke — David Reinecke — Johannesburg, South Africa
Filed the report that contact photos never showed, with the detail that the
AddressBook stores the JPEG somewhere other than where we were looking. Contact
photos are half of what makes Blip look like Messages instead of a terminal.

## @znayer — Zain Nayer — San Francisco
Filed the case where a DM is labelled with the raw phone number when your own
message is the newest one in the thread. That is a naming bug that only shows up
in threads where *you* spoke last, which is exactly the kind of conditional bug a
maintainer never trips over in his own testing.

## @apexbenny — Benny — Apex Technology Group
Filed that only five lines are visible when composing a message. He was right, and
the cause was genuinely interesting: the compose box caps its height at five lines
and clips, but a Qt text area only scrolls to follow its caret when it lives
inside a flickable. Anchored to fill a clipped slot, it just kept laying text out
below the visible area — so past the fifth line you were typing completely blind.
That is now fixed. **Benny, your issue is still open and it should not be; that is
my bookkeeping failing, not your report.**

## @nova-centauri — Nova
Sent the system-notification hardening PR: an all/allow/off mode, skips for the
open conversation and the self-thread, a batch cap so a catch-up after sleep
cannot dump 150 notification cards at you, fail-closed parsing, and handle folding
so `+15550100011` and `(555) 010-0011` are recognised as one person. It has not
merged for one reason — I want a missing allowlist to stay badge-only, because
this database is mostly bank alerts and 2FA codes and a fresh install must not
fire twenty cards on its first catch-up. Every other idea in that PR is good and I
still want it. Nova, the door is open.

---

# One more thing

**I am not a programmer.** I am not a coder. I am an infrastructure guy by
trade — enterprise storage arrays, mostly — and what I actually bring is knowing
what *good* looks like when I see it.

There is no chance I find bugs like SQLite's NULL ordering silently selecting an
empty chat row, or a Family Sharing child's address book outvoting your wife's
contact card, or an EXIF tag that three separate pieces of software each ignore
in a different way. I find those because these people found them, wrote them
down properly, and were patient with a maintainer who kept asking them to split
their PRs up.

And if not for [@dhh](https://x.com/dhh), Omarchy, and AI agents, I would still
be designing enterprise storage arrays. Yawn.

Fifty-one pull requests. Eleven authors. Five more people who filed issues that
changed the code. Twelve thousand lines I did not write.

Thank you. All of you.

— Fred ([@nixfred](https://x.com/nixfred))

---

*Handles were matched from each contributor's own GitHub profile field or their
own published website, then verified as live accounts. Nothing here is guessed.
Where no public account exists I have said so. Corrections welcome and will be
applied immediately — open an issue or just tell me.*
