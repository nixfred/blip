/**
 * Blip-only scroll gain, from bridge.conf. Two keys, both default 1.0:
 *
 *   scroll_gain=0.25            wheel: multiplies angleDelta (120 per notch)
 *   touchpad_scroll_gain=0.5    touchpad: multiplies pixelDelta
 *
 * 1.0 applies the delta the compositor delivers, which already carries
 * Hyprland's input:scroll_factor / input:touchpad:scroll_factor (#114). The
 * keys exist because one physical click of a hi-res wheel can be several
 * notches: an MX Master 4 sends four per click (measured 2026-09-25), so at
 * 1:1 one click moved 480 px in a 609 px window. They are separate because a
 * touchpad usually has its own compositor factor already.
 *
 * BarWidget.qml carries the same regex; this module is the tested twin.
 */
export const SCROLL_GAIN_MIN = 0.05;
export const SCROLL_GAIN_MAX = 10;

function parseGain(conf: string, key: string): number {
  const re = new RegExp("^\\s*" + key + "\\s*=\\s*['\"]?(\\d*\\.?\\d+)", "im");
  const m = String(conf || "").match(re);
  if (!m) return 1;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(SCROLL_GAIN_MAX, Math.max(SCROLL_GAIN_MIN, n));
}

/** `scroll_gain=` → wheel multiplier; unset, empty or nonsense → 1. */
export function parseScrollGain(conf: string): number {
  return parseGain(conf, "scroll_gain");
}

/** `touchpad_scroll_gain=` → touchpad multiplier; unset → 1. */
export function parseTouchpadScrollGain(conf: string): number {
  return parseGain(conf, "touchpad_scroll_gain");
}
