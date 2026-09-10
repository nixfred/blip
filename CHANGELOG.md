# Changelog

## 2.4.0 — 2026-09-08 — read it from the keyboard, send without the wait

- **Reading a conversation can now clear it on your phone.** `push_read` in
  `bridge.conf` gained a documented middle setting and a status surface. The
  default, `all`, pushes to the Mac *only* on the mark-all gesture — so reading
  one thread in Blip cleared its dot here and left the iPhone badge alone,
  which looked exactly like a broken push. `push_read=thread` also pushes each
  DM you open (groups have no `imessage://` form, so they still need mark-all).
  A per-thread push now fires only when that run actually turned unread into
  read: every poll while a thread is open carries its readChat, and pushing on
  each one meant five ssh round trips a minute, four of them "nothing unread",
  each pulling Messages to the front of the Mac. `status` reports the live
  policy as `read_push=`, and the field that used to read `push=` is now
  `watch=` — it was always the message watcher, never read-pushing, and the
  collision is what made this undiagnosable.

- **The conversation list stopped scanning the address book.** With startup
  amortised, what was left was compute — and `chats` was spending 104 ms of
  every request resolving names, because a handle with no exact last-ten key
  fell back to comparing it against all 442 saved numbers. 298 conversations
  meant 60,112 comparisons. They are bucketed by their last seven digits now,
  which is sound rather than lucky: the matching rule only ever matches when
  one number is a suffix of the other with a seven-digit floor, so the last
  seven always agree. Checked against the old full scan over all 750 distinct
  handles in a real chat.db: identical answers, zero mismatches.
  Group clusters and pins are memoised too, against the chat table's shape and
  the pinning plist's mtime rather than chat.db's — which changes on every
  message and would have cached nothing during the busy minute that matters.
  Opening a conversation is 83 ms now (223 ms before any of this), a poll
  39 ms (160 ms), a deep poll 342 ms (707 ms).

- **A persistent channel to the Mac.** Even with the probe gone, every query
  still paid ~90 ms before it read a row: ssh, `blip-dispatch`'s Python start,
  `imsg`'s own, and opening a 218 MB chat.db — for SQL that takes about a
  millisecond. `imsg serve` now answers many requests on one long-lived
  process with chat.db already open, and `blip-bridged` on the Linux side
  keeps two of those channels up (two, because Blip refreshes the list and
  reloads the open conversation in parallel, and a single channel would queue
  the reload behind a 259 ms `chats` call). The bar widget starts it, on the
  leader bar only, exactly as it already runs the push watcher — which is why
  Blip still needs no daemon of its own.
  It is an accelerator and never a dependency: no socket, no socat, a daemon
  that died mid-request, a frame that will not parse — anything at all — and
  the ordinary one-shot ssh path answers instead. The channel carries
  read-only queries only; attachments and avatars stream binary and would park
  it behind a 100 MB photo, and `watch` blocks by design, so those stay
  one-shot. Message text still rides stdin rather than argv.
  Measured end to end: opening a conversation 223 → ~105 ms, a poll 160 →
  ~36 ms, a deep poll 707 → ~370 ms.

- **The bridge stopped paying a toll on every call.** Blip felt subtly laggy
  rather than slow, and measuring said why: nothing was slow, everything paid
  startup. A bridge call cost ~133 ms while the SQL underneath ran in about a
  millisecond — 16 ms ssh, ~25 ms for `blip-dispatch`'s Python start, ~20 ms
  for `imsg`'s, 27 ms to open a 218 MB chat.db. On top of that the shim fired
  a *second* full ssh round trip before every call, purely as a connectivity
  probe: 41 ms, a third of the total, to turn a transport failure into a
  friendlier sentence. ssh already reports that as 255 and every caller in
  Blip has always treated 255 exactly like 69, so the probe is gone and the
  real call carries the news; the `69 → Blip greys out` contract is unchanged.
  That also retires the trap it came with — the probe had to be `ssh -n` or it
  ate stdin and silently emptied `--file-stdin` payloads.
  The push debounce came down from 250 ms to 60 ms. It is paid on every
  received message *and* on every send (Messages writing the row is itself a
  chat.db change), and at 250 ms it was more than twice the cost of the 116 ms
  fetch it was coalescing; a burst still costs one fetch. The post-send reload
  fell from 600 ms to 250 ms, now a fall-back for when the watcher is down
  rather than the mechanism.
  Measured, warm: a bridge call 132 → ~95 ms, opening a conversation 223 →
  ~185 ms, a poll 160 → ~118 ms, a deep poll 707 → ~590 ms.
  Two things measurement talked us OUT of: replacing `cmd_chats`' 300-query
  N+1 with one window function is slower (70 → 107 ms; the per-chat lookups
  are indexed), and bundling the deep poll's three calls into one would be
  undone by the persistent channel coming next.

- **A message can carry several files.** Dropping five photos on a
  conversation attached one and threw the other four away without a word: the
  drop handler read `urls[0]` and the draft was a single path. Drafts are a
  list now — drag-and-drop takes every file, `/attach` and Ctrl+V add to it,
  and each chip has its own ✕. They ship one part per file in the order you
  queued them, with the caption on the first only (repeating it would post the
  same sentence five times), and the service is captured when the batch starts
  so switching threads mid-send cannot push a later part onto a different one.
  A part that fails stops the batch and leaves the rest attached, saying how
  many, rather than making you work out which of five went out. Capped at ten
  files, because a stray drop of a folder should be refused and not become
  eighty sends. Chips are one per row, like the received ones — a row of N
  sums its implicit widths and drags the whole column off the panel.

