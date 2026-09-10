// group-avatar.ts
function initials(value) {
  const name = typeof value === "string" ? value.slice(0, 160).trim() : "";
  if (!name || /^[+0-9]/.test(name) || name.includes("@"))
    return "#";
  const words = name.split(/\s+/);
  return (Array.from(words[0])[0] + (words.length > 1 ? Array.from(words[words.length - 1])[0] : "")).toUpperCase();
}
function members(value) {
  if (!Array.isArray(value))
    return [];
  const seen = new Set;
  const people = [];
  for (const person of value.slice(0, 64)) {
    if (!person || typeof person.handle !== "string" || person.handle.length > 320 || !/^(?:\+?\d+|[^\s@]+@[^\s@]+)$/.test(person.handle) || seen.has(person.handle))
      continue;
    seen.add(person.handle);
    people.push({ handle: person.handle, initials: initials(person.name) });
    if (people.length === 4)
      break;
  }
  const layouts = [
    [],
    [[0.18, 0.18, 0.64]],
    [[0.1, 0.1, 0.55], [0.56, 0.56, 0.34]],
    [[0.27, 0.06, 0.46], [0.09, 0.45, 0.46], [0.45, 0.45, 0.46]],
    [[0.16, 0.16, 0.34], [0.51, 0.16, 0.34], [0.16, 0.51, 0.34], [0.51, 0.51, 0.34]]
  ];
  return people.map((person, i) => {
    const [x, y, size] = layouts[people.length][i];
    const inset = 0.08, scale = 1 - inset * 2;
    return {
      handle: person.handle,
      initials: person.initials,
      x: inset + x * scale,
      y: inset + y * scale,
      size: size * scale
    };
  });
}
export {
  members,
  initials
};
