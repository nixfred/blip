# Native replies

Reply in the message menu, or `Ctrl+R` on a selected bubble, sends a real inline
reply: the same thing Messages sends, recorded in `chat.db` with
`thread_originator_guid`. It needs `replies=on` in `bridge.conf` and the Mac's
existing Accessibility and Automation grants. `Quote and reply` is still there, and
`Ctrl+R` falls back to it on anything a native reply refuses.

Everything below was measured on macOS 27.2 in a self-thread (2026-11-07). If you
are about to investigate replies, read this first: these paths have been walked.

## What works

| Target | Result |
|---|---|
| Plain text in a 1:1 | Sent and confirmed |
| One picture, no caption, in a 1:1 | Sent and confirmed |
| A message that is already a reply | Sent; names the start of the thread |
| Multi-line text with emoji | Sent intact |

A run takes 11 to 13 seconds and brings Messages to the front on the Mac, then
restores whichever app was there.

## How the Mac tool works

`bridge/mac/imsg-reply --guid GUID --text-stdin --yes`, in this order:

1. `chat.db` decides the target and refuses anything unproven.
2. A draft in the composer stops the run, before anything is pressed.
3. The bubble search in `imsg-react` presses `Reply…` once.
4. The reply view must name the target. The field is filled through AX and read back.
5. Focus is rechecked, then Return is pressed.
6. `chat.db` must show your row with this text naming the target's thread.
7. The reply view is closed and the previous app comes back.

| Exit | Meaning | What Blip does |
|---|---|---|
| 0 | Sent and confirmed | Reloads to the real row |
| 75 | Nothing was sent, including a locked Mac or a draft | Failed bubble, words and target back in the composer |
| 76 | Return was pressed but not confirmed, or Messages reported an error | Says so; **never hands the words back**, because a resend could duplicate |
| 65, 69, 77 | Refused, unavailable, or no permission | Same as 75 |

Never retry after Return. The log, `~/.blip/reply.log`, holds the outcome code, exit
status and duration, never a GUID or text.

## What we found in Messages

**The reply view.** `Reply…` opens a view over the conversation:

- The focused field is an `AXTextField` with `AXIdentifier` `messageBodyField` and
  placeholder `Reply`. The main composer has the same identifier and a placeholder of
  `iMessage`, so the placeholder is how to tell them apart.
- A group described `Reply transcript` holds the thread, with bubble labels that name
  the target. That is the check before anything is typed.
- **It stays open after sending.** Escape closes it.
- **There is no send button and no confirm action on the field.** The only `send`
  match is `Send Later`. Return via System Events is the only way, and it goes to
  whichever app is in front, which is why focus is rechecked immediately before.

**Drafts.** A draft in the composer moves into the reply field when the view opens,
and Escape hands it back intact. Filling the field replaces the draft, and sending
destroys it. So the tool refuses when one exists. A draft could be saved and restored
around the send, but that wasn't worth the risk of losing someone's words.

**Never use the clipboard for the text.** Setting `AXValue` works, including line
breaks and emoji. Pasting would put the message on the Mac's clipboard, where any
clipboard sync can carry it to another machine, breaking the rule that message text
never reaches Linux disk or argv.

**Bubble labels.** Times can be 12-hour, and the sender comes first:

- Text: `Your iMessage, hello, 11:30 AM`
- A reply: `Your iMessage, Reply…, hello, 11:43 AM`. `parseLabel` strips the
  `Reply…, ` so replies can be targeted.
- A picture: `Your iMessage, Includes picture, 11:52 AM`. That is all it says, so two
  pictures from one side in one minute can't be told apart, and the tool refuses.
- A picture's live bubble is an `AXButton` under its row, not a group, which is why
  the search takes a `picture` flag.
- In a self-thread each message draws two bubbles, `Maybe: <name>, …` and
  `Your iMessage, …`.

**`chat.db`.**

- `thread_originator_guid` is the message replied to, or **the start of the thread**
  when replying to a reply, so confirmation has to accept the target's own originator.
- `thread_originator_part` looks like `0:0:23` for text and `0:0:1` for a picture. The
  first number is the part. Blip assumes that in a message with several attachments it
  is the attachment's index, falling back to the first. **That is unverified.**
