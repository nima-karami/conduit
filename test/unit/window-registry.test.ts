import { describe, expect, it } from 'vitest';
import type { Session } from '../../src/types';
import {
  assignOwner,
  groupByProject,
  type OwnerMap,
  ownerOf,
  removeOwner,
  sessionsForWindow,
} from '../../src/window-registry';

function s(id: string, projectPath = `/proj/${id}`): Session {
  return {
    id,
    name: id,
    agentId: 'shell:cmd',
    projectPath,
    status: 'running',
    createdAt: 0,
    lastActiveAt: 0,
  };
}

describe('window-registry ownership', () => {
  it('assigns, reads, and removes owners', () => {
    const owners: OwnerMap = new Map();
    assignOwner(owners, 'a', 1);
    assignOwner(owners, 'b', 2);
    expect(ownerOf(owners, 'a')).toBe(1);
    expect(ownerOf(owners, 'b')).toBe(2);
    expect(ownerOf(owners, 'missing')).toBeUndefined();

    removeOwner(owners, 'a');
    expect(ownerOf(owners, 'a')).toBeUndefined();
  });

  it('reassigning an owner overwrites the prior window (Slice B move builds on this)', () => {
    const owners: OwnerMap = new Map();
    assignOwner(owners, 'a', 1);
    assignOwner(owners, 'a', 2);
    expect(ownerOf(owners, 'a')).toBe(2);
  });
});

describe('sessionsForWindow', () => {
  it('filters to the sessions a window owns, preserving input order', () => {
    const owners: OwnerMap = new Map([
      ['a', 1],
      ['b', 2],
      ['c', 1],
    ]);
    const all = [s('a'), s('b'), s('c')];
    expect(sessionsForWindow(owners, 1, all).map((x) => x.id)).toEqual(['a', 'c']);
    expect(sessionsForWindow(owners, 2, all).map((x) => x.id)).toEqual(['b']);
  });

  it('returns an empty list for a window that owns nothing', () => {
    const owners: OwnerMap = new Map([['a', 1]]);
    expect(sessionsForWindow(owners, 99, [s('a')])).toEqual([]);
  });

  it('isolation: a session owned by window 2 never appears in window 1', () => {
    const owners: OwnerMap = new Map([
      ['a', 1],
      ['b', 2],
    ]);
    const all = [s('a'), s('b')];
    const w1 = sessionsForWindow(owners, 1, all).map((x) => x.id);
    expect(w1).toContain('a');
    expect(w1).not.toContain('b');
  });
});

describe('groupByProject (per-window)', () => {
  it('groups only the sessions it is given (the per-window filtered list)', () => {
    const sessions = [s('a', '/p1'), s('b', '/p1'), s('c', '/p2')];
    const groups = groupByProject(sessions);
    expect(groups).toHaveLength(2);
    const p1 = groups.find((g) => g.projectPath === '/p1');
    expect(p1?.sessions.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('empty input yields no groups', () => {
    expect(groupByProject([])).toEqual([]);
  });
});
