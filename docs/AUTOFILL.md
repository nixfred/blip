# Security-code autofill

## Setup

Blip must already receive messages from the Mac. If a new SMS appears only on
the iPhone, enable that Mac under **Settings → Apps → Messages → Text Message
Forwarding** on the iPhone. The devices must use the same Apple Account.
Messages in iCloud can provide forwarding automatically; [Apple's guide](https://support.apple.com/en-au/102545)
explains both paths. Confirm the text arrives in Messages on the Mac, then Blip,
before testing autofill.

On Linux, the adapter needs Python 3, PyGObject and AT-SPI (`python`,
`python-gobject`, `at-spi2-core` on Arch), alongside Blip's existing Bun and
Hyprland dependencies. `OtpRuntime.qml` defaults to `/usr/bin/bun`; if
`command -v bun` resolves elsewhere, set its `executable` to that absolute path
in the installed plugin. This keeps codes off a shell command and its arguments.

Add this key to the existing `~/.config/blip/bridge.conf`:

```ini
otp_autofill=on
```

For Chromium or Brave, add `--force-renderer-accessibility=complete` to the
browser's existing launch flags, preserving its other options. On Omarchy the
files are typically `~/.config/chromium-flags.conf` and
`~/.config/brave-origin-flags.conf`. Fully quit the browser, including installed
web apps, then reopen it; refreshing a page does not apply launch flags.
`NO_AT_BRIDGE` must be absent from the browser's environment. Blip enables the
accessibility bus without enabling a screen reader.

After installing changed plugin files, run `omarchy restart shell` and check:

```sh
qs -p /usr/share/omarchy/shell ipc call nixfred.blip status
```

`autofill=ready` means the helper is running. Request a fresh code, focus the
input and click **Fill code**. Set `otp_autofill=off` to return to the legacy
code toast. Browser launch flags can be removed independently on a relaunch.

## Troubleshooting

- **Top-right prompt:** no usable field bounds. Refocus the field after the
  helper starts and check the browser picked up its accessibility flag.
- **Separate boxes:** compact horizontal groups of 4–12 inputs are supported,
  including JavaScript-only length limits. All boxes must be empty, and their
  count must match the code length. Clear a partial entry before requesting a
  new code. Unusual layouts or replaced accessibility objects may need an
  adapter change.
- **No prompt:** known unrelated fields are excluded; codes expire after five
  minutes. A code tied to a domain also requires the matching HTTPS document
  origin. Old messages are not replayed when the helper starts.

Brave and Chromium were tested through AT-SPI, and GTK through `EditableText`.
Zen (1.22.2b) was tested against a live sign-in page; Gecko ignores the
accessibility text write there, so the code is typed as key events. Chrome and
Firefox identifiers are recognized but have not been tested locally. Labels are
currently English-oriented, and field coordinates depend on the browser/toolkit.
No extension or DevTools connection is used by Blip.

## Code and tests

`BarWidget.noteCode()` passes existing collector events to `OtpAutofill.qml`.
`otp-policy.ts` owns lifetime, field policy and click tokens; `otp-autofill.ts`
owns private-pipe transport and child lifetime; `otp-desktop.py` handles native
accessibility and insertion. `BlipAppearance.qml` supplies the same typography
and palette to the main view and prompt. The collector and Mac bridge are
unchanged. Privacy and insertion boundaries are in [PRIVACY.md](PRIVACY.md)
and [SECURITY.md](SECURITY.md).

Run `bun test` and `python3 test_otp_desktop.py`. The Python tests replace the
accessibility boundary with synthetic objects and need no desktop or GI
installation. For live verification, use an isolated browser profile and
synthetic fields/codes; check single fields, digit groups, unrelated focus,
expiry and dismissal. UI evidence must show the real prompt and the resulting
field, with invented data, as in `scripts/demo/blip-shots`.
