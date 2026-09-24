// screen-leader.ts
function isRealScreen(screen) {
  return !!screen && typeof screen.name === "string" && screen.name !== "" && Number(screen.width) > 0 && Number(screen.height) > 0;
}
function isLeader(own, screens) {
  const real = [];
  for (let i = 0;i < screens.length; i++)
    if (isRealScreen(screens[i]))
      real.push(screens[i]);
  if (real.length === 0)
    return false;
  if (own)
    return isRealScreen(own) && String(own.name) === String(real[0].name);
  return real.length === 1;
}
export {
  isLeader,
  isRealScreen
};
