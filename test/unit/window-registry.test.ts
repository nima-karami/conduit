import { describe, expect, it } from 'vitest';
import type { Session } from '../../src/types';
import {
  assignOwner,
  buildWinList,
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

describe('session move (Slice B) — ownership reassignment', () => {
  it('moves a session from w1 to w2: w1 loses it, w2 gains it', () => {
    const owners: OwnerMap = new Map([
      ['a', 1],
      ['b', 1],
    ]);
    const all = [s('a'), s('b')];
    // Pre-move: window 1 owns both.
    expect(sessionsForWindow(owners, 1, all).map((x) => x.id)).toEqual(['a', 'b']);
    expect(sessionsForWindow(owners, 2, all)).toEqual([]);

    assignOwner(owners, 'a', 2); // the move

    expect(sessionsForWindow(owners, 1, all).map((x) => x.id)).toEqual(['b']);
    expect(sessionsForWindow(owners, 2, all).map((x) => x.id)).toEqual(['a']);
    // The session id is unchanged by the move (the PTY/React key never moves).
    expect(ownerOf(owners, 'a')).toBe(2);
  });
});

describe('buildWinList (Slice B move picker)', () => {
  const ordinal = (id: number) => id; // identity ordinal for predictable titles

  it('counts owned sessions and titles each window by its first owned session name', () => {
    const owners: OwnerMap = new Map([
      ['a', 1],
      ['b', 1],
      ['c', 2],
    ]);
    const all = [s('a'), s('b'), s('c')];
    const list = buildWinList([1, 2], owners, all, ordinal);
    expect(list).toEqual([
      { id: 1, title: 'a', sessionCount: 2 },
      { id: 2, title: 'c', sessionCount: 1 },
    ]);
  });

  it('falls back to "Window N" for a window owning no sessions', () => {
    const owners: OwnerMap = new Map([['a', 1]]);
    const list = buildWinList([1, 2], owners, [s('a')], ordinal);
    expect(list).toEqual([
      { id: 1, title: 'a', sessionCount: 1 },
      { id: 2, title: 'Window 2', sessionCount: 0 },
    ]);
  });

  it('preserves the given window-id order', () => {
    const owners: OwnerMap = new Map();
    const list = buildWinList([5, 3, 8], owners, [], ordinal);
    expect(list.map((w) => w.id)).toEqual([5, 3, 8]);
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
