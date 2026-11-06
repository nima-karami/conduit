import { afterEach, describe, expect, it, vi } from 'vitest';
import { supervise } from '../../server/supervise';
import type { SuperviseOptions } from '../../server/tray/contracts';
import { SERVER_EXIT } from '../../src/contracts/session-identity';

function harness(codes: Array<number | null> = [1, 0]) {
  const controller = new AbortController();
  let time = Date.UTC(2026, 0, 1);
  const trace: unknown[] = [];
  const stopSessions = vi.fn(async () => {
    trace.push('sessions');
    return 3;
  });
  const core = {
    hasOtherLiveTerminals: vi.fn(async () => {
      trace.push('checkCore');
      return false;
    }),
    stop: vi.fn(async () => {
      trace.push('stopCore');
    }),
  };
  const marker = {
    write: vi.fn(async () => 'written' as 'written' | 'newer'),
    exists: vi.fn(async () => true),
    remove: vi.fn(async () => {}),
  };
  const spawnChild = vi.fn(async (): Promise<number | null> => {
    const code = codes.shift();
    return code === undefined ? 0 : code;
  });
  const sleep = vi.fn(async (ms: number, _signal?: AbortSignal) => {
    time += ms;
  });
  const log = vi.fn();
  const options: SuperviseOptions = {
    userData: '/profile',
    logPath: '/profile/server.log',
    now: () => time,
    spawnChild,
    sleep,
    stopSignal: controller.signal,
    stopSessions,
    core,
    marker,
    log,
    hooks: {
      phase: (phase) => trace.push(phase),
      childExit: (code) => trace.push({ exit: code }),
    },
  };
  return { controller, options, trace, spawnChild, sleep, stopSessions, core, marker, log };
}

afterEach(() => vi.useRealTimers());

