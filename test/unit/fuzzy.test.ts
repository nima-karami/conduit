import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyScore } from '../../src/fuzzy';

describe('fuzzyScore', () => {
  it('matches subsequences case-insensitively', () => {
    expect(fuzzyScore('app', 'app/page.tsx')).not.toBeNull();
    expect(fuzzyScore('ApGe', 'app/page.tsx')).not.toBeNull();
    expect(fuzzyScore('xyz', 'app/page.tsx')).toBeNull();
  });

  it('returns the matched positions', () => {
    const m = fuzzyScore('apg', 'app/page');
    expect(m).not.toBeNull();
    expect(m?.positions).toEqual([0, 1, 6]); // a(0), p(1), g(6 — in "page")
  });

  it('empty query matches everything', () => {
    expect(fuzzyScore('', 'whatever')).toEqual({ score: 1, positions: [] });
  });
});

describe('fuzzyFilter', () => {
  const files = ['app/page.tsx', 'components/Page.tsx', 'lib/util.ts', 'README.md'];

  it('filters out non-matches and ranks matches', () => {
    const r = fuzzyFilter('page', files, (f) => f);
    expect(r.length).toBe(2);
    expect(r.map((x) => x.item)).toContain('app/page.tsx');
    expect(r.map((x) => x.item)).toContain('components/Page.tsx');
  });

  it('ranks basename matches above mid-path matches', () => {
    const r = fuzzyFilter('util', files, (f) => f);
    expect(r[0].item).toBe('lib/util.ts');
  });

  it('respects the limit', () => {
    expect(fuzzyFilter('', files, (f) => f, 2).length).toBe(2);
  });
});
