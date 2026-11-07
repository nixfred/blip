// notices.ts
var MAX_LENGTH = 120;
var ERROR_MS = 6000;
var CALM_MS = 2500;
var REACTION_REASONS = [
  [/unreachable/i, "Couldn't reach your Mac."],
  [/did not expose that exact emoji/i, "That emoji isn't available as a reaction on your Mac."],
  [/did not open its tapback picker|picker opened on another message/i, "Messages didn't open the reaction picker. Try again."],
  [/does not offer|not-rendered|not-offered|ambiguous|unsettled|moved/i, "Couldn't find that message in Messages. Try again."],
  [/groups are not supported/i, "Reactions aren't available in group chats yet."],
  [/attachments and link|has a link|with a link/i, "Reactions aren't available on attachments or links yet."],
  [/no tapback row|did not confirm|shows tapback type|stray/i, "Your Mac didn't confirm the reaction. Check it in Messages."],
  [/did not start|re-run blip-setup/i, "Reactions aren't set up. Run blip-setup."],
  [/timed? ?out|deadline/i, "Reaction timed out. Try again."]
];
function bounded(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length <= MAX_LENGTH ? clean : clean.slice(0, MAX_LENGTH - 1).trimEnd() + "…";
}
function noticeText(note) {
  const text = String(note || "");
  if (!text.startsWith("tapback: "))
    return bounded(text);
  const why = text.slice(9);
  const known = REACTION_REASONS.find(([pattern]) => pattern.test(why));
  return known ? known[1] : "Couldn't send that reaction.";
}
function isCalm(note) {
  const text = String(note || "");
  return text === "copied" || text === "sent to LocalSend" || text.startsWith("sending…") || text.startsWith("attached") || text.startsWith("saved");
}
function activeNotices(note, standing, dismissed) {
  const out = [];
  if (String(note || "") !== "") {
    const calm = isCalm(note);
    out.push({
      kind: "note",
      text: noticeText(note),
      error: !calm,
      timeoutMs: String(note).startsWith("sending…") ? 0 : calm ? CALM_MS : ERROR_MS
    });
  }
  for (const item of standing) {
    const text = bounded(item.text);
    if (text !== "" && (dismissed || {})[item.kind] !== text)
      out.push({ kind: item.kind, text, error: true, timeoutMs: 0 });
  }
  return out;
}
export {
  CALM_MS,
  ERROR_MS,
  activeNotices,
  isCalm,
  noticeText
};
