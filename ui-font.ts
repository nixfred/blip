/**
 * Blip-only type size, from `ui_font_size=N` in bridge.conf.
 * 0 = follow Omarchy's Style.font tokens (today: bubbles at body, 12px at the
 *     default base-size).
 * N = pixel size of bubble text, the `body` step; bodySmall and caption keep
 *     the same ratios to it. (Anchored to bodySmall until the body-led ramp of
 *     #170, when bubbles moved up a step: the anchor moved with them, so an
 *     existing `ui_font_size=14` still means 14px bubbles.)
 */
export const UI_FONT_SIZE_MIN = 9;
export const UI_FONT_SIZE_MAX = 24;

export function parseUiFontSize(conf: string): number {
  const m = String(conf || "").match(/^\s*ui_font_size\s*=\s*['"]?(\d+)/im);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(UI_FONT_SIZE_MAX, Math.max(UI_FONT_SIZE_MIN, Math.round(n)));
}

/** Scale one Style.font token so the anchor token (body) lands on `want` pixels. */
export function scaleFontPx(stylePx: number, want: number, styleAnchor: number): number {
  if (!(want > 0) || !(styleAnchor > 0)) return Math.max(1, Math.round(stylePx));
  return Math.max(1, Math.round(stylePx * (want / styleAnchor)));
}
