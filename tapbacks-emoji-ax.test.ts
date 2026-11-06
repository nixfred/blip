import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Execute the shipping JXA with a synthetic Accessibility tree. No Mac, UI
// events, message database or network is used by this test.
const src = readFileSync(new URL("./bridge/mac/imsg-react", import.meta.url), "utf8");
const start = src.indexOf('JXA = r"""') + 10;
const script = src.slice(start, src.indexOf('\n"""', start));

function scene(options: { foreground?: boolean; label?: string; duplicate?: boolean } = {}) {
  const presses: string[] = [];
  let label = options.label ?? "Message, synthetic target";
  let fieldsWritten = 0;
  const element = (id: string, opts: { enabled?: boolean; role?: string; value?: string; afterIdentity?: () => void } = {}): any => ({
    attributes: { byName: (name: string) => ({ value() {
      const result = name === "AXIdentifier" ? id : name === "AXValue" ? opts.value || "" : "";
      opts.afterIdentity?.();
      return result;
    } }) },
    role: () => opts.role || "AXButton",
    enabled: () => opts.enabled !== false,
    description: () => id,
    actions: { name: () => ["AXPress"], byName: () => ({ perform: () => presses.push(id) }) },
  });
  const search: any = {
    role: () => "AXTextField", subrole: () => "AXSearchField", enabled: () => true,
    set value(_v: string) { fieldsWritten++; },
  };
  let children: any[] = [];
  const picker = { description: () => "Tapback Picker", entireContents: () => children };
  const popover = { role: () => "AXPopover", entireContents: () => children.concat(search) };
  const window = { entireContents: () => [picker, {description: () => label}, popover] };
  const windows: any = () => [window]; windows[0] = window;
  const proc = { windows, frontmost: () => options.foreground !== false };
  const Application = () => ({ processes: { byName: () => proc }, keyCode: () => {} });
  const api = new Function("Application", "ObjC", "delay", `${script}\nreturn {pressEmoji, emojiPicker, picker};`)(Application, {import() {}}, () => {});
  return { api, element, presses, set: (els: any[]) => {children = els},
    changeLabel: (l: string) => {label = l}, writes: () => fieldsWritten,
    request: { text: "synthetic target", emoji: "🚀", name: "rocket" } };
}

describe("custom emoji: exact AX identity and original target are required", () => {
  test("presses one enabled exact picker identity", () => {
    const s = scene();
    const els = [s.element("🎉"), s.element("🚀")];
    expect(s.api.pressEmoji(els, "🚀", s.request)).toEqual({ok:true});
    expect(s.presses).toEqual(["🚀"]);
  });
  test("different emoji, skin tone, ZWJ, and variation selectors are never substituted", () => {
    for (const [wanted, offered] of [["🚀","🎉"],["👍🏽","👍"],["👩🏽‍💻","👩‍💻"],["❤️","❤"]]) {
      const s = scene();
      expect(s.api.pressEmoji([s.element(offered)], wanted, s.request).ok).toBe(false);
      expect(s.presses).toEqual([]);
    }
  });
  test("disabled, ambiguous, and image sticker identities are refused", () => {
    const s = scene();
    for (const els of [[s.element("🚀",{enabled:false})], [s.element("🚀"),s.element("🚀")], [s.element("Sticker",{role:"AXImage"})]]) {
      expect(s.api.pressEmoji(els,"🚀",s.request).ok).toBe(false);
      expect(s.presses).toEqual([]);
    }
  });
  test("a search field with the emoji value can never be pressed", () => {
    const s = scene();
    expect(s.api.pressEmoji([s.element("",{role:"AXTextField",value:"🚀"})],"🚀",s.request).ok).toBe(false);
    expect(s.presses).toEqual([]);
  });
  test("focus or original message context changing prevents a press", () => {
    for (const options of [{foreground:false},{label:"Message, another target"}]) {
      const s = scene(options);
      expect(s.api.pressEmoji([s.element("🚀")],"🚀",s.request).ok).toBe(false);
      expect(s.presses).toEqual([]);
    }
  });
  test("context is rechecked after discovering the emoji", () => {
    const s = scene();
    const el = s.element("🚀", {afterIdentity: () => s.changeLabel("Message, changed")});
    expect(s.api.pressEmoji([el],"🚀",s.request).ok).toBe(false);
    expect(s.presses).toEqual([]);
  });
  test("searches only a unique picker and selects only an exact result", () => {
    const s = scene(); s.set([s.element("🚀")]);
    expect(s.api.emojiPicker(s.request)).toEqual({ok:true});
    expect(s.presses).toEqual(["🚀"]);
    expect(s.writes()).toBe(0);
  });
  test("an unrelated popover never receives even a search query", () => {
    const s = scene({label:"Message, other"}); s.set([s.element("🚀")]);
    expect(s.api.emojiPicker(s.request).error).toBe("picker-elsewhere");
    expect(s.writes()).toBe(0);
    expect(s.presses).toEqual([]);
  });
});
