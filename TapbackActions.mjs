// tapback-actions.ts
var TAPBACKS = [
  { kind: "love", emoji: "❤️" },
  { kind: "like", emoji: "\uD83D\uDC4D" },
  { kind: "dislike", emoji: "\uD83D\uDC4E" },
  { kind: "laugh", emoji: "\uD83D\uDE02" },
  { kind: "emphasize", emoji: "‼️" },
  { kind: "question", emoji: "❓" }
];
function tapbackForKey(text) {
  const i = ["1", "2", "3", "4", "5", "6"].indexOf(String(text || ""));
  return i >= 0 ? TAPBACKS[i].kind : "";
}
function initialTapbackCursor(current, keyboard) {
  const i = TAPBACKS.findIndex((t) => t.kind === current);
  return i >= 0 ? i : keyboard ? 0 : -1;
}
function moveTapbackCursor(cursor, dir, n = TAPBACKS.length) {
  if (n <= 0)
    return -1;
  if (cursor < 0 || cursor >= n)
    return dir > 0 ? 0 : n - 1;
  return (cursor + (dir > 0 ? 1 : n - 1)) % n;
}
function tapbacksOn(conf) {
  let v = "";
  for (const raw of String(conf || "").split(`
`)) {
    const line = raw.replace(/#.*/, "").replace(/\s+/g, "");
    const eq = line.indexOf("=");
    if (eq < 0 || line.slice(0, eq) !== "tapbacks")
      continue;
    v = line.slice(eq + 1).replace(/^"/, "").replace(/"$/, "").replace(/^'/, "").replace(/'$/, "");
  }
  return ["on", "yes", "true", "1"].includes(v.toLowerCase());
}
var LINK = /:\/\/|\bwww\./i;
function tapbackKind(emoji) {
  const bare = (s) => String(s || "").replace(/️/g, "");
  const hit = TAPBACKS.find((t) => bare(t.emoji) === bare(emoji));
  return hit ? hit.kind : "";
}
function myTapback(message) {
  for (const t of message?.tapbacks ?? []) {
    if (t.from_me) {
      const kind = tapbackKind(t.emoji);
      if (kind)
        return kind;
    }
  }
  return "";
}
function canTapback(message, group) {
  if (!message || group)
    return false;
  if (!String(message.guid || ""))
    return false;
  if (message.retracted || message.audio || message.pending || message.failed || message.scheduled)
    return false;
  if ((message.attachments ?? []).length > 0 || message.link)
    return false;
  const text = String(message.text || "").trim();
  return text !== "" && !LINK.test(text);
}
function tapbackArgs(guid, kind, current) {
  return ["--guid", guid, kind, ...current === kind ? ["--remove"] : [], "--yes"];
}
var SETTLE_TRIES = 8;
function pendingTapback(chat, guid, kind, current) {
  return { chat, guid, kind, remove: current === kind, done: false, tries: 0 };
}
function tapbackSettled(message, p) {
  return !!p && myTapback(message) === (p.remove ? "" : p.kind);
}
function shownTapbacks(message, p) {
  const list = message?.tapbacks ?? [];
  if (!message || !p || String(message.guid || "") !== p.guid || tapbackSettled(message, p))
    return list;
  const hit = TAPBACKS.find((t) => t.kind === p.kind);
  if (!hit)
    return list;
  const others = list.filter((t) => !(t.from_me && tapbackKind(t.emoji)));
  return [...others, { emoji: hit.emoji, from_me: true, pending: true }];
}
function pendingAfterLoad(p, chat, bubbles, startedAfterDone) {
  if (!p || p.chat !== chat)
    return p;
  const target = bubbles.find((b) => String(b.guid || "") === p.guid) ?? null;
  if (target && tapbackSettled(target, p))
    return null;
  if (!startedAfterDone)
    return p;
  if (!target || p.tries + 1 >= SETTLE_TRIES)
    return null;
  return Object.assign({}, p, { tries: p.tries + 1 });
}
var TAPBACK_NOT_STARTED = "tapback: imsg-react did not start; re-run blip-setup";
var SHIM_UNREACHABLE = "unreachable — the iMessage bridge is offline";
function tapbackFailure(code, stderr) {
  const err = String(stderr || "");
  const line = err.split(`
`).map((l) => l.trim()).filter((l) => l !== "").pop() || "";
  if (code === 255 || code === 69 && (err.includes(SHIM_UNREACHABLE) || !/^imsg-react:/m.test(err)))
    return "tapback: Mac unreachable";
  const why = line.replace(/^imsg-react:\s*/, "").slice(0, 200);
  return "tapback: " + (why || "imsg-react exit " + code);
}
export {
  SETTLE_TRIES,
  TAPBACKS,
  TAPBACK_NOT_STARTED,
  canTapback,
  initialTapbackCursor,
  moveTapbackCursor,
  myTapback,
  pendingAfterLoad,
  pendingTapback,
  shownTapbacks,
  tapbackArgs,
  tapbackFailure,
  tapbackForKey,
  tapbackKind,
  tapbackSettled,
  tapbacksOn
};