describe('interruptible supervisor', () => {
  it('W1 waits for the serving child and never races it with a session stop', async () => {
    const h = harness();
    let closeChild!: (code: number) => void;
    h.spawnChild.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          closeChild = resolve;
        }),
    );
    let settled = false;
    const result = supervise(h.options).then((exit) => {
      settled = true;
      return exit;
    });
    h.controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(h.stopSessions).not.toHaveBeenCalled();
    closeChild(SERVER_EXIT.done);
    await expect(result).resolves.toEqual({ reason: 'done' });
  });

  it('W2 leaves a clear stop signal alone and follows the normal restart path', async () => {
    const h = harness();
    await expect(supervise(h.options)).resolves.toEqual({ reason: 'done' });
    expect(h.controller.signal.aborted).toBe(false);
    expect(h.stopSessions).not.toHaveBeenCalled();
    expect(h.spawnChild).toHaveBeenCalledTimes(2);
  });

  it('honours an abort at the loop top without spawning a child', async () => {
    const h = harness([0]);
    h.controller.abort();
    await expect(supervise(h.options)).resolves.toEqual({
      reason: 'trayStop',
      ok: true,
      killed: 3,
    });
    expect(h.spawnChild).not.toHaveBeenCalled();
    expect(h.stopSessions).toHaveBeenCalledTimes(1);
    expect(h.core.stop).toHaveBeenCalledTimes(1);
    expect(h.trace).toEqual(['sessions', 'checkCore', 'stopCore']);
  });

  it('W3 stops once after a crash without backoff or respawn', async () => {
    const h = harness();
    h.spawnChild.mockImplementationOnce(async () => {
      h.controller.abort();
      return 1;
    });
    await expect(supervise(h.options)).resolves.toEqual({
      reason: 'trayStop',
      ok: true,
      killed: 3,
    });
    expect(h.spawnChild).toHaveBeenCalledTimes(1);
    expect(h.sleep).not.toHaveBeenCalled();
    expect(h.stopSessions).toHaveBeenCalledTimes(1);
    expect(h.core.stop).toHaveBeenCalledTimes(1);
  });

  it.each([
    [SERVER_EXIT.done, 'done', 0],
    [SERVER_EXIT.doneCoreIdle, 'doneCoreIdle', 1],
  ] as const)('W3 preserves orderly exit %s ahead of a late abort', async (code, reason, stops) => {
    const h = harness();
    h.spawnChild.mockImplementationOnce(async () => {
      h.controller.abort();
      return code;
    });
    await expect(supervise(h.options)).resolves.toEqual({ reason });
    expect(h.stopSessions).not.toHaveBeenCalled();
    expect(h.core.stop).toHaveBeenCalledTimes(stops);
  });

  it('W4 passes the abort signal into backoff and does not respawn', async () => {
    const h = harness();
    h.sleep.mockImplementationOnce(async (_ms, signal) => {
      expect(signal).toBe(h.controller.signal);
      h.controller.abort();
    });
    await expect(supervise(h.options)).resolves.toEqual({
      reason: 'trayStop',
      ok: true,
      killed: 3,
    });
    expect(h.spawnChild).toHaveBeenCalledTimes(1);
    expect(h.stopSessions).toHaveBeenCalledTimes(1);
  });

  it('W4 wakes the real clock immediately on abort and clears its timer', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.options.sleep = undefined;
    const result = supervise(h.options);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      h.controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      await expect(result).resolves.toEqual({ reason: 'trayStop', ok: true, killed: 3 });
    } finally {
      await vi.runAllTimersAsync();
      await result;
    }
  });

  it('W4 handles a signal already aborted when backoff starts', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.options.sleep = undefined;
    h.options.hooks = {
      phase: (phase) => {
        if (phase.phase === 'restarting') h.controller.abort();
      },
      childExit: () => {},
    };
    const result = supervise(h.options);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.runAllTimersAsync();
    }
    await expect(result).resolves.toEqual({ reason: 'trayStop', ok: true, killed: 3 });
  });

  it.each(['written', 'newer'] as const)(
    'W5 aborts cooldown and removes only its own marker (%s)',
    async (state) => {
      const h = harness([1, 1, 1, 1, 1, 0]);
      h.marker.write.mockResolvedValue(state);
      const sleep = h.sleep;
      h.options.sleep = async (ms, signal) => {
        if (h.marker.write.mock.calls.length) {
          expect(signal).toBe(h.controller.signal);
          h.controller.abort();
        }
        await sleep(ms, signal);
      };
      await expect(supervise(h.options)).resolves.toEqual({
        reason: 'trayStop',
        ok: true,
        killed: 3,
      });
      expect(h.spawnChild).toHaveBeenCalledTimes(5);
      expect(h.marker.remove).toHaveBeenCalledTimes(state === 'written' ? 1 : 0);
      expect(h.stopSessions).toHaveBeenCalledTimes(1);
      expect(h.core.stop).toHaveBeenCalledTimes(1);
    },
  );

  it('W6 interrupts the marker write-failure sleep without removing anything', async () => {
    const h = harness([1, 1, 1, 1, 1, 0]);
    h.marker.write.mockRejectedValue(new Error('marker denied'));
    const sleep = h.sleep;
    h.options.sleep = async (ms, signal) => {
      if (h.marker.write.mock.calls.length) {
        expect(signal).toBe(h.controller.signal);
        h.controller.abort();
      }
      await sleep(ms, signal);
    };
    await expect(supervise(h.options)).resolves.toEqual({
      reason: 'trayStop',
      ok: true,
      killed: 3,
    });
    expect(h.spawnChild).toHaveBeenCalledTimes(5);
    expect(h.marker.remove).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('marker denied'));
  });

  it('keeps a core with unrelated live terminals after a tray stop', async () => {
    const h = harness();
    h.controller.abort();
    h.core.hasOtherLiveTerminals.mockResolvedValue(true);
    await expect(supervise(h.options)).resolves.toEqual({
      reason: 'trayStop',
      ok: true,
      killed: 3,
    });
    expect(h.stopSessions).toHaveBeenCalledTimes(1);
    expect(h.core.stop).not.toHaveBeenCalled();
  });

  it('logs and returns a failed tray stop instead of continuing supervision', async () => {
    const h = harness();
    h.controller.abort();
    h.stopSessions.mockRejectedValue(new Error('session kill denied'));
    await expect(supervise(h.options)).resolves.toEqual({
      reason: 'trayStop',
      ok: false,
      error: 'session kill denied',
    });
    expect(h.spawnChild).not.toHaveBeenCalled();
    expect(h.stopSessions).toHaveBeenCalledTimes(1);
    expect(h.core.stop).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('session kill denied'));
  });

  it('publishes phase before spawn/backoff/cooldown and exit before the next decision', async () => {
    const h = harness([1, 1, 1, 1, 1, 0]);
    const spawn = h.options.spawnChild;
    h.options.spawnChild = async () => {
      h.trace.push('spawn');
      return spawn();
    };
    const sleep = h.sleep;
    h.options.sleep = async (ms, signal) => {
      h.trace.push('sleep');
      await sleep(ms, signal);
    };
    h.marker.exists.mockResolvedValue(false);
    await expect(supervise(h.options)).resolves.toEqual({ reason: 'done' });
    expect(h.trace).toEqual([
      { phase: 'spawning' },
      'spawn',
      { exit: 1 },
      { phase: 'restarting' },
      'sleep',
      { phase: 'spawning' },
      'spawn',
      { exit: 1 },
      { phase: 'restarting' },
      'sleep',
      { phase: 'spawning' },
      'spawn',
      { exit: 1 },
      { phase: 'restarting' },
      'sleep',
      { phase: 'spawning' },
      'spawn',
      { exit: 1 },
      { phase: 'restarting' },
      'sleep',
      { phase: 'spawning' },
      'spawn',
      { exit: 1 },
      { phase: 'exhausted', retryAt: '2026-01-01T00:30:18.000Z' },
      { phase: 'spawning' },
      'spawn',
      { exit: 0 },
    ]);
  });

  it('publishes a null child exit after a spawn error before restarting', async () => {
    const h = harness([0]);
    h.spawnChild.mockRejectedValueOnce(new Error('spawn denied'));
    await expect(supervise(h.options)).resolves.toEqual({ reason: 'done' });
    expect(h.trace).toEqual([
      { phase: 'spawning' },
      { exit: null },
      { phase: 'restarting' },
      { phase: 'spawning' },
      { exit: 0 },
    ]);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('spawn denied'));
  });
});
