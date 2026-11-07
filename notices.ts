// What the floating notices say. Failures reach here as tool output, so this is
// where they become one short sentence a person can act on.
//
// Pure, shared with the QML renderer. Rebuild the QML module:
//   bun build notices.ts --target browser --format esm --outfile Notices.mjs

export interface Notice { kind: string; text: string; error: boolean; timeoutMs: number }

const MAX_LENGTH = 120;
export const ERROR_MS = 6000;
export const CALM_MS = 2500;

const REACTION_REASONS: [RegExp, string][] = [
  [/unreachable/i, "Couldn't reach your Mac."],
  [/did not expose that exact emoji/i, "That emoji isn't available as a reaction on your Mac."],
  [/did not open its tapback picker|picker opened on another message/i, "Messages didn't open the reaction picker. Try again."],
  [/does not offer|not-rendered|not-offered|ambiguous|unsettled|moved/i, "Couldn't find that message in Messages. Try again."],
  [/groups are not supported/i, "Reactions aren't available in group chats yet."],
  [/attachments and link|has a link|with a link/i, "Reactions aren't available on attachments or links yet."],
  [/no tapback row|did not confirm|shows tapback type|stray/i, "Your Mac didn't confirm the reaction. Check it in Messages."],
  [/did not start|re-run blip-setup/i, "Reactions aren't set up. Run blip-setup."],
  [/timed? ?out|deadline/i, "Reaction timed out. Try again."],
];

function bounded(text: string): string {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length <= MAX_LENGTH ? clean : clean.slice(0, MAX_LENGTH - 1).trimEnd() + "…";
}

/** A tapback failure line becomes its plain reason; other notes pass through. */
export function noticeText(note: string): string {
  const text = String(note || "");
  if (!text.startsWith("tapback: ")) return bounded(text);
  const why = text.slice(9);
  const known = REACTION_REASONS.find(([pattern]) => pattern.test(why));
  return known ? known[1] : "Couldn't send that reaction.";
}

/** Progress and confirmations rather than failures. */
export function isCalm(note: string): boolean {
  const text = String(note || "");
  return text === "copied" || text === "sent to LocalSend" || text.startsWith("sending…")
    || text.startsWith("attached") || text.startsWith("saved");
}

/** Everything to show now, newest concern first. A dismissed standing error
 *  stays away until its text changes. Progress has no timeout: its sender clears it. */
export function activeNotices(note: string, standing: { kind: string; text: string }[], dismissed: Record<string, string>): Notice[] {
  const out: Notice[] = [];
  if (String(note || "") !== "") {
    const calm = isCalm(note);
    out.push({ kind: "note", text: noticeText(note), error: !calm,
      timeoutMs: String(note).startsWith("sending…") ? 0 : calm ? CALM_MS : ERROR_MS });
  }
  for (const item of standing) {
    const text = bounded(item.text);
    if (text !== "" && (dismissed || {})[item.kind] !== text) out.push({ kind: item.kind, text, error: true, timeoutMs: 0 });
  }
  return out;
}
