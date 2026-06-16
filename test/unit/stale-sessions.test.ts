import { describe, expect, it } from 'vitest';
import { staleRelaunchTargets } from '../../src/stale-sessions';
import type { Session } from '../../src/types';

function makeSession(id: string, status: Session['status']): Session {
  return {
    id,
    name: `session-${id}`,
    agentId: 'shell:pwsh',
    projectPath: '/some/path',
    status,
    createdAt: 1000,
    lastActiveAt: 1000,
  };
}

describe('staleRelaunchTargets', () => {
  it('returns empty array for empty session list', () => {
    expect(staleRelaunchTargets([])).toEqual([]);
  });

  it('returns ids of stale sessions only', () => {
    const sessions: Session[] = [
      makeSession('a', 'stale'),
      makeSession('b', 'running'),
      makeSession('c', 'stale'),
      makeSession('d', 'exited'),
    ];
    expect(staleRelaunchTargets(sessions)).toEqual(['a', 'c']);
  });

  it('returns empty array when no sessions are stale', () => {
    const sessions: Session[] = [makeSession('a', 'running'), makeSession('b', 'exited')];
    expect(staleRelaunchTargets(sessions)).toEqual([]);
  });

  it('returns all ids when all sessions are stale', () => {
    const sessions: Session[] = [makeSession('x', 'stale'), makeSession('y', 'stale')];
    expect(staleRelaunchTargets(sessions)).toEqual(['x', 'y']);
  });

  it('handles a single stale session', () => {
    const sessions: Session[] = [makeSession('only', 'stale')];
    expect(staleRelaunchTargets(sessions)).toEqual(['only']);
  });

  it('handles a single non-stale session', () => {
    const sessions: Session[] = [makeSession('only', 'running')];
    expect(staleRelaunchTargets(sessions)).toEqual([]);
  });
});