- **A reply can land under a different chat row for the same person.** In the
  self-thread they went to the phone-number chat while the message replied to was
  under the email chat. Confirm by thread and text, never by chat. Filtering by chat
  made working replies look lost during the investigation.

## Known limits

- **The Mac must be unlocked.** A locked Mac fails with a clear message and nothing is
  sent. Native tapbacks have the same limit.
- **A reply can appear in another of the person's conversations.** When someone has two
  addresses that Blip hasn't merged, the reply may land under the other one. Messages
  draws them as one thread; Blip shows the reply under the other chat, and the pending
  bubble here expires after two minutes. It was seen in a self-thread, where the email
  and phone chats aren't merged. Addresses merged through `chatAliases` are read
  together, so they shouldn't show this, but no merged conversation has been tested.
- **In a self-thread, a picture shows twice in Blip**: the sent row and its echo. Replying
  to either works. Blip's echo folding doesn't cover this case.
- **The whole path has only been exercised in a self-thread.** Real one-to-one
  conversations use the same route, but no reply has been sent in one during testing.

## Dead ends

- **AppleScript has no reply.** `send` takes no reply target.
- **Private APIs.** Replying through `IMCore`, as BlueBubbles' Private API does,
  requires SIP off as far as we know. Not considered for that reason.
- **`Edit ▸ Reply to Message…`.** Acts on the selected message, and selecting a bubble
  from outside is an unsolved problem. The bubble's action needs no selection.
- **Testing with the Mac locked.** Accessibility sees no windows, and screen capture
  fails too. Nothing can be probed until someone unlocks it.
- **Testing on another Mac over ssh.** Needs Full Disk Access and Accessibility for
  `/usr/libexec/sshd-keygen-wrapper`, which only a person can grant.

## Traps when probing

- JXA calls a top-level `function run` by itself. Calling `run()` as well makes it read
  stdin twice, and the second read fails with `JSON Parse error: Unexpected EOF`.
- Path filters on `ConversationList` no longer exclude the sidebar on macOS 27, so a
  loose label filter prints other people's conversation previews. Filter on bubbles
  offering `Reply…`, and keep to the self-thread.
- Never run `entireContents` while the emoji catalogue is open. See `reactions.md`.
- Any query that looks for test rows must filter on your marker text. A filter on
  `ROWID` alone also returns other conversations' messages that arrived in between.
- A self-thread can span several chats, so check that a surprising chat is really yours
  before assuming: its participants must all be in `detect_self_handles()`.
- `grim -g` captures the screen, not the window. A Blip window on another workspace gets
  whatever is on top at those coordinates.
- `imsg-send` takes attachments with `--file-stdin --file-bytes N --name X`.

## Not built, and what it would take

Each of these is refused today, in `canReply` (`message-actions.ts`) and in
`imsg-reply`. Change both together. Test in a self-thread first, except groups, which
need a real group you own and everyone's consent.

| Feature | What to measure first |
|---|---|
| Groups | Bubble labels with several senders, and how to pick the side. The route should be the same. |
| Several pictures in a message | The label, whether each picture has its own `Reply…`, and how the part number maps |
| Picture with a caption | The label, and which part `Reply…` answers |
| Videos, files, audio | Each label |
| Link and app cards | The label is the page's title, not the text, so `chat.db` can't predict it |
| Two pictures in one minute | Whether bubble order can be trusted, and how to check it in the reply view |
| Replying with an attachment | How to attach in the reply view without the clipboard |
| Thread view like Apple's | Blip only; `thread_originator_guid` has what it needs |
| Replying while a draft exists | Save and restore around the send |
| Replies with the Mac locked | Not possible through Accessibility |

The reply context above a bubble works whether or not the Mac is locked, because it
only reads `chat.db`.

## Testing

`bridge/mac/test_reply.py` runs on a synthetic `chat.db` with a scripted Messages.
`message-actions.test.ts`, `thread.test.ts` and `tapbacks.test.ts` cover the Linux side.
For a live run, target only your own self-thread:

    printf 'test' | ~/.blip/bin/imsg-reply --guid GUID --text-stdin        # dry run
    printf 'test' | ~/.blip/bin/imsg-reply --guid GUID --text-stdin --yes
