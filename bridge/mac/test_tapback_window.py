#!/usr/bin/env python3
"""Reactions are searched for from the window's oldest message onward.

enrich() used to read every reaction in chat.db for every conversation load:
93 ms of a 100 ms load on a 282,650-message database. It now asks only for
reactions stamped no earlier than the window's oldest message minus a margin
(TAPBACK_SKEW_NS). The old query survives as `skew_ns=None`: it is the oracle
this file fuzzes the bounded one against. Synthetic rows only. Never opens the
user's Messages database.
"""
import json
import random
import sqlite3
import unittest
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path


def load_imsg():
    loader = SourceFileLoader("blip_tapback_window_test", str(Path(__file__).with_name("imsg")))
    module = module_from_spec(spec_from_loader(loader.name, loader))
    loader.exec_module(module)
    return module


DAY = 86400 * 10**9
T0 = 800_000_000_000_000_000  # a plausible Apple-ns stamp

SCHEMA = """
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY, guid TEXT, date INTEGER, is_from_me INTEGER DEFAULT 0,
      handle_id INTEGER DEFAULT 1, text TEXT, attributedBody BLOB, item_type INTEGER DEFAULT 0,
      associated_message_type INTEGER DEFAULT 0, associated_message_guid TEXT,
      associated_message_emoji TEXT, date_read INTEGER DEFAULT 0,
      balloon_bundle_id TEXT, payload_data BLOB, thread_originator_guid TEXT,
      expressive_send_style_id TEXT, is_audio_message INTEGER DEFAULT 0,
      service TEXT DEFAULT 'iMessage', is_delivered INTEGER DEFAULT 0, is_read INTEGER DEFAULT 0,
      error INTEGER DEFAULT 0);
    CREATE INDEX message_idx_date ON message(date);
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, transfer_name TEXT, mime_type TEXT,
      uti TEXT, total_bytes INTEGER, is_sticker INTEGER DEFAULT 0, sticker_user_info BLOB,
      attribution_info BLOB, emoji_image_short_description TEXT);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    CREATE TABLE chat_recoverable_message_join (message_id INTEGER);
    INSERT INTO handle VALUES (1, '+15551234567'), (2, '+15557654321');
"""


