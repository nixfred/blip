// reaction-badges.ts
function badgeEntries(tapbacks, stickers, capacity) {
  const sequence = (value) => value && typeof value.length === "number" ? Array.prototype.slice.call(value, 0, 256) : [];
  const entries = sequence(tapbacks).filter((t) => t && typeof t.emoji === "string" && t.emoji !== "").map((t) => ({ emoji: t.emoji }));
  for (const sticker of sequence(stickers))
    if (sticker && sticker.reaction === true && sticker.attachment)
      entries.push({ sticker });
  const limit = Math.max(1, Math.min(5, Number.isFinite(capacity) ? Math.floor(capacity) : 1));
  if (entries.length <= limit)
    return entries;
  if (limit === 1)
    return [{ count: entries.length }];
  return entries.slice(0, limit - 1).concat([{ count: entries.length - limit + 1 }]);
}
export {
  badgeEntries
};
