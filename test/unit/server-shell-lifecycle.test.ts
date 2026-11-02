import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerLifecycle, type ShellCore } from '../../server/lifecycle/shell';
import { SERVER_STARTUP_DEADLINE_MS } from '../../src/contracts/server-protocol';
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
  const lifecycle = new ServerLifecycle({ core, exit, emit, logPath: '/logs/server.log' });
  return { lifecycle, core, exit, emit, steps };
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
    expect(stopped.killed).toBe(2);
    expect(x.exit).not.toHaveBeenCalled();
    await stopped.afterReply();
    expect(x.exit).toHaveBeenCalledWith(SERVER_EXIT.doneCoreIdle);
    x.lifecycle.dispose();
  });

  it('restart settles and persists without killing sessions', async () => {
    const x = setup();
    const stopped = await x.lifecycle.stop('restart', 'update');
    expect(x.steps).toEqual(['restart', 'persist']);
    await stopped.afterReply();
    expect(x.exit).toHaveBeenCalledWith(SERVER_EXIT.done);
    expect(x.core.killSessions).not.toHaveBeenCalled();
    x.lifecycle.dispose();
  });

  it('upgrades a settling restart to stopAll and supersedes its unresolved launches', async () => {
    const x = setup();
    let release: () => void = () => {};
    x.core.beginStopping.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const restart = x.lifecycle.stop('restart', 'update');
    const stopAll = x.lifecycle.stop('stopAll', 'stopAll');
    release();
    const stopped = await stopAll;
    expect(x.core.beginStopping.mock.calls.map(([mode]) => mode)).toEqual(['restart', 'stopAll']);
    expect(stopped.killed).toBe(2);
    expect(await restart).toBe(stopped);
    await stopped.afterReply();
    expect(x.exit).toHaveBeenCalledWith(SERVER_EXIT.doneCoreIdle);
    x.lifecycle.dispose();
  });

  it('bounds kill/persist work and refuses to claim a successful stop on timeout', async () => {
    const x = setup();
    x.core.persist.mockImplementation(() => new Promise<void>(() => {}));
    const result = x.lifecycle.stop('stopAll', 'stopAll');
    let settled = false;
    const outcome = result.then(
      () => {
        settled = true;
        return { ok: true, reason: '' };
      },
      (error: unknown) => {
        settled = true;
        return { ok: false, reason: String(error) };
      },
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toEqual({ ok: false, reason: 'Error: stop kill/persist timeout' });
    expect(x.exit).not.toHaveBeenCalled();
    expect(x.lifecycle.stopping).toBe(true);
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
