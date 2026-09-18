# Read/unread sync and conversation actions: readiness review

Reviewed 2026-09-18 against upstream `313326e` (including merged PRs #101 and
#102). Author review, automated regressions and synthetic UI inspection.

**Decision: ready for upstream review with Delete excluded.** The four blockers
from the previous candidate are resolved or removed from scope. This is not a
claim of complete macOS/iPhone parity or fresh live-macOS acceptance testing.

## Resolution of the blockers

| Previous finding | Resolution | Evidence |
| --- | --- | --- |
| A global retry could clear newer inbound messages | Capture the prior complete snapshot's maximum inbound row id and timestamp. Cancel on newer metadata, including same-second rows. The Mac rechecks immediately before clicking and again after waking Messages. Stale requests return a terminal cancellation result instead of retrying. | Offline/same-second/newer-arrival collector tests; Mac guard tests |
| Failed global actions starved later per-chat gestures | A later per-chat gesture supersedes the pending global intent. In-flight work completes before its successor; stale completions cannot acknowledge the successor. | Failed-global/later-read and in-flight read/unread tests |
| Mac actions blocked the collector | `read-worker.ts` uses a durable single-slot mailbox and a separate flock-protected process. The collector alone owns state.json. Results carry job and intent ids; failure acknowledgement applies once. Pin/alert actions use the same worker. | Slow-action/concurrent-polling tests; stale-result and repeated-ack tests |
| Delete lacked verified targeting | Removed the Delete menu, confirmation, collector command and Mac implementation from this submission. | UI absence assertion and source review |

A Mark All Read does not discard unrelated pending pin/alert edits. Repeated
mark-all gestures in the same second accept a newer row boundary. An old
unbounded request cannot prevent a valid due request from dispatching.

## Additional corrections

- Preserve upstream Send Later, prefer_imessage and bin_dir behavior, bounded
  catch-up, contact review, message/link menus and all Mark All Read controls.
- Preserve local group unread overrides across complete snapshots.
- Require verification for pin/mute; skip already-satisfied actions and restore
  the app that was frontmost before selection.
- Hide Alerts suppresses local Blip notifications while leaving the conversation
  visible. Pin and alert metadata refresh after worker completion.
- Remove superseded detached-push helpers and tests of those unused paths.
- Preserve the original Qt badge regressions and add unread suppression coverage.
- Keep bodies out of state, worker files and argv. Mailbox files contain only
  action metadata and bounded status, with a private parent and atomic writes.

## Validation

- Full Bun suite: **623 passed**.
- Mac Python suite: **120 passed**; synthetic SQLite and mocked menu calls.
- Qt: **5 scenarios passed** (plus setup/cleanup), including the original badge
  regressions, unchanged-model identity and optimistic read/unread suppression.
- Generated ReadSync.mjs matches its TypeScript build.
- Python compile, QML parsing, bash syntax, ShellCheck 0.11.0 and whitespace
  checks pass.
- Inspected the [synthetic conversation menu](review-assets/conversation-menu.png).
  No Delete option; contact review, pin, unread and alerts remain visible.
  Demo log has no QML errors; it has an unrelated host-portal registration warning.
- Synthetic in-memory read-state benchmark: 100,000 inbound rows across 100
  conversations in approximately 0.17 seconds on the development machine.
  This is not a production Mac performance measurement.

## Remaining limits for the maintainer

- Messages UI automation cannot make a SQLite check and a menu click atomic.
  A message can arrive after the final guard; selection can be affected by a
  person using the Mac. Post-action database verification detects failures but
  cannot make that interaction transactional. The existing upstream read-push
  integration has the same selection dependency; Delete remains excluded.
- Pin, alert and per-thread Mac read/unread actions support DMs only. Group
  unread remains local; global read still covers groups.
- Read pushes remain `all` by default; `thread` remains opt-in. Pin/alert menu
  requests are independent of read-push policy and can briefly activate Messages.
- Newer global activity conservatively cancels the whole global retry. Users
  can deliberately choose Mark All Read again after reviewing the new state.
- The badge now counts unread conversations instead of individual inbound rows;
  this is an explicit product change for maintainer review, not part of #101.
- Linux needs flock (util-linux). Install the new TypeScript worker/module and
  update both Mac tools with their sibling read_state.py together.
- No real conversation was opened, modified, deleted or messaged for these tests.
  Fresh live-macOS menu/iCloud acceptance is not claimed. Test the supported Mac
  versions and a large real metadata-only database before a broad release.

The installed plugin and Mac bridge were not changed. The code and this review
are provided for upstream assessment; CI status belongs to the resulting PR.
