"""Metadata-only read state shared by the reader and action verifier.

A read cursor can stay ahead of a message explicitly marked unread. Count
only the trailing unread inbound rows instead; a newer read inbound is a
barrier against historical is_read=0 ghosts. Incoming reactions participate:
Messages can mark the latest reaction unread without changing the prior text
message. They remain folded for rendering, but are not excluded from read-state
verification. Never select message bodies.
"""


def valid_chat_id(value):
    # Same boundary as the chat-list reader. Old databases can contain broken
    # identifiers; one unaddressable row must not invalidate the whole inbox.
    return (isinstance(value, str) and 0 < len(value) <= 512
            and not any(ord(c) < 32 or 127 <= ord(c) <= 159
                        or 0x202a <= ord(c) <= 0x202e or 0x2066 <= ord(c) <= 0x2069 for c in value))


def read_state(con, predicate="", include_deleted=False):
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
               MAX(date) AS latest, MAX(id) AS max_id
        FROM ranked GROUP BY chat
    """)
    return [{"chat": r[0], "unread": int(r[1]), "oldest": r[2], "latest": r[3], "max_id": r[4],
             "aliases": [cid for cid, canon in aliases.items() if canon == r[0] and cid != r[0]]}
            for r in rows if valid_chat_id(r[0])]
