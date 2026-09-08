import { describe, expect, test } from "bun:test";

import type { ImsgMessage } from "./collector";
import type { Formats } from "./thread";
import {
  clockLabel,
  dayLabel,
  decorate,
  dedupeSelfEcho,
  DEFAULT_FORMATS,
  formatStamp,
  formatsFromArgv,
  loadThread,
  localToday,
  minutesBetween,
  parsePendingSends,
  pendingBubble,
  receiptLabel,
  selectThread,
  withPendingSends,
} from "./thread";
import type { Bubble, PendingSend } from "./thread";
import { cliChatArg } from "./thread";

function msg(over: Partial<ImsgMessage> = {}): ImsgMessage {
  return {
    ts: "2026-08-30T12:00:00Z",
    from_me: false,
    handle: "+15551234567",
    name: "Test Person",
    service: "iMessage",
    chat: "+15551234567",
    text: "hello",
    ...over,
  };
}

const DOTTED: Formats = { time: "HH:mm", date: "dd.MM", dateWithYear: "dd.MM.yyyy" };

describe("formatStamp", () => {
  const ts = "2026-08-30T21:08:22Z"; // a Sunday

  test.each([
    ["HH:mm", "21:08"],
    ["h:mm AP", "9:08 PM"],
    ["hh:mm ap", "09:08 pm"],
    ["h:mm A", "9:08 PM"],
    ["h", "21"],                       // no AM/PM token → h is 24-hour, as in Qt
    ["H:m:s", "21:8:22"],
    ["dd.MM", "30.08"],
    ["dd.MM.yyyy", "30.08.2026"],
    ["d/M/yy", "30/8/26"],
    ["MMM d, yyyy", "Aug 30, 2026"],
    ["d MMMM yyyy", "30 August 2026"],
    ["ddd d MMM", "Sun 30 Aug"],
    ["dddd", "Sunday"],
    ["h 'o''clock'", "21 o'clock"],    // quoted literals, '' is a quote
    ["'at' h:mm ap", "at 9:08 pm"],    // an 'a' inside quotes is not a token
    ["yyyy-MM-dd'T'HH:mm", "2026-08-30T21:08"],
    ["ww", "ww"],                      // unknown letters pass through
  ])("%s → %s", (pattern, expected) => {
    expect(formatStamp(ts, pattern)).toBe(expected);
  });

  test("midnight and noon on a 12-hour clock", () => {
    expect(formatStamp("2026-08-30T00:30:00Z", "h:mm AP")).toBe("12:30 AM");
    expect(formatStamp("2026-08-30T12:00:00Z", "h:mm AP")).toBe("12:00 PM");
  });

  test("a date-only stamp formats at midnight", () => {
    expect(formatStamp("2026-08-30", "dd.MM HH:mm")).toBe("30.08 00:00");
  });

  test("malformed input formats to nothing, not a crash", () => {
    expect(formatStamp("nonsense", "HH:mm")).toBe("");
    expect(formatStamp("", "HH:mm")).toBe("");
  });
});

describe("formatsFromArgv", () => {
  test("reads the three flags", () => {
    const f = formatsFromArgv(["bun", "thread.ts", "+15550100002", "80",
      "--time-format", "HH:mm", "--date-format", "dd.MM", "--date-format-with-year", "dd.MM.yyyy"]);
    expect(f).toEqual(DOTTED);
  });

  test("unset or empty keeps the default", () => {
    expect(formatsFromArgv(["bun", "thread.ts", "+15550100002", "80"])).toEqual(DEFAULT_FORMATS);
    expect(formatsFromArgv(["--time-format", "", "--date-format"])).toEqual(DEFAULT_FORMATS);
  });
});