- **GIFs move.** An animated GIF arrived as a still, and did so twice over. The
  inline-preview path asks the Mac to resample every image with sips, which
  flattens an animation to a single frame — a 1.4 MB GIF reached Linux as a
  198 KB JPEG, the motion gone before the panel ever saw it. Animated formats
  now skip that path and cross as their own bytes, into the same cache slot a
  click uses. And a QML `Image` paints one frame whatever you hand it, so
  animated attachments render through `AnimatedImage` instead; stills stay on
  `Image`, which is what applies `autoTransform` (the EXIF fall-back for
  anything cached before orientation was baked in at fetch time). Only the
  active renderer loads, so no photo decodes twice, and the decode is still
  bounded in both axes. GIF dimensions now come off the header too — they read
  0×0 before, leaving the bubble nothing to size itself from.

- **Time crosses the bridge as UTC.** Stamps used to arrive as the Mac's naive
  wall clock ("2026-09-07 14:33:12") and were compared against the Linux
  clock — the same string only while both machines sat in one timezone. A Mac
  an hour ahead put every read mark ahead of every message, so nothing ever
  counted as unread; an hour behind and the backlog re-toasted. And once a
  year, in the DST fall-back hour, the Mac's own clock repeated itself: two
  messages an hour apart carried the SAME stamp, so ordering, the watermark
  and "newer than the mark" all quietly stopped meaning anything for that
  hour. The bridge now emits ISO-8601 UTC (`2026-09-07T18:33:12Z`), which is
  monotonic and whose lexical order is chronological order — the property
  every ledger, sort and watermark in Blip was already assuming. Local time
  became a display concern: bubbles, day dividers, "Today"/"Yesterday" and
  read receipts are rendered in the READER's zone, so a day still breaks at
  your midnight and not at Greenwich's. `imsg`'s own plain-text output keeps
  the Mac's clock — a person reading `imsg recent` wants the time they
  remember. Upgrading migrates the marks in `state.json`, and stamps from a
  Mac still on the old bridge are normalised as they come in, so a
  half-upgraded pair keeps working instead of silently going quiet.

- **Pinned avatars no longer grow on the first cursor move.** The tiles were
  measured before the grid had its width, and the layout kept that small size
  until the next relayout; the size is now a layout hint, so they render at
  full size from the first frame.
- **Drafts survive a thread switch.** Text typed but not sent is now kept per
  conversation as you move between threads and restored when you return; the
  panel and the app window share the same drafts. In memory only, so no message
  text lands on disk. Sending, or clearing the field, drops that conversation's
  draft.
- **The keyboard cursor scrolls the list.** j/k and the arrow keys could walk
  the selection below the visible rows — thread list, search hits and the
  new-message picker alike — while the list stayed put. The cursor row now
  registers itself and every move keeps it inside the viewport, with the
  helper Omarchy's audio and Tailscale panels use (a multi-section Column has
  no `positionViewAtIndex`); rows answer "am I the cursor?" with one string
  compare instead of scanning every thread per row per keypress. The cursor
  stops at the first and last row instead of wrapping. Up from the first row
  scrolls to the top and focuses the search field; Down in an empty search or
  new-message field returns to the list at its first row; Esc out of a field
  or a conversation returns to the row you were on. `/` and `n` scroll to the
  top too — pressed deep in the list they used to focus a field that was out
  of view. The app window (SUPER+M) had no list navigation at all, so Up/Down
  and Enter walk the list there as well while no editor has focus.
- **Sending is instant.** Enter used to mean "sending…" under an unchanged
  compose field for about three seconds: the ssh hop, osascript, a fixed
  1.5 s wait for Messages to write the row, then a thread reload. Now the
  bubble is drawn as Enter is pressed, captioned "Sending…", the field clears
  at once, and a second message can follow without waiting (text sends
  queue). The in-flight sends ride every reload on stdin (`--pending-stdin`,
  never argv); `thread.ts` keeps each bubble until its row appears and
  resolves it by text and time, so an early reload cannot make it blink.
  A failed send takes its bubble down, puts the words back in the field and
  says why. Post-send reloads no longer flash "loading…".
- **One card saved twice is one person.** Two Contacts cards in the same
  source sharing a number are still two people when their names differ — but
  "Mom ❤️" and "Mom❤️" (a space, a capital, a compatibility form) are a
  duplicate, and the bridge read them as ambiguity: the most talked-to
  conversation in the list was a bare number with no photo. Names now compare
  spelling-insensitively within a source, and every duplicate is a photo
  candidate. A stranger's SMS that Messages filed under "Filter Unknown
  Senders" showed its chat id, `+1818…(filtered)`; the list shows the number.
  A photo Messages in iCloud has not brought to the Mac yet (`filename` NULL
  in chat.db) said "no such visible attachment"; the Mac now says it is not
  downloaded yet, and a clicked chip shows that reason.
