import { describe, expect, it } from 'vitest';
import { moveBefore, toggleCollapsed } from '../../src/reorder';

// ── collapse set helpers ──────────────────────────────────────────────────────

describe('toggleCollapsed', () => {
  it('adds a path that is not present', () => {
    expect(toggleCollapsed([], '/a')).toEqual(['/a']);
    expect(toggleCollapsed(['/b'], '/a')).toEqual(['/b', '/a']);
  });

  it('removes a path that is already present', () => {
    expect(toggleCollapsed(['/a'], '/a')).toEqual([]);
    expect(toggleCollapsed(['/a', '/b'], '/a')).toEqual(['/b']);
  });

  it('is idempotent: adding then removing returns the original set', () => {
    const after = toggleCollapsed(toggleCollapsed(['/a'], '/b'), '/b');
    expect(after).toEqual(['/a']);
  });

  it('does not mutate the input array', () => {
    const orig = ['/a'];
    toggleCollapsed(orig, '/b');
    expect(orig).toEqual(['/a']);
  });
});

describe('moveBefore', () => {
  const ids = ['s1', 's2', 's3'];

  it('moves an id to just before the target', () => {
    expect(moveBefore(ids, 's3', 's1')).toEqual(['s3', 's1', 's2']);
    expect(moveBefore(ids, 's1', 's2')).toEqual(['s1', 's2', 's3']);
  });

  it('a null or absent target moves it to the end', () => {
    expect(moveBefore(ids, 's1', null)).toEqual(['s2', 's3', 's1']);
    expect(moveBefore(ids, 's1', 'nope')).toEqual(['s2', 's3', 's1']);
  });

  it('is a no-op for a self-drop or an absent id', () => {
    expect(moveBefore(ids, 's2', 's2')).toBe(ids);
    expect(moveBefore(ids, 'nope', 's1')).toBe(ids);
  });
});
