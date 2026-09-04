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
  receiptLabel,
  selectThread,
} from "./thread";
import { cliChatArg } from "./thread";

function msg(over: Partial<ImsgMessage> = {}): ImsgMessage {
  return {
    ts: "2026-08-30 12:00:00",
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
  const ts = "2026-08-30 21:08:22"; // a Sunday

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
    expect(formatStamp("2026-08-30 00:30:00", "h:mm AP")).toBe("12:30 AM");
    expect(formatStamp("2026-08-30 12:00:00", "h:mm AP")).toBe("12:00 PM");
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
    expect(clockLabel("2026-08-30 21:08:22")).toBe("9:08 PM");
  });

  test("formats morning as AM", () => {
    expect(clockLabel("2026-08-30 09:05:00")).toBe("9:05 AM");
  });

  test("midnight is 12 AM, not 0 AM", () => {
    expect(clockLabel("2026-08-30 00:30:00")).toBe("12:30 AM");
  });

  test("noon is 12 PM, not 0 PM", () => {
    expect(clockLabel("2026-08-30 12:00:00")).toBe("12:00 PM");
  });

  test("follows the time pattern it is given", () => {
    expect(clockLabel("2026-08-30 21:08:22", "HH:mm")).toBe("21:08");
  });

  test("garbage in yields an empty label, not a crash", () => {
    expect(clockLabel("nonsense")).toBe("");
  });
});

describe("dayLabel", () => {
  const today = "2026-08-30";

  test("same date reads Today", () => {
    expect(dayLabel("2026-08-30 09:00:00", today)).toBe("Today");
  });

  test("one day back reads Yesterday", () => {
    expect(dayLabel("2026-08-29 09:00:00", today)).toBe("Yesterday");
  });

  test("earlier this year omits the year", () => {
    expect(dayLabel("2026-08-28 09:00:00", today)).toBe("Aug 28");
  });

  test("a previous year includes it", () => {
    expect(dayLabel("2025-12-24 09:00:00", today)).toBe("Dec 24, 2025");
  });

  test("dates follow the patterns, Today and Yesterday stay words", () => {
    expect(dayLabel("2026-08-30 09:00:00", today, DOTTED)).toBe("Today");
    expect(dayLabel("2026-08-29 09:00:00", today, DOTTED)).toBe("Yesterday");
    expect(dayLabel("2026-08-28 09:00:00", today, DOTTED)).toBe("28.08");
    expect(dayLabel("2025-12-24 09:00:00", today, DOTTED)).toBe("24.12.2025");
  });

  test("crossing a month boundary still resolves Yesterday", () => {
    expect(dayLabel("2026-07-31 09:00:00", "2026-08-01")).toBe("Yesterday");
  });

  test("malformed input yields an empty label", () => {
    expect(dayLabel("not-a-date", today)).toBe("");
  });
});

