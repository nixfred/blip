# Experimental native glyph self-test handoff

This is a source-only prototype; nothing here ships in the plugin. The helper
never opens Messages or sends. Its `--dry-run` mode has been compiled and run
on the authorized Mac using only generated pixels, with successful HEIC →
NSAdaptiveImageGlyph → RTFD → glyph identity roundtrip. Clipboard mode is not
yet runtime verified; only the live-UI owner may execute it under self-test
authorization.

Source: `native-glyph-clipboard.m` alongside this note. Compile in a private
Mac temporary directory, with the already installed compiler:

```
clang -Wall -Wextra -fobjc-arc -framework AppKit -framework ImageIO \
  -framework UniformTypeIdentifiers glyph.m -o glyph
printf '{}\n' | ./glyph --dry-run
```

The empty request generates a golden star from geometry. Alternatively a JSON
request can contain `inputPath` (regular PNG, <=10 MB, <=2048px edge) and
`description` (1..160 characters). The helper draws into a transparent 160px
square, uses public ImageIO metadata `tiff:DocumentName` (UUID) and
`dc:description`, constructs NSAdaptiveImageGlyph, and verifies its identifier
and description. Public `NSRTFDTextDocumentType` serialization preserves the
glyph. The clipboard type is **com.apple.flat-rtfd**, not plain PNG or a file
URL. Publishing only that rich type avoids an intentional plain-image fallback.

## Controlled UI test

1. Before publishing, verify the exact authorized self conversation and an
   empty composer: no text, existing attachment, reply draft, or edit state.
   If a draft exists, stop without changing it. Do not select-all/erase it.
2. Start the helper with `--clipboard` and keep its stdin open. Write one JSON
   request line and flush. Read the first JSON response; require `ok` and
   `published`. This is only a prepared clipboard, not a sent message.
3. The helper snapshots all current clipboard item types/data in RAM only,
   rejects unpreservable or oversized snapshots before mutation, publishes
   RTFD, and returns its clipboard `changeCount` and 45-second deadline.
4. Immediately before the single Cmd-V, send `status\n` and require
   `active:true` with sufficient time remaining. Recheck the clipboard's
   changeCount in the same bounded UI action that verifies the focused self
   composer. Abort if changed or if the helper exited/restored. Never paste
   after its deadline. After paste, inspect the composer for one attachment/
   object-replacement glyph and no unexpected plain text; do not press Return
   if the paste result or target is uncertain.
5. Reverify the self target and send exactly once. Poll only the new self row
   after the recorded pre-send boundary. Classify the receipt using
   `attachment.is_sticker`, the attachment UTI/sticker metadata, and adaptive
   glyph identity where exposed. A visually transparent image alone does not
   prove native sticker semantics. Parent-message placement is a separate,
   unverified capability.
6. In a controller `finally`, write `restore\n` and flush, or close stdin.
   Read the final JSON. The helper restores the original RAM snapshot only
   when the clipboard still has its published changeCount. If the user copied
   something new meanwhile, it preserves that new clipboard instead.
   SIGINT/SIGTERM/SIGHUP and the 45-second deadline also request restoration;
   SIGKILL cannot be cleaned up. Keep the controller's UI deadline shorter.
7. If paste succeeded but send did not, preserve the original empty-draft
   condition without touching a changed composer: only undo the known paste
   while the same self composer still contains exactly the inserted glyph.
   Otherwise stop and report the residual draft; never blindly clear it.

The live UI owner can drive the helper with a subprocess pipe while its
existing JXA controller performs the bounded UI operation. Clipboard data and
composer contents must not be written to logs, files, or argv. Record only the
synthetic receipt metadata and outcome. Remove the temporary helper afterward.

Primary API facts: Apple's NSAdaptiveImageGlyph documentation and WWDC24
“Bring expression to your app with Genmoji” describe public attributed-text,
RTFD, and pasteboard support. The metadata-key hypothesis was independently
tested against public ImageIO/AppKit APIs; no upstream implementation was
copied. This prototype does not use IMCore injection or private selectors.
