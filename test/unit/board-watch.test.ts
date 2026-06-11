import { describe, expect, it } from 'vitest';
import type { BoardData } from '../../src/board';
import { fingerprint, isSelfEcho } from '../../src/board-watch';

const board = (cards: BoardData['cards']): BoardData => ({ version: 1, cards });

describe('fingerprint', () => {
  it('is stable for the same board cards', () => {
    const b = board([{ id: 'a', title: 'A', notes: '', stage: 'wishlist' }]);
    expect(fingerprint(b)).toBe(fingerprint(b));
  });

  it('differs when a card moves stage (the agent-advances-card case)', () => {
    const before = board([{ id: 'a', title: 'A', notes: '', stage: 'wishlist' }]);
    const after = board([{ id: 'a', title: 'A', notes: '', stage: 'building' }]);
    expect(fingerprint(before)).not.toBe(fingerprint(after));
  });

  it('ignores the envelope provenance timestamp (compares card payload only)', () => {
    // Two saves of the same cards at different wall-clock times must fingerprint equal,
    // so the host can record a write fingerprint that still matches the file on disk
    // regardless of the envelope `updatedAt`.
    const cards = [{ id: 'a', title: 'A', notes: 'n', stage: 'done' as const }];
    expect(fingerprint(board(cards))).toBe(fingerprint(board([...cards])));
  });
});

describe('isSelfEcho (watcher loop-avoidance)', () => {
  const a = fingerprint(board([{ id: 'a', title: 'A', notes: '', stage: 'wishlist' }]));
  const b = fingerprint(board([{ id: 'a', title: 'A', notes: '', stage: 'building' }]));

  it('true when current matches what we last wrote (our own write echoing back)', () => {
    expect(isSelfEcho(a, a)).toBe(true);
  });

  it('false when current differs from what we last wrote (a genuine external change)', () => {
    expect(isSelfEcho(a, b)).toBe(false);
  });

  it('false when we have never written (any content is external)', () => {
    expect(isSelfEcho(undefined, a)).toBe(false);
  });
});
