import { describe, expect, it } from 'vitest';
import {
  groupKeyOf,
  groupSessions,
  orderSessions,
  projectOrderAfterDrop,
  STANDALONE_KEY,
  sessionMatchesFilter,
  sortSessions,
} from '../../src/session-groups';
import type { Project, Session } from '../../src/types';

function mk(o: Partial<Session> & { id: string }): Session {
  return {
    name: o.id,
    agentId: 'shell:cmd',
    home: '/h',
    roots: [],
    status: 'running',
    createdAt: 0,
    lastActiveAt: 0,
    ...o,
  };
}

const P = (id: string, name: string, order: number): Project => ({ id, name, order });

const keys = (gs: { key: string }[]) => gs.map((g) => g.key);
const ids = (ss: Session[]) => ss.map((s) => s.id);

describe('groupSessions', () => {
  it('manual sort orders projects by Project.order', () => {
    const projects = [P('pb', 'b', 1), P('pa', 'a', 0)];
    const sessions = [mk({ id: 's1', projectId: 'pb' }), mk({ id: 's2', projectId: 'pa' })];
    const g = groupSessions(sessions, projects, { sort: 'manual', filterActive: false });
    expect(keys(g)).toEqual(['pa', 'pb']);
  });

  it('name sort orders projects by name, case-insensitive', () => {
    const projects = [P('p1', 'beta', 0), P('p2', 'Alpha', 1)];
    const sessions = [mk({ id: 's1', projectId: 'p1' }), mk({ id: 's2', projectId: 'p2' })];
    const g = groupSessions(sessions, projects, { sort: 'name', filterActive: false });
    expect(g.map((x) => x.project?.name)).toEqual(['Alpha', 'beta']);
  });

  it('Standalone is last and omitted when empty', () => {
    const projects = [P('pa', 'a', 0)];
    const withStandalone = groupSessions(
      [mk({ id: 's1' }), mk({ id: 's2', projectId: 'pa' })],
      projects,
      { sort: 'manual', filterActive: false },
    );
    expect(keys(withStandalone)).toEqual(['pa', STANDALONE_KEY]);
    expect(withStandalone[1].project).toBeNull();
    expect(ids(withStandalone[1].sessions)).toEqual(['s1']);
    const without = groupSessions([mk({ id: 's2', projectId: 'pa' })], projects, {
      sort: 'manual',
      filterActive: false,
    });
    expect(keys(without)).toEqual(['pa']);
  });

  it('a dangling projectId renders under Standalone', () => {
    const projects = [P('pa', 'a', 0)];
    const s = mk({ id: 's1', projectId: 'p-gone' });
    expect(groupKeyOf(s, projects)).toBe(STANDALONE_KEY);
    expect(groupKeyOf(mk({ id: 's2', projectId: 'pa' }), projects)).toBe('pa');
    expect(groupKeyOf(mk({ id: 's3' }), projects)).toBe(STANDALONE_KEY);
    const g = groupSessions([s], projects, { sort: 'manual', filterActive: false });
    expect(keys(g)).toEqual(['pa', STANDALONE_KEY]);
    expect(ids(g[1].sessions)).toEqual(['s1']);
  });

  it('empty projects included unfiltered, excluded when filterActive', () => {
    const projects = [P('pa', 'a', 0), P('pb', 'b', 1)];
    const sessions = [mk({ id: 's1', projectId: 'pb' })];
    const open = groupSessions(sessions, projects, { sort: 'manual', filterActive: false });
    expect(keys(open)).toEqual(['pa', 'pb']);
    expect(open[0].sessions).toEqual([]);
    const filtered = groupSessions(sessions, projects, { sort: 'manual', filterActive: true });
    expect(keys(filtered)).toEqual(['pb']);
  });

  it('in-group sessions follow the sort; needs-you floats in non-manual sorts only', () => {
    const projects = [P('pa', 'a', 0)];
    const sessions = [
      mk({ id: 'zed', name: 'zed', projectId: 'pa' }),
      mk({ id: 'ann', name: 'ann', projectId: 'pa' }),
      mk({ id: 'mid', name: 'mid', projectId: 'pa', needsAttention: true }),
    ];
    const byName = groupSessions(sessions, projects, { sort: 'name', filterActive: false });
    expect(ids(byName[0].sessions)).toEqual(['mid', 'ann', 'zed']);
    const manual = groupSessions(sessions, projects, { sort: 'manual', filterActive: false });
    expect(ids(manual[0].sessions)).toEqual(['zed', 'ann', 'mid']);
  });
});

