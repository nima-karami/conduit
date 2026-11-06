import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptySnapshot, type ShellStopAll } from '../../server/compose';
import type { ShellCore } from '../../server/lifecycle/shell';
import { runServer } from '../../server/main';
import {
  createEventTap,
  STOP_ALREADY_STOPPING,
  startTrayChannel,
  type TrayEvent,
  type TrayProc,
} from '../../server/tray-channel';
import { TRAY_LIMITS, type TrayCounts } from '../../src/contracts/tray-protocol';

type Sent = { type: string; [key: string]: unknown };
type SendCallback = (error: Error | null) => void;

function session(status: 'running' | 'exited', needsAttention = false) {
  return { status, needsAttention };
}

function harness(over: { send?: boolean; stopAll?: () => Promise<ShellStopAll> } = {}) {
  const sent: Sent[] = [];
  const callbacks: SendCallback[] = [];
  const handlers = new Set<(message: unknown) => void>();
  const listeners = new Set<(...event: TrayEvent) => void>();
  const send = (message: Sent, callback?: SendCallback) => {
    sent.push(message);
    if (callback) callbacks.push(callback);
    return true;
  };
  const on = (_event: string, handler: (message: unknown) => void) => handlers.add(handler);
  const off = (_event: string, handler: (message: unknown) => void) => handlers.delete(handler);
  const proc = {
    connected: true,
    ...(over.send === false ? {} : { send }),
    on,
    off,
  } as unknown as TrayProc;
  const initial: TrayCounts = { running: 1, needsYou: 0, health: 'starting', stopping: null };
  const log = vi.fn();
  const stopAll = vi.fn(
    over.stopAll ??
      (async (): Promise<ShellStopAll> => ({ kind: 'ok', killed: 2, afterReply: async () => {} })),
  );
  const channel = startTrayChannel({
    proc,
    tap: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    initial: () => initial,
    stopAll,
    log,
  });
  const emit = (...event: TrayEvent) => {
    for (const listener of listeners) listener(...event);
  };
  const message = (m: unknown) => {
    for (const handler of handlers) handler(m);
  };
  return { channel, sent, callbacks, handlers, listeners, emit, message, stopAll, log };
}

const sessionsChanged = (...s: ReturnType<typeof session>[]): TrayEvent =>
  ['sessions.changed', { sessions: s }] as unknown as TrayEvent;