describe("clockLabel", () => {
  test("formats afternoon as 12-hour with PM", () => {
    expect(clockLabel("2026-08-30T21:08:22Z")).toBe("9:08 PM");
  });

  test("formats morning as AM", () => {
    expect(clockLabel("2026-08-30T09:05:00Z")).toBe("9:05 AM");
  });

  test("midnight is 12 AM, not 0 AM", () => {
    expect(clockLabel("2026-08-30T00:30:00Z")).toBe("12:30 AM");
  });

  test("noon is 12 PM, not 0 PM", () => {
    expect(clockLabel("2026-08-30T12:00:00Z")).toBe("12:00 PM");
  });

  test("follows the time pattern it is given", () => {
    expect(clockLabel("2026-08-30T21:08:22Z", "HH:mm")).toBe("21:08");
  });

  test("garbage in yields an empty label, not a crash", () => {
    expect(clockLabel("nonsense")).toBe("");
  });
});

describe("dayLabel", () => {
  const today = "2026-08-30";

  test("same date reads Today", () => {
    expect(dayLabel("2026-08-30T09:00:00Z", today)).toBe("Today");
  });

  test("one day back reads Yesterday", () => {
    expect(dayLabel("2026-08-29T09:00:00Z", today)).toBe("Yesterday");
  });

  test("earlier this year omits the year", () => {
    expect(dayLabel("2026-08-28T09:00:00Z", today)).toBe("Aug 28");
  });

  test("a previous year includes it", () => {
    expect(dayLabel("2025-12-24T09:00:00Z", today)).toBe("Dec 24, 2025");
  });

  test("dates follow the patterns, Today and Yesterday stay words", () => {
    expect(dayLabel("2026-08-30T09:00:00Z", today, DOTTED)).toBe("Today");
    expect(dayLabel("2026-08-29T09:00:00Z", today, DOTTED)).toBe("Yesterday");
    expect(dayLabel("2026-08-28T09:00:00Z", today, DOTTED)).toBe("28.08");
    expect(dayLabel("2025-12-24T09:00:00Z", today, DOTTED)).toBe("24.12.2025");
  });

  test("crossing a month boundary still resolves Yesterday", () => {
    expect(dayLabel("2026-07-31T09:00:00Z", "2026-08-01")).toBe("Yesterday");
  });

  test("malformed input yields an empty label", () => {
    expect(dayLabel("not-a-date", today)).toBe("");
  });
});

