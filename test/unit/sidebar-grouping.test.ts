import { describe, expect, it } from 'vitest';
import {
  dropResolvesToManual,
  moveBefore,
  reorderByGroup,
  reorderPersists,
  sortedCanonical,
  toggleCollapsed,
} from '../../src/reorder';
import type { Session } from '../../src/types';

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

// ── test fixtures ─────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    name: overrides.id,
    agentId: 'shell:cmd',
    projectPath: '/proj',
    status: 'running',
    createdAt: 0,
    lastActiveAt: 0,
    ...overrides,
  };
}

function makeMap(...sessions: Session[]): Map<string, Session> {
  return new Map(sessions.map((s) => [s.id, s]));
}

// ── sortedCanonical ──────────────────────────────────────────────────────────

describe('sortedCanonical', () => {
  it('manual: returns ids in the given order unchanged', () => {
    const s1 = makeSession({ id: 's1', name: 'zoo' });
    const s2 = makeSession({ id: 's2', name: 'ant' });
    const map = makeMap(s1, s2);
    expect(sortedCanonical(['s1', 's2'], 'manual', map)).toEqual(['s1', 's2']);
  });

  it('name: sorts by session name A-Z', () => {
    const s1 = makeSession({ id: 's1', name: 'zoo' });
    const s2 = makeSession({ id: 's2', name: 'ant' });
    const map = makeMap(s1, s2);
    expect(sortedCanonical(['s1', 's2'], 'name', map)).toEqual(['s2', 's1']);
  });

  it('recent: sorts by createdAt descending', () => {
    const s1 = makeSession({ id: 's1', createdAt: 100 });
    const s2 = makeSession({ id: 's2', createdAt: 200 });
    const map = makeMap(s1, s2);
    expect(sortedCanonical(['s1', 's2'], 'recent', map)).toEqual(['s2', 's1']);
  });

  it('active: sorts by lastActiveAt descending, name as tiebreaker', () => {
    const s1 = makeSession({ id: 's1', name: 'b', lastActiveAt: 100 });
    const s2 = makeSession({ id: 's2', name: 'a', lastActiveAt: 100 });
    const map = makeMap(s1, s2);
    expect(sortedCanonical(['s1', 's2'], 'active', map)).toEqual(['s2', 's1']);
  });

  it('status: sorts by running < stale < exited, name as tiebreaker', () => {
    const s1 = makeSession({ id: 's1', name: 'a', status: 'exited' });
    const s2 = makeSession({ id: 's2', name: 'b', status: 'running' });
    const s3 = makeSession({ id: 's3', name: 'c', status: 'stale' });
    const map = makeMap(s1, s2, s3);
    expect(sortedCanonical(['s1', 's3', 's2'], 'status', map)).toEqual(['s2', 's3', 's1']);
  });

  it('project: sorts by project basename A-Z then name', () => {
    const s1 = makeSession({ id: 's1', name: 'a', projectPath: '/zoo' });
    const s2 = makeSession({ id: 's2', name: 'b', projectPath: '/ant' });
    const map = makeMap(s1, s2);
    // /ant < /zoo by basename, so s2 (ant) sorts first
    expect(sortedCanonical(['s1', 's2'], 'project', map)).toEqual(['s2', 's1']);
  });

  it('skips ids not present in the map', () => {
    const s1 = makeSession({ id: 's1', name: 'a' });
    const map = makeMap(s1);
    // 'missing' is silently dropped
    expect(sortedCanonical(['s1', 'missing'], 'name', map)).toEqual(['s1']);
  });

  it('does not mutate the input ids array', () => {
    const ids = ['s2', 's1'];
    const s1 = makeSession({ id: 's1', name: 'ant' });
    const s2 = makeSession({ id: 's2', name: 'zoo' });
    sortedCanonical(ids, 'name', makeMap(s1, s2));
    expect(ids).toEqual(['s2', 's1']);
  });
});

// ── dropResolvesToManual ──────────────────────────────────────────────────────