const WINDOW = TRAY_LIMITS.countsCoalesceMs;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('tray channel', () => {
  it('does nothing without a channel to the supervisor', () => {
    const x = harness({ send: false });
    x.channel.ready();
    x.emit(...sessionsChanged(session('running')));
    vi.advanceTimersByTime(WINDOW * 2);
    expect(x.sent).toEqual([]);
    expect(x.handlers.size).toBe(0);
    expect(x.listeners.size).toBe(0);
  });

  it('sends nothing before ready, then ready followed by the current counts', () => {
    const x = harness();
    x.emit(...sessionsChanged(session('running'), session('running', true)));
    vi.advanceTimersByTime(WINDOW * 2);
    expect(x.sent).toEqual([]);
    x.channel.ready();
    expect(x.sent.map((m) => m.type)).toEqual(['ready', 'counts']);
    expect(x.sent[1]).toMatchObject({
      counts: { running: 2, needsYou: 1, health: 'starting', stopping: null },
    });
  });

  it('seeds the first counts from initial() when no event arrived yet', () => {
    const x = harness();
    x.channel.ready();
    expect(x.sent[1]).toMatchObject({ counts: { running: 1, needsYou: 0 } });
  });

  it('sends counts when sessions or runtime health change', () => {
    const x = harness();
    x.channel.ready();
    x.sent.length = 0;
    x.emit(...sessionsChanged(session('running'), session('running')));
    vi.advanceTimersByTime(WINDOW);
    expect(x.sent).toEqual([
      { type: 'counts', counts: { running: 2, needsYou: 0, health: 'starting', stopping: null } },
    ]);
    x.emit('runtime.changed', { state: 'ready', hcVersion: 'x' });
    vi.advanceTimersByTime(WINDOW);
    expect(x.sent[1]).toMatchObject({ counts: { health: 'ready' } });
  });

  it('flushes a stopping reason at once because the server exits right after', () => {
    const x = harness();
    x.channel.ready();
    x.sent.length = 0;
    x.emit('server.stopping', { reason: 'stopAll' });
    expect(x.sent).toEqual([
      {
        type: 'counts',
        counts: { running: 1, needsYou: 0, health: 'starting', stopping: 'stopAll' },
      },
    ]);
  });

  it('does not send when an event leaves the counts unchanged', () => {
    const x = harness();
    x.channel.ready();
    x.emit(...sessionsChanged(session('running')));
    vi.advanceTimersByTime(WINDOW * 2);
    x.sent.length = 0;
    x.emit(...sessionsChanged(session('running')));
    x.emit(...sessionsChanged(session('running'), session('exited')));
    vi.advanceTimersByTime(WINDOW * 2);
    expect(x.sent).toEqual([]);
  });

  it('coalesces a burst into one message with the last value, and none if it settles back', () => {
    const x = harness();
    x.channel.ready();
    x.sent.length = 0;
    x.emit(...sessionsChanged(session('running'), session('running')));
    x.emit(...sessionsChanged(session('running'), session('running'), session('running')));
    vi.advanceTimersByTime(WINDOW - 1);
    expect(x.sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(x.sent).toHaveLength(1);
    expect(x.sent[0]).toMatchObject({ counts: { running: 3 } });
    x.sent.length = 0;
    x.emit(...sessionsChanged(session('running')));
    x.emit(...sessionsChanged(session('running'), session('running'), session('running')));
    vi.advanceTimersByTime(WINDOW * 2);
    expect(x.sent).toEqual([]);
  });

  it('answers stopAll ok with the id and runs afterReply only once the send callback fires', async () => {
    const afterReply = vi.fn(async () => {});
    const x = harness({ stopAll: async () => ({ kind: 'ok', killed: 5, afterReply }) });
    x.channel.ready();
    x.sent.length = 0;
    x.callbacks.length = 0;
    x.message({ type: 'stopAll', id: 7 });
    await vi.advanceTimersByTimeAsync(0);
    expect(x.sent).toEqual([{ type: 'stopAllResult', id: 7, ok: true, killed: 5 }]);
    expect(afterReply).not.toHaveBeenCalled();
    x.callbacks[0]?.(null);
    expect(afterReply).toHaveBeenCalledTimes(1);
  });

  it('answers a late stopAll with the already-stopping reason', async () => {
    const x = harness({ stopAll: async () => ({ kind: 'late' }) });
    x.channel.ready();
    x.sent.length = 0;
    x.message({ type: 'stopAll', id: 3 });
    await vi.advanceTimersByTimeAsync(0);
    expect(x.sent).toEqual([
      { type: 'stopAllResult', id: 3, ok: false, reason: STOP_ALREADY_STOPPING },
    ]);
  });

  it('answers a failed stopAll with the error and runs afterReply after the flush', async () => {
    const afterReply = vi.fn(async () => {});
    const x = harness({
      stopAll: async () => ({ kind: 'failed', error: new Error('persist failed'), afterReply }),
    });
    x.channel.ready();
    x.sent.length = 0;
    x.callbacks.length = 0;
    x.message({ type: 'stopAll', id: 9 });
    await vi.advanceTimersByTimeAsync(0);
    expect(x.sent).toEqual([
      { type: 'stopAllResult', id: 9, ok: false, reason: 'Error: persist failed' },
    ]);
    expect(afterReply).not.toHaveBeenCalled();
    x.callbacks[0]?.(new Error('channel closed'));
    expect(afterReply).toHaveBeenCalledTimes(1);
    expect(x.log).toHaveBeenCalledWith(expect.stringContaining('channel closed'));
  });

  it('replies ok:false when the stop itself throws, and ignores messages that are not a stopAll', async () => {
    const x = harness({
      stopAll: async () => {
        throw new Error('boom');
      },
    });
    x.channel.ready();
    x.sent.length = 0;
    x.message({ type: 'other' });
    x.message(null);
    x.message({ type: 'stopAll', id: 'nope' });
    await vi.advanceTimersByTimeAsync(0);
    expect(x.stopAll).not.toHaveBeenCalled();
    x.message({ type: 'stopAll', id: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(x.sent).toEqual([{ type: 'stopAllResult', id: 1, ok: false, reason: 'Error: boom' }]);
  });

  it('stops listening and sending after dispose', () => {
    const x = harness();
    x.channel.ready();
    x.sent.length = 0;
    x.emit(...sessionsChanged(session('running'), session('running')));
    x.channel.dispose();
    vi.advanceTimersByTime(WINDOW * 2);
    expect(x.sent).toEqual([]);
    expect(x.handlers.size).toBe(0);
    expect(x.listeners.size).toBe(0);
  });
});

describe('event tap', () => {
  it('forwards to the wrapped emit first and then to every listener until unsubscribed', () => {
    const order: string[] = [];
    const tap = createEventTap(() => order.push('emit'));
    const off = tap.tap(() => order.push('tap'));
    tap.emit('server.stopping', { reason: 'idle' });
    off();
    tap.emit('server.stopping', { reason: 'idle' });
    expect(order).toEqual(['emit', 'tap', 'emit']);
  });
});

describe('server entry wiring', () => {
  const dirs: string[] = [];
  const closes: (() => Promise<void>)[] = [];
  afterEach(async () => {
    vi.useRealTimers();
    for (const close of closes.splice(0)) await close();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  function fakeProc() {
    const sent: Sent[] = [];
    const handlers = new Set<(message: unknown) => void>();
    const proc = {
      connected: true,
      send: (message: Sent, callback?: SendCallback) => {
        sent.push(message);
        callback?.(null);
        return true;
      },
      on: (_event: string, handler: (message: unknown) => void) => handlers.add(handler),
      off: (_event: string, handler: (message: unknown) => void) => handlers.delete(handler),
    } as unknown as TrayProc;
    return { sent, handlers, proc };
  }

  function core(): ShellCore {
    return {
      start: vi.fn<ShellCore['start']>(() => new Promise(() => {})),
      beginStopping: vi.fn(async () => {}),
      killSessions: vi.fn(async () => 6),
      persist: vi.fn(async () => {}),
      snapshot: emptySnapshot,
      idleState: vi.fn(async () => ({ liveTerminals: 0, pendingTimers: false, busyTokens: false })),
    };
  }

  it('announces ready after start, never for a second instance, and routes stopAll to exit 3', async () => {
    vi.useRealTimers();
    const dir = await mkdtemp(path.join(tmpdir(), 'tray-channel-'));
    dirs.push(dir);
    const first = fakeProc();
    const exit = vi.fn();
    const server = await runServer(['--user-data', dir], {
      core: core(),
      exit,
      trayProc: first.proc,
    });
    closes.push(() => server.close?.() ?? Promise.resolve());
    expect(first.sent.map((m) => m.type)).toEqual(['ready', 'counts']);

    const second = fakeProc();
    const lost = await runServer(['--user-data', dir], { core: core(), trayProc: second.proc });
    expect(lost.code).toBe(0);
    expect(second.sent).toEqual([]);
    expect(second.handlers.size).toBe(0);

    for (const handler of first.handlers) handler({ type: 'stopAll', id: 4 });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(3));
    expect(first.sent.filter((m) => m.type === 'stopAllResult')).toEqual([
      { type: 'stopAllResult', id: 4, ok: true, killed: 6 },
    ]);
  });
});
