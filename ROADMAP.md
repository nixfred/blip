# Blip roadmap — toward iMessage parity

Verified against the gateway Mac's chat.db 2026-08-31: 27,118 tapbacks, 45,979 read receipts
on sent messages, 4,515 inline replies, 819 edits/unsends, 30 audio messages,
and a readable Contacts DB (3,694 records). Everything below Tier 4 needs no
changes to the Mac beyond claude-on-mac updates.

## Tier 1 — display parity (data already in chat.db, read-only)

- [x] **Contact names + avatars** — names + initials circles predated this
  roadmap (imsg resolves Contacts natively). Contact PHOTOS still open —
  needs image transfer + the same cache decision as attachments.
- [x] **Read receipts (inbound)** — shipped 0.8.0 via `imsg --rich` `read_at`;
  "Read 4:42 PM" under the newest read from-me bubble only.
- [x] **Tapbacks on bubbles** — shipped 0.8.0: corner pills, net add/remove
  per sender, custom emoji included; the `Loved "…"` pseudo-rows are folded.
- [x] **Inline replies** — shipped 0.8.0: quoted snippet above the bubble.
- [x] **Edited / unsent markers** — shipped 0.8.0: "· Edited" in the time row,
  "unsent a message" tombstone.
- [x] **Attachment previews (stage 1)** — shipped 0.8.0: one chip per row
  (NEVER one row of N chips — implicit-width inflation, see CLAUDE.md);
  `.pluginPayloadAttachment` link-preview blobs filtered (imsg 1.5.1).
- [x] **Send-effect labels** — shipped 0.8.0: "· sent with confetti" in the
  time row.

## Tier 2 — attachments both directions (SHIPPED 0.9.0, 2026-08-31)

- [x] **Inbound fetch + inline images** — `imsg attachment <id>` streams bytes
  over the existing shim (binary-clean; the the Linux box shims' ssh preflight needed
  `-n` or it ate stdin); HEIC→JPEG via `sips --jpeg`. Images ≤5 MB in the open
  conversation auto-fetch and render inline; everything else is click-to-fetch
  → `xdg-open`. Cache: `~/.cache/blip/att`, 0700/0600, 500 MB LRU by mtime
  (Fred's call: plain files — the Linux box's disk is LUKS-encrypted at rest).
- [x] **Outbound files** — `imsg-send --file-stdin --name X`: file crosses on
  STDIN (never a Mac path — no exfil surface), staged in
  `~/Pictures/.blip-outbox` (subfolder verified OK for the Sequoia quirk),
  deleted post-send (Messages copies into its own store first) + 1 h GC.
  Compose: Ctrl+V image paste (paste.ts snapshots the clipboard ONCE),
  `/attach <path>`, drag-and-drop; draft chip with ✕; caption rides along,
  reported per-part. Verified delivered from the Linux box end-to-end.
