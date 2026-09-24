import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SessionsParse } from '../../src/persistence';
import type { ProjectsLoad } from '../../src/project-store';
import { buildStartupModel } from '../../src/session-migration';
import type { Project, Session } from '../../src/types';

const pid = (key: string) => `p-${createHash('sha1').update(key).digest('hex').slice(0, 12)}`;

const sess = (id: string, home: string, extra: Partial<Session> = {}): Session => ({
  id,
  name: id,
  agentId: 'shell:cmd',
  home,
  roots: [],
  status: 'stale',
  createdAt: 1,
  lastActiveAt: 1,
  ...extra,
});

const parsed = (sessions: Session[], legacyIds: string[] = []): SessionsParse => ({
  kind: 'ok',
  sessions,
  legacyIds,
  dropped: 0,
});

const ok = (projects: Project[]): ProjectsLoad => ({ kind: 'ok', projects });

describe('buildStartupModel', () => {
  it('C:\\r\\a ×2 and c:/r/b/ legacy → 2 projects a, b in first-seen order', () => {
    const m = buildStartupModel({
      sessions: parsed(
        [sess('1', 'C:\\r\\a'), sess('2', 'c:/R/A/'), sess('3', 'c:/r/b/')],
        ['1', '2', '3'],
      ),
      projects: { kind: 'absent' },
    });
    expect(m.projects).toEqual([
      { id: pid('c:/r/a'), name: 'a', order: 0 },
      { id: pid('c:/r/b'), name: 'b', order: 1 },
    ]);
    expect(m.sessions.map((s) => [s.home, s.projectId])).toEqual([
      ['C:\\r\\a', pid('c:/r/a')],
      ['c:/R/A/', pid('c:/r/a')],
      ['c:/r/b/', pid('c:/r/b')],
    ]);
  });

  it('/Work/x and /work/x → 2 projects', () => {
    const m = buildStartupModel({
      sessions: parsed([sess('1', '/Work/x'), sess('2', '/work/x')], ['1', '2']),
      projects: { kind: 'absent' },
    });
    expect(m.projects.map((p) => p.id)).toEqual([pid('/Work/x'), pid('/work/x')]);
  });

  it('legacy + existing deterministic project reuses it — no duplicate', () => {
    const existing = [
      { id: 'p-other', name: 'Other', order: 0 },
      { id: pid('/w/a'), name: 'Renamed', order: 1 },
    ];
    const m = buildStartupModel({
      sessions: parsed([sess('1', '/w/a'), sess('2', '/w/b')], ['1', '2']),
      projects: ok(existing),
    });
    expect(m.projects).toEqual([...existing, { id: pid('/w/b'), name: 'b', order: 2 }]);
    expect(m.sessions[0].projectId).toBe(pid('/w/a'));
  });

  it('drive root home → project name is the home string', () => {
    const m = buildStartupModel({
      sessions: parsed([sess('1', 'C:\\'), sess('2', 'D:')], ['1', '2']),
      projects: { kind: 'absent' },
    });
    expect(m.projects.map((p) => p.name)).toEqual(['C:\\', 'D:']);
  });

  it('legacy → backup sessions.pre-mf.bak.json overwrite:false; writeProjects && writeSessions', () => {
    const m = buildStartupModel({
      sessions: parsed([sess('1', '/w/a')], ['1']),
      projects: { kind: 'absent' },
    });
    expect(m.backups).toEqual([
      { from: 'sessions.json', to: 'sessions.pre-mf.bak.json', overwrite: false },
    ]);
    expect(m.writeProjects).toBe(true);
    expect(m.writeSessions).toBe(true);
    expect(m.projectsWritable).toBe(true);
    expect(m.warnings).toEqual([]);
  });

  it('no legacy entries and an unchanged list → nothing written, no backup', () => {
    const m = buildStartupModel({
      sessions: parsed([sess('1', '/w/a', { projectId: pid('/w/a') })]),
      projects: ok([{ id: pid('/w/a'), name: 'a', order: 0 }]),
    });
    expect(m.backups).toEqual([]);
    expect(m.writeProjects).toBe(false);
    expect(m.writeSessions).toBe(false);
  });

  it('absent projects + non-legacy session with its deterministic id → project recreated', () => {
    const m = buildStartupModel({
      sessions: parsed([sess('1', 'C:\\w\\a', { projectId: pid('c:/w/a') })]),
      projects: { kind: 'absent' },
    });
    expect(m.projects).toEqual([{ id: pid('c:/w/a'), name: 'a', order: 0 }]);
    expect(m.sessions[0].projectId).toBe(pid('c:/w/a'));
    expect(m.writeProjects).toBe(true);
    expect(m.writeSessions).toBe(false);
  });

  it('absent projects + a non-deterministic dangling id → deleted', () => {
    const m = buildStartupModel({
      sessions: parsed([sess('1', '/w/a', { projectId: 'p-random' })]),
      projects: { kind: 'absent' },
    });
    expect(m.projects).toEqual([]);
    expect('projectId' in m.sessions[0]).toBe(false);
  });

  it('ok projects + a dangling non-deterministic id → deleted; a known id kept', () => {
    const m = buildStartupModel({
      sessions: parsed([
        sess('1', '/w/a', { projectId: 'p-gone' }),
        sess('2', '/w/b', { projectId: 'p-known' }),
      ]),
      projects: ok([{ id: 'p-known', name: 'K', order: 0 }]),
    });
    expect('projectId' in m.sessions[0]).toBe(false);
    expect(m.sessions[1].projectId).toBe('p-known');
  });

  it('corrupt projects → ids kept, backup projects.corrupt.json overwrite:true, writable', () => {
    const m = buildStartupModel({
      sessions: parsed([sess('1', '/w/a', { projectId: 'p-random' })]),
      projects: { kind: 'corrupt' },
    });
    expect(m.sessions[0].projectId).toBe('p-random');
    expect(m.projects).toEqual([]);
    expect(m.projectsWritable).toBe(true);
    expect(m.backups).toEqual([
      { from: 'projects.json', to: 'projects.corrupt.json', overwrite: true },
    ]);
    expect(m.warnings).toHaveLength(1);
  });

  it('unreadable projects → ids kept, projectsWritable false, no projects appended, legacy session still gets its deterministic id', () => {
    const m = buildStartupModel({
      sessions: parsed([sess('1', '/w/a'), sess('2', '/w/b', { projectId: 'p-random' })], ['1']),
      projects: { kind: 'unreadable', code: 'EBUSY' },
    });
    expect(m.projectsWritable).toBe(false);
    expect(m.projects).toEqual([]);
    expect(m.writeProjects).toBe(false);
    expect(m.sessions[0].projectId).toBe(pid('/w/a'));
    expect(m.sessions[1].projectId).toBe('p-random');
    expect(m.backups).toEqual([
      { from: 'sessions.json', to: 'sessions.pre-mf.bak.json', overwrite: false },
    ]);
    expect(m.warnings).toHaveLength(1);
  });

  it('future projects → same as unreadable', () => {
    const m = buildStartupModel({
      sessions: parsed([sess('1', '/w/a'), sess('2', '/w/b', { projectId: 'p-random' })], ['1']),
      projects: { kind: 'future', version: 2 },
    });
    expect(m.projectsWritable).toBe(false);
    expect(m.projects).toEqual([]);
    expect(m.writeProjects).toBe(false);
    expect(m.sessions[0].projectId).toBe(pid('/w/a'));
    expect(m.sessions[1].projectId).toBe('p-random');
    expect(m.warnings).toHaveLength(1);
  });

  it('sessions null (restore off) → sessions [] and no session backup', () => {
    const m = buildStartupModel({
      sessions: null,
      projects: ok([{ id: 'p-1', name: 'One', order: 0 }]),
    });
    expect(m.sessions).toEqual([]);
    expect(m.projects).toEqual([{ id: 'p-1', name: 'One', order: 0 }]);
    expect(m.backups).toEqual([]);
    expect(m.writeSessions).toBe(false);
    expect(m.writeProjects).toBe(false);
  });

  it('does not mutate its input sessions', () => {
    const input = sess('1', '/w/a');
    buildStartupModel({ sessions: parsed([input], ['1']), projects: { kind: 'absent' } });
    expect('projectId' in input).toBe(false);
  });
});