class Base(unittest.TestCase):
    def setUp(self):
        self.imsg = load_imsg()
        self.con = sqlite3.connect(":memory:")
        self.con.row_factory = sqlite3.Row
        self.con.executescript(SCHEMA)

    def tearDown(self):
        self.con.close()

    def add(self, guid, date, kind=0, target=None, mine=False, handle=1, emoji=None):
        return self.con.execute(
            """INSERT INTO message (guid, date, associated_message_type, associated_message_guid,
                                    is_from_me, handle_id, associated_message_emoji)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (guid, date, kind, target, int(mine), handle, emoji)).lastrowid

    def window(self, ids):
        marks = ",".join("?" for _ in ids)
        return list(self.con.execute(
            f"""SELECT m.*, associated_message_type AS assoc_type,
                       associated_message_guid AS assoc_guid, thread_originator_guid AS orig_guid,
                       expressive_send_style_id AS style_id FROM {self.imsg.MESSAGE_SRC} m
                WHERE ROWID IN ({marks}) ORDER BY date, ROWID""", ids))

    def both(self, ids):
        rows = self.window(ids)
        bounded = self.imsg.enrich(self.con, rows, False)
        oracle = self.imsg.enrich(self.con, rows, False, skew_ns=None)
        return bounded, oracle

    @staticmethod
    def shape(result):
        kept, extras = result
        return json.dumps({"kept": [r["ROWID"] for r in kept],
                           "extras": {str(k): v for k, v in sorted(extras.items())}}, sort_keys=True)


class BoundIsExact(Base):
    def test_random_databases_agree_with_the_unbounded_query(self):
        """1,200 seeded databases: reactions before, inside and after the window,
        every guid shape Messages writes, stickers, removals, two senders."""
        shapes = ("p:%d/%s", "bp:%s", "%s")
        for seed in range(1200):
            rnd = random.Random(seed)
            self.con.close()
            self.con = sqlite3.connect(":memory:")
            self.con.row_factory = sqlite3.Row
            self.con.executescript(SCHEMA)
            guids, dates = [], []
            for i in range(rnd.randint(3, 40)):
                g = f"G{seed:04d}-{i:03d}"
                d = T0 + rnd.randint(0, 900) * DAY + rnd.randint(0, DAY)
                self.add(g, d, mine=rnd.random() < 0.4, handle=rnd.choice((1, 2)))
                guids.append(g)
                dates.append(d)
            for _ in range(rnd.randint(0, 60)):
                i = rnd.randrange(len(guids))
                # clocks disagree: from 60 days BEFORE the target to 200 days after it
                when = dates[i] + rnd.randint(-60 * DAY, 200 * DAY)
                shape = rnd.choice(shapes)
                ref = shape % (rnd.randint(0, 12), guids[i]) if shape.startswith("p:") else shape % guids[i]
                kind = rnd.choice((2000, 2001, 2002, 2003, 2004, 2005, 2006, 3000, 3001, 3003, 2007, 3007, 1000))
                self.add(f"R{seed}-{rnd.random()}", when, kind=kind, target=ref, mine=rnd.random() < 0.4,
                         handle=rnd.choice((1, 2)), emoji="🙂" if kind % 1000 == 6 else None)
            # the window: a contiguous newest-N slice, or a random subset
            ordered = [r[0] for r in self.con.execute("SELECT ROWID FROM message ORDER BY date, ROWID")]
            window = ordered[-rnd.randint(1, len(ordered)):] if rnd.random() < 0.5 else \
                rnd.sample(ordered, rnd.randint(1, len(ordered)))
            bounded, oracle = self.both(window)
            self.assertEqual(self.shape(bounded), self.shape(oracle), f"seed {seed}")

    def test_a_reaction_stamped_before_its_target_is_still_found(self):
        """3 of 28,305 on a real chat.db, the worst 0.83 days early."""
        target = self.add("TARGET", T0)
        self.add("REACT", T0 - int(0.83 * DAY), kind=2001, target="p:0/TARGET", handle=2)
        bounded, oracle = self.both([target])
        self.assertEqual([t["emoji"] for t in bounded[1][target]["tapbacks"]], ["👍"])
        self.assertEqual(self.shape(bounded), self.shape(oracle))

    def test_the_margin_edge_is_inclusive(self):
        target = self.add("TARGET", T0)
        self.add("EDGE", T0 - self.imsg.TAPBACK_SKEW_NS, kind=2001, target="p:0/TARGET", handle=2)
        bounded, _ = self.both([target])
        self.assertEqual(len(bounded[1][target]["tapbacks"]), 1)

    def test_documented_limit_a_reaction_over_ninety_days_early_is_not_read(self):
        """The bound is a contract, not an accident: this fails if the margin changes."""
        self.assertEqual(self.imsg.TAPBACK_SKEW_NS, 90 * DAY)
        target = self.add("TARGET", T0)
        self.add("TOO-EARLY", T0 - 90 * DAY - 1, kind=2001, target="p:0/TARGET", handle=2)
        bounded, oracle = self.both([target])
        self.assertNotIn("tapbacks", bounded[1][target])
        self.assertEqual(len(oracle[1][target]["tapbacks"]), 1)

    def test_every_target_in_a_multi_year_window_still_gets_its_reactions(self):
        old = self.add("OLD", T0)
        new = self.add("NEW", T0 + 900 * DAY)
        self.add("R-OLD", T0 + DAY, kind=2000, target="p:0/OLD", handle=2)
        self.add("R-NEW", T0 + 901 * DAY, kind=2002, target="bp:NEW", handle=2)
        bounded, oracle = self.both([old, new])
        self.assertEqual(len(bounded[1][old]["tapbacks"]), 1)
        self.assertEqual(len(bounded[1][new]["tapbacks"]), 1)
        self.assertEqual(self.shape(bounded), self.shape(oracle))


class FloorFallsBackToTheFullScan(Base):
    def test_floor_is_the_oldest_usable_date_minus_the_margin(self):
        rows = [{"date": T0 + 5 * DAY}, {"date": T0}, {"date": T0 + DAY}]
        self.assertEqual(self.imsg._tapback_floor(rows), T0 - self.imsg.TAPBACK_SKEW_NS)

    def test_nothing_usable_means_no_bound(self):
        f = self.imsg._tapback_floor
        self.assertIsNone(f([]))
        self.assertIsNone(f([{}]))                         # a projected row without `date`
        self.assertIsNone(f([{"date": 0}, {"date": None}, {"date": -5}]))
        self.assertIsNone(f([{"date": "800000000000000000"}, {"date": True}, {"date": 1.5}]))
        self.assertIsNone(f([{"date": T0}], skew_ns=None))  # the explicit opt-out

    def test_junk_dates_do_not_drag_the_floor_down(self):
        rows = [{"date": T0}, {"date": None}, {"date": 0}, {"date": -1}]
        self.assertEqual(self.imsg._tapback_floor(rows), T0 - self.imsg.TAPBACK_SKEW_NS)


class UsesTheDateIndex(Base):
    def test_the_bounded_query_searches_message_idx_date_instead_of_scanning(self):
        """Plan check: a refactor that hides `m.date` from the planner would
        quietly bring back the 93 ms scan and still pass every other test."""
        target = self.add("TARGET", T0)
        for i in range(50):
            self.add(f"FILLER{i}", T0 - (i + 1) * 200 * DAY)
        self.add("REACT", T0 + DAY, kind=2001, target="p:0/TARGET", handle=2)
        seen = []
        self.con.set_trace_callback(lambda sql: seen.append(sql))
        self.imsg.enrich(self.con, self.window([target]), False)
        self.con.set_trace_callback(None)
        query = next(s for s in seen if "associated_message_type = 1000" in s and "m.date >=" in s)
        plan = " ".join(str(r[3]) for r in self.con.execute("EXPLAIN QUERY PLAN " + query))
        self.assertIn("message_idx_date", plan)
        self.assertNotRegex(plan, r"SCAN (message|m)\b(?! USING)")

    def test_the_unbounded_oracle_still_reads_everything(self):
        target = self.add("TARGET", T0)
        self.add("FAR", T0 - 400 * DAY, kind=2001, target="p:0/TARGET", handle=2)
        seen = []
        self.con.set_trace_callback(lambda sql: seen.append(sql))
        self.imsg.enrich(self.con, self.window([target]), False, skew_ns=None)
        self.con.set_trace_callback(None)
        self.assertFalse(any("m.date >=" in s for s in seen))


if __name__ == "__main__":
    unittest.main(verbosity=1)
