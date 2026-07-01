import { describe, expect, it } from 'vitest';
import { findTextMatches, MdFindController } from '../../webview/md-find';

// A flattened rendered-markdown string (the TreeWalker join the viewer produces).
const TEXT = 'Conduit renders Conduit docs.\nThe final Conduit line.';

describe('findTextMatches', () => {
  it('returns matches in reading order', () => {
    const m = findTextMatches(TEXT, 'conduit');
    expect(m.map((x) => x.start)).toEqual([0, 16, 40]);
  });

  it('reports correct start/end offsets', () => {
    const [m] = findTextMatches('xxConduit', 'conduit');
    expect(m).toEqual({ start: 2, end: 9 });
  });

  it('is case-insensitive', () => {
    expect(findTextMatches('CoNdUiT here', 'conduit')).toHaveLength(1);
    expect(findTextMatches('conduit here', 'CONDUIT')).toHaveLength(1);
  });

  it('returns no matches for an empty or whitespace-only query', () => {
    expect(findTextMatches(TEXT, '')).toEqual([]);
    expect(findTextMatches(TEXT, '   ')).toEqual([]);
  });

  it('returns no matches when the term is absent', () => {
    expect(findTextMatches(TEXT, 'zzz')).toEqual([]);
  });

  it('does not return overlapping matches (resumes after each hit)', () => {
    expect(findTextMatches('aaaa', 'aa')).toHaveLength(2);
  });

  it('matches at string boundaries', () => {
    const m = findTextMatches('abcabc', 'abc');
    expect(m).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 6 },
    ]);
  });

  it('matches across newlines in multi-line text', () => {
    expect(findTextMatches('one\ntwo\nthree', 'two')).toEqual([{ start: 4, end: 7 }]);
  });

  it('is Unicode-safe over JS string semantics (case-folds accented letters)', () => {
    const m = findTextMatches('café CAFÉ café', 'café');
    expect(m).toHaveLength(3);
  });
});

describe('MdFindController cycling', () => {
  it('search sets the active match to the first result', () => {
    const c = new MdFindController();
    c.search(TEXT, 'conduit');
    expect(c.count).toBe(3);
    expect(c.activeOrdinal).toBe(1);
    expect(c.active()).toEqual({ start: 0, end: 7 });
  });

  it('next() advances and wraps after the last match', () => {
    const c = new MdFindController();
    c.search(TEXT, 'conduit');
    expect(c.next()?.start).toBe(16);
    expect(c.activeOrdinal).toBe(2);
    expect(c.next()?.start).toBe(40);
    expect(c.activeOrdinal).toBe(3);
    expect(c.next()?.start).toBe(0); // wraps
    expect(c.activeOrdinal).toBe(1);
  });

  it('prev() steps back and wraps before the first match', () => {
    const c = new MdFindController();
    c.search(TEXT, 'conduit');
    expect(c.prev()?.start).toBe(40); // wraps to last
    expect(c.activeOrdinal).toBe(3);
    expect(c.prev()?.start).toBe(16);
    expect(c.activeOrdinal).toBe(2);
  });

  it('zero results leaves no active match and next/prev are no-ops', () => {
    const c = new MdFindController();
    c.search(TEXT, 'zzz');
    expect(c.count).toBe(0);
    expect(c.activeOrdinal).toBe(0);
    expect(c.active()).toBeNull();
    expect(c.next()).toBeNull();
    expect(c.prev()).toBeNull();
  });

  it('re-searching replaces matches and resets the cursor', () => {
    const c = new MdFindController();
    c.search(TEXT, 'conduit');
    c.next();
    c.search(TEXT, 'final');
    expect(c.count).toBe(1);
    expect(c.activeOrdinal).toBe(1);
    expect(c.active()).toEqual({ start: 34, end: 39 });
  });
});
