import { describe, expect, it } from 'vitest';
import { canRelaunch, relaunchableSessionIds, staleSessionIds } from '../../src/stale-sessions';
import type { Session } from '../../src/types';

function makeSession(id: string, status: Session['status']): Session {
  return {
    id,
    name: `session-${id}`,
    agentId: 'shell:pwsh',
    home: '/some/path',
    roots: [],
    status,
    createdAt: 1000,
    lastActiveAt: 1000,
  };
}

describe('staleSessionIds', () => {
  it('returns empty array for empty session list', () => {
    expect(staleSessionIds([])).toEqual([]);
  });

  it('returns ids of stale sessions only', () => {
    const sessions: Session[] = [
      makeSession('a', 'stale'),
      makeSession('b', 'running'),
      makeSession('c', 'stale'),
      makeSession('d', 'exited'),
    ];
    expect(staleSessionIds(sessions)).toEqual(['a', 'c']);
  });

  it('returns empty array when no sessions are stale', () => {
    const sessions: Session[] = [makeSession('a', 'running'), makeSession('b', 'exited')];
    expect(staleSessionIds(sessions)).toEqual([]);
  });

  it('returns all ids when all sessions are stale', () => {
    const sessions: Session[] = [makeSession('x', 'stale'), makeSession('y', 'stale')];
    expect(staleSessionIds(sessions)).toEqual(['x', 'y']);
  });

  it('handles a single stale session', () => {
    const sessions: Session[] = [makeSession('only', 'stale')];
    expect(staleSessionIds(sessions)).toEqual(['only']);
  });

  it('handles a single non-stale session', () => {
    const sessions: Session[] = [makeSession('only', 'running')];
    expect(staleSessionIds(sessions)).toEqual([]);
  });
});

describe('relaunch gating (mf-live-edits AC-4)', () => {
  const missing = (id: string, status: Session['status']): Session => ({
    ...makeSession(id, status),
    homeMissing: true,
  });

  it('canRelaunch false for stale+homeMissing and exited+homeMissing, true for stale', () => {
    expect(canRelaunch(missing('a', 'stale'))).toBe(false);
    expect(canRelaunch(missing('a', 'exited'))).toBe(false);
    expect(canRelaunch(makeSession('a', 'stale'))).toBe(true);
    expect(canRelaunch(makeSession('a', 'exited'))).toBe(true);
    expect(canRelaunch(makeSession('a', 'running'))).toBe(false);
  });

  it('relaunchableSessionIds skips homeMissing', () => {
    const sessions = [
      makeSession('a', 'stale'),
      missing('b', 'stale'),
      makeSession('c', 'exited'),
      makeSession('d', 'stale'),
    ];
    expect(relaunchableSessionIds(sessions)).toEqual(['a', 'd']);
  });

  it(`closing stays allowed: staleSessionIds still lists a can't-start session`, () => {
    expect(staleSessionIds([missing('b', 'stale')])).toEqual(['b']);
  });
});
