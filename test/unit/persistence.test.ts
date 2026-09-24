import { describe, expect, it } from 'vitest';
import {
  parseDocs,
  parseSessions,
  serializeDocs,
  serializeSessions,
  shouldPersistSessions,
} from '../../src/persistence';
import type { PersistedDoc } from '../../src/protocol';
import type { Session } from '../../src/types';

const s: Session = {
  id: '1',
  name: 'A',
  agentId: 'claude',
  home: '/p',
  roots: [],
  status: 'running',
  createdAt: 100,
  lastActiveAt: 250,
};

const v1 = (sessions: unknown[]) => JSON.stringify({ version: 1, sessions });

function sessionsOf(blob: string | undefined): Session[] {
  const r = parseSessions(blob);
  return r.kind === 'ok' ? r.sessions : [];
}

describe('persistence', () => {
  it('round-trips sessions, forcing restored ones to stale', () => {
    const blob = serializeSessions([s]);
    const restored = sessionsOf(blob);
    expect(restored).toHaveLength(1);
    expect(restored[0].id).toBe('1');
    expect(restored[0].status).toBe('stale'); // live terminals don't survive reload
    expect(restored[0].lastActiveAt).toBe(250);
  });

  it('strips the runtime-only fields rather than freezing a snapshot that lies', () => {
    const blob = serializeSessions([
      {
        ...s,
        lastLine: 'Edit webview/styles.css',
        completedRun: true,
        git: { kind: 'branch', branch: 'main', dirty: true },
      },
    ]);
    expect(blob).not.toContain('lastLine');
    expect(blob).not.toContain('completedRun');
    const restored = sessionsOf(blob);
    expect(restored[0].lastLine).toBeUndefined();
    expect(restored[0].completedRun).toBeUndefined();
    expect(restored[0].git).toBeUndefined();
  });

  it('backfills lastActiveAt from createdAt for legacy sessions', () => {
    // A pre-feature blob with createdAt but no lastActiveAt.
    const blob = JSON.stringify({
      version: 1,
      sessions: [
        { id: '1', name: 'A', agentId: 'c', projectPath: '/p', status: 'running', createdAt: 100 },
      ],
    });
    const restored = sessionsOf(blob);
    expect(restored[0].lastActiveAt).toBe(100);
  });

  it('parseSessions reads a legacy projectPath as home', () => {
    const blob = JSON.stringify({
      version: 1,
      sessions: [
        { id: '1', name: 'A', agentId: 'c', projectPath: '/p', status: 'running', createdAt: 100 },
      ],
    });
    const [restored] = sessionsOf(blob);
    expect(restored.home).toBe('/p');
    expect('projectPath' in restored).toBe(false);
  });

  it('returns empty array on corrupt input', () => {
    expect(sessionsOf('not json')).toEqual([]);
    expect(sessionsOf(undefined)).toEqual([]);
    expect(sessionsOf('{"version":999}')).toEqual([]);
    expect(parseSessions('not json')).toEqual({ kind: 'empty' });
    expect(parseSessions('{"version":1,"sessions":{}}')).toEqual({ kind: 'empty' });
  });

  it('serialize writes version 1 with home and a projectPath mirror', () => {
    const parsed = JSON.parse(serializeSessions([{ ...s, roots: ['/r'], projectId: 'p-1' }]));
    expect(parsed.version).toBe(1);
    expect(parsed.sessions[0]).toMatchObject({
      home: '/p',
      projectPath: '/p',
      roots: ['/r'],
      projectId: 'p-1',
    });
  });

  it('serialize strips missingRoots and homeMissing', () => {
    const blob = serializeSessions([
      { ...s, roots: ['/r'], missingRoots: ['/r'], homeMissing: true },
    ]);
    const [entry] = JSON.parse(blob).sessions;
    expect('missingRoots' in entry).toBe(false);
    expect('homeMissing' in entry).toBe(false);
    expect(entry.roots).toEqual(['/r']);
  });

  it('home preferred, projectPath fallback, id listed in legacyIds', () => {
    const r = parseSessions(
      v1([
        { id: 'new', name: 'N', agentId: 'c', home: '/h', projectPath: '/stale', createdAt: 1 },
        { id: 'old', name: 'O', agentId: 'c', projectPath: '/legacy', createdAt: 1 },
        { id: 'blank', name: 'B', agentId: 'c', home: '', projectPath: '/fallback', createdAt: 1 },
      ]),
    );
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.sessions.map((x) => x.home)).toEqual(['/h', '/legacy', '/fallback']);
    expect(r.legacyIds).toEqual(['old', 'blank']);
    expect(r.sessions.every((x) => !('projectPath' in x))).toBe(true);
  });

  it('entry with neither is dropped and counted', () => {
    const r = parseSessions(
      v1([
        { id: 'a', name: 'A', agentId: 'c', home: '/a', createdAt: 1 },
        { id: 'b', name: 'B', agentId: 'c', createdAt: 1 },
        { id: 'c', name: 'C', agentId: 'c', home: 7, projectPath: '', createdAt: 1 },
        null,
      ]),
    );
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.dropped).toBe(3);
    expect(r.legacyIds).toEqual([]);
    expect(r.sessions.map((x) => x.id)).toEqual(['a']);
  });

  it('roots: non-array → [], deduped by key, home key dropped', () => {
    const r = parseSessions(
      v1([
        { id: 'a', name: 'A', agentId: 'c', home: 'C:\\h', roots: 'C:\\x', createdAt: 1 },
        {
          id: 'b',
          name: 'B',
          agentId: 'c',
          home: 'C:\\h',
          roots: ['C:\\x', 'c:/X/', '', 3, 'c:/h/', 'C:\\y'],
          createdAt: 1,
        },
      ]),
    );
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.sessions[0].roots).toEqual([]);
    expect(r.sessions[1].roots).toEqual(['C:\\x', 'C:\\y']);
  });

  it('non-string projectId deleted', () => {
    const r = parseSessions(
      v1([
        { id: 'a', name: 'A', agentId: 'c', home: '/a', projectId: 5, createdAt: 1 },
        { id: 'b', name: 'B', agentId: 'c', home: '/b', projectId: 'p-1', createdAt: 1 },
      ]),
    );
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect('projectId' in r.sessions[0]).toBe(false);
    expect(r.sessions[1].projectId).toBe('p-1');
  });

  it('version 2 → empty', () => {
    expect(parseSessions(JSON.stringify({ version: 2, sessions: [s] }))).toEqual({
      kind: 'empty',
    });
  });

  it("round trip: an older build's spread of home/roots/projectId survives", () => {
    const live: Session = { ...s, roots: ['/r1', '/r2'], projectId: 'p-abc' };
    const written: Record<string, unknown>[] = JSON.parse(serializeSessions([live])).sessions;
    // An older build spreads every field of an entry it loaded back out on its next write.
    const olderRewrite = v1(written.map((e) => ({ ...e })));
    expect(parseSessions(olderRewrite)).toEqual({
      kind: 'ok',
      sessions: [{ ...live, status: 'stale' }],
      legacyIds: [],
      dropped: 0,
    });
    // An entry that older build ADDED has only projectPath: same session back, flagged legacy.
    const { home: _home, ...mirrorOnly } = written[0];
    expect(parseSessions(v1([mirrorOnly]))).toEqual({
      kind: 'ok',
      sessions: [{ ...live, status: 'stale' }],
      legacyIds: ['1'],
      dropped: 0,
    });
  });
});

