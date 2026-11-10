#!/usr/bin/env python3
"""Read/unread metadata and menu verification, using synthetic data only."""
import contextlib
import importlib.machinery
import importlib.util
import io
import sqlite3
import sys
import unittest
from pathlib import Path
from unittest.mock import patch, Mock

sys.path.insert(0, str(Path(__file__).parent))
from read_state import read_state, read_state_scan, MAX_CANDIDATE_CHATS
import random


def load_tool(name):
    loader = importlib.machinery.SourceFileLoader('test_' + name.replace('-', '_'), str(Path(__file__).with_name(name)))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


class Metadata(unittest.TestCase):
    def setUp(self):
        self.con = sqlite3.connect(':memory:')
        self.con.executescript('''
            CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT,
              last_read_message_timestamp INTEGER, is_filtered INTEGER, group_id TEXT, style INTEGER);
            CREATE TABLE message (ROWID INTEGER PRIMARY KEY, date INTEGER, is_read INTEGER,
              is_from_me INTEGER, item_type INTEGER, associated_message_type INTEGER);
            CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
            CREATE TABLE chat_recoverable_message_join (message_id INTEGER);
            INSERT INTO chat VALUES (1,'+15551234567',999999,0,'dm',45);
        ''')

    def add(self, ident, date, read=0, chat=1, outbound=0, item=0, tapback=0):
        self.con.execute('INSERT INTO message VALUES (?,?,?,?,?,?)', (ident, date, read, outbound, item, tapback))
        self.con.execute('INSERT INTO chat_message_join VALUES (?,?)', (chat, ident))

    def count(self):
        return read_state(self.con)[0]['unread']

    def test_manual_unread_below_read_cursor_is_detected(self):
        self.add(1, 100, read=0)
        self.assertEqual(self.count(), 1)

    def test_read_tip_hides_old_ghosts_and_same_time_uses_rowid(self):
        self.add(1, 100)
        self.add(2, 100, read=1)
        self.assertEqual(self.count(), 0)
        self.add(3, 100)
        self.assertEqual(self.count(), 1)

    def test_announcements_deleted_and_outbound_do_not_badge(self):
        self.add(1, 100, read=1)
        self.add(2, 101, read=1, tapback=2000)
        self.add(3, 102, item=1)
        self.add(4, 103, outbound=1)
        self.add(5, 104)
        self.con.execute('INSERT INTO chat_recoverable_message_join VALUES (5)')
        self.assertEqual(self.count(), 0)
        self.assertEqual(read_state(self.con, include_deleted=True)[0]['unread'], 1)

    def test_unread_reaction_after_read_message_matches_messages(self):
        self.add(1, 100, read=1)
        self.add(2, 101, outbound=1)
        self.add(3, 102, tapback=2004)
        self.assertEqual(self.count(), 1)
        self.con.execute('UPDATE message SET is_read=1 WHERE ROWID=3')
        self.assertEqual(self.count(), 0)

    def test_read_reaction_is_a_barrier_against_older_unread_ghosts(self):
        self.add(1, 100)
        self.add(2, 101, read=1, tapback=2000)
        self.assertEqual(self.count(), 0)

    def test_duplicate_service_join_is_counted_once(self):
        self.add(1, 100)
        self.con.execute('INSERT INTO chat VALUES (2,"+15551234567",999999,0,"dm",45)')
        self.con.execute('INSERT INTO chat_message_join VALUES (2,1)')
        self.assertEqual(self.count(), 1)

    def test_merged_email_phone_share_read_barrier_and_aliases(self):
        self.add(1, 100)
        self.con.execute('INSERT INTO chat VALUES (2,"you@example.com",999999,0,"dm",45)')
        self.add(2, 200, read=1, chat=2)
        rows = read_state(self.con)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['unread'], 0)
        self.assertEqual(rows[0]['chat'], 'you@example.com')
        self.assertIn('+15551234567', rows[0]['aliases'])

    def test_filters_and_minimal_older_schema(self):
        self.add(1, 100)
        self.assertEqual(read_state(self.con, 'c.is_filtered NOT IN (0)'), [])
        self.con.execute('DROP TABLE chat_recoverable_message_join')
        self.assertEqual(self.count(), 1)

    def test_malformed_old_identifier_does_not_poison_complete_snapshot(self):
        self.add(1, 100)
        self.con.execute('INSERT INTO chat VALUES (2,?,999999,0,"broken",45)', ('x' * 513,))
        self.add(2, 200, chat=2)
        rows = read_state(self.con)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['chat'], '+15551234567')

    def test_verifier_uses_identical_metadata_definition(self):
        helper = load_tool('imsg-read')
        self.add(1, 100)
        with patch.object(helper.sqlite3, 'connect') as connect:
            # Do not let the helper close the fixture connection.
            wrapper = Mock(wraps=self.con)
            wrapper.close = Mock()
            connect.return_value = wrapper
            self.assertEqual(helper.unread_on_mac('+15551234567'), 1)


