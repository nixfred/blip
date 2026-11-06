# Conversation appearance

The app uses a full-width two-pane layout, with a centered contact photo and
resolved name. Unknown contacts use “Conversation” and a `?` avatar; phone
numbers and email addresses are not substituted into the conversation header.
The sidebar still identifies every conversation and preserves unread markers.
Favorites use equal-width tiles and short personal names; matching first names
include a surname initial. Group names and the full conversation header stay
intact.

**New Message** sits at the upper-left of the conversation pane, just across
the sidebar divider. In the compact popout it remains at the top-right of the
conversation list. The `n` shortcut remains available.

Click **+** beside the composer to select up to ten local files. They remain
queued attachments until you send. Click the **smiley** for searchable emoji;
choosing one inserts it at the draft's cursor or replaces selected text, without sending. The blue arrow
or Enter sends, while Shift+Enter inserts a newline.

Swipe left with two fingers to reveal message times, as in Messages; your
bubbles slide aside and spring back when you stop. The keyboard cursor also
shows its message's time. Delivery failures,
sending/scheduled state, edits, and the latest read receipt remain visible.
Photos preserve their aspect ratio and fit within a 240-pixel display height;
open an attachment to see its original. Transparent stickers have no bubble
background. Native sticker reactions and emoji reactions share larger round
balloons with a two-dot tail. Known additive placements appear on their message; unsupported body-part
placements stay in a separate sticker strip instead of being guessed.

Voice messages have an inline play/pause button, a measured waveform, remaining
time, and a seek control. Click the waveform to seek; Tab reaches the controls,
Space toggles playback, and Left/Right on the seek control move five seconds.
Only one message plays at a time. Closing the surface or changing conversations
stops playback, including a play request still waiting for its file. Audio
files up to 5 MB preload silently; larger or unknown sizes load when clicked.
When waveform analysis is unavailable, a simple progress track remains usable.
Right-click the player to save the file.

## Backgrounds

Open a conversation's **⋯** menu. Click outside it or press Escape to close;
its translucent surface and spacious rows stay within the window:


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

`python3 scripts/test-composer-emoji-ui.py` checks real composer selection,
popup keys, and send isolation. `python3 scripts/test-audio-session-ui.py`
checks delayed audio playback, cancellation, switching, and retry using a fake
fetcher. Neither test contacts the Mac or sends a message.

`python3 scripts/test-conversation-menu-ui.py` exercises outside-click dismissal,
reopening, Escape, and actual action clicks. `python3 scripts/test-reaction-badge-ui.py`
checks round sizing and sticker interaction without involving real conversations.
