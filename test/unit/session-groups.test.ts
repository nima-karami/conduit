import { describe, expect, it } from 'vitest';
import {
  deleteProjectDialog,
  groupKeyOf,
  openBoardTarget,
  projectPickerRows,
  STANDALONE_KEY,
  sessionMatchesFilter,
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

describe('deleteProjectDialog', () => {
  const SUFFIX = "Folders and their .conduit/ data aren't touched.";

  it('delete copy for 0, 1, 2 sessions in one window', () => {
    expect(deleteProjectDialog('RMB', 0, 1).message).toBe(`It has no agents. ${SUFFIX}`);
    expect(deleteProjectDialog('RMB', 1, 1).message).toBe(
      `Its 1 agent keeps running without a space. ${SUFFIX}`,
    );
    expect(deleteProjectDialog('RMB', 2, 1).message).toBe(
      `Its 2 agents keep running without a space. ${SUFFIX}`,
    );
  });

  it('count-free copy when windowCount > 1, even with count 0', () => {
    const want = `Its agents keep running without a space. ${SUFFIX}`;
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

describe('projectPickerRows', () => {
  const projects = [P('p1', 'RMB pipeline', 0), P('p2', 'conduit', 1), P('p3', 'Portal', 2)];

  it('picker rows: spaces in order then No space; current flagged (dangling id → No space current)', () => {
    const { rows, noMatch } = projectPickerRows(projects, '', 'p2');
    expect(rows).toEqual([
      { key: 'p1', label: 'RMB pipeline', current: false },
      { key: 'p2', label: 'conduit', current: true },
      { key: 'p3', label: 'Portal', current: false },
      { key: STANDALONE_KEY, label: 'No space', current: false },
    ]);
    expect(noMatch).toBe(false);
    const dangling = groupKeyOf(mk({ id: 's', projectId: 'p-gone' }), projects);
    const r2 = projectPickerRows(projects, '', dangling).rows;
    expect(r2.filter((r) => r.current).map((r) => r.key)).toEqual([STANDALONE_KEY]);
  });

  it('filter is case-insensitive substring; no match → noMatch, No space still present', () => {
    const hit = projectPickerRows(projects, '  PORT ', 'p1');
    expect(hit.rows.map((r) => r.key)).toEqual(['p3', STANDALONE_KEY]);
    expect(hit.noMatch).toBe(false);
    const miss = projectPickerRows(projects, 'zzz', 'p1');
    expect(miss.rows.map((r) => r.key)).toEqual([STANDALONE_KEY]);
    expect(miss.noMatch).toBe(true);
    expect(projectPickerRows([], '', STANDALONE_KEY)).toEqual({
      rows: [{ key: STANDALONE_KEY, label: 'No space', current: true }],
      noMatch: false,
    });
  });
});