- **Omarchy's panel hotkeys reach Blip.** `omarchy-shell shell toggle
  nixfred.blip` and `SUPER+CTRL+<n>` did nothing — the shell logged "summon:
  no live bar widget": the bar looks a panel up through `open()`, `close()`
  and an `opened` property, and the widget had no `opened`. One readonly
  property, the same line Omarchy's clock and weather widgets carry; the
  README shows the stock `o.bind` for it. The ⇱ tooltip and the security-code
  toast no longer name SUPER+M and Super+Shift+V: both are bindings the README
  asks you to add yourself, and Omarchy's own tooltips name no keys. Opening
  the app through IPC `app` (the SUPER+M bind) now closes the popout the way
  double-click and ⇱ always did; the two surfaces are the same view.
- **Read history from the keyboard.** In a conversation, `↑`/`↓` from an empty
  compose field — or from the first / last line of a draft — select a bubble:
  newest first, kept in view, drawn with the
  list rows' fill — and `↓` past the newest or `Esc` drops the selection and
  returns to the bottom; `PgUp`/`PgDn` select the topmost or bottommost visible
  bubble and then move a screen per press, with text in the compose field too
  (`Shift+PgUp`/`Shift+PgDn` for one bubble at a time);
  `Home`/`End` select the oldest and newest bubble (from a draft, once the
  caret sits at its line's edge). The mouse wheel and the
  keys share one helper, so the bottom-stick that gates the deferred push
  reload behaves the same either way. With text typed the arrows and Home/End
  keep moving the caret inside the draft. On the selected bubble, `Enter` opens its attachment
  or link, `Ctrl+C` copies its text — or the picture itself, with its own
  MIME type, when the bubble is only a picture — and `Ctrl+R` quotes it into
  the compose field as `> …`; iMessage's inline reply is not reachable
  through the bridge, so the quote is a plain one. The status line under the
  compose box keeps its height when empty, so "copied" and "sending…" no
  longer shove the conversation, and only failures are red. Enter on a link
  opens the share sheet, not the browser: the sheet names the host, and it
  takes the keyboard (1–3, arrows, Enter). A sheet that opened by itself waits
  a moment before Enter counts, so an Enter meant to send never opens the link
  that just landed. A message with several links offers them all, whether
  sent, received or opened with Enter, and ←/→ step through them.
- **Full audit (four Codex gpt-6-astra auditors, one per area), thirty-eight
  verified fixes.** Forty findings, each checked against the code before
  anything changed; two ruled out. The ones worth naming: an unmapped media
  MIME kept the *sender's* file extension, so "evil.desktop" with an image MIME
  reached `xdg-open` — the extension is ours now, `.bin` when unmapped; search
  text rode argv on both machines and now goes stdin end to end; a message
  dated tomorrow became the global read mark and suppressed every toast until
  then; `blip-setup` accepted a host beginning with `-` and ran ssh without
  `--`, so `host=-Fssh_config` reached ssh as an option; the demo harness would
  `rm -rf` whatever `BLIP_DEMO_HOME` pointed at, and now refuses anything
  without a marker file it wrote itself, `$HOME` and the repo outright; a
  crafted app-card archive cost about a billion decoder iterations; and the
  consent probes still cut macOS's Automation prompt short at 20 and 60
  seconds, which TCC records as a denial.

- **The panel and the app window agree about links, and Esc no longer eats a
  draft.** Esc over the share sheet used to clear the compose field underneath
  it, overlapping QR jobs published the wrong image, and a security code could
  outlive its five minutes in the toast path.

- **A long draft scrolls instead of typing off the bottom.** The compose box
  caps at five lines and clips, but a `TextArea` follows its caret only inside
  a `Flickable` — anchored to fill the clipped slot it kept laying text out
  below the visible area, so past the fifth line you were typing blind.

- **IPC `window` could never report a window it had just shown.** `ensureWindow()`
  defers the real `visible = true`, so the handler read a property that had not
  settled and answered "window hidden" on both paths. It reports what it did now.

- **`goto` refuses an id that is not one.** `goto ""` opened a nameless thread
  with no header that nothing could send to — a script with an unset variable
  is how you get there. The share sheet also outlived the conversation it
  belonged to: it opens by itself on an arriving link, and nothing dismissed it
  when you navigated, so it floated over the next conversation offering a QR
  for a link no longer on screen.

- **The demo harness renders on the overlay layer** and no longer shares the
  real runtime directory, so making the README screenshots cannot touch your
  contacts dump, drafts or QR files. `undefined/st.json`, a test artifact
  committed at 2.2.0, is gone from the repo.

- **Bug hunt (Codex, gpt-6-astra), fourteen fixes.** A 2FA code was written
  to Omarchy's on-disk notification history — the daemon persists every
  displayed toast regardless of the `transient` hint — so the toast now says a
  code arrived and the digits stay in memory; the message's own preview toast
  is dropped too; clicking an older code toast copies *that* code, not a
  newer one; "code for card 1234 is 987654" no longer picks 1234. A third
  Contacts card with the same number could resurrect a name two cards had
  already made ambiguous; a nearer source's suffix match could put its photo
  on a conversation named after another source's exact card. A re-keyed group
  showed only its newest row's history (9 rows from the Mac, 6 shown), and
  reading it left the alias rows' unread to reappear. One dropped orphan row
  in a full page stopped the unread catch-up early. Link-preview URLs rode
  argv and were stored in the cache; a server that sent headers then stalled
  the body parked the whole preview queue. The unsend flag never reached the
  collector's plain poll. A second monitor's right/middle click started a
  second collector. `install.sh` fired the Automation prompt before the
  wizard's "be at the Mac" pause; re-running setup wiped hand-set
  `bridge.conf` keys; setup said "bridge is up" after three failed grants.

- **Pinned groups and merged DMs follow Messages again.** A re-keyed group's
  pin stays on a retired chat row's `group_id`, so matching only the live row
  dropped it from Favorites. A merged 1:1 (phone SMS + email iMessage) split
  into two threads, with the pin stuck on the stale SMS handle. `chats` now
  matches pins against every id in the cluster, 1:1s that share a `group_id`
  fold like re-keyed groups, and the thread loader keeps alias rows.

## 2.3.3 — 2026-09-05 — blue bubbles, and reads that reach your phone

- **The Messages Automation prompt gets the time it needs.** `blip-check` gave
  Messages 25 seconds and moved on; macOS gives its Allow prompt about two
  minutes, and an unanswered prompt is recorded as a *denial* (`auth_reason 9`,
  Prompt Timeout) — which on macOS 26 the System Settings switch may then
  refuse to flip back on (#36). The probe now waits 150 s and says beforehand
  that the prompt will appear on the Mac's screen; `blip-setup` sends you to
  the Mac before firing it. Recovery for a Mac already in that state is in the
  README (`tccutil reset AppleEvents`, then re-run at the Mac's screen).
- **Security codes, the macOS way.** A text that carries a one-time code —
  "Your verification code is 483920", Google's "G-482913", the origin-bound
  `@example.com #493857` line — now toasts the code as it lands. Click the
  toast to copy it, or press a key (`typecode` over IPC; Super+Shift+V in the
  README's binding) and Blip types it into whatever has keyboard focus, the
  way macOS offers a code from Messages to Safari's login form. The detector
  wants a trigger word (code, passcode, PIN, OTP, verify, confirm, sign in…)
  and picks the 4–8 digit token nearest it; money, percentages, phone numbers
  and URLs never qualify, nor does anything from a group or the self-thread.
  The code is held in the widget's memory for five minutes and nowhere else —
  not state.json, not argv, not the notification daemon's on-disk history
  (the toast is transient). Typing goes through Hyprland's `send_key_state`,
  the same path as Omarchy's universal paste, because a virtual keyboard's
  digits merge with the modifiers still held from the hotkey and became
  Super+Shift+<digit>. Both verbs sit behind `automation=on`.
- **Blue bubbles.** Your messages are iMessage blue with white text on every
  theme. They followed the Omarchy accent, which is red on several themes —
  and red bubbles read as failed sends. The unread dot on the bar icon is the
  same blue. Foreground and background still come from the theme.
- **The icon's unread dot is iMessage blue, always.** It followed the Omarchy
  theme accent, which on several themes is red — a red dot on a messaging icon
  reads as an error, and red belongs to alerts. Blue bubbles, blue dot.
- **Contacts saved without a country code get their name and photo.** The
  bridge matched phone numbers on their last ten digits, which is a whole
  national number in North America and nothing anywhere else: a card saved
  as `123 45 678` never met the handle `+4712345678`, so that person — the
  owner's own card included — showed as a bare number with initials. When the
  exact key finds nothing, `imsg` now matches the way Contacts does: the Mac's
  region fills in the missing country code (`calling_codes.py`, generated from
  libphonenumber), and two numbers are the same when the calling codes agree
  and one national number ends with the other — a saved trunk zero
  (`07700 900123`) included. A North American card shorter than ten digits is
  missing its area code and is refused rather than guessed. The exact key
  still decides first, so nothing that resolved before changes. Mac side:
  re-run the install one-liner so `~/.blip/bin/imsg` picks it up.
- **iMessage-app cards read as text instead of a replacement character.**
  Ask to Buy requests, Fitness sharing, Find My and other app cards store
  U+FFFD as their message text and the real content in an MSMessage payload.
  Blip showed the � — or an empty bubble — in the conversation, the list
  preview and the toast; on one family database that was 254 messages. The
  bridge now returns the payload's `ldtext`, the sentence Messages itself
  shows when the app cannot render the card, falling back to the card's
  caption and then the app's name. Link cards are unchanged. Mac side:
  re-run the install one-liner so `~/.blip/bin/imsg` picks it up.
- **Unsent messages are tombstones again, not empty bubbles.** On macOS 26 an
  Undo Send no longer sets `date_retracted`; Apple records it as an edit —
  `date_edited` stamped, body cleared, the withdrawn parts listed as `rp` in
  `message_summary_info`. The bridge read only the date columns, so every
  unsend since January arrived as an empty bubble tagged "Edited". It now
  reads the summary blob too: `rp` means unsent (and not edited), `ec` means
  a real edit as before, and the old `date_retracted` path still works on
  older Macs. In the conversation with yourself, where every message lands
  twice, the withdrawn copy now wins over its echo instead of being folded
  away as transport noise. Mac side: re-run the install one-liner so
  `~/.blip/bin/imsg` picks it up.
- **No more nameless conversation at the top of the list.** Deleting a
  conversation removes its chat row, but Messages in iCloud keeps the message
  rows, and some arrive with no handle either. Grouped by their empty identity
  they became one thread with no name and no number that could not be opened.
  Rows with neither a chat nor a handle are now dropped where messages enter
  the collector; rows with a handle are untouched, since some SMS senders only
  ever exist that way.
- **A pinned conversation shows its unread dot.** Pinned threads render only
  in the favourites grid — the list below is the unpinned ones — and 2.3.1
  removed the count under each tile, which left a bold caption as a pinned
  conversation's only unread signal. One unread in a pinned group produced
  badge 1 and "nothing new in the app". The tile now carries the same blue dot
  the list rows do, at the top-left of the circle like Messages, with a ring so
  it reads on a photo.
- **Reads actually reach the Mac now.** `imsg-read` clicked Messages' *Mark
  All as Read* and trusted the menu item's enabled state: disabled meant
  "nothing unread", exit 0. But AppKit only validates an app's menus while it
  is the active app — with Messages in the background, *every* Conversation
  item reads disabled, even with the menu forced open. So every push since
  2.3.0 was a silent no-op unless you happened to be using Messages at the
  time: Blip cleared, the phone kept its badge, nothing said why. `imsg-read`
  now counts what Messages itself considers unread in `chat.db` (inbound rows
  newer than the chat's own read cursor, which is what the Dock badge follows)
  before and after the click; when the menu is dormant it activates Messages
  for 0.7 s, clicks, hands focus straight back to whatever was in front, and
  exits 75 with a reason if the count did not move. Verified end to end: 1 → 0
  on the Mac, Dock badge gone, previous app restored in under a second.
  `imsg-read --status` reports "ready but dormant" with the count when a push
  would currently do nothing.
- **A failed push leaves evidence.** The collector fires `imsg-read` detached
  and exits before it finishes, so a failure used to be indistinguishable from
  success. Each push now records its exit code and `imsg-read`'s status line
  in `~/.local/state/blip/push-read.log` (0600, last ~100 lines, never any
  message content).

- **Group photos show up as photos again.** Messages stores a group's picture
  on an announcement row (`item_type = 3`). The bridge hides those rows so
  they never become empty unread bubbles, and the photo lookup joined through
  that same filter, so every group with a real picture fell back to a letter.
  The lookup now reads the raw message table (and `groupPhotoGuid` when the
  attachment's filename is blank), and streams a 512px JPEG so a multi-megabyte
  PNG still fits the Linux cache. Groups that only have Messages' member
  collage still show initials — that collage is not a stored image.
- **A photo you just assigned is not stuck as a letter.** The first ask
  remembered "no photo" for a day, and the window remembered the letter for
  the rest of the session, so a group picture or Contacts card set a minute
  later never appeared. The UI now re-asks (skipping that marker), and
  reopening the panel retries any letter.
- **Blip text can be larger than the rest of the shell.** `ui_font_size=14`
  in `bridge.conf` is bubble text in pixels (9–24). Caption and labels keep
  the same proportions. Unset, Blip still follows Omarchy's type tokens.
  This does not change the bar, GTK apps, or terminals.

## 2.3.2 — 2026-09-04

- **A mute list, for the texts nobody opted into.** Political fundraising
  blasts — "the deadline is TONIGHT, rush $25, Reply STOP2END" — arrive from a
  short code that is different every cycle, so blocking the number is
  whack-a-mole. `~/.config/blip/mutelist.json` is the allowlist's mirror image
  in shape (`{ "mute": [...] }` or a bare array, re-read every poll, no
  restart) and its opposite in effect: a matched conversation is dropped
  before the unread ledger, the thread list and the toasts are built, so it
  cannot show, count, or interrupt. Entries match a handle or chat id exactly,
  or a phrase of two or more characters anywhere in an INBOUND message
  (`"ActBlue"`, `"WinRed"`, `"Stop2End"`) — the platform's name and the
  legally required opt-out footer both outlive the rotating number. One match
  mutes the whole conversation; quoting a muted phrase to a friend never mutes
  the friend. Nothing is deleted: the messages stay untouched on the Mac.

- **Your own address book decides who someone is.** Contact names were
  resolved by counting sources and taking the most common spelling, so a work
  Exchange account or a synced company directory holding thousands of rows
  could outvote the single card you typed yourself. Sources are now ranked
  rather than tallied — your local "On My Mac" store first, then your own
  iCloud, then anything synced — and the most common spelling only breaks ties
  within a rank. The same order now decides contact PHOTOS, which took
  whichever source came first alphabetically. Mac side: re-run the install
  one-liner.
- **The font is part of setup now, without shipping one.** Blip picks the first
  of SF Pro, Inter, then your theme font. `blip-setup` offers to install
  **Inter** (SIL OFL, in Arch's `extra`, drawn for exactly this job) and only
  points at Apple's own download page for SF Pro. **No font is carried in this
  repo:** SF Pro is Apple's and its licence forbids redistribution, which is
  also why the AUR package fetches it from Apple rather than mirroring it.

## 2.3.1 — 2026-09-03 — it looks like Messages now

- **Blip uses the font Messages uses.** Omarchy resolves its family to
  JetBrainsMono system-wide, so every label in the panel was monospace — the
  loudest remaining difference from Messages, more than any spacing. When this
  machine has **SF Pro Text** (the family Messages ships with, and one a Mac-
  themed Linux box usually already has), Blip now uses it for the sidebar,
  bubbles and compose box. `Qt.fontFamilies()` decides, so a missing family
  falls back to your theme font rather than to some arbitrary sans. Nothing
  changes for anyone without it. `ui_font=theme` in `bridge.conf` opts out.
- **The popout is 20% narrower** (440 → 352). Messages' sidebar is a narrow
  column.
- **Sidebar rows read like Messages**: previews wrap to two lines instead of
  eliding at one, the name is semibold always (unread is carried by the blue
  dot and blue timestamp), a slightly larger avatar, and row stamps follow
  Apple's rule — a clock today, "Yesterday", then the weekday for the past
  week, then a date. It was printing date-plus-clock for everything older than
  today, which is a mail-client habit.
- **No numbers under the pinned tiles**, and conversation rows are
  left-justified again: the 1–9 hint reserved a fixed-width column at the head
  of every row that stayed blank once nine pins owned the digits. `1`–`9` still
  jumps.

## 2.3.0 — 2026-09-03 — the contributors' release

- **Photos in a message stopped arriving once they were full-size.** Someone
  sending two pictures at once got two grey chips and no pictures. The cause
  was a cap measured against the wrong number: `sips` turns a 5.07 MB iPhone
  HEIC into a **7.80 MB** JPEG, so a photo could pass the 5 MB auto-fetch gate
  on its source size and then be rejected for exceeding the same 5 MB as a
  converted transfer — or fail the gate first and never be asked for at all.
  Both of a real two-photo message failed, one at each end.
  Now the Mac resamples an auto-fetch to 1600 px on the long edge (`imsg
  attachment --max-dim`), which is generous for a bubble that draws at 800,
  and those two photos arrive at 0.86 MB and 0.73 MB instead of 7.80 and 6.33.
  Previews live in their own cache slot (`<id>-prev-…`, always `.jpg` because
  they always are), so **clicking a photo still fetches the untouched
  original**. Applies to every image, not just HEIC: a 12 MP PNG was just as
  slow shipped raw. Mac side: re-run the install one-liner.

- **Your kids' contact lists no longer rename your contacts.** Family
  Sharing's "Manage Contacts" (Screen Time) mirrors each child's address book
  onto the parent's Mac as a separate Contacts store. Contacts.app keeps those
  out of All Contacts, but the bridge read every store on disk and let them
  vote on names — so with two sons, the number saved as "Monica Gamble" in
  your own contacts showed as "Mom" in every Blip thread, tile and group
  name, two votes to one. `imsg`, `contacts` and `blip-check` now skip stores
  whose account is flagged `isChildDelegate` in the Accounts database; a Mac
  where that database cannot be read behaves exactly as before. `blip-check`
  says how many child lists it ignored. Mac side: re-run the install
  one-liner. Names and photos that exist ONLY in a child's list fall back to
  the bare number, which is what Contacts.app shows you too.
- **Location-sharing notices no longer show up as empty unread messages.**
  Messages.app writes its own announcements — someone joined or left, a
  rename, location sharing started or stopped — into the message table with
  `item_type != 0`, and never marks them read. The bridge passed them through,
  so each one became an empty bubble that counted as unread forever and pulled
  its conversation to the top; an iCloud re-sync after a restart lands several
  at once. `imsg` now hides them at the source, next to Recently Deleted, so
  every query agrees. Group names are unaffected: rename rows are still read
  for that. Mac side: re-run the install one-liner so `~/.blip/bin/imsg` picks
  it up.
- **Clock and dates are yours to set.** Bubble times and read receipts were
  hardcoded 12-hour while the conversation list showed 24-hour — two clocks
  in one window, and no setting for either. Both now follow three Qt format
  strings on the widget's shell.json entry, the way Omarchy's clock takes its
  `format`: `timeFormat`, `dateFormat` (day dividers this year) and
  `dateFormatWithYear`. Unset, the time follows your locale and dates read as
  before, so nothing changes until you ask.
- **Jump to a conversation with 1–9.** Super+M then a digit opens that
  sidebar thread without Enter. The first nine rows (pins first) show the
  digit. A digit that cannot open a thread is typed, not eaten. Shifted
  number keys and a queued file with an empty caption stay in compose.
  (Johan Thorén)
- **Super+M keys, live search, and whole-word ranking.** The app window
  honors `n`, `/`, and Esc the way the popout does. New-message and `/`
  search as you type. Conversations match first, then messages. Whole-word
  hits (case-insensitive) rank above substrings, then by message time.
  `imsg search` also scans capitalized needles in `attributedBody`, because
  newer messages often have a null `text` column. (Johan Thorén)
- **Reads now reach the Mac, and your phone.** Blip's "mark all read" cleared
  the badge on Linux and nothing else; the iPhone kept its red dots. The old
  note called this impossible because `open imessage://<handle>` does not flip
  `is_read` — true, but Messages has a **Conversation ▸ Mark All as Read** menu
  item, and menu items are scriptable. `imsg-read` on the Mac clicks it, and
  the collector calls that after the local marks are committed. Verified by
  round trip on a real Mac: unread → Blip's mark-all-read → read, on both
  machines. Because it goes through Messages rather than writing `chat.db`, the
  change syncs to every device the way any read does.
  - Needs **Accessibility** for `/usr/libexec/sshd-keygen-wrapper` alongside the
    Full Disk Access it already had. `blip-check` reports it; without it
    everything else still works.
  - `push_read=` in `bridge.conf`: `all` (default — only the explicit
    mark-all-read gesture), `thread` (also every conversation you open), `off`.
    The default is `all` because `--all` provably does not disturb the Mac,
    while pushing one conversation has to open it, which pulls Messages to the
    front of whatever the Mac is doing.
  - **If you have read receipts turned on, senders will now see them.** That is
    what marking a message read means; it was previously impossible for Blip to
    do, and now it is not.

- **A re-keyed group is one conversation again.** Messages re-keys a group
  (a re-invite, an iCloud re-sync, a service move) by writing a NEW chat row
  with the same name and the same members — Messages.app shows one thread,
  Blip listed one per row ("2x Sportsball!", twice again as a pinned tile).
  The bridge now clusters group rows by (name, members), lists the row
  Messages is writing to now, sums the message count, names the older rows as
  `aliases`, and `thread --chat` loads every row so the history is whole. The
  collector folds threads, unread counts and oldest-unread stamps onto the
  live id, and caches the map in `state.json` so a shallow poll folds the same
  way. Apple agrees: the pinning plist's alias for one Sportsball! row points
  at the other row's original group id.
- **Group photos, and no more borrowed faces.** A group row bound its
  picture to whoever spoke last, so it showed that member's cached contact
  photo one minute and initials the next. Groups now bind to their own chat
  id and the bridge streams the group's own photo (`imsg avatar --chat <id>`,
  PNG/JPEG as-is, anything else through sips). Messages keeps that photo as
  an attachment whose name ends in `GroupPhotoImage`; the carrier message's
  `group_action_type` is 3 for photos set up to April 2025 and 1 after, so
  the lookup matches the FILENAME, not the action type, and searches every
  chat row of the conversation — a re-keyed group can keep its photo on the
  row Messages retired. Groups without one show initials.
- **"No photo" is remembered for a day, not a week.** A photo that appears
  later — a new group picture, a Contacts card, or a bridge fix that starts
  finding one — now shows up within a day instead of after the 7-day cache
  expired.
- **Every link gets its card, not just the ones Apple decorated.** Messages
  builds an `LPLinkMetadata` preview for some URLs and leaves most bare — on
  this Mac 7 of 27. For the bare ones Blip now fetches the page itself and
  builds the same card from its Open Graph tags: picture, title, description,
  host. The fetch happens on the Linux box, never the Mac; http(s) only, at
  most three redirects, and a host resolving into your LAN or to a cloud
  metadata address is refused, so a link from a stranger cannot make Blip
  probe your network. Cached for a week (a page with no card, for a day) under
  `~/.cache/blip/linkpreview`. `link_previews=off` in `bridge.conf` turns it
  off. A message that is only a URL shows just the card, like Messages.
- **The share sheet opens itself for a link, sent or received.** Send a
  message containing a URL and the sheet comes up on it; a link that ARRIVES
  does the same — but only onto a Blip surface that is already open, because
  Omarchy runs `focus_on_activate=false` and a bank alert must not throw a
  panel over full-screen work. One sheet, the newest link only, and each
  message fires exactly once through a persisted `link:` ring, so a catch-up
  after sleep cannot stack modals and yesterday's links never pop tomorrow.
  The self-thread never triggers it.
- **Open the app from the panel.** A ⇱ button beside ＋ in the panel header
  opens the full app window, the same thing SUPER+M does.
- **Share sheet for links.** Right-click a link in a bubble, or a link card,
  and Blip opens a sheet: open in browser, copy, a QR code your phone can
  scan, and "send to a device" through LocalSend — Omarchy's own share sheet,
  fed the way `omarchy-menu-share clipboard` feeds it. The URL travels on
  stdin to qrencode and to the temp file; left-click still opens the link.
- **Pinned conversations, mirrored from Messages.** The Mac's ordered pin
  list (`com.apple.messages.pinning.plist`, `pD.pP`) rides along on the
  `chats` call and Blip renders those conversations as avatar tiles above the
  list, in Messages' order. Read-only: Blip has no pin control and writes
  nothing back. (Erik Zachrisen, #11) Follow-ups on main: groups are pinned
  by their chat.db `group_id` / `original_group_id`, not the chat identifier,
  so pinned groups resolve too; the reader uses the ordered list (with the
  `pZ` alias map) instead of every string in the file, which had ranked a
  group ahead of every DM; and j/k highlight a pinned tile — the cursor walks
  pinned threads first and had no visible position on them.

## 2.2.3 — 2026-09-02

- **Received bubbles showed a lighter square in the tail corner.** The
  "tail" was a second translucent rectangle drawn over the corner, so the
  14 % fill composited twice. The corner is now squared with Qt 6.7
  per-corner radii and the extra rectangle is gone. (Adam Gamble, #10)
- **iPhone photos rendered on their side — inline AND in the viewer.** A
  camera photo stores its rotation as an EXIF orientation tag, and `sips`
  keeps that tag when the bridge converts HEIC to JPEG — so the pixels
  arrive landscape with a "rotate 90°" note that Qt only honours on request
  and imv (Omarchy's default viewer) never does. Two fixes: every `Image` in
  the conversation sets `autoTransform: true`, and `fetch.ts` now bakes the
  orientation into the cached JPEG losslessly with `jpegtran` (libjpeg-turbo,
  already on every Qt box) — colour profile kept, EXIF dropped so nothing
  double-rotates. Files cached before this release stay as they were; clear
  `~/.cache/blip/att` to re-fetch them upright. (Adam Gamble, #9)

## 2.2.2 — 2026-09-02

- **Group sends failed with -1728 on Macs that keep one chat row per
  service.** A group that moved between iMessage, SMS and RCS leaves several
  `chat` rows sharing one identifier; only one holds messages. `imsg groups`
  returned all of them, the empty shell sorted last and overwrote the live
  guid in Blip's group cache, and AppleScript could not resolve it. The bridge
  now keeps one row per identifier, newest first. Mac side: re-run the install
  one-liner so `~/.blip/bin/imsg` picks it up. (tolewis, #8)

## 2.2.1 — 2026-09-02

- **Short-code SMS threads opened empty.** Georgia Power (99123), 878478 and
  every other 5–8 digit sender showed in the list but loaded zero bubbles:
  the thread loader's CLI convenience turned any bare digits into an E.164
  number ("+99123"), and 2.2.0's exact chat-id query correctly found nothing.
  Only a full number (10+ digits) is "+"-prefixed now, in `thread.ts` and in
  the IPC `goto` alias. Short codes go through verbatim. Tests for both.
- **App window fills like other Omarchy windows.** The 0.70 backdrop alpha
  assumed Hyprland blur, which stock Omarchy 4.x ships off — the wallpaper
  showed through the Super+M window. Now `color: Color.background`, like the
  shell's dev gallery, with Hyprland's default-opacity rule doing the rest.
  (Johan Thorén, #7)

## 2.2.0 — 2026-09-02 — verified fixes

The war-room judge panel re-ran against 2.1.6 (three lenses per finding):
11 earlier fixes confirmed closed, 17 findings confirmed open. This release
fixes 13 of them; the rest stay listed in ROADMAP.md.

**Multi-monitor.** Omarchy builds one bar — and one Blip widget — per
screen. Only the widget on the first screen now polls, watches, toasts,
owns the app window and answers IPC; the others show the badge from
`state.json` and forward clicks to it. (Previously: N pollers, N ssh
watchers, duplicate toasts and windows.)

**Sends.** SMS/RCS conversations go out on their own service instead of
silently as iMessage (text and files). A refused send now shows the Mac's
reason ("message too long", "not authorized"…) instead of "exit 1".

**Reads.** The app window marks a conversation read only while it is the
focused window — visible on another workspace no longer clears dots.
Mark-all-read / middle-click / IPC refresh keep the full list when a
surface is open (a shallow run used to collapse it to the preview window).

**Correctness.** A DM loads by exact chat id (`thread --chat`) so a
contact's group posts no longer eat the history window. A DM is persisted
as a "self chat" only after two independent same-second twins, not one
coincidence. Failed-send toasts fired every poll for 15 minutes because the
dedupe ring dropped their `fail:` prefix on load.

**Robustness.** A `bun` that cannot start is reported as such (not "Mac
unreachable"); the offline poll backs off to 30 s; the push watcher's
liveness timer arms at start.

**Config.** `country_code=` in `bridge.conf` for numbers typed without a
country code outside North America.

**Docs.** README no longer promises a headless Mac without a logged-in
session; the last real-looking number left the code; a duplicated README
block removed.

## 2.1.6 — 2026-09-01

- **Duplicate toasts fixed.** The bridge now emits each message's ROWID and
  the toast key no longer includes the text: Messages can land a row before
  its decoded body, and a timestamp slightly ahead of the Linux clock kept
  the message above the watermark, so the same message toasted twice.

## 2.1.1 – 2.1.4 — 2026-09-01

- **Links open and come to the front.** Clicks were reaching `xdg-open`
  all along; Omarchy's `focus_on_activate=false` left the tab on the
  browser's workspace. Blip now focuses the browser after opening. (2.1.4)
- **Text selection + Ctrl+C in bubbles** — the conversation Flickable was
  grabbing every drag. (2.1.1)
- **Contact names regression** — one person across several Contacts
  sources ("Rob" / "Robert") is not a collision. (2.1.2)
- Repo scrubbed of maintainer machine names, a real group name, absolute
  paths. (2.1.3)
- README Install rewritten around `omarchy plugin add … --enable`, with
  notes for humans and for AI agents; `AGENTS.md` added. (2.1.4)

## 2.1.0 — 2026-09-01 — war room

Ten expert-lens reviewers swept the repo after the DHH retweet; 114
findings, the clear ones fixed here, the rest on the roadmap.

**Fixed — correctness**
- Attachment-cache eviction had silently never run since 1.9.4 (a missing
  `statSync` import threw inside the LRU). 500 MB cap is real again.
- A DM thread admitted that person's messages from *group* chats.
- Catch-up fetches could exceed Bun's default 1 MB `spawnSync` buffer and
  fail sticky; all bridge calls now allow 64 MB.
- A timed-out `imsg` (Mac asleep behind a live ssh mux) read as a bridge
  bug; it now reads as "Mac asleep" and greys the icon.
- Bridge errors show the *last* stderr line (Python puts the cause last),
  not "Traceback (most recent call last):".
- `state.json` is fsync'd before rename (a power cut no longer resets every
  read mark). Cache temp names carry entropy (no EEXIST after pid reuse).
- Link cards: `$null` titles, URLs with `(…)` (Wikipedia), and userinfo
  host-spoofing handled. Inline-reply snippets respect Recently Deleted.
- macOS 12 and earlier: `imsg` no longer dies on the missing
  Recently-Deleted table.
- Avatar initials for whitespace-only names; non-ASCII attachment names
  survive sanitizing; sent files keep their extension.
- `wait_for_copy` matches only attachment rows newer than the send
  (same-name re-sends no longer confuse it); a send whose copy was never
  observed is kept in `~/.blip/sent` instead of deleted an hour later.

**Fixed — security / privacy**
- File-send captions no longer appear in any process's argv
  (`--caption-stdin`). A cut ssh stream can no longer deliver a truncated
  file (`--file-bytes N` is enforced on the Mac).
- Cache file extensions follow the gated MIME type, not the sender's
  filename (`xdg-open` dispatches on extension).
- `tcc-check` removed from the confined key's allowlist.
- `blip-setup` no longer `source`s `bridge.conf`, no longer echoes a message
  body into the terminal, guards the `authorized_keys` append with a
  newline, keeps a hand-set `automation=` on re-run, drops the ssh master
  before re-checking grants, and names a missing Xcode CLT instead of
  misdiagnosing Full Disk Access. `install.sh` fails loudly on the CLT stub.
- Consent banner prints only on a TTY (recipients no longer reach journald).
- A real phone number and email were removed from a public test fixture.
- Transient bridge failures no longer write a 7-day "no photo" marker.

**Changed**
- Users' dashes are sent as typed (`--keep-dashes` everywhere).
- `xdg-open` and the window-state writer run detached (a blocking handler
  or a mid-write hide could swallow later clicks / the hidden state).
- IPC `compose` refuses when the popout is closed.
- The shim's offline message includes the ssh reason.
- `sync-bridge.sh` stages upstream copies beside locally-modified tools
  instead of overwriting them.
- Tests are isolated from the developer's real caches (`bunfig.toml`
  preload sets `XDG_CACHE_HOME`).

## 2.0.4 — 2026-09-01

**Fixed**
- `blip-check` probed a single, unordered Contacts source; a stale CardDAV
  `.abcddb` sorting first produced a false "contacts ❌ — grant Full Disk
  Access" during `blip-setup` even though contacts and avatars worked. It now
  probes every source like the `contacts` tool does and fails only when none
  opens. First outside contribution — **@jethrojones** (#2). Thank you.

**Repo**
- CI on every push and PR (bun test, Mac tools byte-compile, shellcheck),
  CONTRIBUTING, issue/PR templates, security policy, GitHub Releases.

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