class ConversationWindow(unittest.TestCase):
    def test_unread_beyond_sidebar_limit_is_included_without_adding_read_backlog(self):
        imsg = load_tool('imsg')
        rows = [{"chat_identifier": x} for x in ['recent', 'read-old', 'unread-old', 'alias']]
        states = [{"chat": 'unread-old', "unread": 1, "aliases": ['alias']}]
        self.assertEqual(imsg.conversation_window(rows, 1, states), [rows[0], rows[2], rows[3]])


class ReactionReadBoundary(unittest.TestCase):
    def test_folded_reactions_and_removals_keep_their_activity_timestamp(self):
        imsg = load_tool('imsg')
        target = {"ROWID": 1, "guid": "target", "assoc_type": 0,
                  "date_read": 0, "is_delivered": 0, "service": "iMessage",
                  "is_from_me": 1, "orig_guid": None,
                  "style_id": None, "is_audio_message": 0,
                  "balloon_bundle_id": None, "payload_data": None}
        for kind in [2004, 3004]:
            con = Mock()
            con.execute.return_value = [{"ag": "p:0/target", "t": kind,
                "date": 810000000000000000, "is_from_me": 0, "handle": "+15551234567"}]
            with patch.object(imsg, '_has_col', return_value=False), patch.object(imsg, '_chunked_in', return_value=[]):
                kept, extras = imsg.enrich(con, [target], with_names=False)
            self.assertEqual(kept, [target])
            self.assertEqual(extras[1]['activity_ts'], imsg.fmt_ts(810000000000000000))
            self.assertEqual(len(extras[1].get('tapbacks', [])), 1 if kind == 2004 else 0)


