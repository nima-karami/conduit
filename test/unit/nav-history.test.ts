import { describe, expect, it } from 'vitest';
import {
  back,
  canBack,
  canForward,
  current,
  EMPTY_NAV,
  forward,
  NAV_STACK_CAP,
  type NavLoc,
  record,
} from '../../src/nav-history';

const loc = (sessionId: string, docId: string | null = null) => ({ sessionId, docId });

describe('navHistory', () => {
  it('records distinct locations and tracks current', () => {
    let s = record(EMPTY_NAV, loc('a'));
    s = record(s, loc('b'));
    expect(s.stack.length).toBe(2);
    expect(current(s)).toEqual(loc('b'));
  });

  it('dedupes consecutive identical locations', () => {
    let s = record(EMPTY_NAV, loc('a'));
    s = record(s, loc('a'));
    expect(s.stack.length).toBe(1);
  });

  it('moves back and forward within bounds', () => {
    let s = record(EMPTY_NAV, loc('a'));
    s = record(s, loc('b'));
    s = record(s, loc('c'));
    expect(canForward(s)).toBe(false);
    s = back(s);
    expect(current(s)).toEqual(loc('b'));
    expect(canForward(s)).toBe(true);
    s = forward(s);
    expect(current(s)).toEqual(loc('c'));
  });

  it('does not move past the ends', () => {
    const s = record(EMPTY_NAV, loc('a'));
    expect(canBack(s)).toBe(false);
    expect(back(s)).toEqual(s);
    expect(forward(s)).toEqual(s);
  });

  it('truncates forward history when recording after going back', () => {
    let s = record(EMPTY_NAV, loc('a'));
    s = record(s, loc('b'));
    s = record(s, loc('c'));
    s = back(s); // at b
    s = record(s, loc('d')); // replaces forward (c)
    expect(s.stack.map((l) => l.sessionId)).toEqual(['a', 'b', 'd']);
    expect(canForward(s)).toBe(false);
    expect(current(s)).toEqual(loc('d'));
  });

  it('treats different docId in same session as distinct locations', () => {
    let s = record(EMPTY_NAV, loc('a', null));
    s = record(s, loc('a', 'file:/x'));
    expect(s.stack.length).toBe(2);
  });

  describe('isAlive skip', () => {
    const aliveExcept =
      (...dead: string[]) =>
      (l: NavLoc) =>
        !dead.includes(l.sessionId ?? '');

    it('skips a single dead entry on back, landing on the nearest live one', () => {
      let s = record(EMPTY_NAV, loc('a'));
      s = record(s, loc('b'));
      s = record(s, loc('c')); // index 2 (c)
      s = back(s, aliveExcept('b')); // skip b → a
      expect(current(s)).toEqual(loc('a'));
      expect(s.index).toBe(0);
    });

    it('skips a run of dead entries on back', () => {
      let s = record(EMPTY_NAV, loc('a'));
      s = record(s, loc('b'));
      s = record(s, loc('c'));
      s = record(s, loc('d')); // index 3 (d)
      s = back(s, aliveExcept('b', 'c')); // skip c, b → a
      expect(current(s)).toEqual(loc('a'));
      expect(s.index).toBe(0);
    });

    it('skips a dead entry on forward', () => {
      let s = record(EMPTY_NAV, loc('a'));
      s = record(s, loc('b'));
      s = record(s, loc('c'));
      s = back(s); // index 1 (b)
      s = back(s); // index 0 (a)
      s = forward(s, aliveExcept('b')); // skip b → c
      expect(current(s)).toEqual(loc('c'));
      expect(s.index).toBe(2);
    });

    it('no-ops (index unchanged, stack intact) when every older entry is dead', () => {
      let s = record(EMPTY_NAV, loc('a'));
      s = record(s, loc('b'));
      s = record(s, loc('c')); // index 2 (c)
      const next = back(s, aliveExcept('a', 'b'));
      expect(next).toBe(s);
      expect(next.index).toBe(2);
      expect(next.stack.length).toBe(3);
    });

    it('skips multiple occurrences of a dead session', () => {
      let s = record(EMPTY_NAV, loc('a'));
      s = record(s, loc('dead', 'x'));
      s = record(s, loc('dead', 'y'));
      s = record(s, loc('c')); // index 3
      s = back(s, aliveExcept('dead')); // skip both dead → a
      expect(current(s)).toEqual(loc('a'));
      expect(s.index).toBe(0);
    });

    it('lands on the nearest live entry, leaving dead entries in the stack', () => {
      let s = record(EMPTY_NAV, loc('a'));
      s = record(s, loc('b'));
      s = record(s, loc('c'));
      const lenBefore = s.stack.length;
      s = back(s, aliveExcept('b'));
      expect(s.stack.length).toBe(lenBefore); // no prune
    });
  });

  describe('NAV_STACK_CAP', () => {
    it('caps the stack and drops the oldest, index pointing at the tip', () => {
      let s = EMPTY_NAV;
      for (let i = 0; i < NAV_STACK_CAP + 1; i++) s = record(s, loc(`s${i}`));
      expect(s.stack.length).toBe(NAV_STACK_CAP);
      expect(s.index).toBe(NAV_STACK_CAP - 1);
      expect(current(s)).toEqual(loc(`s${NAV_STACK_CAP}`));
      // The oldest (s0) was evicted; the bottom of the stack is now s1.
      expect(s.stack[0]).toEqual(loc('s1'));
    });

    it('back from the capped tip reaches exactly the 50 most-recent', () => {
      let s = EMPTY_NAV;
      for (let i = 0; i < NAV_STACK_CAP + 5; i++) s = record(s, loc(`s${i}`));
      let steps = 0;
      while (canBack(s)) {
        s = back(s);
        steps++;
      }
      expect(steps).toBe(NAV_STACK_CAP - 1);
      expect(current(s)).toEqual(loc('s5')); // s0..s4 evicted
    });
  });
});
