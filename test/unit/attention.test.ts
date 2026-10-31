import { describe, expect, it } from 'vitest';
import {
  applySnooze,
  attentionChipLabel,
  attentionEntries,
  attentionSessions,
  nextSnoozeExpiry,
  pruneSnoozed,
  SNOOZE_MS,
  visibleSessionIds,
} from '../../src/attention';
import type { McpAttentionItem } from '../../src/conduit-mcp/types';
import type { Session } from '../../src/types';

type Flags = Pick<Session, 'status' | 'busy' | 'needsAttention'> & { id: string };

const s = (id: string, over: Partial<Flags> = {}): Flags => ({
  id,
  status: 'running',
  busy: false,
  needsAttention: false,
  ...over,
});

describe('visibleSessionIds', () => {
  it('reports the active session and the split pane', () => {
    expect(visibleSessionIds('a', 'b')).toEqual(['a', 'b']);
  });

  it('drops the empty slots', () => {
    expect(visibleSessionIds('a', null)).toEqual(['a']);
    expect(visibleSessionIds(null, 'b')).toEqual(['b']);
    expect(visibleSessionIds(undefined, undefined)).toEqual([]);
    expect(visibleSessionIds('', null)).toEqual([]);
  });

  it('dedupes a split that is the active session', () => {
    expect(visibleSessionIds('a', 'a')).toEqual(['a']);
  });
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

describe('attentionEntries (conduit-mcp §8 chip)', () => {
  const item = (o: Partial<McpAttentionItem>): McpAttentionItem => ({
    id: 'urgent-waiting:codex-2:m1',
    reason: 'urgent-waiting',
    handle: 'codex-2',
    sessionId: 'b',
    threadId: 't1',
    messageId: 'm1',
    at: '2026-10-25T10:00:00.000Z',
    ...o,
  });
  const NOW = 1_000_000;

  it('session entries first, then items by at', () => {
    const sessions = [s('a', { needsAttention: true }), s('b')];
    const items = [
      item({ id: 'late', at: '2026-10-25T11:00:00.000Z' }),
      item({ id: 'early', at: '2026-10-25T09:00:00.000Z', reason: 'message-to-you' }),
    ];
    const entries = attentionEntries(sessions, items, new Map(), NOW);
    expect(entries.map((e) => e.key)).toEqual(['session:a', 'early', 'late']);
    expect(entries[0]).toMatchObject({ kind: 'session', sessionId: 'a', reason: null });
    expect(entries[1]).toMatchObject({ kind: 'message', threadId: 't1', reason: 'message-to-you' });
  });

  it('items of a snoozed session are hidden; thread items stay', () => {
    const sessions = [s('b', { needsAttention: true })];
    const items = [item({ id: 'tied' }), item({ id: 'thread', sessionId: null })];
    const snoozed = new Map([['b', NOW + SNOOZE_MS]]);
    expect(attentionEntries(sessions, items, snoozed, NOW).map((e) => e.key)).toEqual(['thread']);
    // A lapsed snooze hides nothing.
    const lapsed = new Map([['b', NOW - 1]]);
    expect(attentionEntries(sessions, items, lapsed, NOW).map((e) => e.key)).toEqual([
      'session:b',
      'tied',
      'thread',
    ]);
  });

  it('count includes items', () => {
    const sessions = [s('a', { needsAttention: true })];
    expect(attentionChipLabel(attentionEntries(sessions, [item({})], new Map(), NOW).length)).toBe(
      '2 need you',
    );
  });
});

describe('attentionEntries with asks', () => {
  const NOW = 1_000_000;
  const ask = { askId: 'a1', callerSessionId: 's1', callerHandle: 'fake-1' };

  it('asks come first and are not snoozable', () => {
    const sessions = [s('s1', { needsAttention: true }), s('s2', { needsAttention: true })];
    const snoozed = new Map([['s1', NOW + SNOOZE_MS]]);
    const entries = attentionEntries(sessions, [], snoozed, NOW, [ask]);
    expect(entries.map((e) => e.key)).toEqual(['ask:a1', 'session:s2']);
    expect(entries[0]).toEqual({
      key: 'ask:a1',
      kind: 'ask',
      sessionId: 's1',
      threadId: null,
      reason: null,
      handle: 'fake-1',
    });
  });

  it('chip label counts asks', () => {
    const sessions = [s('s2', { needsAttention: true })];
    const entries = attentionEntries(sessions, [], new Map(), NOW, [ask, { ...ask, askId: 'a2' }]);
    expect(attentionChipLabel(entries.length)).toBe('3 need you');
  });
});
