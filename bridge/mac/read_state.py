"""Metadata-only read state shared by the reader and action verifier.

A read cursor can stay ahead of a message explicitly marked unread. Count
only the trailing unread inbound rows instead; a newer read inbound is a
barrier against historical is_read=0 ghosts. Incoming reactions participate:
Messages can mark the latest reaction unread without changing the prior text
message. They remain folded for rendering, but are not excluded from read-state
verification. Never select message bodies.
"""
import re


def valid_chat_id(value):
    # Same boundary as the chat-list reader. Old databases can contain broken
    # identifiers; one unaddressable row must not invalidate the whole inbox.
    return (isinstance(value, str) and 0 < len(value) <= 512
            and not any(ord(c) < 32 or 127 <= ord(c) <= 159
                        or 0x202a <= ord(c) <= 0x202e or 0x2066 <= ord(c) <= 0x2069 for c in value))


def read_state_scan(con, predicate="", include_deleted=False):
    """The whole-table scan: one window over every inbound message ever received.

    Correct on any schema, O(history). It is the fallback for databases the indexed
    path does not understand and the oracle the tests hold read_state() to."""
    tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    deleted = ("AND m.ROWID NOT IN (SELECT message_id FROM chat_recoverable_message_join)"
               if not include_deleted and "chat_recoverable_message_join" in tables else "")
    filt = "AND " + predicate if predicate else ""
    # Messages can merge phone/email DMs under one group_id. Compute their
    # canonical id from activity metadata, exactly like imsg's DM clustering.
    cols = {r[1] for r in con.execute("PRAGMA table_info(chat)")}
    aliases = {}
    if {"group_id", "style"} <= cols:
        groups = {}
        for cid, gid, rid, latest in con.execute(f"""
            SELECT c.chat_identifier,c.group_id,c.ROWID,MAX(m.date)
            FROM chat c LEFT JOIN chat_message_join j ON j.chat_id=c.ROWID
            LEFT JOIN message m ON m.ROWID=j.message_id AND m.item_type=0 {deleted}
            WHERE c.style!=43 AND c.group_id IS NOT NULL AND TRIM(c.group_id)!=''
            GROUP BY c.ROWID
        """):
            if valid_chat_id(cid):
                groups.setdefault(gid, []).append((latest or -1, rid, cid))
        for members in groups.values():
            canonical = max(members)[2]
            for _, _, cid in members:
                aliases[cid] = canonical
    con.create_function("blip_read_chat", 1, lambda cid: aliases.get(cid, cid))
    rows = con.execute(f"""
        WITH inbound AS (
            SELECT DISTINCT blip_read_chat(c.chat_identifier) AS chat, m.ROWID AS id,
                   m.date, m.is_read
            FROM chat c JOIN chat_message_join j ON j.chat_id=c.ROWID
            JOIN message m ON m.ROWID=j.message_id
            WHERE m.is_from_me=0 AND m.item_type=0
              AND c.chat_identifier IS NOT NULL {deleted} {filt}
        ), ranked AS (
            SELECT *, SUM(CASE WHEN is_read=1 THEN 1 ELSE 0 END) OVER (
                PARTITION BY chat ORDER BY date DESC, id DESC
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) AS read_barriers FROM inbound
        )
        SELECT chat,
               SUM(CASE WHEN read_barriers=0 THEN 1 ELSE 0 END) AS unread,
               MIN(CASE WHEN read_barriers=0 THEN date END) AS oldest,
               MAX(date) AS latest
        FROM ranked GROUP BY chat
    """)
    return [{"chat": r[0], "unread": int(r[1]), "oldest": r[2], "latest": r[3],
             "aliases": [cid for cid, canon in aliases.items() if canon == r[0] and cid != r[0]]}
            for r in rows if valid_chat_id(r[0])]


# Above this many chats with a candidate unread row, the indexed path stops being
# a win and the scan answers instead. A real inbox has a handful.
MAX_CANDIDATE_CHATS = 400


