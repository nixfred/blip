import { EMOJI_CATALOGUE } from "./emoji-catalogue";

export const EMOJI_GROUPS = ["All", "Smileys & Emotion", "People & Body", "Animals & Nature", "Food & Drink", "Travel & Places", "Activities", "Objects", "Symbols", "Flags"];
export interface ReactionChoice { emoji: string; name: string; kind: string }
const EMOJI_CHOICES: ReactionChoice[] = EMOJI_CATALOGUE.map((r) => ({ emoji: r[0], name: r[1], kind: "emoji:" + r[0] }));
const EMOJI_NAMES = new Map(EMOJI_CATALOGUE.map((r) => [r[0], r[1]]));

/** The grid is virtualized in QML; searching and category policy live here.
 *  Pasting a valid sequence always exposes that exact emoji as the first hit. */
export function searchReactionEmoji(query: string, group = "All"): ReactionChoice[] {
  const q = String(query || "").trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const choices = EMOJI_CHOICES.filter((r, i) => (group === "All" || EMOJI_CATALOGUE[i][2] === group)
    && (r.emoji === q || words.every((w) => r.name.toLowerCase().includes(w))));
  if (validReactionEmoji(q) && !choices.some((r) => r.emoji === q)) choices.unshift({ emoji: q, name: EMOJI_NAMES.get(q) || "Custom emoji", kind: "emoji:" + q });
  return choices;
}


export function validReactionEmoji(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  // QML's Array.from(string) walks UTF-16 units on supported Qt builds;
  // explicitly advance over surrogate pairs instead of relying on it.
  const points: number[] = [];
  for (let i = 0; i < value.length;) {
    const point = value.codePointAt(i)!;
    points.push(point);
    i += point > 0xffff ? 2 : 1;
  }
  if (points.length === 2 && points.every((n) => n >= 0x1f1e6 && n <= 0x1f1ff)) return true;
  if (/^[0-9#*]\uFE0F?\u20E3$/.test(value)) return true;
  const base = (n: number) => (n >= 0x1f000 && n <= 0x1faff && !(n >= 0x1f1e6 && n <= 0x1f1ff)) || (n >= 0x2600 && n <= 0x27bf)
    || [0xa9, 0xae, 0x203c, 0x2049, 0x2122, 0x2139, 0x2194, 0x2195, 0x2196, 0x2197, 0x2198, 0x2199,
      0x21a9, 0x21aa, 0x231a, 0x231b, 0x2328, 0x23cf, 0x23e9, 0x23ea, 0x23eb, 0x23ec, 0x23ed,
      0x23ee, 0x23ef, 0x23f0, 0x23f1, 0x23f2, 0x23f3, 0x23f8, 0x23f9, 0x23fa, 0x24c2,
      0x25aa, 0x25ab, 0x25b6, 0x25c0, 0x25fb, 0x25fc, 0x25fd, 0x25fe, 0x2934, 0x2935,
      0x2b05, 0x2b06, 0x2b07, 0x2b1b, 0x2b1c, 0x2b50, 0x2b55, 0x3030, 0x303d, 0x3297, 0x3299].includes(n);
  let at = 0;
  for (;;) {
    const n = points[at++];
    if (!base(n) || (n >= 0x1f3fb && n <= 0x1f3ff)) return false;
    if (points[at] === 0xfe0f || points[at] === 0xfe0e) at++;
    if (points[at] >= 0x1f3fb && points[at] <= 0x1f3ff) at++;
    // Unicode subdivision flags, e.g. England, finish with CANCEL TAG.
    if (n === 0x1f3f4 && points[at] >= 0xe0020 && points[at] <= 0xe007e) {
      while (points[at] >= 0xe0020 && points[at] <= 0xe007e) at++;
      if (points[at++] !== 0xe007f) return false;
    }
    if (at === points.length) return true;
    if (points[at++] !== 0x200d || at === points.length) return false;
  }
}
