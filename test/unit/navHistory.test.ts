import { describe, expect, it } from 'vitest';
import {
  back,
  canBack,
  canForward,
  current,
  EMPTY_NAV,
  forward,
  record,
} from '../../src/navHistory';

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
});
