import {test, expect} from 'bun:test';
import {initials, members} from './group-avatar';
test('initials use full names and keep unknown handles neutral', () => {
  expect(initials('Sam Smith')).toBe('SS');
  expect(initials('Bill Nelson')).toBe('BN');
  expect(initials('Pat')).toBe('P');
  expect(initials('+15551234567')).toBe('#');
  expect(initials('you@example.com')).toBe('#');
  expect(initials(null)).toBe('#');
});
test('composites select at most four distinct valid participants', () => {
  const people = Array.from({length: 8}, (_,i) => ({handle: `person${i}@example.com`,name: 'Sam Smith'}));
  const result = members([null, {}, {handle:'chat123'},people[0],...people]);
  expect(result).toHaveLength(4);
  expect(result.map(p => p.handle)).toEqual(people.slice(0,4).map(p => p.handle));
  expect(result.every(p => p.initials === 'SS')).toBe(true);
  expect(members({})).toEqual([]);
});
test('all one-to-four-member layouts leave breathing room inside the circular avatar', () => {
  for(let count=1; count<=4; count++) {
    for(const p of members(Array.from({length:count},(_,i)=>({handle:`p${i}@example.com`,name:'Pat'})))) {
      expect(Math.hypot(p.x!+p.size!/2-.5,p.y!+p.size!/2-.5)+p.size!/2).toBeLessThanOrEqual(.42);
    }
  }
});
