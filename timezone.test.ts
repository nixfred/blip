/**
 * The UTC wire format, and the local-time display built on it.
 *
 * The rest of the suite runs pinned to UTC (test-setup.ts), where local time
 * and wire time are the same string and every bug this file is about is
 * invisible. So these tests move the clock themselves: a Mac and a Linux box
 * in different zones, and the DST fall-back hour in which a naive wall clock
 * stops being ordered at all.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { isUnread, loadState, nowTs, normalizeMsgStamps, saveState, toUtcStamp, type ImsgMessage } from "./collector";
import { dayLabel, clockLabel, decorate, localDay, minutesBetween, stampMs } from "./thread";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => { process.env.TZ = ORIGINAL_TZ; });

/** Run body with the process clock in `zone`. */
function inZone<T>(zone: string, body: () => T): T {
  process.env.TZ = zone;
  try { return body(); } finally { process.env.TZ = ORIGINAL_TZ; }
}

const msg = (over: Partial<ImsgMessage>): ImsgMessage => ({
  id: 1, ts: "2026-08-30T10:00:00Z", from_me: false, handle: "+15551234567", name: "A",
  service: "iMessage", chat: "+15551234567", text: "hi", read: false, ...over,
} as ImsgMessage);

describe("the wire is UTC, the labels are local", () => {
  test("one instant renders in each reader's own clock", () => {
    const ts = "2026-09-07T18:33:12Z";
    expect(inZone("UTC", () => clockLabel(ts))).toBe("6:33 PM");
    expect(inZone("America/New_York", () => clockLabel(ts))).toBe("2:33 PM");
    expect(inZone("Asia/Tokyo", () => clockLabel(ts))).toBe("3:33 AM");
  });

  test("the day divider breaks at the READER's midnight, not UTC's", () => {
    // 2026-08-31 02:00 UTC is still the evening of the 30th in New York.
    const ts = "2026-08-31T02:00:00Z";
    expect(inZone("UTC", () => localDay(ts))).toBe("2026-08-31");
    expect(inZone("America/New_York", () => localDay(ts))).toBe("2026-08-30");
    // …so on a New York reader's 30th the same message is "Today", while a
    // UTC reader is still on the 30th and it is already dated the 31st.
    expect(inZone("America/New_York", () => dayLabel(ts, "2026-08-30"))).toBe("Today");
    expect(inZone("UTC", () => dayLabel(ts, "2026-08-30"))).toBe("Aug 31");
  });

  test("a bare date is the local calendar day, never UTC midnight", () => {
    // Date.parse("2026-08-30") is UTC midnight by the ISO rule — which is the
    // 29th anywhere west of Greenwich. localToday() hands dayLabel() bare dates.
    expect(inZone("America/New_York", () => localDay("2026-08-30"))).toBe("2026-08-30");
  });
});

describe("the DST fall-back hour", () => {
  // 2026-11-01 in America/New_York: 01:00-01:59 happens twice, EDT then EST.
  const edt = "2026-11-01T05:00:00Z";   // 01:00 EDT — first
  const est = "2026-11-01T06:00:00Z";   // 01:00 EST — an hour later

  test("both instants wear the same local clock face", () => {
    // This is exactly why a naive wall clock cannot be the wire format: as
    // strings these two were EQUAL, an hour apart.
    inZone("America/New_York", () => {
      expect(clockLabel(edt)).toBe("1:00 AM");
      expect(clockLabel(est)).toBe("1:00 AM");
    });
  });

  test("UTC keeps them ordered and an hour apart", () => {
    expect(edt < est).toBe(true);                  // the comparison every ledger makes
    expect(minutesBetween(edt, est)).toBe(60);
    expect(stampMs(est) - stampMs(edt)).toBe(3600_000);
  });

  test("a run breaks across the repeated hour instead of merging", () => {
    // 60 minutes > GROUP_GAP_MINUTES, so these are two runs. On naive stamps
    // the gap read as 0 and they merged into one.
    const bubbles = inZone("America/New_York", () =>
      decorate([msg({ id: 1, ts: edt }), msg({ id: 2, ts: est })], "2026-11-01"));
    expect(bubbles.map((b) => b.groupStart)).toEqual([true, true]);
  });
});