class IndexedMatchesScan(unittest.TestCase):
    """read_state() answers from indexes; read_state_scan() reads every row. They must agree."""

    SCHEMA = """
        CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT,
          is_filtered INTEGER, group_id TEXT, style INTEGER);
        CREATE TABLE message (ROWID INTEGER PRIMARY KEY, date INTEGER, is_read INTEGER,
          is_from_me INTEGER, item_type INTEGER, associated_message_type INTEGER);
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER);
        CREATE TABLE chat_recoverable_message_join (message_id INTEGER);
        CREATE INDEX cmj_date ON chat_message_join(chat_id, message_date, message_id);
    """

    @staticmethod
    def random_db(rng):
        con = sqlite3.connect(":memory:")
        con.executescript(IndexedMatchesScan.SCHEMA)
        n_chats = rng.randint(1, 9)
        ids = ["+1555000%04d" % rng.randint(0, 6), "a%d@example.com" % rng.randint(0, 3),
               "chat%d" % rng.randint(100, 104), "%032x" % rng.randint(0, 3)]
        for rowid in range(1, n_chats + 1):
            ident = None if rng.random() < 0.08 else rng.choice(ids)
            style = rng.choice([43, 45, 45, 45])
            group = rng.choice([None, None, "g1", "g2", " "])
            con.execute("INSERT INTO chat VALUES (?,?,?,?,?)",
                        (rowid, ident, rng.choice([0, 0, 1, 2]), group, style))
        for mid in range(1, rng.randint(0, 40) + 1):
            date = rng.randint(1, 12)          # a small range, so dates tie and ROWID decides
            con.execute("INSERT INTO message VALUES (?,?,?,?,?,?)",
                        (mid, date, rng.choice([0, 0, 1, 1, 1, None, 2, -1]),
                         rng.choice([0, 0, 0, 1]), rng.choice([0, 0, 0, 0, 1, 3]),
                         rng.choice([0, 0, 0, 2000, 3001])))
            for chat in {rng.randint(1, n_chats) for _ in range(rng.choice([1, 1, 1, 2]))}:
                con.execute("INSERT INTO chat_message_join VALUES (?,?,?)", (chat, mid, date))
            if rng.random() < 0.1:
                con.execute("INSERT INTO chat_recoverable_message_join VALUES (?)", (mid,))
        return con

    def test_random_databases_agree_with_the_scan(self):
        rng = random.Random(20261110)
        for case in range(1500):
            con = self.random_db(rng)
            for predicate in ("", "c.is_filtered NOT IN (1)", "(c.ROWID IS NULL OR c.is_filtered NOT IN (1, 2))"):
                for deleted in (False, True):
                    want = read_state_scan(con, predicate, deleted)
                    got = read_state(con, predicate, deleted)
                    self.assertEqual(got, sorted(want, key=lambda r: r["chat"]),
                                     "case %d predicate=%r include_deleted=%r" % (case, predicate, deleted))

    def test_row_shape_and_key_order_are_the_scans(self):
        con = self.random_db(random.Random(3))
        con.execute("INSERT INTO message VALUES (900, 50, 0, 0, 0, 0)")
        con.execute("INSERT INTO chat_message_join VALUES (1, 900, 50)")
        got = read_state(con)
        self.assertTrue(got)
        self.assertEqual([list(r) for r in got], [["chat", "unread", "oldest", "latest", "aliases"]] * len(got))

    def test_schema_without_message_date_takes_the_scan(self):
        con = sqlite3.connect(":memory:")
        con.executescript("""
            CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, is_filtered INTEGER, group_id TEXT, style INTEGER);
            CREATE TABLE message (ROWID INTEGER PRIMARY KEY, date INTEGER, is_read INTEGER, is_from_me INTEGER, item_type INTEGER);
            CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
            INSERT INTO chat VALUES (1,'+15551234567',0,NULL,45);
            INSERT INTO message VALUES (1,100,0,0,0);
            INSERT INTO chat_message_join VALUES (1,1);
        """)
        self.assertEqual(read_state(con)[0]["unread"], 1)

    def test_a_predicate_on_messages_takes_the_scan(self):
        # The contract is "alias c"; one that reaches into m must still be honoured.
        con = self.random_db(random.Random(5))
        for _ in range(200):
            con = self.random_db(random.Random(_))
            self.assertEqual(read_state(con, "m.date > 3"), read_state_scan(con, "m.date > 3"))

    def test_more_candidates_than_the_limit_take_the_scan(self):
        con = sqlite3.connect(":memory:")
        con.executescript(self.SCHEMA)
        for i in range(1, MAX_CANDIDATE_CHATS + 6):
            con.execute("INSERT INTO chat VALUES (?,?,0,NULL,45)", (i, "+1555%07d" % i))
            con.execute("INSERT INTO message VALUES (?,?,0,0,0,0)", (i, 10 + i))
            con.execute("INSERT INTO chat_message_join VALUES (?,?,?)", (i, i, 10 + i))
        got = read_state(con)
        self.assertEqual(len(got), MAX_CANDIDATE_CHATS + 5)
        self.assertEqual(got, sorted(read_state_scan(con), key=lambda r: r["chat"]))

    def test_a_chat_with_nothing_unread_still_reports_its_newest_inbound(self):
        # reconcileReadIntents needs a row for a read chat, or a mark-read intent never clears.
        con = sqlite3.connect(":memory:")
        con.executescript(self.SCHEMA)
        con.execute("INSERT INTO chat VALUES (1,'+15551234567',0,NULL,45)")
        for mid, date, mine, read in ((1, 10, 0, 1), (2, 20, 1, 1), (3, 30, 0, 1), (4, 40, 1, 1)):
            con.execute("INSERT INTO message VALUES (?,?,?,?,0,0)", (mid, date, read, mine))
            con.execute("INSERT INTO chat_message_join VALUES (1,?,?)", (mid, date))
        self.assertEqual(read_state(con), [{"chat": "+15551234567", "unread": 0, "oldest": None, "latest": 30, "aliases": []}])


