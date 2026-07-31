import { describe, expect, it } from 'vitest';
import { attentionChipLabel, attentionSessions } from '../../src/attention';
import type { Session } from '../../src/types';

type Flags = Pick<Session, 'status' | 'busy' | 'needsAttention'> & { id: string };

const s = (id: string, over: Partial<Flags> = {}): Flags => ({
  id,
  status: 'running',
  busy: false,
  needsAttention: false,
  ...over,
});

describe('attentionSessions', () => {
  it('selects only running sessions that are waiting on the user', () => {
    const list = [
      s('a'),
      s('b', { needsAttention: true }),
      s('c', { busy: true, needsAttention: true }),
      s('d', { status: 'exited', needsAttention: true }),
      s('e', { needsAttention: true }),
    ];
    expect(attentionSessions(list).map((x) => x.id)).toEqual(['b', 'e']);
  });

  it('is empty when nothing is waiting', () => {
    expect(attentionSessions([s('a'), s('b', { busy: true })])).toEqual([]);
    expect(attentionSessions([])).toEqual([]);
  });

  it('keeps list order, so the chip focuses the topmost waiting session', () => {
    const list = [s('x', { needsAttention: true }), s('y', { needsAttention: true })];
    expect(attentionSessions(list)[0].id).toBe('x');
  });
});

describe('attentionChipLabel', () => {
  it('is suppressed at zero rather than rendered as "0"', () => {
    expect(attentionChipLabel(0)).toBeNull();
    expect(attentionChipLabel(-1)).toBeNull();
  });

  it('agrees with itself in number', () => {
    expect(attentionChipLabel(1)).toBe('1 needs you');
    expect(attentionChipLabel(2)).toBe('2 need you');
    expect(attentionChipLabel(11)).toBe('11 need you');
  });
});
