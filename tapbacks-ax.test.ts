import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";

// imsg-react's JXA half against a simulated System Events. What makes the
// simulation worth having: an element is a *path* ("row 3 of the
// transcript"), resolved again on every call, and a scroll renumbers the rows
// a few calls after it is asked for. On macOS 26.6 that let a check read the
// right bubble and the press that followed land on its neighbour. Every pass
// here runs the real script, fresh, as osascript would.

const src = readFileSync(new URL("./bridge/mac/imsg-react", import.meta.url), "utf8");
const JXA = src.slice(src.indexOf('JXA = r"""') + 10, src.indexOf('\n"""', src.indexOf('JXA = r"""')));
const ACTIONS = [...src.matchAll(/^ {4}"\w+": \("([^"]+)", \d\),$/gm)].map((m) => m[1]);
const MAX_SETTLES = Number(src.match(/^MAX_SETTLES = (\d+)/m)![1]);

interface Msg { text: string; hhmm: string; mine: boolean }
interface Press { action: string; text: string }

const RENDERED = 8;   // rows Messages keeps in the tree
const CHUNK = 4;      // it re-renders, and renumbers, in steps of this many rows
const PAGE = 6;       // rows one "scroll up by a page" moves

/** Messages' window: a transcript of `msgs` scrolled to `top`. Every scroll
 *  moves the bubbles on screen; the tree holds RENDERED rows from
 *  `renderTop`, which follows in steps of CHUNK, so only some scrolls
 *  renumber the rows. A scroll or page is applied `lag` AX calls after it is
 *  asked for, or when the pass ends (osascript exits and the scroll finishes
 *  before the next one starts). `drift` moves the transcript by itself, at
 *  one AX call, as new messages or Messages' own scrolling do. */
class Messages {
  top: number;
  pending: { top: number; after: number } | null = null;
  drift: { at: number; by: number } | null = null;
  presses: Press[] = [];
  /** Per press: which row it hit, where that row sat, and the AX call of the
   *  last read before it. */
  hits: { idx: number; key: string; lastRead: number }[] = [];
  calls = 0;
  lastRead = 0;
  constructor(public msgs: Msg[], public lag: number) {
    this.top = msgs.length - RENDERED;
  }
  clamp(t: number) { return Math.max(0, Math.min(this.msgs.length - RENDERED, t)); }
  get renderTop() { return Math.min(Math.ceil(this.top / CHUNK) * CHUNK, this.msgs.length - RENDERED); }
  tick() {
    this.calls++;
    if (this.drift && this.calls === this.drift.at) this.top = this.clamp(this.top + this.drift.by);
    if (this.pending && this.pending.after-- <= 0) { this.top = this.pending.top; this.pending = null; }
  }
  settle() { if (this.pending) { this.top = this.pending.top; this.pending = null; } }
  scrollTo(top: number) { if (this.clamp(top) !== this.top) this.pending = { top: this.clamp(top), after: this.lag }; }
  key(idx: number) { return [this.msgs[idx].mine ? 600 : 100, 100 + (idx - this.top) * 40, 200, 30].join(","); }
  label(m: Msg) { return `${m.mine ? "You" : "Ann"}, ${m.text}, ${m.hhmm}`; }

  /** What `path` names right now: the window, the compose field, the
   *  transcript, a row or the bubble in it. */
  resolve(path: string, read = true) {
    this.tick();
    if (read) this.lastRead = this.calls;
    const rest = path.slice(WIN.length);
    if (rest === "") return { kind: "window" } as const;
    if (rest === ".textFields.at(0)") return { kind: "field" } as const;
    if (rest === ".groups.at(0)") return { kind: "transcript" } as const;
    const m = rest.match(/^\.groups\.at\(0\)\.groups\.at\((\d+)\)(\.groups\.at\(0\))?$/);
    if (!m || +m[1] >= RENDERED) throw new Error("Invalid index");
    const k = +m[1], idx = this.renderTop + k;
    return { kind: m[2] ? "bubble" : "row", k, idx, msg: this.msgs[idx] } as const;
  }
  names(kind: string, idx: number) {
    const atBottom = this.top >= this.msgs.length - RENDERED;
    const scroll = ["AXScrollToVisible", "Escape", ...(atBottom ? [] : ["scroll down by a page"]), "scroll up by a page", "show menu"];
    return kind === "bubble" ? ["AXPress", ...scroll, ...ACTIONS] : scroll;
  }
  act(path: string, name: string) {
    const e = this.resolve(path, false);
    if (e.kind !== "row" && e.kind !== "bubble") throw new Error("no action");
    if (!this.names(e.kind, e.idx).includes(name)) throw new Error("no action " + name);
    if (name === "AXScrollToVisible") this.scrollTo(e.idx - 3);
    else if (name === "scroll up by a page") this.scrollTo(this.top - PAGE);
    else if (name === "scroll down by a page") this.scrollTo(this.top + PAGE);
    else if (ACTIONS.includes(name)) {
      this.presses.push({ action: name, text: e.msg.text });
      this.hits.push({ idx: e.idx, key: this.key(e.idx), lastRead: this.lastRead });
    }
  }
  el(path: string): any {
    const self = this;
    const at = (n: number) => `${path}.actions.at(${n})`;
    const actions: any = () => {
      const e = self.resolve(path);
      if (e.kind !== "row" && e.kind !== "bubble") return [];
      // Each action is a path too: which bubble it presses is decided when it is performed.
      return self.names(e.kind, e.idx).map((_, n) => ({
        perform() {
          const now = self.resolve(path, false);
          if (now.kind !== "row" && now.kind !== "bubble") throw new Error("gone");
          const name = self.names(now.kind, now.idx)[n];
          if (name === undefined) throw new Error("Invalid index " + at(n));
          self.act(path, name);
        },
      }));
    };
    actions.description = () => {
      const e = self.resolve(path);
      return e.kind === "row" || e.kind === "bubble" ? self.names(e.kind, e.idx) : [];
    };
    actions.byName = (name: string) => ({ perform: () => self.act(path, name) });
    actions.at = (n: number) => ({
      perform() {
        const now = self.resolve(path, false);
        if (now.kind !== "row" && now.kind !== "bubble") throw new Error("gone");
        const name = self.names(now.kind, now.idx)[n];
        if (name === undefined) throw new Error("Invalid index " + at(n));
        self.act(path, name);
      },
    });
    const groups: any = {};
    groups.description = () => {
      const e = self.resolve(path);
      if (e.kind === "transcript") return self.msgs.slice(self.renderTop, self.renderTop + RENDERED).map((m) => self.label(m));
      if (e.kind === "row") return [self.label(e.msg)];
      return ["transcript"];
    };
    return {
      path,
      actions,
      groups,
      description() {
        const e = self.resolve(path);
        return e.kind === "row" || e.kind === "bubble" ? self.label(e.msg) : e.kind;
      },
      position() {
        const e = self.resolve(path);
        if (e.kind === "field") return [0, 900];
        if (e.kind === "row" || e.kind === "bubble") return [e.msg.mine ? 600 : 100, 100 + (e.idx - self.top) * 40];
        return [0, 0];
      },
      size() {
        const e = self.resolve(path);
        if (e.kind === "field") return [1000, 30];
        return e.kind === "row" || e.kind === "bubble" ? [200, 30] : [1000, 800];
      },
      // One Apple event: everything read from the same moment.
      properties() {
        const e = self.resolve(path);
        if (e.kind !== "row" && e.kind !== "bubble") return { description: e.kind };
        return { description: self.label(e.msg), position: [e.msg.mine ? 600 : 100, 100 + (e.idx - self.top) * 40], size: [200, 30] };
      },
      entireContents() {
        self.resolve(path);
        const T = `${WIN}.groups.at(0)`;
        const rows = Array.from({ length: RENDERED }, (_, k) => [`${T}.groups.at(${k})`, `${T}.groups.at(${k}).groups.at(0)`]);
        return [`${WIN}.textFields.at(0)`, T, ...rows.flat()].map((p) => self.el(p));
      },
    };
  }
}

const WIN = 'Application("System Events").processes.byName("Messages").windows.at(0)';

/** One osascript run of the real script: a fresh evaluation, the request
 *  on "stdin". */
function pass(ui: Messages, request: object): any {
  const stdin = JSON.stringify(request);
  const $ = {
    NSFileHandle: { fileHandleWithStandardInput: { readDataToEndOfFile: stdin } },
    NSString: { alloc: { initWithDataEncoding: (d: string) => d } },
    NSUTF8StringEncoding: 4,
  };
  const ObjC = { import() {}, unwrap: (x: string) => x };
  const proc = { windows: [ui.el(WIN)] };
  const Application = () => ({ processes: { byName: () => proc } });
  const Automation = { getDisplayString: (el: any) => el.path };
  const run = new Function("ObjC", "Application", "Automation", "$", `${JXA}\nreturn run;`)(ObjC, Application, Automation, $);
  const out = JSON.parse(run());
  ui.settle();
  return out;
}

/** imsg-react's perform() loop, as far as the script sees it: page up while
 *  not rendered, hand back the frame of an "unsettled" pass. */
function tapback(ui: Messages, target: number, action = "Heart") {
  const t = ui.msgs[target], newest = ui.msgs[ui.msgs.length - 1];
  let request: any = {
    text: t.text, from_me: t.mine, hhmm: t.hhmm, ordinal: 0, actions: ACTIONS, action,
    newest: { text: newest.text, hhmm: newest.hhmm, from_me: newest.mine }, frame: "", mode: "perform",
  };
  let settles = 0, pages = 0, r: any;
  for (;;) {
    r = pass(ui, request);
    if (r.error === "unsettled" && settles < MAX_SETTLES) { settles++; request = { ...request, frame: r.frame }; continue; }
    if (r.error === "not-rendered" && pages < 6) { pages++; pass(ui, { ...request, mode: "page", direction: "up" }); continue; }
    return r;
  }
}

/** Alternating sides, every text and time distinct, so a press says which
 *  bubble it hit. */
function transcript(n = 30): Msg[] {
  return Array.from({ length: n }, (_, i) => ({
    text: `message ${i}`, hhmm: `10:${String(i).padStart(2, "0")}`, mine: i % 2 === 0,
  }));
}

describe("imsg-react: presses land on the target while the transcript moves", () => {
  test("the simulation reads the tapback names from imsg-react", () => {
    expect(ACTIONS).toEqual(["Heart", "Thumbs up", "Thumbs down", "Ha ha!", "Exclamation mark", "Question mark"]);
  });

  // Targets: in view at the bottom, rendered but off-screen, and a few pages
  // up (Erik's live miss was 12 and 25 up). Lags: the scroll lands anywhere
  // from the next AX call to several calls later.
  const targets = [29, 26, 24, 22, 18, 12, 6];
  for (const lag of [0, 1, 2, 3, 5, 8]) {
    test(`with a scroll that lands ${lag} AX calls later, nothing but the target is ever pressed`, () => {
      for (const target of targets) {
        for (const side of [0, 1]) {
          const msgs = transcript(), at = target - side;
          const ui = new Messages(msgs, lag);
          const r = tapback(ui, at);
          for (const p of ui.presses) expect(`${p.text} (${lag} lag, aimed at ${at})`).toBe(`${msgs[at].text} (${lag} lag, aimed at ${at})`);
          if (r.ok) expect(ui.presses).toEqual([{ action: "Heart", text: msgs[at].text }]);
          else expect(ui.presses).toEqual([]);
        }
      }
    });
  }

  test("a target that needs a scroll is pressed, once the scroll has settled", () => {
    const msgs = transcript(), ui = new Messages(msgs, 2);
    const r = tapback(ui, 18);
    expect(r.ok).toBe(true);
    expect(ui.presses).toEqual([{ action: "Heart", text: "message 18" }]);
  });

  // What is left after the fix: Messages moving the transcript by itself
  // between the last read and the press. Anything earlier in the pass the
  // read catches: a label that changed, or an identical twin ("ok" twice at
  // 10:26) that slid into the target's row at another height. Only a twin
  // landing on the very spot is invisible to AX; the stray check names that.
  test("Messages moving by itself is caught unless it moves after the last read", () => {
    let runs = 0;
    for (const twin of [false, true]) {
      for (const target of [26, 20, 12]) {
        const make = () => {
          const msgs = transcript();
          if (twin) msgs[target - CHUNK] = { ...msgs[target] };
          return msgs;
        };
        const dry = new Messages(make(), 1);
        tapback(dry, target);
        for (const by of [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5]) {
          for (let at = 1; at <= dry.calls; at++) {
            const msgs = make(), ui = new Messages(msgs, 1);
            ui.drift = { at, by };
            const r = tapback(ui, target);
            runs++;
            ui.hits.forEach(({ idx, key, lastRead }) => {
              if (idx === target || at > lastRead) return;
              // The twin sat at the very frame the target was settled at.
              const sameSpot = ui.label(msgs[idx]) === ui.label(msgs[target]) && key === r.frame;
              expect(`${sameSpot ? "same spot" : "caught"}`).toBe("same spot");
            });
          }
        }
      }
    }
    expect(runs).toBeGreaterThan(1000);
  });

  test("a bubble that is still moving when the settles run out is never pressed", () => {
    const msgs = transcript(), ui = new Messages(msgs, 0);
    // Between passes Messages nudges the transcript a row, one way then the
    // other, so no two passes find the bubble at the same frame.
    const settle = ui.settle.bind(ui);
    let n = 0;
    ui.settle = () => { settle(); ui.top = ui.clamp(ui.top + (n++ % 2 ? 1 : -1)); };
    const r = tapback(ui, 24);
    expect(r.error).toBe("unsettled");
    expect(ui.presses).toEqual([]);
  });
});