describe("minutesBetween", () => {
  test("measures a simple gap", () => {
    expect(minutesBetween("2026-08-30T12:00:00Z", "2026-08-30T12:20:00Z")).toBe(20);
  });

  test("is order-independent", () => {
    expect(minutesBetween("2026-08-30T12:20:00Z", "2026-08-30T12:00:00Z")).toBe(20);
  });

  test("unparseable stamps read as infinitely far apart, forcing a new group", () => {
    expect(minutesBetween("junk", "2026-08-30T12:00:00Z")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("decorate", () => {
  const today = "2026-08-30";

  test("a lone message is both group start and end", () => {
    const b = decorate([msg({ ts: "2026-08-30T12:00:00Z" })], today);
    expect(b[0]!.groupStart).toBe(true);
    expect(b[0]!.groupEnd).toBe(true);
    expect(b[0]!.time).toBe("12:00 PM");
  });

  test("the patterns reach the divider, the timestamp and the read receipt", () => {
    const b = decorate(
      [msg({ ts: "2026-08-28T16:42:00Z", from_me: true, read_at: "2026-08-28T16:45:00Z" })],
      today,
      DOTTED,
    );
    expect(b[0]!.day).toBe("28.08");
    expect(b[0]!.time).toBe("16:42");
    expect(b[0]!.receipt).toBe("Read 28.08 16:45");
  });

  test("consecutive messages from one sender form a single group", () => {
    const b = decorate(
      [
        msg({ ts: "2026-08-30T12:00:00Z", text: "one" }),
        msg({ ts: "2026-08-30T12:01:00Z", text: "two" }),
        msg({ ts: "2026-08-30T12:02:00Z", text: "three" }),
      ],
      today,
    );
    expect(b.map((x) => x.groupStart)).toEqual([true, false, false]);
    expect(b.map((x) => x.groupEnd)).toEqual([false, false, true]);
  });

  test("only the last bubble of a group carries a timestamp", () => {
    const b = decorate(
      [msg({ ts: "2026-08-30T12:00:00Z" }), msg({ ts: "2026-08-30T12:01:00Z" })],
      today,
    );
    expect(b[0]!.time).toBe("");
    expect(b[1]!.time).toBe("12:01 PM");
  });

  test("a sender change breaks the group", () => {
    const b = decorate(
      [
        msg({ ts: "2026-08-30T12:00:00Z", from_me: false }),
        msg({ ts: "2026-08-30T12:01:00Z", from_me: true }),
      ],
      today,
    );
    expect(b[0]!.groupEnd).toBe(true);
    expect(b[1]!.groupStart).toBe(true);
  });

  test("in a group, a different member breaks the run even seconds apart", () => {
    const b = decorate(
      [
        msg({ ts: "2026-08-30T12:00:00Z", handle: "+1111111111", name: "Jordan" }),
        msg({ ts: "2026-08-30T12:00:30Z", handle: "+2222222222", name: "Casey" }),
      ],
      today,
    );
    expect(b[0]!.groupEnd).toBe(true);
    expect(b[1]!.groupStart).toBe(true);
  });

  test("a gap longer than 15 minutes breaks the group", () => {
    const b = decorate(
      [msg({ ts: "2026-08-30T12:00:00Z" }), msg({ ts: "2026-08-30T12:20:00Z" })],
      today,
    );
    expect(b[1]!.groupStart).toBe(true);
  });

  test("a gap under 15 minutes does not", () => {
    const b = decorate(
      [msg({ ts: "2026-08-30T12:00:00Z" }), msg({ ts: "2026-08-30T12:14:00Z" })],
      today,
    );
    expect(b[1]!.groupStart).toBe(false);
  });

  test("the day label appears once, on the first message of that day", () => {
    const b = decorate(
      [
        msg({ ts: "2026-08-29T23:00:00Z" }),
        msg({ ts: "2026-08-30T09:00:00Z" }),
        msg({ ts: "2026-08-30T09:01:00Z" }),
      ],
      today,
    );
    expect(b[0]!.day).toBe("Yesterday");
    expect(b[1]!.day).toBe("Today");
    expect(b[2]!.day).toBe("");
  });

  test("a day change always starts a new group even within 15 minutes", () => {
    const b = decorate(
      [msg({ ts: "2026-08-29T23:59:00Z" }), msg({ ts: "2026-08-30T00:01:00Z" })],
      today,
    );
    expect(b[1]!.groupStart).toBe(true);
    expect(b[0]!.groupEnd).toBe(true);
  });

  test("falls back to the handle when a message has no contact name", () => {
    const b = decorate([msg({ name: null, handle: "+15551234567" })], today);
    expect(b[0]!.name).toBe("+15551234567");
  });

  test("an empty thread decorates to nothing", () => {
    expect(decorate([], today)).toEqual([]);
  });
});

describe("dedupeSelfEcho", () => {
  test("drops the empty from_me twin the self-thread produces", () => {
    // A real send logs twice: from_me=true with empty text, and from_me=false
    // carrying the text. Rendering both shows your own message as theirs.
    const out = dedupeSelfEcho([
      msg({ ts: "2026-08-30T21:08:22Z", from_me: true, text: "" }),
      msg({ ts: "2026-08-30T21:08:22Z", from_me: false, text: "Larry test" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("Larry test");
  });

  test("the surviving twin is re-attributed to me — it renders on the right", () => {
    const out = dedupeSelfEcho([
      msg({ ts: "2026-08-30T21:08:22Z", from_me: true, text: "" }),
      msg({ ts: "2026-08-30T21:08:22Z", from_me: false, text: "mine" }),
    ]);
    expect(out[0]!.from_me).toBe(true);
  });

  test("a text-bearing pair is mine whichever twin arrives first", () => {
    // imsg decodes attributedBody, so the from_me=true twin has text too.
    const self = msg().chat;
    const a = dedupeSelfEcho([
      msg({ ts: "2026-08-30T21:08:22Z", from_me: false, text: "same" }),
      msg({ ts: "2026-08-30T21:08:22Z", from_me: true, text: "same" }),
    ], [self]);
    expect(a).toHaveLength(1);
    expect(a[0]!.from_me).toBe(true);
    const b = dedupeSelfEcho([
      msg({ ts: "2026-08-30T21:08:22Z", from_me: true, text: "same" }),
      msg({ ts: "2026-08-30T21:08:22Z", from_me: false, text: "same" }),
    ], [self]);
    expect(b[0]!.from_me).toBe(true);
  });

  test("an unsent message keeps its tombstone: the retracted twin wins, the echo goes", () => {
    // Undo Send in the self-thread withdraws only the sent copy; the echo still
    // carries the text. Same shape as the echo case, opposite truth.
    const self = msg().chat;
    const out = dedupeSelfEcho([
      msg({ ts: "2026-08-30T21:08:22Z", from_me: true, text: "", retracted: true }),
      msg({ ts: "2026-08-30T21:08:22Z", from_me: false, text: "taken back" }),
    ], [self]);
    expect(out).toHaveLength(1);
    expect(out[0]!.retracted).toBe(true);
    expect(out[0]!.from_me).toBe(true);
    expect(out[0]!.text).toBe("");
  });

  test("a genuine inbound with no empty twin stays theirs", () => {
    const out = dedupeSelfEcho([msg({ ts: "2026-08-30T21:08:22Z", from_me: false, text: "theirs" })]);
    expect(out[0]!.from_me).toBe(false);
  });

  test("keeps legitimate same-direction duplicates at the same timestamp", () => {
    const out = dedupeSelfEcho([
      msg({ ts: "2026-08-30T21:08:22Z", text: "same" }),
      msg({ ts: "2026-08-30T21:08:22Z", text: "same" }),
    ]);
    expect(out).toHaveLength(2);
  });

  test("keeps identical text sent at different times", () => {
    const out = dedupeSelfEcho([
      msg({ ts: "2026-08-30T21:08:22Z", text: "ok" }),
      msg({ ts: "2026-08-30T21:09:00Z", text: "ok" }),
    ]);
    expect(out).toHaveLength(2);
  });

  test("leaves an ordinary conversation untouched", () => {
    const out = dedupeSelfEcho([
      msg({ ts: "2026-08-30T12:00:00Z", text: "hi" }),
      msg({ ts: "2026-08-30T12:01:00Z", from_me: true, text: "hey" }),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe("loadThread", () => {
  const fake = (r: { status: number; stdout?: string; stderr?: string }) =>
    (() => ({ status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" })) as never;

  test("returns decorated bubbles on success", () => {
    const r = loadThread(
      "+15551234567",
      10,
      "2026-08-30",
      DEFAULT_FORMATS,
      fake({ status: 0, stdout: JSON.stringify([msg({ ts: "2026-08-30T12:00:00Z" })]) }),
    );
    expect(r.ok).toBe(true);
    expect(r.bubbles).toHaveLength(1);
    expect(r.bubbles[0]!.time).toBe("12:00 PM");
  });

  test("exit 69 reports the bridge offline", () => {
    const r = loadThread("+1", 10, "2026-08-30", DEFAULT_FORMATS, fake({ status: 69 }));
    expect(r.ok).toBe(false);
    expect(r.online).toBe(false);
    expect(r.error).toBe("Mac unreachable");
  });

  test("malformed stdout is reported, not thrown", () => {
    const r = loadThread("+1", 10, "2026-08-30", DEFAULT_FORMATS, fake({ status: 0, stdout: "junk" }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("bad JSON");
  });

  test("a non-zero exit surfaces the first stderr line", () => {
    const r = loadThread("+1", 10, "2026-08-30", DEFAULT_FORMATS, fake({ status: 2, stderr: "nope\nmore" }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("nope");
  });
});

describe("localToday", () => {
  test("uses the local calendar date, not UTC", () => {
    // 2026-08-30 23:30 local — toISOString() would already say the 31st in EDT.
    expect(localToday(new Date(2026, 7, 30, 23, 30))).toBe("2026-08-30");
  });

  test("zero-pads month and day", () => {
    expect(localToday(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("selectThread", () => {
  const guid = "ce5a593a78af408282d61461ade89135";
  test("a group filters a mixed recent window down to its own chat, oldest-first", () => {
    const out = selectThread(
      [
        msg({ chat: guid, ts: "2026-08-30T12:05:00Z", text: "late" }),
        msg({ chat: "+15550000000", ts: "2026-08-30T12:04:00Z", text: "other chat" }),
        msg({ chat: guid, ts: "2026-08-30T12:00:00Z", text: "early" }),
      ],
      guid, true, 80,
    );
    expect(out.map((m) => m.text)).toEqual(["early", "late"]);
  });

  test("a re-keyed group keeps its alias rows' history (Astra #8)", () => {
    // `thread --chat` on the Mac already expands to the whole cluster; the
    // alias rows arrive with their OWN chat ids. Filtering on the requested id
    // threw them away: 9 rows from the Mac, 6 bubbles here.
    const alias = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const out = selectThread(
      [
        msg({ chat: guid, ts: "2026-08-30T12:05:00Z", text: "new row" }),
        msg({ chat: alias, ts: "2026-08-30T12:00:00Z", text: "old row, before the re-key" }),
        msg({ chat: "+15550000000", ts: "2026-08-30T12:04:00Z", text: "a DM, never" }),
      ],
      guid, true, 80,
    );
    expect(out.map((m) => m.text)).toEqual(["old row, before the re-key", "new row"]);
  });

  test("keeps only the newest `limit` messages", () => {
    const raw = Array.from({ length: 5 }, (_, i) => msg({ chat: guid, ts: `2026-08-30T12:0${i}:00Z`, text: `m${i}` }));
    expect(selectThread(raw, guid, true, 2).map((m) => m.text)).toEqual(["m3", "m4"]);
  });

  test("a DM drops rows whose handle merely contains the queried digits", () => {
    // `imsg thread` matches by substring; another handle with the same tail
    // must not leak into this conversation (Codex finding #3).
    const out = selectThread(
      [
        msg({ chat: "+15551234567", handle: "+15551234567", text: "mine" }),
        msg({ chat: "+995551234567", handle: "+995551234567", text: "someone else" }),
      ],
      "+15551234567", false, 80,
    );
    expect(out.map((m) => m.text)).toEqual(["mine"]);
  });

  test("a DM window passes through untouched apart from ordering", () => {
    const out = selectThread([msg({ ts: "2026-08-30T12:01:00Z" }), msg({ ts: "2026-08-30T12:00:00Z" })], "+15551234567", false, 80);
    expect(out[0]!.ts).toBe("2026-08-30T12:00:00Z");
  });

  test("a merged DM keeps rows from every alias handle, in either direction", () => {
    const phone = "+15550100001";
    const email = "pat@example.com";
    const raw = [
      msg({ chat: phone, handle: phone, ts: "2026-09-04T21:32:29Z", text: "sms" }),
      msg({ chat: email, handle: email, ts: "2026-09-05T17:24:01Z", text: "imessage" }),
      msg({ chat: "+15550100002", handle: "+15550100002", ts: "2026-09-05T18:00:00Z", text: "other" }),
    ];
    const aliases = { [phone]: email };
    expect(selectThread(raw, email, false, 80, [], aliases).map((m) => m.text))
      .toEqual(["sms", "imessage"]);
    expect(selectThread(raw, phone, false, 80, [], aliases).map((m) => m.text))
      .toEqual(["sms", "imessage"]);
  });

  test("loadThread loads a group by EXACT chat id via thread --chat", () => {
    let seen: string[] = [];
    const runner = ((_: string, args: string[]) => { seen = args; return { status: 0, stdout: "[]", stderr: "" }; }) as never;
    loadThread(guid, 80, "2026-08-30", DEFAULT_FORMATS, runner);
    expect(seen).toContain("--rich");
    expect(seen).toContain("--chat");
    expect(seen[seen.indexOf("--chat") + 1]).toBe(guid);
  });
});

describe("linkify", () => {
  const { linkify } = require("./thread") as typeof import("./thread");

  test("no URL → empty string (PlainText fast path)", () => {
    expect(linkify("just words")).toBe("");
    expect(linkify("")).toBe("");
  });

  test("URLs become anchors; surrounding text is escaped", () => {
    expect(linkify("see https://nixfred.com now")).toBe(
      'see <a href="https://nixfred.com">https://nixfred.com</a> now',
    );
    expect(linkify("go to www.edgeupbarber.com!")).toBe(
      'go to <a href="https://www.edgeupbarber.com">www.edgeupbarber.com</a>!',
    );
  });

  test("trailing sentence punctuation stays prose", () => {
    expect(linkify("https://x.com/a.")).toBe('<a href="https://x.com/a">https://x.com/a</a>.');
  });

  test("hostile markup in messages is neutralized", () => {
    expect(linkify('<img src=x onerror=alert(1)> https://a.io')).toBe(
      '&lt;img src=x onerror=alert(1)&gt; <a href="https://a.io">https://a.io</a>',
    );
    // quotes/brackets can never be part of the matched URL — the hostile
    // tail is plain escaped text, outside the anchor entirely
    expect(linkify('https://a.io/"><script>')).toBe(
      '<a href="https://a.io/">https://a.io/</a>&quot;&gt;&lt;script&gt;',
    );
  });

  test("newlines become <br> in the rich path", () => {
    expect(linkify("https://a.io\nline2")).toBe('<a href="https://a.io">https://a.io</a><br>line2');
  });
});

describe("rich decoration", () => {
  const today = "2026-08-31";

  test("receipt lands only on the NEWEST read from-me bubble", () => {
    const out = decorate(
      [
        msg({ ts: "2026-08-31T10:00:00Z", from_me: true, read_at: "2026-08-31T10:00:30Z" }),
        msg({ ts: "2026-08-31T10:05:00Z", from_me: false }),
        msg({ ts: "2026-08-31T10:06:00Z", from_me: true, read_at: "2026-08-31T10:07:12Z" }),
        msg({ ts: "2026-08-31T10:08:00Z", from_me: true }), // sent, not yet read
      ],
      today,
    );
    expect(out.map((b) => b.receipt)).toEqual(["", "", "Read 10:07 AM", ""]);
  });

  test("receipt from an earlier day carries the day label", () => {
    expect(receiptLabel("2026-08-30T21:03:00Z", today)).toBe("Read Yesterday 9:03 PM");
    expect(receiptLabel("2026-08-31T16:42:00Z", today)).toBe("Read 4:42 PM");
  });

  test("link-preview payload pseudo-attachments are filtered out", () => {
    const out = decorate(
      [msg({
        text: "Edgeupbarber.com",
        attachments: [
          { name: "D8149C0E.pluginPayloadAttachment", mime: null, bytes: 29909 },
          { name: "real.pdf", mime: "application/pdf", bytes: 5 },
        ],
      })],
      today,
    );
    expect(out[0]!.attachments.map((a) => a.name)).toEqual(["real.pdf"]);
  });

  test("attachment placeholder char is stripped, chips pass through", () => {
    const out = decorate(
      [msg({ text: "￼", attachments: [{ name: "IMG_1.png", mime: "image/png", bytes: 5 }] })],
      today,
    );
    expect(out[0]!.text).toBe("");
    expect(out[0]!.attachments).toEqual([{ name: "IMG_1.png", mime: "image/png", bytes: 5 }]);
  });

  test("tapbacks, reply context, edited, retracted, effect all pass through", () => {
    const out = decorate(
      [
        msg({
          tapbacks: [{ emoji: "❤️", from_me: false, by: "Tom" }],
          reply_to: { text: "Working late!", from_me: true },
          edited: true,
          effect: "confetti",
        }),
        msg({ ts: "2026-08-31T10:01:00Z", retracted: true }),
      ],
      today,
    );
    expect(out[0]!.tapbacks[0]!.emoji).toBe("❤️");
    expect(out[0]!.replyText).toBe("Working late!");
    expect(out[0]!.replyMine).toBe(true);
    expect(out[0]!.edited).toBe(true);
    expect(out[0]!.effect).toBe("confetti");
    expect(out[1]!.retracted).toBe(true);
  });

  test("plain (non-rich) messages decorate with empty extras", () => {
    const out = decorate([msg({})], today);
    expect(out[0]!.receipt).toBe("");
    expect(out[0]!.tapbacks).toEqual([]);
    expect(out[0]!.attachments).toEqual([]);
    expect(out[0]!.replyText).toBe("");
    expect(out[0]!.edited).toBe(false);
    expect(out[0]!.retracted).toBe(false);
  });
});

describe("cliChatArg (CLI / IPC bare-digit convenience)", () => {
  test("a short code stays verbatim — it IS the chat_identifier", () => {
    expect(cliChatArg("99123")).toBe("99123");
    expect(cliChatArg("878478")).toBe("878478");
    expect(cliChatArg("29923")).toBe("29923");
  });
  test("a bare full number becomes E.164 (qs rejects a leading +)", () => {
    expect(cliChatArg("15550100001")).toBe("+15550100001");
    expect(cliChatArg("4402079460958")).toBe("+4402079460958");
  });
  test("already-E.164, emails and group ids pass through", () => {
    expect(cliChatArg("+15550100001")).toBe("+15550100001");
    expect(cliChatArg("someone@example.com")).toBe("someone@example.com");
    expect(cliChatArg("ce5a593a78af408282d61461ade89135")).toBe("ce5a593a78af408282d61461ade89135");
    expect(cliChatArg("chat123456")).toBe("chat123456");
  });
});

describe("pending sends (the bubble drawn before the Mac writes the row)", () => {
  const today = "2026-08-30";
  const now = Date.parse("2026-08-30T12:00:30");
  const real = (over: Partial<Bubble> = {}): Bubble =>
    ({ ...decorate([msg({ from_me: true, text: "on my way", ts: "2026-08-30T11:59:00Z" })], today)[0]!, ...over });
  const send = (over: Partial<PendingSend> = {}): PendingSend => ({ chat: "+15551234567", text: "see you soon", ts: "2026-08-30T12:00:00Z", ...over });

  test("an unresolved send is appended as a pending bubble that joins your run", () => {
    const r = withPendingSends([real()], [send()], today, DEFAULT_FORMATS, now);
    expect(r.bubbles).toHaveLength(2);
    const [prev, mine] = r.bubbles;
    expect(mine!.pending).toBe(true);
    expect(mine!.from_me).toBe(true);
    expect(mine!.text).toBe("see you soon");
    expect(mine!.time).toBe("12:00 PM");
    expect(mine!.day).toBe("");                  // same day as the bubble before it
    expect(mine!.groupStart).toBe(false);
    expect(prev!.groupEnd).toBe(false);          // the run continues, so the older bubble loses its time
    expect(prev!.time).toBe("");
    expect(r.pending).toEqual([send()]);
  });

  test("the first bubble of an empty thread opens the day", () => {
    const r = withPendingSends([], [send()], today, DEFAULT_FORMATS, now);
    expect(r.bubbles[0]!.day).toBe("Today");
    expect(r.bubbles[0]!.groupStart).toBe(true);
  });

  test("a reply from them starts a new run", () => {
    const theirs = decorate([msg({ from_me: false, text: "where are you", ts: "2026-08-30T11:59:00Z" })], today)[0]!;
    const r = withPendingSends([theirs], [send()], today, DEFAULT_FORMATS, now);
    expect(r.bubbles[1]!.groupStart).toBe(true);
    expect(r.bubbles[0]!.time).toBe("11:59 AM");
  });

  test("the real row resolves the send and nothing is appended", () => {
    const landed = real({ text: "see you soon", ts: "2026-08-30T12:00:01Z" });
    const r = withPendingSends([real(), landed], [send()], today, DEFAULT_FORMATS, now);
    expect(r.bubbles).toHaveLength(2);
    expect(r.bubbles.some((b) => b.pending)).toBe(false);
    expect(r.pending).toEqual([]);
  });

  test("the same text sent twice waits for two rows", () => {
    const landed = real({ text: "ok", ts: "2026-08-30T12:00:01Z" });
    const twice = [send({ text: "ok", ts: "2026-08-30T12:00:00Z" }), send({ text: "ok", ts: "2026-08-30T12:00:05Z" })];
    const r = withPendingSends([landed], twice, today, DEFAULT_FORMATS, now);
    expect(r.bubbles).toHaveLength(2);
    expect(r.bubbles[1]!.pending).toBe(true);
    expect(r.pending).toEqual([twice[1]]);
  });

  test("an identical message from yesterday does not resolve today's send", () => {
    const old = real({ text: "see you soon", ts: "2026-08-29T12:00:00Z" });
    const r = withPendingSends([old], [send()], today, DEFAULT_FORMATS, now);
    expect(r.bubbles).toHaveLength(2);
    expect(r.bubbles[1]!.pending).toBe(true);
  });

  test("a Mac timestamp a little behind the Linux clock still resolves", () => {
    const landed = real({ text: "see you soon", ts: "2026-08-30T11:58:30Z" });
    const r = withPendingSends([landed], [send()], today, DEFAULT_FORMATS, now);
    expect(r.pending).toEqual([]);
  });

  test("a send two minutes old without a row is given up on, quietly", () => {
    const stale = send({ ts: "2026-08-30T11:58:00Z" });
    const r = withPendingSends([real()], [stale], today, DEFAULT_FORMATS, now);
    expect(r.bubbles).toHaveLength(1);
    expect(r.pending).toEqual([]);
  });

  test("a retracted or already-pending bubble never resolves a send", () => {
    const gone = real({ text: "see you soon", ts: "2026-08-30T12:00:01Z", retracted: true });
    const r = withPendingSends([gone], [send()], today, DEFAULT_FORMATS, now);
    expect(r.pending).toHaveLength(1);
    const again = withPendingSends(r.bubbles, [send()], today, DEFAULT_FORMATS, now);
    expect(again.bubbles.filter((b) => b.pending)).toHaveLength(2);   // the old pending bubble is not a row
  });

  test("a URL in a pending bubble is already clickable", () => {
    const { bubble } = pendingBubble(undefined, send({ text: "look https://example.com" }), today);
    expect(bubble.html).toContain('<a href="https://example.com">');
  });

  test("parsePendingSends accepts only well-formed entries", () => {
    expect(parsePendingSends("nope")).toEqual([]);
    expect(parsePendingSends(JSON.stringify([{ chat: "a", text: "b", ts: "c" }, { chat: 1 }, null]))).toEqual([{ chat: "a", text: "b", ts: "c" }]);
  });

  test("loadThread --pending-stdin runs end to end through the CLI", async () => {
    const proc = Bun.spawn(["bun", "thread.ts", "+15550100001", "5", "--pending-stdin"], {
      stdin: new TextEncoder().encode(JSON.stringify([{ chat: "+15550100001", text: "hi", ts: localToday() + " 00:00:00" }])),
      env: { ...process.env, HOME: "/nonexistent-blip-home" },   // no ~/bin/imsg: offline, pending echoed back
      stdout: "pipe",
    });
    const out = JSON.parse(await new Response(proc.stdout).text());
    expect(out.ok).toBe(false);
    expect(out.pending).toEqual([{ chat: "+15550100001", text: "hi", ts: localToday() + " 00:00:00" }]);
  });
});