describe('sortSessions / orderSessions', () => {
  it('project sort: by project name, standalone last, then session name', () => {
    const projects = [P('pz', 'zoo', 0), P('pa', 'Ant', 1)];
    const list = [
      mk({ id: 'lone', name: 'a-lone' }),
      mk({ id: 'z2', name: 'b', projectId: 'pz' }),
      mk({ id: 'z1', name: 'a', projectId: 'pz' }),
      mk({ id: 'a1', name: 'q', projectId: 'pa' }),
    ];
    expect(ids(sortSessions(list, 'project', projects))).toEqual(['a1', 'z1', 'z2', 'lone']);
  });

  it('manual keeps the input order; orderSessions leaves manual alone', () => {
    const list = [mk({ id: 'b' }), mk({ id: 'a', needsAttention: true })];
    expect(ids(sortSessions(list, 'manual', []))).toEqual(['b', 'a']);
    expect(ids(orderSessions(list, 'manual', []))).toEqual(['b', 'a']);
    expect(ids(orderSessions(list, 'recent', []))).toEqual(['a', 'b']);
  });

  it('name / recent / active / status match the rail comparators', () => {
    const list = [
      mk({ id: 's1', name: 'b', createdAt: 1, lastActiveAt: 5, status: 'exited' }),
      mk({ id: 's2', name: 'a', createdAt: 2, lastActiveAt: 5, status: 'stale' }),
      mk({ id: 's3', name: 'c', createdAt: 3, lastActiveAt: 9, status: 'running' }),
    ];
    expect(ids(sortSessions(list, 'name', []))).toEqual(['s2', 's1', 's3']);
    expect(ids(sortSessions(list, 'recent', []))).toEqual(['s3', 's2', 's1']);
    expect(ids(sortSessions(list, 'active', []))).toEqual(['s3', 's2', 's1']);
    expect(ids(sortSessions(list, 'status', []))).toEqual(['s3', 's2', 's1']);
  });
});

describe('sessionMatchesFilter', () => {
  const ctx = { projectName: 'RMB pipeline', agentLabel: 'PowerShell 7' };
  const s = mk({
    id: 's',
    name: 'api fix',
    home: 'G:\\work\\portal',
    roots: ['C:\\x\\ref', '/y/ref2'],
  });

  it('filter matches name, project name, home basename, a root basename (C:\\x\\ref and /y/ref), agent label; trims and lower-cases; empty q matches', () => {
    expect(sessionMatchesFilter(s, 'API', ctx)).toBe(true);
    expect(sessionMatchesFilter(s, 'rmb pipe', ctx)).toBe(true);
    expect(sessionMatchesFilter(s, 'portal', ctx)).toBe(true);
    expect(sessionMatchesFilter(s, '  ref  ', ctx)).toBe(true);
    expect(sessionMatchesFilter(s, 'ref2', ctx)).toBe(true);
    expect(sessionMatchesFilter(s, 'powershell', ctx)).toBe(true);
    expect(sessionMatchesFilter(s, '', ctx)).toBe(true);
    expect(sessionMatchesFilter(s, '   ', ctx)).toBe(true);
    expect(sessionMatchesFilter(s, 'work', ctx)).toBe(false);
    expect(sessionMatchesFilter(s, 'x', { projectName: undefined, agentLabel: 'cmd' })).toBe(
      true, // 'api fix' contains x
    );
    expect(sessionMatchesFilter(s, 'nomatch', ctx)).toBe(false);
  });

  it('filter: a standalone session never matches on project name', () => {
    expect(sessionMatchesFilter(s, 'rmb', { projectName: undefined, agentLabel: 'cmd' })).toBe(
      false,
    );
  });
});

describe('projectOrderAfterDrop', () => {
  it('projectOrderAfterDrop moves before target; null for same id, unknown id, or unchanged order', () => {
    const cur = ['a', 'b', 'c'];
    expect(projectOrderAfterDrop(cur, 'c', 'a', cur)).toEqual(['c', 'a', 'b']);
    expect(projectOrderAfterDrop(cur, 'a', 'c', cur)).toEqual(['b', 'a', 'c']);
    expect(projectOrderAfterDrop(cur, 'a', 'a', cur)).toBeNull();
    expect(projectOrderAfterDrop(cur, 'zz', 'a', cur)).toBeNull();
    expect(projectOrderAfterDrop(cur, 'a', 'zz', cur)).toBeNull();
    expect(projectOrderAfterDrop(cur, 'a', 'b', cur)).toBeNull();
  });
});
