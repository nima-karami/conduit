import { describe, expect, it } from 'vitest';
import { badgeStateForCard, sessionsForCard } from '../../src/board-linkage';
import type { Session } from '../../src/types';

const base = {
  agentId: 'claude',
  projectPath: '/p',
  createdAt: 100,
  lastActiveAt: 100,
} satisfies Partial<Session>;

const sess = (id: string, status: Session['status'], cardId?: string): Session => ({
  ...base,
  id,
  name: id,
  status,
  ...(cardId ? { cardId } : {}),
});

describe('board-linkage: sessionsForCard', () => {
  it('matches only sessions whose cardId equals the card id', () => {
    const sessions = [
      sess('a', 'running', 'card-1'),
      sess('b', 'exited', 'card-2'),
      sess('c', 'running'), // no cardId
      sess('d', 'stale', 'card-1'),
    ];
    const matched = sessionsForCard(sessions, 'card-1');
    expect(matched.map((s) => s.id)).toEqual(['a', 'd']);
  });

  it('returns an empty array when nothing links to the card', () => {
    expect(sessionsForCard([sess('a', 'running', 'card-9')], 'card-1')).toEqual([]);
  });

  it('never matches a session with an undefined cardId', () => {
    expect(sessionsForCard([sess('a', 'running')], 'card-1')).toEqual([]);
  });
});

describe('board-linkage: badgeStateForCard', () => {
  it('returns null when no session links to the card', () => {
    expect(badgeStateForCard([sess('a', 'running', 'other')], 'card-1')).toBeNull();
  });

  it('prefers a running session and points the badge at it', () => {
    const sessions = [sess('exited', 'exited', 'card-1'), sess('running', 'running', 'card-1')];
    const badge = badgeStateForCard(sessions, 'card-1');
    expect(badge).not.toBeNull();
    expect(badge?.status).toBe('running');
    expect(badge?.sessionId).toBe('running');
    expect(badge?.count).toBe(2);
  });

  it('treats stale as a non-running (exited-like) badge', () => {
    const badge = badgeStateForCard([sess('s', 'stale', 'card-1')], 'card-1');
    expect(badge?.status).toBe('exited');
    expect(badge?.sessionId).toBe('s');
    expect(badge?.count).toBe(1);
  });

  it('falls back to the most-recently-active session when none is running', () => {
    const older = { ...sess('old', 'exited', 'card-1'), lastActiveAt: 100 };
    const newer = { ...sess('new', 'exited', 'card-1'), lastActiveAt: 500 };
    const badge = badgeStateForCard([older, newer], 'card-1');
    expect(badge?.sessionId).toBe('new');
    expect(badge?.status).toBe('exited');
  });

  it('points at the most-recently-active RUNNING session when several run', () => {
    const r1 = { ...sess('r1', 'running', 'card-1'), lastActiveAt: 100 };
    const r2 = { ...sess('r2', 'running', 'card-1'), lastActiveAt: 900 };
    const badge = badgeStateForCard([r1, r2], 'card-1');
    expect(badge?.sessionId).toBe('r2');
    expect(badge?.status).toBe('running');
    expect(badge?.count).toBe(2);
  });
});
