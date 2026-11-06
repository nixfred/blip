# Conversation appearance

The app uses a full-width two-pane layout, with a centered contact photo and
resolved name. Unknown contacts use “Conversation” and a `?` avatar; phone
numbers and email addresses are not substituted into the conversation header.
The sidebar still identifies every conversation and preserves unread markers.

Click **+** beside the composer to select up to ten local files. They remain
queued attachments until you send. Click the **smiley** for searchable emoji;
choosing one inserts it at the draft's cursor, without sending. The blue arrow
or Enter sends, while Shift+Enter inserts a newline.

Message timestamps appear on hover or keyboard selection. Delivery failures,
sending/scheduled state, edits, and the latest read receipt remain visible.
Photos preserve their aspect ratio and fit within a 240-pixel display height;
open an attachment to see its original. Transparent stickers have no bubble
background. Known placements appear on their message; unsupported body-part
placements stay in a separate sticker strip instead of being guessed.

## Backgrounds

Open a conversation's **⋯** menu:

- **Choose Conversation Background…** sets a local PNG or JPEG for that chat.
- **Reset Conversation Background** restores the default background.
- **Choose Default Background…** supplies a fallback for conversations without
  their own choice.
- **Remove Default Background** restores the theme's normal canvas.

These choices affect Blip on this Linux machine only. They are not sent to the
Mac or other participants. Switching conversations while the file picker is
open keeps the choice associated with the conversation where you opened it.
Both open Blip surfaces refresh when a preference changes.

The picker accepts regular local PNG/JPEG files up to 20 MB and 40 megapixels.
Blip decodes, strips metadata, and scales a private copy to at most 2560 pixels
per side. Remote URLs, SVG documents, symlinks, and arbitrary saved paths are
not accepted. The copy remains available if the original file moves.

Preferences stay in `~/.config/blip/bridge.conf`. A default uses
`conversation_background=<image hash>.png`; per-conversation keys append a
SHA-256 hash of the conversation identifier. Raw handles and message text are
not written. Private image copies are stored in
`~/.local/state/blip/backgrounds/` with `0700` directory and `0600` file modes.
Replacing or resetting a choice removes its old copy when no other choice
still references it. Concurrent saves are serialized with a kernel lock;
configuration errors are reported without overwriting unrelated settings.

## Type and theme

Blip prefers an installed SF Pro or Inter family, then an installed Linux sans
family. Default bubble text is at least 13 pixels. Existing `ui_font_size=` and
`ui_font=theme` preferences remain authoritative. Bubbles retain iMessage
blue; the surrounding interface follows the desktop theme. A theme-colored
wash and translucent surfaces keep text readable on bright or dark images.

## Synthetic verification

`scripts/demo/blip-shots` renders the shipping view against invented people,
messages, avatars, and generated sticker art. It never opens a real
conversation. `BLIP_DEMO_OUT` optionally changes the screenshot directory.
`python3 scripts/test-background-ui.py` executes the actual QML callbacks with
synthetic state, covering pending picker results, chat switches, queued
configuration refreshes, cancellation, and component startup.