def read_state(con, predicate="", include_deleted=False):
    """Same answer as read_state_scan, without reading the whole message table.

    The scan costs O(every message ever received): 0.5 s on a 530 MB chat.db, paid on
    every poll. Two facts make that unnecessary. A chat can only have unread messages
    if it holds at least one inbound row with is_read != 1, and Apple indexes exactly
    that lookup (message_idx_is_read): 24 such rows among 144,621 inbound on the
    gateway. And a chat's newest inbound row is found by walking chat_message_join's
    (chat_id, message_date, message_id) index from the newest end, which stops at the
    first inbound row, normally the first or second.

    So: (1) find the candidate chats from the index; (2) run the SAME window query
    as the scan, but only over those chats' rows; (3) give every other chat
    unread=0 with its newest inbound date. Rows are returned in the scan's order.

    Assumes chat_message_join.message_date equals message.date, which Messages sets
    when it inserts the join row. Checked over all 282,650 rows of the gateway's
    chat.db: zero differences. Anything this path cannot vouch for goes to the scan:
    a schema without message_date, a predicate that touches the message or join
    tables (read_state_scan lets it; the contract is "alias c"), or more candidate
    chats than MAX_CANDIDATE_CHATS.
    """
    if re.search(r"\b[mj]\.", predicate or ""):
        return read_state_scan(con, predicate, include_deleted)
    tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "message_date" not in {r[1] for r in con.execute("PRAGMA table_info(chat_message_join)")}:
        return read_state_scan(con, predicate, include_deleted)
    deleted = ("AND m.ROWID NOT IN (SELECT message_id FROM chat_recoverable_message_join)"
               if not include_deleted and "chat_recoverable_message_join" in tables else "")
    filt = "AND " + predicate if predicate else ""
    newest = """(SELECT m.date FROM chat_message_join j JOIN message m ON m.ROWID=j.message_id
                  WHERE j.chat_id=c.ROWID AND m.item_type=0 {inbound} {deleted}
                  ORDER BY j.message_date DESC, j.message_id DESC LIMIT 1)"""

    # Messages can merge phone/email DMs under one group_id: same canonical id as the scan.
    cols = {r[1] for r in con.execute("PRAGMA table_info(chat)")}
    aliases = {}
    if {"group_id", "style"} <= cols:
        groups = {}
        for cid, gid, rid, latest in con.execute(f"""
            SELECT c.chat_identifier, c.group_id, c.ROWID, {newest.format(inbound="", deleted=deleted)}
            FROM chat c
            WHERE c.style!=43 AND c.group_id IS NOT NULL AND TRIM(c.group_id)!=''
        """):
            if valid_chat_id(cid):
                groups.setdefault(gid, []).append((latest or -1, rid, cid))
        for members in groups.values():
            canonical = max(members)[2]
            for _, _, cid in members:
                aliases[cid] = canonical
    canon = lambda cid: aliases.get(cid, cid)  # noqa: E731
    con.create_function("blip_read_chat", 1, canon)

    # (1) Chats that can have anything unread. Anything but is_read=1 is unread (the
    # scan's CASE WHEN is_read=1). One branch per way of not being 1, UNIONed, because
    # `is_read IS NOT 1` and any OR of them make SQLite scan every message (55 ms on
    # the gateway) where each branch alone is an index search (0.8 ms). Real data holds
    # only 0 and 1; the other branches keep NULL and stray values exact at no cost.
    unread_row = """SELECT c.chat_identifier
        FROM message m JOIN chat_message_join j ON j.message_id=m.ROWID
        JOIN chat c ON c.ROWID=j.chat_id
        WHERE m.is_from_me=0 AND m.item_type=0 AND c.chat_identifier IS NOT NULL
          AND {cond} {deleted} {filt}"""
    candidates = set()
    for (cid,) in con.execute(" UNION ".join(
            unread_row.format(cond=cond, deleted=deleted, filt=filt)
            for cond in ("m.is_read=0", "m.is_read IS NULL", "m.is_read>1", "m.is_read<0"))):
        candidates.add(canon(cid))
    if len(candidates) > MAX_CANDIDATE_CHATS:
        return read_state_scan(con, predicate, include_deleted)

    # (2) The scan's own window query, over only the candidate conversations' rows.
    by_chat = {}
    if candidates:
        members = sorted({k for k, v in aliases.items() if v in candidates}
                         | {c for c in candidates if c not in aliases})
        marks = ",".join("?" * len(members))
        for chat, unread, oldest, latest in con.execute(f"""
            WITH inbound AS (
                SELECT DISTINCT blip_read_chat(c.chat_identifier) AS chat, m.ROWID AS id,
                       m.date, m.is_read
                FROM chat c JOIN chat_message_join j ON j.chat_id=c.ROWID
                JOIN message m ON m.ROWID=j.message_id
                WHERE m.is_from_me=0 AND m.item_type=0
                  AND c.chat_identifier IN ({marks}) {deleted} {filt}
            ), ranked AS (
                SELECT *, SUM(CASE WHEN is_read=1 THEN 1 ELSE 0 END) OVER (
                    PARTITION BY chat ORDER BY date DESC, id DESC
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) AS read_barriers FROM inbound
            )
            SELECT chat,
                   SUM(CASE WHEN read_barriers=0 THEN 1 ELSE 0 END) AS unread,
                   MIN(CASE WHEN read_barriers=0 THEN date END) AS oldest,
                   MAX(date) AS latest
            FROM ranked GROUP BY chat
        """, members):
            by_chat[chat] = {"chat": chat, "unread": int(unread), "oldest": oldest, "latest": latest}

    # (3) Everyone else: nothing unread, newest inbound date from the join index.
    latest_of = {}
    for cid, latest in con.execute(f"""
        SELECT c.chat_identifier, {newest.format(inbound="AND m.is_from_me=0", deleted=deleted)}
        FROM chat c WHERE c.chat_identifier IS NOT NULL {filt}
    """):
        if latest is None:
            continue
        chat = canon(cid)
        if latest_of.get(chat, latest) <= latest:
            latest_of[chat] = latest
    for chat, latest in latest_of.items():
        if chat not in by_chat:
            by_chat[chat] = {"chat": chat, "unread": 0, "oldest": None, "latest": latest}

    # One pass over the aliases, not one per row (1,240 rows x 2,365 aliases was ~3M steps).
    # Insertion order is kept, so each list matches what the scan builds.
    retired = {}
    for cid, c in aliases.items():
        if cid != c:
            retired.setdefault(c, []).append(cid)
    return [{**row, "aliases": retired.get(row["chat"], [])}
            for _, row in sorted(by_chat.items()) if valid_chat_id(row["chat"])]
