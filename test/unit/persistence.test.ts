import { describe, it, expect } from 'vitest';
import { serializeSessions, restoreSessions } from '../../src/persistence';
import { Session } from '../../src/types';

const s: Session = {
  id: '1',
  name: 'A',
  agentId: 'claude',
  projectPath: '/p',
  status: 'running',
  createdAt: 100,
};

describe('persistence', () => {
  it('round-trips sessions, forcing restored ones to stale', () => {
    const blob = serializeSessions([s]);
    const restored = restoreSessions(blob);
    expect(restored).toHaveLength(1);
    expect(restored[0].id).toBe('1');
    expect(restored[0].status).toBe('stale'); // live terminals don't survive reload
  });

  it('returns empty array on corrupt input', () => {
    expect(restoreSessions('not json')).toEqual([]);
    expect(restoreSessions(undefined)).toEqual([]);
    expect(restoreSessions('{"version":999}')).toEqual([]);
  });
});
