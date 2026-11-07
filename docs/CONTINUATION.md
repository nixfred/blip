# Private continuation

This checkout preserves Blip 2.6.2 and its original MIT license and history.
The recovered baseline is `d51b0bccb35b723be5050bee9cae73f6413b752d`
(November 4, 2026), also available from:

- https://github.com/ianswope/blip
- https://github.com/mmdisbrow/blip
- https://github.com/TabibitoLab/blip

On November 6, the original repository and account were unavailable from
GitHub's live public API. This does not establish why they were unavailable,
or that the original author abandoned the project. The project website still
linked to the original repository; no confirmed migration was found.

The public fork search also found `duketopceo/blip` commit
`e38cf844fa000e75813c19f37d1b0cc580c8f471` (November 5), an Omarchy/Qt
compatibility change. Its branch lacks 420 commits in the recovered baseline,
so its later timestamp is not a newer complete release. Its namespaced QML
imports and plain-text display precautions are useful review references;
replacing the baseline with that branch would lose substantial functionality.

Blip was created by Fred Nix with Larry. The Mac bridge was originally
vendored from `nixfred/claude-on-mac`; see `bridge/BRIDGE-VERSION` and the
original README credits. This continuation is not an official upstream release.

## Development checks

Run `bun test`, the synthetic Python tests under `bridge/mac` and
`bridge/linux`, `python3 test_otp_desktop.py`, and
`python3 scripts/test-read-ui.py`. Consult `.github/workflows/ci.yml` for the
complete upstream check list. Desktop previews use the fake bridge in
`scripts/demo`, never real conversations. Tests that need local sockets or
subprocess execution must run with those permissions; permission-denied failures
in a restricted shell are not a successful validation run.

Run `scripts/deploy-local` to install a committed HEAD into the live plugin. It
restarts the shell, so preserve unsent drafts first.

The `nixfred` GitHub account no longer resolves, so nothing here may download
from it: someone else could register that name. Remaining mentions are credits.

Do not test sends or reactions against other people. Native Mac behavior
must be distinguished from Linux rendering and synthetic protocol tests.

## Handoff — November 6, 2026

The private `2.7.0-private.1` build added a Messages-style layout: contact
photos and names, a cleaner favorites grid, glass controls, local conversation
backgrounds, aligned composer buttons, and inline audio with measured waveforms,
play/pause, progress, and seeking. The window is named Messages. New Message sits
beside the conversation header; the mark-all button is removed. The conversation
menu dismisses on an outside click and has translucent, roomier rows.

Received stickers retain transparency and supported animation. Placed stickers
remain separate from native sticker reactions, which share round thought-bubble
badges with emoji reactions. See [stickers](STICKERS.md), [audio](AUDIO.md), and
[appearance](APPEARANCE.md) for formats, private caching, and rendering limits.

Native testing on macOS 27.2 verified classic Heart, a searched custom emoji,
replacement with another custom emoji, exact custom removal, and a complete
variation-selector/ZWJ emoji. The route verifies database receipts and never
retries an uncertain send. Current Mac targeting is any eligible plain-text direct message;
groups, attachments, and cards are refused.
Skin-tone variant selection remains unverified. See [reactions](reactions.md).

Sending native stickers or sticker reactions is still unfinished. A public AppKit
`NSAdaptiveImageGlyph`/HEIC/RTFD round trip worked in a source-only probe;
no clipboard/paste/send path or native sticker receipt was verified. The probe is in
[docs/research](research/native-glyph-probe.md). Do not
present ordinary image attachments as native sticker sends. This is the main
remaining feature to investigate before extending reaction target coverage.

Deployment uses the private repository as the installed plugin's origin.
Mac tools changed are `imsg` and `imsg-react`; persistent reader channels must
restart to load reader changes. Preserve unsent drafts before a shell restart:
drafts and queued attachments remain memory-only. Back up installed source and
bridge configuration before updating. `automation=off` can remain off while
`tapbacks=on` enables the user-triggered reaction path.

This desktop also has separate local launcher/dock matching and a custom
titlebar renderer change: shared Quickshell windows use their own title instead
of the runtime's desktop-entry name. Those desktop changes are outside this
Blip repository. Synthetic preview images and fixtures contain invented people;
do not add live conversation captures to the repository.
