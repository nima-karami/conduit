import { describe, expect, it } from 'vitest';
import { attentionSessions } from '../../src/attention';
import type { RequestSource } from '../../src/conduit-mcp/request-types';
import type { RuntimeHealth, SessionView } from '../../src/contracts/server-protocol';
import { runningSessions } from '../../src/quit-guard';
import { trayCounts } from '../../src/tray-counts';

const NO_NEEDS = { openRequests: [], waitingAsks: 0 };
const request = (session: string | null, source: RequestSource) => ({ session, source });

describe('trayCounts', () => {
  it('a waiting ask counts once in needsYou, with no request in the open list', () => {
    const waitingPermission = { openRequests: [], waitingAsks: 1 };
    expect(trayCounts([], 'ready', null, waitingPermission).needsYou).toBe(1);
  });

  const sessions = [
    { id: 'a', status: 'running', needsAttention: true },
    { id: 'b', status: 'running', needsAttention: true, busy: true },
    { id: 'c', status: 'running', busy: false },
    { id: 'd', status: 'exited', needsAttention: true },
    { id: 'e', status: 'stale', needsAttention: true },
  ] as const;

  it('shares running and attention derivations, without changing the input', () => {
    const before = structuredClone(sessions);
    expect(trayCounts(sessions, 'ready', null, NO_NEEDS)).toEqual({
      running: runningSessions(sessions).length,
      needsYou: attentionSessions(runningSessions(sessions)).length,
      health: 'ready',
      stopping: null,
    });
    expect(trayCounts(sessions, 'ready', null, NO_NEEDS)).toMatchObject({
      running: 3,
      needsYou: 1,
    });
    expect(sessions).toEqual(before);
  });

  const twoAttention = [
    { id: 'a', status: 'running', needsAttention: true },
    { id: 'f', status: 'running', needsAttention: true },
  ] as const;

  it('counts open requests and waiting asks', () => {
    const needs = {
      openRequests: [request('c', 'agent'), request(null, 'message')],
      waitingAsks: 3,
    };
    expect(trayCounts(sessions, 'ready', null, needs)).toMatchObject({ needsYou: 6 });
  });

  it('a session with an open attend request is counted once', () => {
    const needs = { openRequests: [request('a', 'observed')], waitingAsks: 0 };
    expect(trayCounts(twoAttention, 'ready', null, needs)).toMatchObject({ needsYou: 2 });
  });

  it('a session with an open scheduler request is counted once', () => {
    const needs = { openRequests: [request('a', 'scheduler')], waitingAsks: 0 };
    expect(trayCounts(twoAttention, 'ready', null, needs)).toMatchObject({ needsYou: 2 });
  });

  it('a session that asked and also needs attention is counted once', () => {
    const needs = {
      openRequests: [request('a', 'message'), request('a', 'agent')],
      waitingAsks: 0,
    };
    expect(trayCounts(twoAttention, 'ready', null, needs)).toMatchObject({ needsYou: 3 });
  });

  it('a question message request counts once', () => {
    const quiet = [{ id: 'c', status: 'running', busy: false }] as const;
    const needs = { openRequests: [request('c', 'message')], waitingAsks: 0 };
    expect(trayCounts(quiet, 'ready', null, needs)).toMatchObject({ running: 1, needsYou: 1 });
  });

  it.each<RuntimeHealth['state']>(['ready', 'starting', 'degraded', 'unavailable'])(
    'preserves %s health and the stopping reason at zero sessions',
    (health) => {
      expect(trayCounts([], health, 'stopAll', NO_NEEDS)).toEqual({
        running: 0,
        needsYou: 0,
        health,
        stopping: 'stopAll',
      });
    },
  );

  it('accepts the server SessionView and preserves generic running-session fields', () => {
    const serverSessions: readonly SessionView[] = [];
    expect(trayCounts(serverSessions, 'ready', 'idle', NO_NEEDS).stopping).toBe('idle');
    const minimal = [{ id: 'x', status: 'running', terminal: 'hc-1' }] as const;
    expect(runningSessions(minimal)[0]).toBe(minimal[0]);
    expect(runningSessions(minimal)[0].terminal).toBe('hc-1');
  });
});
