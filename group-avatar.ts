// Rebuild: bun build group-avatar.ts --target browser --format esm --outfile GroupAvatar.mjs
export function initials(value: unknown): string {
  const name = typeof value === 'string' ? value.slice(0, 160).trim() : '';
  if (!name || /^[+0-9]/.test(name) || name.includes('@')) return '#';
  const words = name.split(/\s+/);
  return (Array.from(words[0]!)[0]! + (words.length > 1 ? Array.from(words[words.length - 1]!)[0]! : '')).toUpperCase();
}

/** Bounded render model; positions are fractions of the enclosing circle. */
export function members(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const people: { handle: string; initials: string }[] = [];
  for (const person of value.slice(0, 64)) {
    if (!person || typeof person.handle !== 'string' || person.handle.length > 320
      || !/^(?:\+?\d+|[^\s@]+@[^\s@]+)$/.test(person.handle) || seen.has(person.handle)) continue;
    seen.add(person.handle);
    people.push({ handle: person.handle, initials: initials(person.name) });
    if (people.length === 4) break;
  }
  const layouts = [[], [[.18,.18,.64]], [[.1,.1,.55],[.56,.56,.34]],
    [[.27,.06,.46],[.09,.45,.46],[.45,.45,.46]],
    [[.16,.16,.34],[.51,.16,.34],[.16,.51,.34],[.51,.51,.34]]];
  return people.map((person, i) => {
    const [x,y,size] = layouts[people.length]![i]!;
    // Leave an 8% radial inset so participant circles do not hug the rim.
    const inset = .08, scale = 1 - inset * 2;
    return {handle: person.handle, initials: person.initials,
      x: inset + x! * scale, y: inset + y! * scale, size: size! * scale};
  });
}
