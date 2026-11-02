import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerLifecycle, type ShellCore, STOP_FAILED_EXIT } from '../../server/lifecycle/shell';
import {
  SERVER_STARTUP_DEADLINE_MS,
  STOP_KILL_PERSIST_BUDGET_MS,
} from '../../src/contracts/server-protocol';
import { SERVER_EXIT } from '../../src/contracts/session-identity';

function setup() {
  const steps: string[] = [];
  const core = {
    start: vi.fn<ShellCore['start']>(() => new Promise(() => {})),
    beginStopping: vi.fn(async (mode: 'restart' | 'stopAll') => {
      steps.push(mode);
    }),
    killSessions: vi.fn(async () => {
      steps.push('kill');
      return 2;
    }),
    persist: vi.fn(async () => {
      steps.push('persist');
    }),
    idleState: vi.fn(async () => ({ liveTerminals: 0, pendingTimers: false, busyTokens: false })),
    snapshot: vi.fn(),
  } satisfies ShellCore;
  const exit = vi.fn();
  const emit = vi.fn();
  const onError = vi.fn();
  const lifecycle = new ServerLifecycle({ core, exit, emit, onError, logPath: '/logs/server.log' });
  return { lifecycle, core, exit, emit, onError, steps };
}

describe('server lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('bounds startup health without abandoning the pending core', async () => {
    const x = setup();
    let ready: (v: { state: 'ready'; hcVersion: string }) => void = () => {};
    x.core.start.mockImplementation(
      () =>
        new Promise((resolve) => {
          ready = resolve;
        }),
    );
    x.lifecycle.start();
    await vi.advanceTimersByTimeAsync(SERVER_STARTUP_DEADLINE_MS);
    expect(x.lifecycle.runtime).toEqual({
      state: 'unavailable',
      reason: 'startup timeout',
      logPath: '/logs/server.log',
    });
    ready({ state: 'ready', hcVersion: '0.1.16' });
    await Promise.resolve();
    expect(x.lifecycle.runtime).toEqual({ state: 'ready', hcVersion: '0.1.16' });
    expect(x.exit).not.toHaveBeenCalled();
    x.lifecycle.dispose();
  });

  it('retries a rejected startup in the background', async () => {
    const x = setup();
    x.core.start.mockRejectedValueOnce(new Error('core offline'));
    x.lifecycle.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(x.core.start.mock.calls.length).toBeGreaterThan(1);
    x.lifecycle.dispose();
  });

  it('settles stopAll, kills, persists, replies, then exits', async () => {
    const x = setup();
    const reply = x.lifecycle.stop('stopAll', 'stopAll');
    expect(x.lifecycle.stopping).toBe(true);
    const stopped = await reply;
    expect(x.steps).toEqual(['stopAll', 'kill', 'persist']);
    expect(stopped).toMatchObject({ kind: 'stopped', killed: 2 });
    if (stopped.kind !== 'stopped') throw new Error('expected a stop');
    expect(x.exit).not.toHaveBeenCalled();
    await stopped.afterReply();
    expect(x.exit).toHaveBeenCalledWith(SERVER_EXIT.doneCoreIdle);
    x.lifecycle.dispose();
  });

  it('restart settles and persists without killing sessions', async () => {
    const x = setup();
    const stopped = await x.lifecycle.stop('restart', 'update');
    expect(x.steps).toEqual(['restart', 'persist']);
    if (stopped.kind !== 'stopped') throw new Error('expected a stop');
    await stopped.afterReply();
    expect(x.exit).toHaveBeenCalledWith(SERVER_EXIT.done);
    expect(x.core.killSessions).not.toHaveBeenCalled();
    x.lifecycle.dispose();
  });

  it('upgrades a settling restart to stopAll and kills only after the settle is released', async () => {
    const x = setup();
    let release: () => void = () => {};
    x.core.beginStopping.mockImplementationOnce(
      (mode) =>
        new Promise<void>((resolve) => {
          x.steps.push(mode);
          release = resolve;
        }),
    );
    const restart = x.lifecycle.stop('restart', 'update');
    const stopAll = x.lifecycle.stop('stopAll', 'stopAll');
    await vi.advanceTimersByTimeAsync(0);
    expect(x.core.killSessions).not.toHaveBeenCalled();
    expect(x.steps).toEqual(['restart']);
    release();
    const stopped = await stopAll;
    expect(x.steps).toEqual(['restart', 'stopAll', 'kill', 'persist']);
    expect(stopped).toMatchObject({ kind: 'stopped', killed: 2 });
    expect(await restart).toBe(stopped);
    expect(x.emit.mock.calls.filter(([type]) => type === 'server.stopping')).toEqual([
      ['server.stopping', { reason: 'update' }],
      ['server.stopping', { reason: 'stopAll' }],
    ]);
    if (stopped.kind !== 'stopped') throw new Error('expected a stop');
    await stopped.afterReply();
    expect(x.exit).toHaveBeenCalledWith(SERVER_EXIT.doneCoreIdle);
    x.lifecycle.dispose();
  });

  it('leaves a stopAll unanswered once a restart is past its kill decision (F12 fallback)', async () => {
    const x = setup();
    const restart = await x.lifecycle.stop('restart', 'update');
    expect(x.steps).toEqual(['restart', 'persist']);
    const late = await x.lifecycle.stop('stopAll', 'stopAll');
    expect(late).toEqual({ kind: 'late' });
    expect(x.core.killSessions).not.toHaveBeenCalled();
    if (restart.kind !== 'stopped') throw new Error('expected a stop');
    await restart.afterReply();
    expect(x.exit).toHaveBeenCalledWith(SERVER_EXIT.done);
    x.lifecycle.dispose();
  });

  it('a stop past its kill/persist budget replies with the error, then exits as a crash', async () => {
    const x = setup();
    x.core.persist.mockImplementation(() => new Promise<void>(() => {}));
    let settled = false;
    const result = x.lifecycle.stop('stopAll', 'stopAll').finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(STOP_KILL_PERSIST_BUDGET_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await result;
    expect(outcome).toMatchObject({
      kind: 'failed',
      error: new Error('stop kill/persist timeout'),
    });
    expect(x.exit).not.toHaveBeenCalled();
    if (outcome.kind !== 'failed') throw new Error('expected a failure');
    await outcome.afterReply();
    expect(x.exit).toHaveBeenCalledWith(STOP_FAILED_EXIT);
    expect(Object.values(SERVER_EXIT)).not.toContain(STOP_FAILED_EXIT);
    x.lifecycle.dispose();
  });

  it.each([
    ['beginStopping', (x: ReturnType<typeof setup>) => x.core.beginStopping],
    ['persist', (x: ReturnType<typeof setup>) => x.core.persist],
  ] as const)('a rejected %s replies with the error, then exits as a crash', async (_, pick) => {
    const x = setup();
    pick(x).mockRejectedValueOnce(new Error('disk gone'));
    const outcome = await x.lifecycle.stop('restart', 'user');
    expect(outcome).toMatchObject({ kind: 'failed', error: new Error('disk gone') });
    if (outcome.kind !== 'failed') throw new Error('expected a failure');
    await outcome.afterReply();
    expect(x.exit).toHaveBeenCalledWith(STOP_FAILED_EXIT);
    x.lifecycle.dispose();
  });

  it('logs an idle persist failure, keeps runtime health and retries at the next idle', async () => {
    const x = setup();
    x.core.persist.mockRejectedValueOnce(new Error('disk busy'));
    x.core.start.mockResolvedValue({ state: 'ready', hcVersion: '0.1.16' });
    x.lifecycle.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(x.onError).toHaveBeenCalledWith(new Error('disk busy'));
    expect(x.lifecycle.runtime).toEqual({ state: 'ready', hcVersion: '0.1.16' });
    expect(x.lifecycle.stopping).toBe(false);
    expect(x.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(x.exit).toHaveBeenCalledWith(SERVER_EXIT.doneCoreIdle);
    x.lifecycle.dispose();
  });

  it('aborts an idle exit when any C2 connection arrives during persist', async () => {
    const x = setup();
    let finish: () => void = () => {};
    x.core.persist.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    x.lifecycle.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(x.core.persist).toHaveBeenCalled();
    x.lifecycle.connected();
    x.lifecycle.disconnected();
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(x.exit).not.toHaveBeenCalled();
    expect(x.lifecycle.stopping).toBe(false);
    x.lifecycle.dispose();
  });

  it.each([
    { liveTerminals: 1, pendingTimers: false, busyTokens: false },
    { liveTerminals: 0, pendingTimers: true, busyTokens: false },
    { liveTerminals: 0, pendingTimers: false, busyTokens: true },
  ])('keeps an idle server while core is busy: %j', async (busy) => {
    const x = setup();
    x.core.idleState.mockResolvedValue(busy);
    x.lifecycle.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
    expect(x.core.idleState).toHaveBeenCalled();
    expect(x.core.persist).not.toHaveBeenCalled();
    expect(x.exit).not.toHaveBeenCalled();
    x.lifecycle.dispose();
  });

  it('exits idle with core-idle code after persisting', async () => {
    const x = setup();
    x.lifecycle.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(x.steps).toEqual(['persist']);
    expect(x.exit).toHaveBeenCalledWith(SERVER_EXIT.doneCoreIdle);
    x.lifecycle.dispose();
  });
});
