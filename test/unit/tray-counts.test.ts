import { describe, expect, it } from 'vitest';
import { attentionSessions } from '../../src/attention';
import type { RuntimeHealth, SessionView } from '../../src/contracts/server-protocol';
import { runningSessions } from '../../src/quit-guard';
import { trayCounts } from '../../src/tray-counts';

describe('trayCounts', () => {
  const sessions = [
    { status: 'running', needsAttention: true },
    { status: 'running', needsAttention: true, busy: true },
    { status: 'running', busy: false },
    { status: 'exited', needsAttention: true },
    { status: 'stale', needsAttention: true },
  ] as const;

  it('shares running and attention derivations, without changing the input', () => {
    const before = structuredClone(sessions);
    expect(trayCounts(sessions, 'ready', null)).toEqual({
      running: runningSessions(sessions).length,
      needsYou: attentionSessions(runningSessions(sessions)).length,
      health: 'ready',
      stopping: null,
    });
    expect(trayCounts(sessions, 'ready', null)).toMatchObject({ running: 3, needsYou: 1 });
    expect(sessions).toEqual(before);
  });

  it.each<RuntimeHealth['state']>(['ready', 'starting', 'degraded', 'unavailable'])(
    'preserves %s health and the stopping reason at zero sessions',
    (health) => {
      expect(trayCounts([], health, 'stopAll')).toEqual({
        running: 0,
        needsYou: 0,
        health,
        stopping: 'stopAll',
      });
    },
  );

  it('accepts the server SessionView and preserves generic running-session fields', () => {
    const serverSessions: readonly SessionView[] = [];
    expect(trayCounts(serverSessions, 'ready', 'idle').stopping).toBe('idle');
    const minimal = [{ status: 'running', terminal: 'hc-1' }] as const;
    expect(runningSessions(minimal)[0]).toBe(minimal[0]);
    expect(runningSessions(minimal)[0].terminal).toBe('hc-1');
  });
});
