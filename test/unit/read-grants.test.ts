import { describe, expect, it } from 'vitest';
import { createGrantStore } from '../../src/read-grants';

// A deterministic canonicalizer for tests: lower-case + strip a trailing slash, so
// we can exercise the "two spellings of the same file collapse to one grant" path
// without touching the real filesystem.
const lc = (p: string) => p.toLowerCase().replace(/\/+$/, '');

describe('createGrantStore — add / has', () => {
  it('grants a file it was told to add', () => {
    const g = createGrantStore({ canonical: lc });
    g.add('/work/a.ts');
    expect(g.has('/work/a.ts')).toBe(true);
  });

  it('does not grant a path that was never added', () => {
    const g = createGrantStore({ canonical: lc });
    g.add('/work/a.ts');
    expect(g.has('/work/b.ts')).toBe(false);
  });

  it('canonicalizes on BOTH add and has, so two spellings of one file collide', () => {
    const g = createGrantStore({ canonical: lc });
    g.add('/Work/A.TS');
    // Different surface spelling, same canonical path -> granted.
    expect(g.has('/work/a.ts')).toBe(true);
  });

  it('reports its size (distinct canonical entries only)', () => {
    const g = createGrantStore({ canonical: lc });
    g.add('/work/a.ts');
    g.add('/WORK/A.TS'); // same canonical -> not a new entry
    g.add('/work/b.ts');
    expect(g.size).toBe(2);
  });
});

describe('createGrantStore — bounded cap + eviction', () => {
  it('evicts the OLDEST grant when the cap is exceeded (fail-closed)', () => {
    const g = createGrantStore({ canonical: lc, cap: 2 });
    g.add('/a');
    g.add('/b');
    g.add('/c'); // exceeds cap of 2 -> oldest (/a) evicted
    expect(g.has('/a')).toBe(false);
    expect(g.has('/b')).toBe(true);
    expect(g.has('/c')).toBe(true);
    expect(g.size).toBe(2);
  });

  it('re-adding an existing grant refreshes its recency (LRU-lite)', () => {
    const g = createGrantStore({ canonical: lc, cap: 2 });
    g.add('/a');
    g.add('/b');
    g.add('/a'); // touch /a -> now /b is the oldest
    g.add('/c'); // evicts the oldest, which is now /b
    expect(g.has('/a')).toBe(true);
    expect(g.has('/b')).toBe(false);
    expect(g.has('/c')).toBe(true);
  });

  it('never grows beyond the cap under churn', () => {
    const g = createGrantStore({ canonical: lc, cap: 3 });
    for (let i = 0; i < 50; i++) g.add(`/f${i}`);
    expect(g.size).toBe(3);
    // Only the last 3 added survive.
    expect(g.has('/f49')).toBe(true);
    expect(g.has('/f48')).toBe(true);
    expect(g.has('/f47')).toBe(true);
    expect(g.has('/f46')).toBe(false);
  });

  it('defaults to a sane cap when none is supplied', () => {
    const g = createGrantStore({ canonical: lc });
    for (let i = 0; i < 600; i++) g.add(`/f${i}`);
    // Default cap is 500; oldest 100 evicted.
    expect(g.size).toBe(500);
    expect(g.has('/f599')).toBe(true);
    expect(g.has('/f99')).toBe(false);
  });
});