describe("minutesBetween", () => {
  test("measures a simple gap", () => {
    expect(minutesBetween("2026-08-30 12:00:00", "2026-08-30 12:20:00")).toBe(20);
  });

  test("is order-independent", () => {
    expect(minutesBetween("2026-08-30 12:20:00", "2026-08-30 12:00:00")).toBe(20);
  });

  test("unparseable stamps read as infinitely far apart, forcing a new group", () => {
    expect(minutesBetween("junk", "2026-08-30 12:00:00")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("decorate", () => {
  const today = "2026-08-30";

  test("a lone message is both group start and end", () => {
    const b = decorate([msg({ ts: "2026-08-30 12:00:00" })], today);
    expect(b[0]!.groupStart).toBe(true);
    expect(b[0]!.groupEnd).toBe(true);
    expect(b[0]!.time).toBe("12:00 PM");
    expect(b[0]!.handle).toBe("+15551234567");
  });

  test("the patterns reach the divider, the timestamp and the read receipt", () => {
    const b = decorate(
      [msg({ ts: "2026-08-28 16:42:00", from_me: true, read_at: "2026-08-28 16:45:00" })],
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
        msg({ ts: "2026-08-30 12:00:00", text: "one" }),
        msg({ ts: "2026-08-30 12:01:00", text: "two" }),
        msg({ ts: "2026-08-30 12:02:00", text: "three" }),
      ],
      today,
    );
    expect(b.map((x) => x.groupStart)).toEqual([true, false, false]);
    expect(b.map((x) => x.groupEnd)).toEqual([false, false, true]);
  });

  test("only the last bubble of a group carries a timestamp", () => {
    const b = decorate(
      [msg({ ts: "2026-08-30 12:00:00" }), msg({ ts: "2026-08-30 12:01:00" })],
      today,
    );
    expect(b[0]!.time).toBe("");
    expect(b[1]!.time).toBe("12:01 PM");
  });

  test("a sender change breaks the group", () => {
    const b = decorate(
      [
        msg({ ts: "2026-08-30 12:00:00", from_me: false }),
        msg({ ts: "2026-08-30 12:01:00", from_me: true }),
      ],
      today,
    );
    expect(b[0]!.groupEnd).toBe(true);
    expect(b[1]!.groupStart).toBe(true);
  });

  test("in a group, a different member breaks the run even seconds apart", () => {
    const b = decorate(
      [
        msg({ ts: "2026-08-30 12:00:00", handle: "+1111111111", name: "Jordan" }),
        msg({ ts: "2026-08-30 12:00:30", handle: "+2222222222", name: "Casey" }),
      ],
      today,
    );
    expect(b[0]!.groupEnd).toBe(true);
    expect(b[1]!.groupStart).toBe(true);
  });

  test("a gap longer than 15 minutes breaks the group", () => {
    const b = decorate(
      [msg({ ts: "2026-08-30 12:00:00" }), msg({ ts: "2026-08-30 12:20:00" })],
      today,
    );
    expect(b[1]!.groupStart).toBe(true);
  });

  test("a gap under 15 minutes does not", () => {
    const b = decorate(
      [msg({ ts: "2026-08-30 12:00:00" }), msg({ ts: "2026-08-30 12:14:00" })],
      today,
    );
    expect(b[1]!.groupStart).toBe(false);
  });

  test("the day label appears once, on the first message of that day", () => {
    const b = decorate(
      [
        msg({ ts: "2026-08-29 23:00:00" }),
        msg({ ts: "2026-08-30 09:00:00" }),
        msg({ ts: "2026-08-30 09:01:00" }),
      ],
      today,
    );
    expect(b[0]!.day).toBe("Yesterday");
    expect(b[1]!.day).toBe("Today");
    expect(b[2]!.day).toBe("");
  });

  test("a day change always starts a new group even within 15 minutes", () => {
    const b = decorate(
      [msg({ ts: "2026-08-29 23:59:00" }), msg({ ts: "2026-08-30 00:01:00" })],
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
      msg({ ts: "2026-08-30 21:08:22", from_me: true, text: "" }),
      msg({ ts: "2026-08-30 21:08:22", from_me: false, text: "Larry test" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("Larry test");
  });

  test("the surviving twin is re-attributed to me — it renders on the right", () => {
    const out = dedupeSelfEcho([
      msg({ ts: "2026-08-30 21:08:22", from_me: true, text: "" }),
      msg({ ts: "2026-08-30 21:08:22", from_me: false, text: "mine" }),
    ]);
    expect(out[0]!.from_me).toBe(true);
  });

  test("a text-bearing pair is mine whichever twin arrives first", () => {
    // imsg decodes attributedBody, so the from_me=true twin has text too.
    const self = msg().chat;
    const a = dedupeSelfEcho([
      msg({ ts: "2026-08-30 21:08:22", from_me: false, text: "same" }),
      msg({ ts: "2026-08-30 21:08:22", from_me: true, text: "same" }),
    ], [self]);
    expect(a).toHaveLength(1);
    expect(a[0]!.from_me).toBe(true);
    const b = dedupeSelfEcho([
      msg({ ts: "2026-08-30 21:08:22", from_me: true, text: "same" }),
      msg({ ts: "2026-08-30 21:08:22", from_me: false, text: "same" }),
    ], [self]);
    expect(b[0]!.from_me).toBe(true);
  });

  test("a genuine inbound with no empty twin stays theirs", () => {
    const out = dedupeSelfEcho([msg({ ts: "2026-08-30 21:08:22", from_me: false, text: "theirs" })]);
    expect(out[0]!.from_me).toBe(false);
  });

  test("keeps legitimate same-direction duplicates at the same timestamp", () => {
    const out = dedupeSelfEcho([
      msg({ ts: "2026-08-30 21:08:22", text: "same" }),
      msg({ ts: "2026-08-30 21:08:22", text: "same" }),
    ]);
    expect(out).toHaveLength(2);
  });

  test("keeps identical text sent at different times", () => {
    const out = dedupeSelfEcho([
      msg({ ts: "2026-08-30 21:08:22", text: "ok" }),
      msg({ ts: "2026-08-30 21:09:00", text: "ok" }),
    ]);
    expect(out).toHaveLength(2);
  });

  test("leaves an ordinary conversation untouched", () => {
    const out = dedupeSelfEcho([
      msg({ ts: "2026-08-30 12:00:00", text: "hi" }),
      msg({ ts: "2026-08-30 12:01:00", from_me: true, text: "hey" }),
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
      fake({ status: 0, stdout: JSON.stringify([msg({ ts: "2026-08-30 12:00:00" })]) }),
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
        msg({ chat: guid, ts: "2026-08-30 12:05:00", text: "late" }),
        msg({ chat: "+15550000000", ts: "2026-08-30 12:04:00", text: "other chat" }),
        msg({ chat: guid, ts: "2026-08-30 12:00:00", text: "early" }),
      ],
      guid, true, 80,
    );
    expect(out.map((m) => m.text)).toEqual(["early", "late"]);
  });

  test("keeps only the newest `limit` messages", () => {
    const raw = Array.from({ length: 5 }, (_, i) => msg({ chat: guid, ts: `2026-08-30 12:0${i}:00`, text: `m${i}` }));
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
    const out = selectThread([msg({ ts: "2026-08-30 12:01:00" }), msg({ ts: "2026-08-30 12:00:00" })], "+15551234567", false, 80);
    expect(out[0]!.ts).toBe("2026-08-30 12:00:00");
  });

  test("loadThread loads a group by EXACT chat id via thread --chat", () => {
    let seen: string[] = [];
    const runner = ((_: string, args: string[]) => { seen = args; return { status: 0, stdout: "[]", stderr: "" }; }) as never;
    loadThread(guid, 80, "2026-08-30", DEFAULT_FORMATS, runner);
    expect(seen).toContain("--rich");
    expect(seen).toContain("--chat");
    expect(seen[seen.indexOf("--chat") + 1]).toBe(guid);
  });

  test("a coalesced group loads and selects every exact historical alias", () => {
    const oldGuid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const raw = [
      msg({ chat: oldGuid, ts: "2026-08-29 12:00:00", text: "old history" }),
      msg({ chat: guid, ts: "2026-08-30 12:00:00", text: "new history" }),
    ];
    expect(selectThread(raw, guid, true, 80, [], [oldGuid]).map((m) => m.text))
      .toEqual(["old history", "new history"]);
    let seen: string[] = [];
    const runner = ((_: string, args: string[]) => {
      seen = args;
      return { status: 0, stdout: JSON.stringify(raw), stderr: "" };
    }) as never;
    const out = loadThread(guid, 80, "2026-08-30", DEFAULT_FORMATS, runner, [oldGuid]);
    expect(seen).not.toContain("--also-chat");
    expect(seen[seen.indexOf("--chat") + 1]).toBe(guid);
    expect(out.bubbles.map((bubble) => bubble.text)).toEqual(["old history", "new history"]);
  });
});

describe("linkify", () => {
  const { linkify, standaloneUrl } = require("./thread") as typeof import("./thread");

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

  test("a standalone shared URL is recognized even when metadata canonicalizes it", () => {
    expect(standaloneUrl("https://example.com/reel/one?tracking=abc")).toBe(true);
    expect(standaloneUrl("look https://example.com/reel/one")).toBe(false);
  });
});

describe("rich decoration", () => {
  const today = "2026-08-31";

  test("receipt lands only on the NEWEST read from-me bubble", () => {
    const out = decorate(
      [
        msg({ ts: "2026-08-31 10:00:00", from_me: true, read_at: "2026-08-31 10:00:30" }),
        msg({ ts: "2026-08-31 10:05:00", from_me: false }),
        msg({ ts: "2026-08-31 10:06:00", from_me: true, read_at: "2026-08-31 10:07:12" }),
        msg({ ts: "2026-08-31 10:08:00", from_me: true }), // sent, not yet read
      ],
      today,
    );
    expect(out.map((b) => b.receipt)).toEqual(["", "", "Read 10:07 AM", ""]);
  });

  test("receipt from an earlier day carries the day label", () => {
    expect(receiptLabel("2026-08-30 21:03:00", today)).toBe("Read Yesterday 9:03 PM");
    expect(receiptLabel("2026-08-31 16:42:00", today)).toBe("Read 4:42 PM");
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

  test("an unfurled card suppresses a URL-only body but keeps a real caption", () => {
    const link = {
      url: "https://example.com/reel/one",
      title: "One reel",
      summary: "",
      image_id: "10",
    };
    const out = decorate([
      msg({ text: "https://example.com/reel/one?tracking=abc", link }),
      msg({ ts: "2026-08-30 12:01:00", text: "Look at this https://example.com/reel/one", link }),
    ], today);
    expect(out[0]!.linkOnly).toBe(true);
    expect(out[1]!.linkOnly).toBe(false);
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
        msg({ ts: "2026-08-31 10:01:00", retracted: true }),
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
    expect(out[0]!.linkOnly).toBe(false);
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