class DeliveryState(unittest.TestCase):
    def delivered(self, service, is_delivered=1, is_from_me=1):
        imsg = load_tool('imsg')
        row = {"ROWID": 1, "guid": "m", "assoc_type": 0, "date_read": 0,
               "is_delivered": is_delivered, "service": service, "is_from_me": is_from_me,
               "orig_guid": None, "style_id": None, "is_audio_message": 0,
               "balloon_bundle_id": None, "payload_data": None}
        con = Mock()
        con.execute.return_value = []
        with patch.object(imsg, '_has_col', return_value=False), patch.object(imsg, '_chunked_in', return_value=[]):
            _, extras = imsg.enrich(con, [row], with_names=False)
        return extras[1].get('delivered', False)

    def test_only_own_imessage_and_rcs_report_delivery(self):
        self.assertTrue(self.delivered('iMessage'))
        self.assertTrue(self.delivered('RCS'))
        self.assertFalse(self.delivered('SMS'))
        self.assertFalse(self.delivered('iMessage', is_delivered=0))
        self.assertFalse(self.delivered('iMessage', is_from_me=0))


class Actions(unittest.TestCase):
    def setUp(self):
        self.tool = load_tool('imsg-read')

    def test_unverified_action_is_failure_not_success(self):
        for before, after in ((None, None), (1, None)):
            with self.assertRaises(SystemExit) as ctx, contextlib.redirect_stderr(io.StringIO()):
                self.tool.report(before, after, True, 'Mark as Read')
            self.assertEqual(ctx.exception.code, 75)
            with self.assertRaises(SystemExit) as ctx, contextlib.redirect_stderr(io.StringIO()):
                self.tool.report_unread(before, after, True)
            self.assertEqual(ctx.exception.code, 75)

    def test_partial_mark_all_is_not_acknowledged(self):
        with self.assertRaises(SystemExit) as ctx, contextlib.redirect_stderr(io.StringIO()):
            self.tool.report(3, 2, True, 'Mark All as Read')
        self.assertEqual(ctx.exception.code, 75)

    def main(self, flag, before, after):
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        mocks = {}
        for name, result in [('ensure_messages', ''), ('accessibility', ''), ('unread_on_mac', before),
                             ('frontmost', 'Previous'), ('select_chat', ''), ('wake_messages', 'Previous'),
                             ('click', (False, '')), ('settle', after), ('settle_unread', after), ('restore_front', None)]:
            mocks[name] = stack.enter_context(patch.object(self.tool, name, return_value=result))
        stack.enter_context(patch.object(sys, 'argv', ['imsg-read', flag, '+15551234567']))
        stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.tool.main()
        return mocks

    def test_already_unread_is_not_opened_and_read_accidentally(self):
        mocks = self.main('--unread', 1, 1)
        mocks['select_chat'].assert_not_called()
        mocks['click'].assert_not_called()

    def test_read_wakes_menu_and_accepts_selection_read_with_absent_item(self):
        mocks = self.main('--chat', 1, 0)
        mocks['wake_messages'].assert_called_once()
        mocks['settle'].assert_called_once_with(1, '+15551234567')
        mocks['restore_front'].assert_called_once_with('Previous')

    def test_unread_waits_for_verified_state_and_restores_focus(self):
        mocks = self.main('--unread', 0, 1)
        mocks['settle_unread'].assert_called_once_with('+15551234567')
        mocks['restore_front'].assert_called_once_with('Previous')

    def test_settle_waits_until_all_are_read_not_just_one(self):
        with patch.object(self.tool, 'unread_on_mac', side_effect=[2, 1, 0]), patch.object(self.tool.time, 'sleep'):
            self.assertEqual(self.tool.settle(3), 0)


if __name__ == '__main__':
    unittest.main()
