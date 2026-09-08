#!/usr/bin/env python3
"""Stamps cross the bridge as UTC.

The naive Mac-local wall clock they used to carry was only comparable to the
Linux side's clock while both machines sat in one timezone, and stopped being
ordered at all during the DST fall-back hour. `fmt_ts` is the wire; the plain
text renders keep `fmt_ts_local`, because a person reading `imsg recent` wants
the time they remember."""
from __future__ import annotations

import datetime as dt
import os
import sys
import time
import unittest
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path

HERE = Path(__file__).parent


def load(tool: str):
    loader = SourceFileLoader(f"blip_{tool}", str(HERE / tool))
    spec = spec_from_loader(loader.name, loader)
    assert spec is not None
    mod = module_from_spec(spec)
    sys.modules[loader.name] = mod
    loader.exec_module(mod)
    return mod


imsg = load("imsg")
APPLE_EPOCH = 978307200


def apple_ns(*, year, month, day, hour=0, minute=0, second=0) -> int:
    """Apple's nanoseconds-since-2001 for a UTC instant."""
    when = dt.datetime(year, month, day, hour, minute, second, tzinfo=dt.timezone.utc)
    return int((when.timestamp() - APPLE_EPOCH) * 1e9)


class InZone:
    """Run a block with the process in `zone` — fmt_ts must not care."""

    def __init__(self, zone: str) -> None:
        self.zone = zone

    def __enter__(self):
        self.prev = os.environ.get("TZ")
        os.environ["TZ"] = self.zone
        time.tzset()
        return self

    def __exit__(self, *exc):
        if self.prev is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = self.prev
        time.tzset()
        return False


class WireFormat(unittest.TestCase):
    def test_utc_regardless_of_the_macs_timezone(self):
        ns = apple_ns(year=2026, month=9, day=7, hour=18, minute=33, second=12)
        for zone in ("UTC", "America/New_York", "Asia/Tokyo", "Australia/Adelaide"):
            with InZone(zone):
                self.assertEqual(imsg.fmt_ts(ns), "2026-09-07T18:33:12Z")

    def test_human_render_follows_the_macs_clock(self):
        ns = apple_ns(year=2026, month=9, day=7, hour=18, minute=33, second=12)
        with InZone("America/New_York"):
            self.assertEqual(imsg.fmt_ts_local(ns), "2026-09-07 14:33:12")
        with InZone("UTC"):
            self.assertEqual(imsg.fmt_ts_local(ns), "2026-09-07 18:33:12")

    def test_sorts_lexicographically_in_time_order(self):
        earlier = imsg.fmt_ts(apple_ns(year=2026, month=9, day=7, hour=23, minute=59))
        later = imsg.fmt_ts(apple_ns(year=2026, month=9, day=8, hour=0, minute=1))
        self.assertLess(earlier, later)

    def test_the_dst_fall_back_hour_stays_ordered(self):
        # America/New_York, 2026-11-01: 01:00-01:59 runs twice, EDT then EST.
        edt = apple_ns(year=2026, month=11, day=1, hour=5)   # 01:00 EDT
        est = apple_ns(year=2026, month=11, day=1, hour=6)   # 01:00 EST, an hour later
        with InZone("America/New_York"):
            # The wall clock cannot tell these apart — the whole reason the
            # wire is UTC. Every client orders messages by comparing stamps.
            self.assertEqual(imsg.fmt_ts_local(edt), imsg.fmt_ts_local(est))
            self.assertLess(imsg.fmt_ts(edt), imsg.fmt_ts(est))

    def test_missing_date_is_still_a_question_mark(self):
        for empty in (0, None):
            self.assertEqual(imsg.fmt_ts(empty), "?")
            self.assertEqual(imsg.fmt_ts_local(empty), "?")


if __name__ == "__main__":
    unittest.main(verbosity=2)