- [x] **Audio messages (inbound)** — verified 1.3.0: the 🎤 chip fetches and
  xdg-opens into mpv (the Linux box's audio/x-m4a handler). Nothing more needed.

## Tier 3 — UX parity

- [x] **Search** — shipped 1.0.0: `/` in list view, snippet centered on the
  match, click opens the thread (live thread object preferred, so groups stay
  sendable); IPC `find <query>`. Theme colors landed with it: accents and
  "my" bubbles follow `Color.accent` (luminance-picked text, iMessage-blue
  fallback for accentless themes). Wheel scroll became DIRECT 1:1 after two
  animated schemes failed against hi-res wheel event floods.
- [x] **Historical group hits** — fixed 1.3.0: groups load by EXACT chat id
  (`imsg thread --chat`, claude-on-mac 1.8.0) — full history reachable, and
  ~20× fewer rows per group load than the old recent-window scan.
- [x] **New-conversation composer** — shipped 1.2.0: `n` / "＋ new" opens a
  contact picker (`contacts --json find` over the bridge; every phone/email
  is its own row, Apple `_$!<Mobile>!$_` labels unwrapped, bare numbers and
  emails accepted directly); IPC `newchat <query>`.
- [x] **Reply from the toast** — shipped 1.2.0/1.2.1: clicking the toast
  opens the panel on that conversation, compose focused (`--wait` +
  default action; 45 s watchdog since the daemon pauses expiry on hover).
  The daemon renders no action BUTTONS and only invokes `default`, so a
  separate Reply button (and inline text entry) would need a daemon patch.
- [x] **Real-time push** — shipped 1.1.0: `imsg watch` (claude-on-mac 1.7.0)
  emits content-free pings on chat.db/WAL mtime change; Blip debounces 250 ms
  into a refresh AND reloads the open conversation in parallel. Poll stretches
  6 s → 60 s while `push=true` (see `status`); watcher restarts 8 s after any
  exit. Measured ~2 s message-to-screen (was ≤6 s poll + serial reload).
- [x] **Clickable links** — shipped 1.3.0: URLs in bubbles are live anchors
  (escaped-then-linkified in thread.ts, injection-tested; plain messages keep
  the PlainText fast path). Full preview CARDS (title/thumbnail from the
  pluginPayloadAttachment blob) remain open — binary plist parsing.
- [x] **Failed-delivery flags** — shipped 1.4.0 (claude-on-mac 1.10.0):
  `error` on own rows → red bold "⚠ Not Delivered" in the bubble's time row;
  the collector emits `failures` for own sends that died in the last 15 min,
  toasted exactly once ("⚠ Not delivered to <name>"), not allowlist-gated.

## Tier 4 — the actual app

Architecture (decided 2026-08-31): the app is a `FloatingWindow` hosted
INSIDE the Omarchy shell by the plugin itself — exactly how Omarchy's
dev-gallery does it. It shares the bar widget's poller, push watcher, and
read-state ledger, so **no `blipd` daemon is needed** (that item is retired;
a daemon only returns if the app ever has to run outside the shell).

- [x] **Window skeleton** — shipped 1.5.0: `BlipWindow.qml`, Messages-style
  two-pane layout (sidebar of every thread with dots/previews + a read-only
  text conversation + compose), toggled by IPC `window` (keybind next).
  Shares live data with the panel; reads mark through the same ledger.
- [x] **Shared `BlipView`** — DONE 1.8.0 (plan: `docs/app-design-review.md`).
  `BlipView.qml` holds all state/processes/visuals behind the host contract
  with two always-instantiated panes behind `splitView`; `Panel.qml` is a
  97-line popout host, `BlipWindow.qml` a 60-line window host. Both surfaces
  render every feature from one file. Codex found no split-induced bugs.
- [x] **Window persistence** — 1.8.1: `~/.local/state/blip/window.json`
  remembers open/closed + size; the window restores itself (and requests a
  deep list) when the shell comes back. Verified across a real restart.
- [x] **Keybind** — `SUPER+M` on the Linux box (Lua `o.bind` → IPC `window`, 1.8.1;
  documented in README for others). Esc closes (unwinds first). Size
  persisted. Still open: unread count in the window title; sidebar search.
- [ ] ~~`blipd` daemon~~ — retired (see above).

## Release readiness — Omarchy plugin site

Gate: **Fred says "complete."** Nothing ships to the marketplace before that.

**A. One source (blocker).** Blip currently depends on claude-on-mac ≥1.11.0
on the Mac plus hand-made the Linux box shims with `the gateway Mac` hardcoded.
- [x] Vendor the Mac tools into `bridge/mac/` — 1.7.0: pinned in
  `bridge/BRIDGE-VERSION` (claude-on-mac f3612e8 / v1.11.0),
  `scripts/sync-bridge.sh <rev>` refreshes; upstream stays the toolkit.
- [x] Generic Linux shim — 1.7.0: `bridge/linux/blip-shim` installed as
  `~/bin/{imsg,imsg-send,contacts}`, reads `~/.config/blip/bridge.conf`
  (host=, remote_bin single-quoted so it expands on the Mac); `ssh -n`.
- [x] `scripts/blip-setup` — 1.7.0: config, ControlMaster block, shims
  (backs up existing), Mac install over ssh (`bridge/mac/install.sh` →
  `~/.blip/bin`), TCC grant walkthrough + `tcc-check`, smoke test. Dogfooded
  on the Linux box. 1.9.0: `bridge/mac/blip-check` (chat.db / Messages automation /
  Contacts, checked over ssh — the automation check itself pops the Allow
  prompt) with a grant-then-recheck loop in the wizard.
- [ ] Self-handles: auto-detected from chat.db already (`imsg-send
  --list-self`); allowlist editor still open. Machine-specific strings removed (1.7.0).

**B. Finish the app.**
- [x] Shared `BlipView` (docs/app-design-review.md) so the window has the
  rich renderer: tapbacks, inline photos, replies, search, attachments.
- [x] Keybind to toggle the window; remembered size/position; Esc closes;
  sidebar search; unread count in the title.

**C. Polish for strangers' machines.**
- [x] **Honest failure states** — 1.9.0: `collector.explainBridgeError` maps
  bridge stderr to the one sentence that fixes it (Full Disk Access,
  Automation, blip-setup, missing Mac tools, ssh keys); the panel shows it in
  urgent red, the bar tooltip carries it. Verified by breaking the bridge on
  purpose. Still open: Linux-side dependency checks (`bun`/`jq`/`wl-copy`).
- [x] (2.0.0 sweep: HOME fallbacks → os.homedir, wizard example made generic; hyprctl is inherent to Omarchy) Remove machine-specific assumptions: paths, mpv/xdg handlers, Hyprland-only bits;
  degrade gracefully (older macOS without `date_edited`, no sips, no HEIC).
- [x] First-run and offline UX: clear "Mac unreachable / grant missing"
  states with the fix spelled out.
- [x] Contact photos; link preview cards; unread in window title (2.0.0).

**D. Ship hygiene.**
- [x] Full Codex audit → docs/SECURITY.md (12 findings; 8 fixed in 1.9.4,
  then 1.10.0: forced-command ssh key + `automation=` IPC gate) + docs/PRIVACY.md.
- [x] `--text-stdin` end to end so bodies leave argv (audit #4) — 1.11.0.
- [x] README: the SUPER+M keybind recipe (Hyprland-driven; see CLAUDE.md
  hot-reload invariant) — users must not bind a plain `qs ipc … window`.
- [x] Upstream: omacom/omarchy#9533 — report the hot-reload zombie IpcHandler to Omarchy
  (shell.qml reloadPlugins → old bar widget keeps the ipc target).
- [x] (1.11.0: imsg-send keeps sent files in ~/.blip/sent, imsg resolves outbox
  paths to them — remote-recipient path verified by code only) Images Blip sends to OTHER people: chat.db's attachment row keeps the
  `~/Pictures/.blip-outbox/…` path (Messages did not copy it into its store),
  so the bubble can never re-fetch it once the outbox is swept. Keep sent
  files until the row points into ~/Library/Messages/Attachments, or cache
  the outgoing bytes locally under the attachment id.
- [ ] README rewrite for non-Fred users; screenshots/GIF; manifest fields
  (description, author, screenshots); CHANGELOG; version 2.0.0.
- [ ] Test on a second Mac/Linux pair before publishing — DEFERRED (Fred,
  2026-08-31: "not interested in trying another machine yet"); revisit only
  when he raises it.

## War room 2026-09-01 — deferred findings (verified real, not yet fixed)

Ten expert reviewers, 114 findings; 2.1.0 fixed the clear ones; the judge
panel (3 lenses × finding, against current main) confirmed 11 closed and
17 open, of which 2.2.0 fixed all but the ones still unticked below.

- [x] One BarWidget per monitor → leader election (2.2.0; follower bars
  show the badge from state.json and forward clicks over IPC).
- [x] SMS/RCS threads send on their own service (2.2.0). Last inbound
  wins; a failed iMessage to a phone (error 22) sends SMS next (PR #4).
- [ ] **3–4 digit short codes classify as groups** — `isGroupChat()` treats a
  digits-only id shorter than 5 as "not a phone", so a carrier-style sender
  opens read-only with "group id unknown". Widen to `{3,15}` (E.164 max is
  15) once tested against a real one. 5+ digit codes load correctly since 2.2.1.
- [ ] **Timestamps are Mac-local wall-clock strings** compared against the
  Linux clock (DST fall-back hour, a UTC Mac). Move the bridge to epoch/UTC
  and convert on display. Cross-cutting; do it as its own release.
- [ ] **One never-opened unread pins the catch-up loop** — every poll walks
  150→8192 rows across sequential ssh calls. Cache the reconciliation
  boundary per chat.
- [x] Window marks read only while focused (2.2.0, Hyprland active toplevel).
- [ ] Toasts fire for the conversation being read (bar popout case).
- [x] Self-chat promotion needs two twins to persist (2.2.0).
- [x] Failure toasts re-fired (ring normalizer dropped the `fail:` prefix) (2.2.0).
- [x] `country_code=` in bridge.conf for non-NANP numbers (2.2.0).
- [ ] `searching` sticks on after a click into the field; `bubbleFocused`
  can stick after a reload; link colour inside the accent bubble.
- [ ] Send-target resolution exists twice (QML text path, TS file path) —
  unify on TS.
- [ ] `--read` clears a chat's ledger count but only marks through
  `--seen`; make them agree.

## Futures — requested, not scheduled

- [ ] **In-flight encryption** (community request, 2026-09-01) — **answered,
  not scheduled.** In flight: every byte between the two machines already
  rides ssh on the dedicated `blip_ed25519` key. At rest: that is the disk's
  job — Omarchy installs with LUKS by default and the Mac has FileVault —
  and Blip only ever writes opened attachments, contact thumbnails, and a
  timestamps/counts state file (never message text). Encrypting the cache
  ourselves would add nothing on an encrypted disk and still hand `xdg-open`
  a plaintext file on an unencrypted one. Revisit only if someone names a
  concrete threat that ssh + disk encryption does not cover.

## Prior art

- **[BlueFerry](https://github.com/erikwb/blueferry)** — iMessage on Linux over
  Bluetooth MAP straight to the iPhone (no Mac). Decision 2026-08-31: the gateway Mac
  stays Blip's source (BT gets no attachments, no tapbacks, no history, shaky
  groups), but BlueFerry does two things Blip can't: **mark messages read on
  the phone** and push-latency delivery. Its Quickshell client is worth
  reading; a future hybrid could borrow BT MAP *just* for read-marking.
  Check its license before lifting code.

## Not possible (and why)

- **Outbound tapbacks / edits / typing indicators** — no public API; requires
  BlueBubbles-style code injection into Messages.app, which requires disabling
  SIP (System Integrity Protection) on the Mac. Rejected for the gateway Mac: daily
  driver, not worth the security downgrade.
- **Sending read receipts** — `open imessage://` does not flip `is_read`.
- **Group add/rename** — AppleScript cannot.
