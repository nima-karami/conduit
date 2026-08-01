import { describe, expect, it } from 'vitest';
import type { BoardCard, BoardData } from '../../src/board';
import {
  badgeStateForCard,
  proposedAdditionsIn,
  proposedFlags,
  sessionsForCard,
} from '../../src/board-linkage';
import { diffBoard } from '../../src/conduit-proposal';
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

const bcard = (
  id: string,
  stage: BoardCard['stage'],
  over: Partial<BoardCard> = {},
): BoardCard => ({
  id,
  title: id.toUpperCase(),
  notes: '',
  stage,
  ...over,
});

describe('board-linkage: proposedFlags', () => {
  it('flags nothing when no proposal is pending', () => {
    expect(proposedFlags(null).size).toBe(0);
  });

  it('flags a card the proposal adds, moves, edits or removes', () => {
    const current: BoardData = {
      version: 1,
      cards: [
        bcard('keep', 'wishlist'),
        bcard('mover', 'planning'),
        bcard('editee', 'building'),
        bcard('goner', 'done'),
      ],
    };
    const proposed: BoardData = {
      version: 1,
      cards: [
        bcard('keep', 'wishlist'),
        bcard('mover', 'building'),
        bcard('editee', 'building', { notes: 'rewritten' }),
        bcard('fresh', 'wishlist'),
      ],
    };
    const flags = proposedFlags(diffBoard(current, proposed));
    expect([...flags.keys()].sort()).toEqual(['editee', 'fresh', 'goner', 'mover']);
    expect(flags.get('keep')).toBeUndefined();
    expect(flags.get('fresh')?.changes).toEqual(['added']);
    expect(flags.get('fresh')?.detail).toBe('new card in Wish list');
    expect(flags.get('mover')?.detail).toBe('move to Building');
    expect(flags.get('editee')?.detail).toBe('edit notes');
    expect(flags.get('goner')?.detail).toBe('remove this card');
  });

  it('merges the facets when one card is both moved and edited', () => {
    const current: BoardData = { version: 1, cards: [bcard('c', 'planning')] };
    const proposed: BoardData = {
      version: 1,
      cards: [bcard('c', 'done', { title: 'Renamed', notes: 'why' })],
    };
    const flag = proposedFlags(diffBoard(current, proposed)).get('c');
    expect(flag?.changes).toEqual(['moved', 'edited']);
    expect(flag?.detail).toBe('move to Done · edit title, notes');
  });

  it('clears itself once the proposal matches the board', () => {
    const board: BoardData = { version: 1, cards: [bcard('c', 'planning')] };
    expect(proposedFlags(diffBoard(board, board)).size).toBe(0);
  });
});

describe('board-linkage: proposedAdditionsIn', () => {
  it('returns only the cards a proposal would add to that stage', () => {
    const current: BoardData = { version: 1, cards: [] };
    const proposed: BoardData = {
      version: 1,
      cards: [bcard('a', 'wishlist'), bcard('b', 'building'), bcard('c', 'wishlist')],
    };
    const diff = diffBoard(current, proposed);
    expect(proposedAdditionsIn(diff, 'wishlist').map((c) => c.id)).toEqual(['a', 'c']);
    expect(proposedAdditionsIn(diff, 'building').map((c) => c.id)).toEqual(['b']);
    expect(proposedAdditionsIn(diff, 'done')).toEqual([]);
  });

  it('is empty with no proposal pending', () => {
    expect(proposedAdditionsIn(null, 'wishlist')).toEqual([]);
  });
});