describe('shouldPersistSessions', () => {
  // Data-loss guard: with restore OFF the app must NOT overwrite the saved session set —
  // otherwise the next persist/quit writes [] over sessions.json and toggling restore back
  // on brings back nothing.
  it('permits writing the session list only when restore is on', () => {
    expect(shouldPersistSessions({ restoreSessions: true })).toBe(true);
    expect(shouldPersistSessions({ restoreSessions: false })).toBe(false);
  });
});

describe('persistence — editor tabs (docs.json)', () => {
  const docs: PersistedDoc[] = [
    { kind: 'file', path: '/a.ts', sessionId: 'S1' },
    { kind: 'file', path: '/b.ts', sessionId: 'S1', preview: true, active: true },
  ];

  it('round-trips persisted docs', () => {
    expect(parseDocs(serializeDocs(docs))).toEqual(docs);
  });

  it('absent or older/corrupt docs.json degrades to no tabs', () => {
    expect(parseDocs(undefined)).toEqual([]);
    expect(parseDocs('not json')).toEqual([]);
    expect(parseDocs('{"version":999,"docs":[]}')).toEqual([]);
    expect(parseDocs(serializeSessions([]))).toEqual([]); // a sessions blob has no `docs`
  });

  it('drops malformed entries (unknown kind / bad diffScope / missing fields)', () => {
    const blob = JSON.stringify({
      version: 1,
      docs: [
        { kind: 'file', path: '/ok.ts', sessionId: 'S1' },
        { kind: 'diff', path: '/x.ts', sessionId: 'S1' },
        { kind: 'diff', path: '/s.ts', sessionId: 'S1', diffScope: 'staged' },
        { kind: 'diff', path: '/b.ts', sessionId: 'S1', diffScope: 'bogus' },
        { kind: 'file', path: '/f.ts', sessionId: 'S1', diffScope: 'staged' },
        { kind: 'review', path: '@review', sessionId: 'S1' },
        { kind: 'file', sessionId: 'S1' }, // no path
        { kind: 'file', path: '/y.ts' }, // no sessionId
      ],
    });
    expect(parseDocs(blob)).toEqual([
      { kind: 'file', path: '/ok.ts', sessionId: 'S1' },
      { kind: 'diff', path: '/x.ts', sessionId: 'S1' },
      { kind: 'diff', path: '/s.ts', sessionId: 'S1', diffScope: 'staged' },
    ]);
  });

  it('round-trips scoped diff docs with preview/active', () => {
    const docs: PersistedDoc[] = [
      { kind: 'diff', path: '/a.ts', sessionId: 'S1', diffScope: 'unstaged', active: true },
      { kind: 'diff', path: '/a.ts', sessionId: 'S1', preview: true },
    ];
    expect(parseDocs(serializeDocs(docs))).toEqual(docs);
  });
});