describe("read marks survive a Mac in another timezone", () => {
  test("a message that just arrived is unread whatever either clock reads", () => {
    // The mark is this machine's clock; the stamp is the Mac's. Both UTC now,
    // so the comparison holds in every zone — it did not when each side wrote
    // its own wall clock.
    for (const zone of ["UTC", "America/New_York", "Asia/Tokyo", "Pacific/Kiritimati"]) {
      inZone(zone, () => {
        const mark = nowTs(new Date(Date.now() - 60_000));      // read a minute ago
        const arriving = msg({ ts: nowTs(), read: false });
        expect(isUnread(arriving, mark)).toBe(true);
      });
    }
  });

  test("a mark taken now covers a message from a moment ago, in every zone", () => {
    for (const zone of ["UTC", "America/New_York", "Asia/Tokyo"]) {
      inZone(zone, () => {
        const earlier = msg({ ts: nowTs(new Date(Date.now() - 60_000)) });
        expect(isUnread(earlier, nowTs())).toBe(false);
      });
    }
  });
});

describe("upgrading from the pre-UTC format", () => {
  test("a naive stamp is re-anchored through this machine's offset", () => {
    // 14:33 in New York IS 18:33 UTC.
    expect(inZone("America/New_York", () => toUtcStamp("2026-09-07 14:33:12")))
      .toBe("2026-09-07T18:33:12Z");
    // Already-wire stamps pass through untouched; junk becomes "".
    expect(toUtcStamp("2026-09-07T18:33:12Z")).toBe("2026-09-07T18:33:12Z");
    expect(toUtcStamp("x")).toBe("");
    expect(toUtcStamp("")).toBe("");
  });

  test("state.json written by an older release loads as UTC", () => {
    const p = join(mkdtempSync(join(tmpdir(), "blip-tz-")), "state.json");
    writeFileSync(p, JSON.stringify({
      watermark: "2026-09-07 14:33:12",
      readMark: "2026-09-07 14:00:00",
      readMarks: { A: "2026-09-07 13:00:00" },
      unreadCounts: { A: 1 },
      unreadOldest: { A: "2026-09-07 13:30:00" },
      unreadInitialized: true,
    }));
    const state = inZone("America/New_York", () => loadState(p));
    expect(state.watermark).toBe("2026-09-07T18:33:12Z");
    expect(state.readMark).toBe("2026-09-07T18:00:00Z");
    expect(state.readMarks.A).toBe("2026-09-07T17:00:00Z");
    expect(state.unreadOldest.A).toBe("2026-09-07T17:30:00Z");
  });

  test("a Mac still on the old bridge has its stamps normalised at the door", () => {
    // Marks migrate on load; if the bridge kept emitting naive stamps and
    // nothing normalised them, EVERY message would sort below EVERY mark
    // (" " < "T") and the badge would silently go quiet.
    const legacy = msg({ ts: "2026-09-07 14:33:12", read_at: "2026-09-07 14:35:00" } as Partial<ImsgMessage>);
    const fixed = inZone("America/New_York", () => normalizeMsgStamps(legacy));
    expect(fixed.ts).toBe("2026-09-07T18:33:12Z");
    expect(fixed.read_at).toBe("2026-09-07T18:35:00Z");

    const mark = inZone("America/New_York", () => toUtcStamp("2026-09-07 14:00:00"));
    expect(isUnread(fixed, mark)).toBe(true);       // newer than the mark, as it should be
  });

  test("normalising leaves a wire-format message untouched", () => {
    const m = msg({ ts: "2026-09-07T18:33:12Z" });
    expect(normalizeMsgStamps(m)).toBe(m);          // same object: no needless copy
  });
});

describe("state round-trips in the wire format", () => {
  test("marks saved and reloaded are unchanged", () => {
    const p = join(mkdtempSync(join(tmpdir(), "blip-tz-")), "state.json");
    const watermark = nowTs();
    saveState({
      watermark, readMark: watermark, unreadCounts: {}, unreadOldest: {},
      unreadInitialized: true, selfChats: [], readMarks: {}, groups: {},
      chatAliases: {}, pins: {}, toasted: [],
    }, p);
    expect(inZone("Asia/Tokyo", () => loadState(p).watermark)).toBe(watermark);
  });
});
