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
from read_state import read_state


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
                  "date_read": 0, "is_from_me": 1, "orig_guid": None,
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


class GlobalReadGuard(unittest.TestCase):
    def test_newer_same_second_row_prevents_any_global_click(self):
        tool = load_tool('imsg-read')
        with patch.object(sys, 'argv', ['imsg-read', '--all', '--through-row', '1']), \
                patch.object(tool, 'ensure_messages', return_value=''), \
                patch.object(tool, 'accessibility', return_value=''), \
                patch.object(tool, 'unread_on_mac', return_value=1), \
                patch.object(tool.sqlite3, 'connect'), \
                patch.object(tool, 'read_state', return_value=[{'max_id': 2}]), \
                patch.object(tool, 'click') as click, \
                contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
            tool.main()
        self.assertEqual(caught.exception.code, 76)
        click.assert_not_called()

    def test_waking_messages_rechecks_before_global_click_and_restores_focus(self):
        tool = load_tool('imsg-read')
        with patch.object(sys, 'argv', ['imsg-read', '--all', '--through', '2026-09-01T10:00:00Z']), \
                patch.object(tool, 'ensure_messages', return_value=''), \
                patch.object(tool, 'accessibility', return_value=''), \
                patch.object(tool, 'unread_on_mac', return_value=1), \
                patch.object(tool, 'newer_than_seen', side_effect=[False, True]), \
                patch.object(tool, 'click', return_value=(False, '')) as click, \
                patch.object(tool, 'wake_messages', return_value='Previous'), \
                patch.object(tool, 'restore_front') as restore, \
                contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
            tool.main()
        self.assertEqual(caught.exception.code, 76)
        self.assertEqual(click.call_count, 1)
        restore.assert_called_once_with('Previous')


class MenuVerification(unittest.TestCase):
    def setUp(self):
        self.tool = load_tool('imsg-read')

    def test_flag_settles_through_transient_unavailability(self):
        probe = Mock(side_effect=[None, False, True])
        with patch.object(self.tool.time, 'sleep'):
            self.assertTrue(self.tool.settle_flag(probe, True))
        self.assertEqual(probe.call_count, 3)

    def test_pin_and_mute_cannot_succeed_without_verification(self):
        for flag in ('--pin', '--unpin', '--mute', '--unmute'):
            with self.subTest(flag=flag), contextlib.ExitStack() as stack:
                stack.enter_context(patch.object(sys, 'argv', ['imsg-read', flag, '+15551234567']))
                for name, value in [('ensure_messages', ''), ('accessibility', ''),
                                    ('chat_pinned', None), ('chat_muted', None),
                                    ('click_conversation_item', None), ('settle_flag', None)]:
                    stack.enter_context(patch.object(self.tool, name, return_value=value))
                stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
                with self.assertRaises(SystemExit) as caught:
                    self.tool.main()
                self.assertEqual(caught.exception.code, 75)

    def test_already_pinned_does_not_select_or_click(self):
        with patch.object(sys, 'argv', ['imsg-read', '--pin', '+15551234567']), \
                patch.object(self.tool, 'ensure_messages', return_value=''), \
                patch.object(self.tool, 'accessibility', return_value=''), \
                patch.object(self.tool, 'chat_pinned', return_value=True), \
                patch.object(self.tool, 'click_conversation_item') as click, \
                contextlib.redirect_stdout(io.StringIO()):
            self.tool.main()
        click.assert_not_called()

    def test_menu_action_restores_app_that_preceded_selection(self):
        events = []
        with patch.object(self.tool, 'frontmost', side_effect=lambda: events.append('capture') or 'Previous'), \
                patch.object(self.tool, 'select_chat', side_effect=lambda h: events.append('select') or ''), \
                patch.object(self.tool, 'wake_messages', return_value='Messages'), \
                patch.object(self.tool, 'click', return_value=(True, '')), \
                patch.object(self.tool, 'restore_front') as restore:
            self.tool.click_conversation_item('Pin', '+15551234567')
        self.assertEqual(events, ['capture', 'select'])
        restore.assert_called_once_with('Previous')



if __name__ == '__main__':
    unittest.main()
