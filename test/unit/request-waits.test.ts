import { describe, expect, it } from 'vitest';
import { createRequestWaits, requestWaitMs } from '../../src/conduit-mcp/request-waits';

interface FakeTimer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

function setup() {
  const timers: FakeTimer[] = [];
  const changes = { n: 0 };
  const waits = createRequestWaits({
    setTimer: (fn, ms) => {
      const t: FakeTimer = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as FakeTimer).cleared = true;
    },
    onWaitingChanged: () => {
      changes.n++;
    },
  });
  // Honours cleared, so a timer left armed after its wait ended would still fire here.
  const fire = (t: FakeTimer) => {
    if (!t.cleared) t.fn();
  };
  return { waits, timers, changes, fire };
}

const key = (connId: number, requestId: string) => ({ connId, requestId });

describe('createRequestWaits', () => {
  it('ended resolves every wait on that id', async () => {
    const t = setup();
    const a = t.waits.open({
      requestId: 'r1',
      sessionId: 's1',
      key: key(1, 'a'),
      timeoutMs: 60_000,
    });
    const b = t.waits.open({
      requestId: 'r1',
      sessionId: 's2',
      key: key(2, 'b'),
      timeoutMs: 60_000,
    });
    t.waits.open({ requestId: 'r2', sessionId: 's1', key: key(1, 'c'), timeoutMs: 60_000 });
    t.waits.ended('r1');
    expect(await a).toEqual({ kind: 'ended' });
    expect(await b).toEqual({ kind: 'ended' });
    expect(t.waits.isWaiting('r1')).toBe(false);
    expect(t.waits.isWaiting('r2')).toBe(true);
  });

  it('timeout resolves timeout', async () => {
    const t = setup();
    const p = t.waits.open({
      requestId: 'r1',
      sessionId: 's1',
      key: key(1, 'a'),
      timeoutMs: 5_000,
    });
    expect(t.timers).toHaveLength(1);
    expect(t.timers[0]?.ms).toBe(5_000);
    t.fire(t.timers[0] as FakeTimer);
    expect(await p).toEqual({ kind: 'timeout' });
    expect(t.waits.isWaiting('r1')).toBe(false);
  });

  it('cancel by key resolves cancelled and isWaiting turns false', async () => {
    const t = setup();
    const a = t.waits.open({
      requestId: 'r1',
      sessionId: 's1',
      key: key(1, 'a'),
      timeoutMs: 60_000,
    });
    const b = t.waits.open({
      requestId: 'r2',
      sessionId: 's1',
      key: key(2, 'b'),
      timeoutMs: 60_000,
    });
    t.waits.cancel((w) => w.key.connId === 1 && w.key.requestId === 'a');
    expect(await a).toEqual({ kind: 'cancelled' });
    expect(t.waits.isWaiting('r1')).toBe(false);
    expect(t.waits.isWaiting('r2')).toBe(true);
    t.waits.dispose();
    expect(await b).toEqual({ kind: 'cancelled' });
  });

  it('onWaitingChanged fires on open and on every end', async () => {
    const t = setup();
    t.waits.open({ requestId: 'r1', sessionId: 's1', key: key(1, 'a'), timeoutMs: 60_000 });
    t.waits.open({ requestId: 'r1', sessionId: 's1', key: key(1, 'b'), timeoutMs: 60_000 });
    expect(t.changes.n).toBe(2);
    t.waits.ended('r1');
    expect(t.changes.n).toBe(3);
    t.waits.ended('r1');
    expect(t.changes.n).toBe(3);
    t.waits.open({ requestId: 'r2', sessionId: 's1', key: key(1, 'c'), timeoutMs: 5_000 });
    expect(t.changes.n).toBe(4);
    t.fire(t.timers[2] as FakeTimer);
    expect(t.changes.n).toBe(5);
  });

  it('zero timeout resolves timeout at once and never counts as waiting', async () => {
    const t = setup();
    const p = t.waits.open({ requestId: 'r1', sessionId: 's1', key: key(1, 'a'), timeoutMs: 0 });
    expect(await p).toEqual({ kind: 'timeout' });
    expect(t.waits.isWaiting('r1')).toBe(false);
    expect(t.waits.countFor('s1')).toBe(0);
    expect(t.timers).toHaveLength(0);
    expect(t.changes.n).toBe(0);
  });

  it('requestWaitMs defaults to budget minus 10 s', () => {
    expect(requestWaitMs(null, 120_000)).toEqual({ ms: 110_000 });
    expect(requestWaitMs(null, 5_000)).toEqual({ ms: 0 });
  });

  it('requestWaitMs clamps to budget minus 5 s', () => {
    expect(requestWaitMs(200, 50_000)).toEqual({ ms: 45_000, clampedTo: 45 });
    expect(requestWaitMs(30, 50_000)).toEqual({ ms: 30_000 });
  });

  it('requestWaitMs(0) is zero', () => {
    expect(requestWaitMs(0, 50_000)).toEqual({ ms: 0 });
    expect(requestWaitMs(0, 1_000)).toEqual({ ms: 0 });
  });

  it('countFor counts per session', async () => {
    const t = setup();
    t.waits.open({ requestId: 'r1', sessionId: 's1', key: key(1, 'a'), timeoutMs: 60_000 });
    t.waits.open({ requestId: 'r2', sessionId: 's1', key: key(1, 'b'), timeoutMs: 60_000 });
    t.waits.open({ requestId: 'r3', sessionId: 's2', key: key(2, 'c'), timeoutMs: 60_000 });
    expect(t.waits.countFor('s1')).toBe(2);
    expect(t.waits.countFor('s2')).toBe(1);
    expect(t.waits.countFor('s3')).toBe(0);
    t.waits.ended('r1');
    expect(t.waits.countFor('s1')).toBe(1);
  });

  it('a timer is cleared when the wait ends early', async () => {
    const t = setup();
    t.waits.open({ requestId: 'r1', sessionId: 's1', key: key(1, 'a'), timeoutMs: 60_000 });
    t.waits.ended('r1');
    expect(t.timers[0]?.cleared).toBe(true);
  });
});
