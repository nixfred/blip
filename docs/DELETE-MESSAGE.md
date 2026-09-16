# Delete one message

Blip can delete one message through Messages. The bridge installs the helpers automatically; macOS still
requires you to approve access on the Mac's desktop.

## Install or update

From the Blip checkout on Linux, run:

```sh
scripts/blip-setup you@your-mac
```

This updates the Mac helpers, installs the Linux `imsg-delete` shim, and enrolls the confined SSH key. It preserves existing
configuration. The normal permission check does not save contacts or send or
delete messages. Stay at the Mac or connected through Screen Sharing when the
wizard says an Allow prompt is about to appear; the prompt expires in about
two minutes.

The Mac must have Xcode Command Line Tools, including Python and Swift. If
needed, run `xcode-select --install` on the Mac and complete Apple's installer.
Keep the Mac logged into the same user account that runs Messages, signed into
Messages, unlocked, and with Messages open for deletion. Linux needs no Swift
installation. These actions use macOS APIs behind the existing SSH bridge.

### A Mac without a monitor

These actions let you manage conversations from Omarchy while a Mac serves as
the iMessage gateway. Deletion still operates the Mac's Messages interface:
the Mac must be awake, logged in, **unlocked**, and have Messages open. A
connected monitor is not required; use Screen Sharing to unlock the Mac and
open Messages before returning to Blip. SSH connectivity alone does not make
the desktop available to the deletion helper.

Messages does not expose an individual-message deletion command in its
scripting dictionary. Blip uses Accessibility to operate its Delete action,
then verifies the result through a read-only database query. This means
deletion cannot run in a locked or logged-out desktop session. Blip does not
unlock the Mac or change its automatic-lock settings.

If a first attempt after unlocking says to keep Messages open, bring Messages
forward, wait for the conversation to load, then reopen the Blip deletion
dialog. If an attempt says deletion could not be verified, check Messages
before retrying: the action may already have completed.

## One-time Mac approvals

Open **System Settings → Privacy & Security** on the Mac.

1. Under **Full Disk Access**, enable `/usr/libexec/sshd-keygen-wrapper`.
   This is the bridge's existing requirement for reading Messages and contact
   names. Reconnect SSH after changing a grant.
2. Under **Accessibility**, click **+**. In the file picker, press **⌘⇧G**
   (Command–Shift–G), paste `/usr/libexec/sshd-keygen-wrapper`, press Return,
   and click **Open**. Enable its switch. This is a file inside the hidden
   `/usr/libexec` directory; you do not need to locate it in Finder first.
3. Keep the existing **Automation → Messages** approval used for sending.
   The deletion helper uses Accessibility directly and does not request
   System Events automation.

macOS approval switches cannot be granted by the setup script. No SIP changes
or private frameworks are required. Do not reset all permissions as a routine
setup step.

Check the optional action permissions from Linux using your usual SSH login:

```sh
ssh you@your-mac 'python3 "$HOME/.blip/bin/blip-check" --mutations'
```

Add `--json` for structured results. The optional checks read permission status;
they do not trigger a Contacts prompt or perform an action. A nonzero exit
means a required permission or tool is missing. A successful check establishes
prerequisites; it does not prove an individual deletion succeeded.

## Delete one message

Right-click a message or attachment, choose **Delete message…**, review the
preview, then confirm **Delete message**. Pending or failed local sends do not
have a stored Mac message identity and cannot use this action. Right-clicking
a link retains its existing share action.

Messages comes forward on the Mac. The bridge locates the selected message by
its unique ID, verifies the selected bubble, invokes Delete, and checks that
the exact message left live history. It handles Messages' first-use Recently
Deleted notice. Unknown dialogs or unsupported accessibility layouts stop the
operation rather than accepting an unrelated prompt. Avoid interacting with
Messages during the operation.

Deletion moves the message to **Recently Deleted** in Messages, normally for
30 days. With Messages in iCloud enabled, deletion also syncs to your devices.
This is not **Undo Send** and does not remove a recipient's copy. Recover a
message through Messages on the Mac if needed.

The native interface was exercised on macOS 26.5.2. Delete action names and
confirmation labels currently require English;
other locales fail closed. Apple may change the accessibility layout between
macOS releases. If Blip cannot verify deletion, check the Mac and reload the
conversation before trying again. No message database is written directly.

Deletion requests cross bounded stdin, not command-line
arguments. Message bodies are read on the Mac for target verification and are
not logged or stored by the deletion helper.
