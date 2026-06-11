import { describe, expect, it } from 'vitest';
import { restoreSessions, serializeSessions } from '../../src/persistence';
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
