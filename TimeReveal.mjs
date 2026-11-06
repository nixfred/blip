// time-reveal.ts
var COMMIT_PX = 10;
var X_DOMINANCE = 1.5;
var HOLD_OPEN_MS = 1400;
var ABANDON_MS = 160;
function idleGesture() {
  return { axis: "", x: 0, y: 0 };
}
function routeWheel(gesture, dx, dy) {
  const x = Number.isFinite(dx) ? dx : 0;
  const y = Number.isFinite(dy) ? dy : 0;
  if (gesture.axis === "x")
    return { gesture, dx: x, dy: 0 };
  if (gesture.axis === "y")
    return { gesture, dx: 0, dy: y };
  const sumX = gesture.x + x;
  const sumY = gesture.y + y;
  if (Math.abs(sumX) >= COMMIT_PX && Math.abs(sumX) > Math.abs(sumY) * X_DOMINANCE)
    return { gesture: { axis: "x", x: sumX, y: sumY }, dx: sumX, dy: 0 };
  if (Math.abs(sumY) >= COMMIT_PX && Math.abs(sumY) >= Math.abs(sumX))
    return { gesture: { axis: "y", x: sumX, y: sumY }, dx: 0, dy: y };
  return { gesture: { axis: "", x: sumX, y: sumY }, dx: 0, dy: y };
}
function nextOffset(offset, dx, maxOffset) {
  const max = Number.isFinite(maxOffset) && maxOffset > 0 ? maxOffset : 0;
  const next = (Number.isFinite(offset) ? offset : 0) - (Number.isFinite(dx) ? dx : 0);
  return Math.max(0, Math.min(max, next));
}
function settleDelay(offset, maxOffset) {
  return maxOffset > 0 && offset >= maxOffset / 2 ? HOLD_OPEN_MS : ABANDON_MS;
}
export {
  ABANDON_MS,
  HOLD_OPEN_MS,
  idleGesture,
  nextOffset,
  routeWheel,
  settleDelay
};