describe('dropResolvesToManual', () => {
  it('returns false when candidate equals canonical', () => {
    expect(dropResolvesToManual(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(false);
  });

  it('returns true when candidate differs in order', () => {
    expect(dropResolvesToManual(['b', 'a', 'c'], ['a', 'b', 'c'])).toBe(true);
  });

  it('returns true when lengths differ', () => {
    expect(dropResolvesToManual(['a', 'b'], ['a', 'b', 'c'])).toBe(true);
  });

  it('returns true for a single transposition', () => {
    expect(dropResolvesToManual(['a', 'c', 'b'], ['a', 'b', 'c'])).toBe(true);
  });

  it('returns false for identical single-element arrays', () => {
    expect(dropResolvesToManual(['a'], ['a'])).toBe(false);
  });

  it('returns false for empty arrays', () => {
    expect(dropResolvesToManual([], [])).toBe(false);
  });
});

// ── reorderPersists ───────────────────────────────────────────────────────────

describe('reorderPersists', () => {
  it('manual: a card move that changes the rendered order persists', () => {
    const s1 = makeSession({ id: 's1' });
    const s2 = makeSession({ id: 's2' });
    const s3 = makeSession({ id: 's3' });
    const map = makeMap(s1, s2, s3);
    const current = ['s1', 's2', 's3'];
    const candidate = moveBefore(current, 's3', 's1'); // [s3, s1, s2]
    expect(reorderPersists(candidate, current, 'manual', map)).toBe(true);
  });

  it('manual: a whole-group move that changes the rendered order persists', () => {
    const s1 = makeSession({ id: 's1', projectPath: '/a' });
    const s2 = makeSession({ id: 's2', projectPath: '/b' });
    const map = makeMap(s1, s2);
    const groupOf = (id: string) => map.get(id)?.projectPath ?? '';
    const current = ['s1', 's2'];
    const candidate = reorderByGroup(current, groupOf, '/a', null); // [s2, s1]
    expect(reorderPersists(candidate, current, 'manual', map)).toBe(true);
  });

  it('manual: a no-op move (candidate === current) does not persist', () => {
    const s1 = makeSession({ id: 's1' });
    const s2 = makeSession({ id: 's2' });
    const map = makeMap(s1, s2);
    const current = ['s1', 's2'];
    expect(reorderPersists(['s1', 's2'], current, 'manual', map)).toBe(false);
  });

  it('name sort: candidate already in sort order does not persist', () => {
    const s1 = makeSession({ id: 's1', name: 'ant' });
    const s2 = makeSession({ id: 's2', name: 'bee' });
    const map = makeMap(s1, s2);
    // candidate is already in name-sorted order → no-op, does not persist
    expect(reorderPersists(['s1', 's2'], ['s1', 's2'], 'name', map)).toBe(false);
  });

  it('name sort: candidate deviating from sort order persists (switch to manual)', () => {
    const s1 = makeSession({ id: 's1', name: 'ant' });
    const s2 = makeSession({ id: 's2', name: 'bee' });
    const map = makeMap(s1, s2);
    // dragging bee before ant deviates from the name-sorted canonical [s1, s2]
    expect(reorderPersists(['s2', 's1'], ['s1', 's2'], 'name', map)).toBe(true);
  });
});

// ── commit-builder integration ────────────────────────────────────────────────
// Verifies that the card-drop and group-drop builders produce the right outcome
// across sort modes (the "commit logic" from the spec).

describe('card-commit builder (moveBefore + dropResolvesToManual)', () => {
  const s1 = makeSession({ id: 's1', name: 'ant' });
  const s2 = makeSession({ id: 's2', name: 'bee' });
  const s3 = makeSession({ id: 's3', name: 'zoo' });
  const map = makeMap(s1, s2, s3);
  const renderedIds = ['s1', 's2', 's3']; // in name-sorted rendered order

  it('manual: a same-pos drop is a no-op (no switch)', () => {
    const candidate = moveBefore(['s1', 's2', 's3'], 's1', 's2');
    // s1→before s2 in [s1,s2,s3] puts s1 before s2 — no real change
    const canonical = sortedCanonical(['s1', 's2', 's3'], 'manual', map);
    expect(dropResolvesToManual(candidate, canonical)).toBe(false);
  });

  it('name sort: a violating drop switches to manual', () => {
    // Drag s1 (ant) after s3 (zoo): rendered order becomes [s2, s3, s1]
    const candidate = moveBefore(renderedIds, 's1', null); // null = end
    const canonical = sortedCanonical(renderedIds, 'name', map);
    expect(candidate).toEqual(['s2', 's3', 's1']);
    expect(dropResolvesToManual(candidate, canonical)).toBe(true);
  });

  it('name sort: dropping onto canonical position is a no-op', () => {
    // [s1, s2, s3] is already the name-sorted order; moving s2 before s3 is a no-op
    const candidate = moveBefore(renderedIds, 's2', 's3');
    const canonical = sortedCanonical(renderedIds, 'name', map);
    expect(candidate).toEqual(['s1', 's2', 's3']);
    expect(dropResolvesToManual(candidate, canonical)).toBe(false);
  });
});

describe('group-commit builder (reorderByGroup + dropResolvesToManual)', () => {
  const s1 = makeSession({ id: 's1', projectPath: '/ant', name: 'x' });
  const s2 = makeSession({ id: 's2', projectPath: '/bee', name: 'y' });
  const s3 = makeSession({ id: 's3', projectPath: '/zoo', name: 'z' });
  const map = makeMap(s1, s2, s3);
  const groupOf = (id: string) => map.get(id)?.projectPath ?? '';
  const renderedIds = ['s1', 's2', 's3']; // in project-name sorted order

  it('project sort: dragging group out of order switches to manual', () => {
    // Move /ant group after /zoo: [s2, s3, s1]
    const candidate = reorderByGroup(renderedIds, groupOf, '/ant', null);
    const canonical = sortedCanonical(renderedIds, 'project', map);
    expect(candidate).toEqual(['s2', 's3', 's1']);
    expect(dropResolvesToManual(candidate, canonical)).toBe(true);
  });

  it('project sort: dropping group onto own position is a no-op', () => {
    const candidate = reorderByGroup(renderedIds, groupOf, '/ant', '/ant');
    const canonical = sortedCanonical(renderedIds, 'project', map);
    // reorderByGroup no-ops when drag===target and returns same ref
    expect(candidate).toBe(renderedIds);
    expect(dropResolvesToManual(candidate, canonical)).toBe(false);
  });
});
