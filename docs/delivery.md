# Delivery receipts

The newest sent message shows **Delivered** after the recipient device acknowledges an iMessage or RCS, then **Read** with the existing timestamp format when a read receipt arrives. Carrier SMS has no delivery receipt. Older gateways that omit `delivered` keep working and show only read receipts.

Failed, retracted and scheduled messages do not show Delivered. Self-thread echo folding preserves the sent row’s receipt metadata. No new setting, message content storage, or send path is introduced.

Run `bun test` and `python3 bridge/mac/test_read_sync.py`. All fixtures are synthetic; no live send is needed.
