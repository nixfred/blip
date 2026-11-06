# Reaction picker and native bridge

Right-click an eligible message or press Ctrl+E with a history bubble selected.
The six classic Tapbacks remain first; 1–6 or the arrow keys choose one.
The plus button opens a searchable, categorized emoji catalogue. A pasted
emoji keeps its complete sequence, including skin tone and joined characters.
Choosing the reaction already on the message requests removal. The same
catalogue supplies the composer's emoji insertion button.

The catalogue contains the 3,963 fully qualified Emoji 18.0 sequences, from
[Unicode's released data](https://www.unicode.org/Public/emoji/18.0/emoji-test.txt).
[Unicode 18.0 was released in September 2026](https://www.unicode.org/versions/Unicode18.0.0/).
Font and receiving-device support can lag that catalogue. The data's Unicode
License v3 is included in [UNICODE-LICENSE.txt](UNICODE-LICENSE.txt).

## What the bridge does

Sending still requires `tapbacks=on` and the Mac's existing Accessibility and
Automation grants. It never requests new consent as part of a reaction. The
existing target restrictions remain: delivered plain-text direct-message
bubbles, without attachments or link/app cards; on macOS 27, the newest
message only. Opening Messages can briefly change focus on the Mac.

Classic requests retain the original command protocol. Custom emoji use
`imsg-react --guid GUID --emoji-stdin --yes`, with a bounded JSON object
containing `emoji` and an optional search `name` on stdin. Neither the emoji,
search text, nor original message body rides process arguments or is saved
to a Linux file. The bridge log records only outcome codes and duration.

For a custom reaction, the bridge first looks for an exact emoji action on
the matched bubble, or an enabled picker control whose AXIdentifier/AXValue
is the requested Unicode sequence. A catalogue search can narrow results,
but a name or grid position never authorizes the final press. There must be
exactly one enabled matching button/cell. The original Tapback Picker's
message label and Messages foreground state are checked again before a
picker press. The custom catalogue is searched only inside a unique
Messages-owned Accessibility popover while that original message label
remains visible. A detached/inaccessible picker, ambiguous result, changed
target, or unavailable exact emoji fails visibly. There is no guessed
coordinate, numbered-grid navigation, Return-key fallback, or image-sticker
substitution.

Success requires a new chat.db receipt on the intended GUID with type 2006
(add) or 3006 (remove) **and the same emoji sequence**. The type alone cannot
distinguish two custom emoji. Existing custom reactions retain their type on
the read path, so a custom 👍 cannot accidentally remove a classic Like.
The existing stray-message guard, UI lock, focus restoration, and no-retry
rule continue to apply. Accessibility can still race user activity between
the final check and the press; the database receipt remains the referee.

Native sticker-reaction sending is not implemented by this route. Apple's
Messages UI supports stickers, but an image attachment is not a native
sticker reaction and must not be represented as one.

## Evidence and limits

The classic AX implementation predates this change and has its original
native verification notes in `imsg-react`. The new custom route is covered
with synthetic AX trees and chat.db fixtures, including exact identities,
wrong emoji receipts, stale target/focus, disabled and ambiguous controls,
no-op/removal semantics, and no retry after a missing receipt.

`python3 scripts/test-reaction-ui.py` runs the shipping QML in an isolated
QtTest process. It covers classic number keys, the busy gate, expanding and
focusing search, exact custom selection, grid navigation, composer mode,
and expanded popup placement near the bottom of the window. Add
`--screenshot PATH` for visual QA. All fixture message content is invented.

The development Mac was inspected only for OS/tool versions, permission
state, and Accessibility metadata. On macOS 27.2 it lacked the SSH client's
Accessibility grant, so live custom-picker/send behavior has **not** been
verified there. No real conversation was read and no live reaction was
sent. Arbitrary emoji can be browsed and requested; availability of a safe
native selection is established at runtime, not promised for every Mac.

## Implementation references

Apple documents [Tapbacks with any emoji in Messages](https://support.apple.com/guide/messages/ichtb967d30b/mac).
The upstream [Blip discussion #69](https://github.com/nixfred/blip/issues/69)
reports exact recent-emoji AX actions and the Add Emoji as Tapback action.

The following primary source at Beeper `platform-imessage` commit
`04666201f5dfa93398f6961e4e9367bb3c939729` informed the independent Python/JXA
implementation:

- [Reaction.swift](https://github.com/beeper/platform-imessage/blob/04666201f5dfa93398f6961e4e9367bb3c939729/src/IMessage/Sources/IMessage/Reaction.swift): custom direct action titles are the emoji itself; classic and custom identities are distinct.
- [MessagesController.swift](https://github.com/beeper/platform-imessage/blob/04666201f5dfa93398f6961e4e9367bb3c939729/src/IMessage/Sources/IMessage/Messages/MessagesController.swift): reaction picker cells carry an exact emoji identifier.
- [MessagesAppElements.swift](https://github.com/beeper/platform-imessage/blob/04666201f5dfa93398f6961e4e9367bb3c939729/src/IMessage/Sources/IMessage/Messages/MessagesAppElements.swift): Add custom emoji reaction control and detached CharacterPalette limitations.

No Swift source is vendored. Beeper's MIT copyright and permission notice
is retained in [BEEPER-LICENSE.txt](BEEPER-LICENSE.txt) for the referenced
automation design. Blip deliberately does not adopt its search-result
keyboard-offset navigation or private emoji-search framework integration.
