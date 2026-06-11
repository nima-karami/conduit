import { describe, expect, it } from 'vitest';
import { isDirty, nextDirtySet } from '../../webview/dirty-state';

describe('isDirty', () => {
  it('is clean when buffer equals the on-disk baseline', () => {
    expect(isDirty('hello', 'hello')).toBe(false);
  });
  it('is dirty when buffer differs from the baseline', () => {
    expect(isDirty('hello', 'hello!')).toBe(true);
  });
  it('treats whitespace-only changes as dirty', () => {
    expect(isDirty('a', 'a ')).toBe(true);
  });
});

describe('nextDirtySet', () => {
  it('adds a path when its buffer diverges from disk', () => {
    const next = nextDirtySet(new Set(), '/f.ts', 'disk', 'edited');
    expect(next.has('/f.ts')).toBe(true);
  });

  it('removes a path once its buffer matches disk again (e.g. after save)', () => {
    const start = new Set(['/f.ts']);
    const next = nextDirtySet(start, '/f.ts', 'saved', 'saved');
    expect(next.has('/f.ts')).toBe(false);
  });

  it('clears dirty when an edit is undone back to the baseline', () => {
    const start = new Set(['/f.ts']);
    const next = nextDirtySet(start, '/f.ts', 'original', 'original');
    expect(next.has('/f.ts')).toBe(false);
  });

  it('returns the SAME set reference when membership does not change (no-op edit)', () => {
    const start = new Set<string>();
    // baseline === buffer and path already absent -> no change.
    expect(nextDirtySet(start, '/f.ts', 'x', 'x')).toBe(start);
    const dirty = new Set(['/f.ts']);
    // still dirty and already present -> no change.
    expect(nextDirtySet(dirty, '/f.ts', 'x', 'y')).toBe(dirty);
  });

  it('does not disturb other paths in the set', () => {
    const start = new Set(['/a.ts']);
    const next = nextDirtySet(start, '/b.ts', 'disk', 'edited');
    expect([...next].sort()).toEqual(['/a.ts', '/b.ts']);
  });
});
