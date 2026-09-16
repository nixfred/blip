# Save a new contact

From the Blip checkout on Linux, run:

```sh
scripts/blip-setup you@your-mac
```

The wizard installs `contact-save` and its native helper on the Mac and the
Linux shim. It preserves existing configuration. Normal setup does not create
contacts or send messages. Stay at the Mac or connected through Screen Sharing
when the wizard announces the existing Automation approval prompt.

## Mac permission

Keep the bridge's existing Full Disk Access and Automation grants. Saving a
contact also requires Contacts access. Approve its prompt on the Mac during the
first save. If previously denied, check System Settings → Privacy & Security →
Contacts for the bridge process. Full Disk Access alone is not enough.
Contact saving does not need Accessibility or Swift. The Mac helper uses the
native Contacts and AddressBook frameworks through JavaScript for Automation.

## Save a new contact

Open **Review contact** from a conversation. For a group, select the participant
first. If no matching card exists, choose **Save new contact**, enter a name,
review the number and email, then click **Save to Contacts**. Keep the selected
sender's identity on the card. Existing cards are not edited or merged.

The bridge checks for an existing phone number or email, creates the card using
the Mac's native Contacts layer, and reads the saved card back before reporting
success. Account placement follows the Mac's Contacts configuration. If a
response is lost, inspect Contacts on the Mac before trying again; a timeout
can follow a successful save.

Contact fields cross bounded stdin, never command-line arguments. Drafts stay
in memory on Linux. The empty Mac lock file contains no contact data.
