// Which bar widget leads: owns the app window, the collector and IPC.
// Pure so the QML binding and the tests agree on one answer.
// Rebuild the QML module: bun build screen-leader.ts --target browser --format esm --outfile ScreenLeader.mjs

export interface ScreenLike {
  name?: unknown;
  width?: unknown;
  height?: unknown;
}

/** A real output, not Qt's placeholder. With every monitor gone (a display
 *  powered off, or one that drops off DisplayPort when it sleeps) Qt invents a
 *  placeholder screen with no name and no size, and Omarchy builds a bar on it. */
export function isRealScreen(screen: ScreenLike | null | undefined): boolean {
  return !!screen && typeof screen.name === "string" && screen.name !== ""
    && Number(screen.width) > 0 && Number(screen.height) > 0;
}

/** The widget on the first real screen leads. An unresolved widget (own is
 *  null) leads only when there is exactly one real screen, so hotplugged bars
 *  do not race. With no real screen, nobody leads: a leader restores the app
 *  window, and mapping it with no output crashes Hyprland 0.56. */
export function isLeader(own: ScreenLike | null | undefined, screens: ArrayLike<ScreenLike | null | undefined>): boolean {
  const real: ScreenLike[] = [];
  for (let i = 0; i < screens.length; i++) if (isRealScreen(screens[i])) real.push(screens[i]!);
  if (real.length === 0) return false;
  if (own) return isRealScreen(own) && String(own.name) === String(real[0]!.name);
  return real.length === 1;
}
