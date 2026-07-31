import { describe, expect, it } from 'vitest';
import {
  applySnooze,
  attentionChipLabel,
  attentionSessions,
  nextSnoozeExpiry,
  pruneSnoozed,
  SNOOZE_MS,
} from '../../src/attention';
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

describe('Snooze (D16)', () => {
  const T0 = 1_000_000;
  const waiting = [s('a', { needsAttention: true }), s('b', { needsAttention: true })];

  it('silences one session for ten minutes and leaves the rest alone', () => {
    const snoozed = new Map([['a', T0 + SNOOZE_MS]]);
    const after = applySnooze(waiting, snoozed, T0);
    expect(attentionSessions(after).map((x) => x.id)).toEqual(['b']);
    expect(SNOOZE_MS).toBe(10 * 60 * 1000);
  });

  it('does not mutate the session — the host flag is untouched, so nothing answers the prompt', () => {
    const snoozed = new Map([['a', T0 + SNOOZE_MS]]);
    applySnooze(waiting, snoozed, T0);
    expect(waiting[0].needsAttention).toBe(true);
  });

  it('raises the session again once the window lapses', () => {
    const snoozed = new Map([['a', T0 + SNOOZE_MS]]);
    const after = applySnooze(waiting, snoozed, T0 + SNOOZE_MS + 1);
    expect(attentionSessions(after).map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('is a no-op for a session that is not waiting', () => {
    const quiet = [s('a')];
    expect(applySnooze(quiet, new Map([['a', T0 + SNOOZE_MS]]), T0)).toEqual(quiet);
  });

  it('prunes lapsed entries and keeps the same map when none lapsed', () => {
    const snoozed = new Map([
      ['a', T0 + 10],
      ['b', T0 + 20],
    ]);
    expect(pruneSnoozed(snoozed, T0)).toBe(snoozed);
    expect([...pruneSnoozed(snoozed, T0 + 15).keys()]).toEqual(['b']);
    expect(pruneSnoozed(snoozed, T0 + 100).size).toBe(0);
  });

  it('reports the earliest expiry so one timer covers every snooze', () => {
    expect(nextSnoozeExpiry(new Map())).toBeUndefined();
    expect(
      nextSnoozeExpiry(
        new Map([
          ['a', T0 + 50],
          ['b', T0 + 10],
        ]),
      ),
    ).toBe(T0 + 10);
  });
});
