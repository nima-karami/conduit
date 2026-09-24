import { describe, expect, it } from 'vitest';
import {
  cardDropIntent,
  deleteProjectDialog,
  groupKeyOf,
  groupSessions,
  openBoardTarget,
  orderSessions,
  projectOrderAfterDrop,
  projectPickerRows,
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
    expect(projectOrderAfterDrop(cur, 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(projectOrderAfterDrop(cur, 'a', 'c')).toEqual(['b', 'a', 'c']);
    expect(projectOrderAfterDrop(cur, 'a', 'a')).toBeNull();
    expect(projectOrderAfterDrop(cur, 'zz', 'a')).toBeNull();
    expect(projectOrderAfterDrop(cur, 'a', 'zz')).toBeNull();
    expect(projectOrderAfterDrop(cur, 'a', 'b')).toBeNull();
  });

  it('the no-op test is against the RENDERED order: dropping onto the next header is null in a derived sort', () => {
    const rendered = ['alpha', 'beta'];
    expect(projectOrderAfterDrop(rendered, 'alpha', 'beta')).toBeNull();
    expect(projectOrderAfterDrop(rendered, 'beta', 'alpha')).toEqual(['beta', 'alpha']);
  });
});

describe('deleteProjectDialog', () => {
  const SUFFIX = "Folders and their .conduit/ data aren't touched.";

  it('delete copy for 0, 1, 2 sessions in one window', () => {
    expect(deleteProjectDialog('RMB', 0, 1).message).toBe(`It has no sessions. ${SUFFIX}`);
    expect(deleteProjectDialog('RMB', 1, 1).message).toBe(
      `Its 1 session becomes standalone and keeps running. ${SUFFIX}`,
    );
    expect(deleteProjectDialog('RMB', 2, 1).message).toBe(
      `Its 2 sessions become standalone and keep running. ${SUFFIX}`,
    );
  });

  it('count-free copy when windowCount > 1, even with count 0', () => {
    const want = `Its sessions become standalone and keep running. ${SUFFIX}`;
    expect(deleteProjectDialog('RMB', 0, 2).message).toBe(want);
    expect(deleteProjectDialog('RMB', 3, 3).message).toBe(want);
  });

  it('title uses curly quotes', () => {
    expect(deleteProjectDialog('RMB pipeline', 1, 1).title).toBe('Delete “RMB pipeline”?');
  });
});

describe('openBoardTarget', () => {
  it('openBoardTarget: active in project → active; else highest lastActiveAt; none → undefined; ignores other projects', () => {
    const sessions = [
      mk({ id: 'a1', projectId: 'pa', lastActiveAt: 5 }),
      mk({ id: 'a2', projectId: 'pa', lastActiveAt: 9 }),
      mk({ id: 'a3', projectId: 'pa', lastActiveAt: 9 }),
      mk({ id: 'b1', projectId: 'pb', lastActiveAt: 50 }),
      mk({ id: 'lone', lastActiveAt: 99 }),
    ];
    expect(openBoardTarget('pa', sessions, 'a1')).toBe('a1');
    expect(openBoardTarget('pa', sessions, 'b1')).toBe('a2');
    expect(openBoardTarget('pa', sessions, undefined)).toBe('a2');
    expect(openBoardTarget('pb', sessions, 'lone')).toBe('b1');
    expect(openBoardTarget('pc', sessions, 'a1')).toBeUndefined();
  });
});

describe('cardDropIntent', () => {
  it('another project → {projectId}', () => {
    expect(cardDropIntent(STANDALONE_KEY, 'p-b')).toEqual({ projectId: 'p-b' });
    expect(cardDropIntent('p-a', 'p-b')).toEqual({ projectId: 'p-b' });
  });

  it('Standalone target → {projectId: null}', () => {
    expect(cardDropIntent('p-a', STANDALONE_KEY)).toEqual({ projectId: null });
  });

  it('own group → null', () => {
    expect(cardDropIntent('p-a', 'p-a')).toBeNull();
    expect(cardDropIntent(STANDALONE_KEY, STANDALONE_KEY)).toBeNull();
  });
});

describe('projectPickerRows', () => {
  const projects = [P('p1', 'RMB pipeline', 0), P('p2', 'conduit', 1), P('p3', 'Portal', 2)];

  it('picker rows: projects in order then Standalone; current flagged (dangling id → Standalone current)', () => {
    const { rows, noMatch } = projectPickerRows(projects, '', 'p2');
    expect(rows).toEqual([
      { key: 'p1', label: 'RMB pipeline', current: false },
      { key: 'p2', label: 'conduit', current: true },
      { key: 'p3', label: 'Portal', current: false },
      { key: STANDALONE_KEY, label: 'Standalone', current: false },
    ]);
    expect(noMatch).toBe(false);
    const dangling = groupKeyOf(mk({ id: 's', projectId: 'p-gone' }), projects);
    const r2 = projectPickerRows(projects, '', dangling).rows;
    expect(r2.filter((r) => r.current).map((r) => r.key)).toEqual([STANDALONE_KEY]);
  });

  it('filter is case-insensitive substring; no match → noMatch, Standalone still present', () => {
    const hit = projectPickerRows(projects, '  PORT ', 'p1');
    expect(hit.rows.map((r) => r.key)).toEqual(['p3', STANDALONE_KEY]);
    expect(hit.noMatch).toBe(false);
    const miss = projectPickerRows(projects, 'zzz', 'p1');
    expect(miss.rows.map((r) => r.key)).toEqual([STANDALONE_KEY]);
    expect(miss.noMatch).toBe(true);
    expect(projectPickerRows([], '', STANDALONE_KEY)).toEqual({
      rows: [{ key: STANDALONE_KEY, label: 'Standalone', current: true }],
      noMatch: false,
    });
  });
});
