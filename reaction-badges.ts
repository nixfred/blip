/** Bounded contents for the reaction balloon; placed decorations stay separate. */
export interface BadgeEntry { emoji?: string; sticker?: any; count?: number }
export function badgeEntries(tapbacks: any[] | undefined, stickers: any[] | undefined, capacity: number): BadgeEntry[] {
  // QML model roles may expose QVariantList as an array-like sequence, for
  // which Array.isArray is false even though indexing and length work.
  const sequence = (value: any) => value && typeof value.length === "number"
    ? Array.prototype.slice.call(value, 0, 256) : [];
  const entries: BadgeEntry[] = sequence(tapbacks)
    .filter(t => t && typeof t.emoji === "string" && t.emoji !== "")
    .map(t => ({ emoji: t.emoji }));
  for (const sticker of sequence(stickers))
    if (sticker && sticker.reaction === true && sticker.attachment) entries.push({ sticker });
  const limit = Math.max(1, Math.min(5, Number.isFinite(capacity) ? Math.floor(capacity) : 1));
  if (entries.length <= limit) return entries;
  if (limit === 1) return [{ count: entries.length }];
  return entries.slice(0, limit - 1).concat([{ count: entries.length - limit + 1 }]);
}
