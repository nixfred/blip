/** Sideways-swipe gesture behind the Messages-style timestamp reveal.
 *
 *  Wheel events carry no "fingers down" signal on this stack, so a gesture is
 *  a burst of events: the QML side resets it after a short idle. One burst
 *  commits to one axis, so a vertical scroll with some sideways drift never
 *  nudges the transcript and a sideways swipe never scrolls it. */
export interface WheelGesture { axis: "" | "x" | "y"; x: number; y: number }
export interface WheelRoute { gesture: WheelGesture; dx: number; dy: number }

const COMMIT_PX = 10;
const X_DOMINANCE = 1.5;
/** How long a swipe stays open once the events stop, so the times can be read. */
export const HOLD_OPEN_MS = 1400;
/** A partial swipe that was abandoned closes almost immediately. */
export const ABANDON_MS = 160;

export function idleGesture(): WheelGesture { return { axis: "", x: 0, y: 0 }; }

/** Route one wheel delta. Vertical passes through until the burst commits to
 *  sideways, keeping scrolling 1:1; sideways is withheld until it commits. */
export function routeWheel(gesture: WheelGesture, dx: number, dy: number): WheelRoute {
  const x = Number.isFinite(dx) ? dx : 0;
  const y = Number.isFinite(dy) ? dy : 0;
  if (gesture.axis === "x") return { gesture, dx: x, dy: 0 };
  if (gesture.axis === "y") return { gesture, dx: 0, dy: y };
  const sumX = gesture.x + x;
  const sumY = gesture.y + y;
  if (Math.abs(sumX) >= COMMIT_PX && Math.abs(sumX) > Math.abs(sumY) * X_DOMINANCE)
    return { gesture: { axis: "x", x: sumX, y: sumY }, dx: sumX, dy: 0 };
  if (Math.abs(sumY) >= COMMIT_PX && Math.abs(sumY) >= Math.abs(sumX))
    return { gesture: { axis: "y", x: sumX, y: sumY }, dx: 0, dy: y };
  return { gesture: { axis: "", x: sumX, y: sumY }, dx: 0, dy: y };
}

/** A negative Qt x delta moves content left, which is the reveal direction. The
 *  sign is the delta's rather than the fingers', so it honors natural scrolling. */
export function nextOffset(offset: number, dx: number, maxOffset: number): number {
  const max = Number.isFinite(maxOffset) && maxOffset > 0 ? maxOffset : 0;
  const next = (Number.isFinite(offset) ? offset : 0) - (Number.isFinite(dx) ? dx : 0);
  return Math.max(0, Math.min(max, next));
}

export function settleDelay(offset: number, maxOffset: number): number {
  return maxOffset > 0 && offset >= maxOffset / 2 ? HOLD_OPEN_MS : ABANDON_MS;
}
