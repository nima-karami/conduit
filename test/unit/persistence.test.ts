import { describe, expect, it } from 'vitest';
import {
  parseDocs,
  restoreSessions,
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
  projectPath: '/p',
  status: 'running',
  createdAt: 100,
  lastActiveAt: 250,
};

describe('persistence', () => {
  it('round-trips sessions, forcing restored ones to stale', () => {
    const blob = serializeSessions([s]);
    const restored = restoreSessions(blob);
    expect(restored).toHaveLength(1);
    expect(restored[0].id).toBe('1');
    expect(restored[0].status).toBe('stale'); // live terminals don't survive reload
    expect(restored[0].lastActiveAt).toBe(250);
  });

  it('backfills lastActiveAt from createdAt for legacy sessions', () => {
    // A pre-feature blob with createdAt but no lastActiveAt.
    const blob = JSON.stringify({
      version: 1,
      sessions: [
        { id: '1', name: 'A', agentId: 'c', projectPath: '/p', status: 'running', createdAt: 100 },
      ],
    });
    const restored = restoreSessions(blob);
    expect(restored[0].lastActiveAt).toBe(100);
  });

  it('returns empty array on corrupt input', () => {
    expect(restoreSessions('not json')).toEqual([]);
    expect(restoreSessions(undefined)).toEqual([]);
    expect(restoreSessions('{"version":999}')).toEqual([]);
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

  it('drops malformed entries (non-file kind / missing fields)', () => {
    const blob = JSON.stringify({
      version: 1,
      docs: [
        { kind: 'file', path: '/ok.ts', sessionId: 'S1' },
        { kind: 'diff', path: '/x.ts', sessionId: 'S1' }, // file-only (D4)
        { kind: 'file', sessionId: 'S1' }, // no path
        { kind: 'file', path: '/y.ts' }, // no sessionId
      ],
    });
    expect(parseDocs(blob)).toEqual([{ kind: 'file', path: '/ok.ts', sessionId: 'S1' }]);
  });
});
