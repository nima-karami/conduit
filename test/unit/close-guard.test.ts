import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACK_TIMEOUT_MS,
  type CloseGuardDeps,
  createCloseGuard,
  createQuitGrant,
  GRANT_TTL_MS,
  type GuardAsk,
  SHOWN_TIMEOUT_MS,
} from '../../src/close-guard';

type Call = [string, ...unknown[]];

function setup(
  ids: number[] = [1, 2],
  opts: { resumeReenters: boolean } = { resumeReenters: true },
) {
  const live = [...ids];
  const calls: Call[] = [];
  const boxes: { id: number; signal: AbortSignal; resolve: (v: boolean) => void }[] = [];
  const deps: CloseGuardDeps = {
    windowIds: () => [...live],
    prepare: (id) => calls.push(['prepare', id]),
    focus: (id) => calls.push(['focus', id]),
    counts: (id) => ({ running: id * 10, busy: id }),
    ask: (id, ask) => calls.push(['ask', id, { ...ask }]),
    abort: (id, requestId) => calls.push(['abort', id, requestId]),
    confirmUnresponsive: (id, signal) =>
      new Promise<boolean>((resolve) => {
        calls.push(['confirmUnresponsive', id]);
        boxes.push({ id, signal, resolve });
      }),
    proceedApp: (reason) => calls.push(['proceedApp', reason]),
    proceedWindow: (id) => calls.push(['proceedWindow', id]),
    resumeWindowClose: (id) => {
      calls.push(['resumeWindowClose', id]);
      if (opts.resumeReenters) guard.requestWindowClose(id);
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    log: (message) => calls.push(['log', message]),
  };
  const guard = createCloseGuard(deps);
  const of = (name: string) => calls.filter((c) => c[0] === name);
  const asks = () => of('ask').map((c) => ({ id: c[1] as number, ask: c[2] as GuardAsk }));
  const lastAskOf = (id: number) => {
    const found = asks().filter((a) => a.id === id);
    const last = found[found.length - 1];
    if (!last) throw new Error(`window ${id} was never asked`);
    return last.ask;
  };
  const answer = (id: number, proceed: boolean) =>
    guard.onDecision(id, lastAskOf(id).requestId, proceed);
  const show = (id: number) => {
    const { requestId } = lastAskOf(id);
    guard.onAck(id, requestId);
    guard.onShown(id, requestId);
  };
  const gone = (id: number) => {
    live.splice(live.indexOf(id), 1);
    guard.onWindowGone(id);
  };
  const add = (id: number) => {
    live.push(id);
    guard.onWindowCreated(id);
  };
  return { guard, calls, of, asks, lastAskOf, answer, show, gone, add, boxes };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createCloseGuard — app quit', () => {
  it('asks focused-first, one at a time', () => {
    const t = setup([1, 2]);
    t.guard.requestAppQuit('quit');
    expect(t.asks().map((a) => a.id)).toEqual([1]);
    t.answer(1, true);
    expect(t.asks().map((a) => a.id)).toEqual([1, 2]);
    expect(t.asks().map((a) => a.ask)).toEqual([
      { requestId: 1, reason: 'quit', running: 10, busy: 1 },
      { requestId: 2, reason: 'quit', running: 20, busy: 2 },
    ]);
  });

  it('prepares each window before asking', () => {
    const t = setup([1, 2]);
    t.guard.requestAppQuit('quit');
    t.answer(1, true);
    const order = t.calls
      .filter((c) => c[0] === 'prepare' || c[0] === 'ask')
      .map((c) => [c[0], c[1]]);
    expect(order).toEqual([
      ['prepare', 1],
      ['ask', 1],
      ['prepare', 2],
      ['ask', 2],
    ]);
  });

  it('firstId moves to the front', () => {
    const t = setup([1, 2, 3]);
    t.guard.requestAppQuit('update', 2);
    t.answer(2, true);
    t.answer(1, true);
    expect(t.asks().map((a) => a.id)).toEqual([2, 1, 3]);
  });

  it('all proceed → proceedApp once', () => {
    const t = setup([1, 2]);
    t.guard.requestAppQuit('quit');
    t.answer(1, true);
    t.answer(2, true);
    expect(t.of('proceedApp')).toEqual([['proceedApp', 'quit']]);
    expect(t.guard.pending()).toBe(false);
  });

  it('cancel in window 2 aborts window 1 only', () => {
    const t = setup([1, 2]);
    t.guard.requestAppQuit('quit');
    const reqIdOf1 = t.lastAskOf(1).requestId;
    t.answer(1, true);
    t.answer(2, false);
    expect(t.of('abort')).toEqual([['abort', 1, reqIdOf1]]);
    expect(t.of('proceedApp')).toEqual([]);
    expect(t.guard.pending()).toBe(false);
  });

  it('no windows → proceedApp immediately', () => {
    const t = setup([]);
    t.guard.requestAppQuit('update');
    expect(t.of('proceedApp')).toEqual([['proceedApp', 'update']]);
    expect(t.of('ask')).toEqual([]);
    expect(t.guard.pending()).toBe(false);
  });

  it('requestIds are host-unique and monotonic across guards', () => {
    const t = setup([1, 2]);
    t.guard.requestAppQuit('quit');
    t.answer(1, false);
    t.guard.requestWindowClose(2);
    t.answer(2, false);
    t.guard.requestAppQuit('quit');
    expect(t.asks().map((a) => a.ask.requestId)).toEqual([1, 2, 3]);
  });

  it('window gone mid-ask → proceed; gone before its turn → skipped', () => {
    const t = setup([1, 2, 3]);
    t.guard.requestAppQuit('quit');
    t.gone(2);
    t.gone(1);
    expect(t.asks().map((a) => a.id)).toEqual([1, 3]);
    t.answer(3, true);
    expect(t.of('proceedApp')).toEqual([['proceedApp', 'quit']]);
  });

  it('a gone window is not told to abort when a later window cancels', () => {
    const t = setup([1, 2, 3]);
    t.guard.requestAppQuit('quit');
    t.gone(1);
    t.answer(2, true);
    t.gone(2);
    t.answer(3, false);
    expect(t.of('abort')).toEqual([]);
  });

  it('unlockAnswered skips a proceeder that has gone since', () => {
    const t = setup([1, 2]);
    t.guard.requestAppQuit('quit');
    t.answer(1, true);
    t.answer(2, true);
    t.gone(1);
    t.guard.unlockAnswered();
    expect(t.of('abort')).toEqual([['abort', 2, 2]]);
  });

  it('window created mid app guard is appended', () => {
    const t = setup([1]);
    t.guard.requestAppQuit('quit');
    t.add(5);
    t.answer(1, true);
    expect(t.asks().map((a) => a.id)).toEqual([1, 5]);
    expect(t.of('proceedApp')).toEqual([]);
    t.answer(5, true);
    expect(t.of('proceedApp')).toEqual([['proceedApp', 'quit']]);
  });

  it('a window created outside an app guard is not asked', () => {
    const t = setup([1]);
    t.guard.requestWindowClose(1);
    t.add(5);
    t.answer(1, true);
    expect(t.asks().map((a) => a.id)).toEqual([1]);
  });

  it('update during app guard upgrades the reason', () => {
    const t = setup([1, 2]);
    t.guard.requestAppQuit('quit');
    t.guard.requestAppQuit('update');
    t.answer(1, true);
    expect(t.lastAskOf(1).reason).toBe('quit');
    expect(t.lastAskOf(2).reason).toBe('update');
    t.answer(2, true);
    expect(t.of('proceedApp')).toEqual([['proceedApp', 'update']]);
  });

  it('unlockAnswered aborts the last app attempt’s proceeders', () => {
    const t = setup([1, 2]);
    t.guard.requestAppQuit('quit');
    t.answer(1, true);
    t.answer(2, true);
    t.guard.unlockAnswered();
    expect(t.of('abort')).toEqual([
      ['abort', 1, 1],
      ['abort', 2, 2],
    ]);
    t.guard.unlockAnswered();
    expect(t.of('abort')).toHaveLength(2);
  });

  it('unlockAnswered after a cancelled attempt aborts nobody new', () => {
    const t = setup([1, 2]);
    t.guard.requestAppQuit('quit');
    t.answer(1, true);
    t.answer(2, true);
    t.guard.requestAppQuit('quit');
    t.answer(1, false);
    t.guard.unlockAnswered();
    expect(t.of('abort')).toEqual([]);
  });
});

describe('createCloseGuard — per-ask states', () => {
  it('no ACK in 3000 ms → abort to it, then proceed + log', () => {
    const t = setup([1, 2]);
    t.guard.requestAppQuit('quit');
    vi.advanceTimersByTime(ACK_TIMEOUT_MS - 1);
    expect(t.of('abort')).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(t.of('abort')).toEqual([['abort', 1, 1]]);
    expect(t.of('log')).toHaveLength(1);
    expect(t.asks().map((a) => a.id)).toEqual([1, 2]);
    const abortAt = t.calls.findIndex((c) => c[0] === 'abort');
    const secondAskAt = t.calls.findIndex((c) => c[0] === 'ask' && c[1] === 2);
    expect(abortAt).toBeLessThan(secondAskAt);
  });

  it('ACK then silence 12 000 ms → abort to it, then proceed', () => {
    const t = setup([1]);
    t.guard.requestWindowClose(1);
    vi.advanceTimersByTime(ACK_TIMEOUT_MS - 1);
    t.guard.onAck(1, 1);
    vi.advanceTimersByTime(SHOWN_TIMEOUT_MS - 1);
    expect(t.of('proceedWindow')).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(t.of('abort')).toEqual([['abort', 1, 1]]);
    expect(t.of('log')).toHaveLength(1);
    expect(t.of('proceedWindow')).toEqual([['proceedWindow', 1]]);
  });

  it('a timed-out window is not aborted again when a later window cancels', () => {
    const t = setup([1, 2]);
    t.guard.requestAppQuit('quit');
    vi.advanceTimersByTime(ACK_TIMEOUT_MS);
    t.answer(2, false);
    expect(t.of('abort')).toEqual([['abort', 1, 1]]);
  });

  it('shown waits forever', () => {
    const t = setup([1]);
    t.guard.requestWindowClose(1);
    t.show(1);
    vi.advanceTimersByTime(60_000);
    expect(t.of('proceedWindow')).toEqual([]);
    expect(t.of('abort')).toEqual([]);
    expect(t.guard.pending()).toBe(true);
  });

  it('a decision straight from asked settles and cancels the ACK timer', () => {
    const t = setup([1]);
    t.guard.requestWindowClose(1);
    t.answer(1, true);
    vi.advanceTimersByTime(60_000);
    expect(t.of('proceedWindow')).toEqual([['proceedWindow', 1]]);
    expect(t.of('abort')).toEqual([]);
  });

  it('unresponsive when shown → native box; true proceeds', async () => {
    const t = setup([1]);
    t.guard.requestWindowClose(1);
    t.show(1);
    t.guard.onUnresponsive(1);
    expect(t.of('confirmUnresponsive')).toEqual([['confirmUnresponsive', 1]]);
    t.boxes[0]?.resolve(true);
    await vi.runAllTimersAsync();
    expect(t.of('proceedWindow')).toEqual([['proceedWindow', 1]]);
  });

  it('unresponsive box answered Wait keeps waiting for the dialog', async () => {
    const t = setup([1]);
    t.guard.requestWindowClose(1);
    t.show(1);
    t.guard.onUnresponsive(1);
    t.boxes[0]?.resolve(false);
    await vi.runAllTimersAsync();
    expect(t.of('proceedWindow')).toEqual([]);
    t.answer(1, true);
    expect(t.of('proceedWindow')).toEqual([['proceedWindow', 1]]);
  });

  it('unresponsive while asked/acked opens no box', () => {
    const t = setup([1]);
    t.guard.requestWindowClose(1);
    t.guard.onUnresponsive(1);
    t.guard.onAck(1, 1);
    t.guard.onUnresponsive(1);
    expect(t.of('confirmUnresponsive')).toEqual([]);
  });

  it('a second unresponsive while a box is open opens no second box', () => {
    const t = setup([1]);
    t.guard.requestWindowClose(1);
    t.show(1);
    t.guard.onUnresponsive(1);
    t.guard.onUnresponsive(1);
    expect(t.of('confirmUnresponsive')).toHaveLength(1);
  });

  it('decision beats a pending box and aborts its signal', async () => {
    const t = setup([1, 2]);
    t.guard.requestAppQuit('quit');
    t.show(1);
    t.guard.onUnresponsive(1);
    const box = t.boxes[0];
    t.answer(1, false);
    expect(box?.signal.aborted).toBe(true);
    t.guard.requestWindowClose(2);
    t.show(2);
    box?.resolve(true);
    await vi.runAllTimersAsync();
    expect(t.of('proceedApp')).toEqual([]);
    expect(t.of('proceedWindow')).toEqual([]);
    expect(t.guard.pending()).toBe(true);
  });

  it('window gone beats a pending box and aborts its signal', async () => {
    const t = setup([1, 2]);
    t.guard.requestAppQuit('quit');
    t.show(1);
    t.guard.onUnresponsive(1);
    const box = t.boxes[0];
    t.gone(1);
    expect(box?.signal.aborted).toBe(true);
    expect(t.asks().map((a) => a.id)).toEqual([1, 2]);
    t.show(2);
    box?.resolve(true);
    await vi.runAllTimersAsync();
    expect(t.asks().map((a) => a.id)).toEqual([1, 2]);
    expect(t.of('proceedApp')).toEqual([]);
  });

  it('stale requestId and a foreign window’s decision are ignored', () => {
    const t = setup([1, 2]);
    t.guard.requestAppQuit('quit');
    t.guard.onDecision(1, 99, false);
    t.guard.onDecision(2, 1, false);
    t.guard.onAck(1, 99);
    t.guard.onShown(1, 99);
    vi.advanceTimersByTime(ACK_TIMEOUT_MS - 1);
    expect(t.of('abort')).toEqual([]);
    expect(t.asks().map((a) => a.id)).toEqual([1]);
    t.answer(1, true);
    t.guard.onDecision(1, 1, false);
    t.answer(2, true);
    expect(t.of('proceedApp')).toEqual([['proceedApp', 'quit']]);
    expect(t.of('abort')).toEqual([]);
  });
});

describe('createCloseGuard — window close', () => {
  it('window guard proceed → proceedWindow; cancel → nothing', () => {
    const t = setup([1, 2]);
    t.guard.requestWindowClose(2);
    expect(t.asks()).toEqual([
      { id: 2, ask: { requestId: 1, reason: 'windowClose', running: 20, busy: 2 } },
    ]);
    t.answer(2, true);
    expect(t.of('proceedWindow')).toEqual([['proceedWindow', 2]]);
    t.guard.requestWindowClose(1);
    t.answer(1, false);
    expect(t.of('proceedWindow')).toEqual([['proceedWindow', 2]]);
    expect(t.of('abort')).toEqual([]);
    expect(t.of('proceedApp')).toEqual([]);
    expect(t.guard.pending()).toBe(false);
  });

  it('window close of X during window guard for W is queued (S4)', () => {
    const t = setup([1, 2, 3]);
    t.guard.requestWindowClose(1);
    t.guard.requestWindowClose(2);
    t.guard.requestWindowClose(2);
    t.guard.requestWindowClose(3);
    expect(t.of('focus')).toEqual([]);
    t.gone(3);
    t.answer(1, true);
    expect(t.of('resumeWindowClose')).toEqual([['resumeWindowClose', 2]]);
    t.answer(2, true);
    expect(t.of('resumeWindowClose')).toEqual([['resumeWindowClose', 2]]);
    expect(t.guard.pending()).toBe(false);
  });

  it('queue drains one item at a time', () => {
    const t = setup([1, 2, 3]);
    t.guard.requestWindowClose(1);
    t.guard.requestWindowClose(2);
    t.guard.requestWindowClose(3);
    t.answer(1, false);
    expect(t.of('resumeWindowClose')).toEqual([['resumeWindowClose', 2]]);
    expect(t.asks().map((a) => a.id)).toEqual([1, 2]);
    t.answer(2, true);
    expect(t.of('resumeWindowClose')).toEqual([
      ['resumeWindowClose', 2],
      ['resumeWindowClose', 3],
    ]);
    expect(t.asks().map((a) => a.id)).toEqual([1, 2, 3]);
  });

  it('a queued item whose resume starts no guard lets the next one run', () => {
    const t = setup([1, 2, 3], { resumeReenters: false });
    t.guard.requestWindowClose(1);
    t.guard.requestWindowClose(2);
    t.guard.requestWindowClose(3);
    t.answer(1, false);
    expect(t.of('resumeWindowClose')).toEqual([
      ['resumeWindowClose', 2],
      ['resumeWindowClose', 3],
    ]);
  });

  it('update during window guard is queued then run', () => {
    for (const proceed of [true, false]) {
      const t = setup([1, 2]);
      t.guard.requestWindowClose(1);
      t.guard.requestAppQuit('update', 2);
      expect(t.asks().map((a) => a.id)).toEqual([1]);
      t.answer(1, proceed);
      expect(t.asks().map((a) => [a.id, a.ask.reason])).toEqual([
        [1, 'windowClose'],
        [2, 'update'],
      ]);
    }
  });

  it('a later queued update replaces the earlier one', () => {
    const t = setup([1, 2, 3]);
    t.guard.requestWindowClose(1);
    t.guard.requestAppQuit('update', 2);
    t.guard.requestAppQuit('update', 3);
    t.answer(1, false);
    expect(t.asks().map((a) => a.id)).toEqual([1, 3]);
    t.answer(3, true);
    t.answer(1, true);
    t.answer(2, true);
    expect(t.of('proceedApp')).toEqual([['proceedApp', 'update']]);
    expect(t.guard.pending()).toBe(false);
    expect(t.asks().map((a) => a.id)).toEqual([1, 3, 1, 2]);
  });

  it('app guard proceed clears the queue; cancel drains it', () => {
    for (const proceed of [true, false]) {
      const t = setup([1, 2]);
      t.guard.requestWindowClose(1);
      t.guard.requestAppQuit('update');
      t.guard.requestWindowClose(2);
      t.answer(1, false);
      expect(t.lastAskOf(1).reason).toBe('update');
      expect(t.of('resumeWindowClose')).toEqual([]);
      t.answer(1, proceed);
      if (proceed) t.answer(2, true);
      expect(t.of('proceedApp')).toEqual(proceed ? [['proceedApp', 'update']] : []);
      expect(t.of('resumeWindowClose')).toEqual(proceed ? [] : [['resumeWindowClose', 2]]);
      expect(t.guard.pending()).toBe(!proceed);
      if (proceed) {
        t.guard.requestWindowClose(1);
        t.answer(1, false);
        expect(t.of('resumeWindowClose')).toEqual([]);
      }
    }
  });
});

describe('createCloseGuard — re-entrancy', () => {
  it('re-trigger re-probes a shown ask', () => {
    const t = setup([1, 2]);
    t.guard.requestAppQuit('quit');
    t.show(1);
    const first = t.lastAskOf(1);
    t.calls.length = 0;
    t.guard.requestAppQuit('quit');
    t.guard.requestWindowClose(1);
    t.guard.requestAppQuit('update');
    expect(t.calls.filter((c) => c[0] === 'ask' || c[0] === 'focus')).toEqual([
      ['ask', 1, first],
      ['focus', 1],
      ['ask', 1, first],
      ['focus', 1],
      ['ask', 1, first],
      ['focus', 1],
    ]);
    t.answer(1, true);
    expect(t.lastAskOf(2)).toEqual({ requestId: 2, reason: 'update', running: 20, busy: 2 });
  });

  it('re-trigger re-probes a shown window ask', () => {
    const t = setup([1, 2]);
    t.guard.requestWindowClose(1);
    t.show(1);
    const first = t.lastAskOf(1);
    t.calls.length = 0;
    t.guard.requestWindowClose(1);
    t.guard.requestAppQuit('quit');
    expect(t.calls.filter((c) => c[0] === 'ask' || c[0] === 'focus')).toEqual([
      ['ask', 1, first],
      ['focus', 1],
      ['ask', 1, first],
      ['focus', 1],
    ]);
  });

  it('re-trigger while asked/acked only focuses', () => {
    const t = setup([1, 2]);
    t.guard.requestAppQuit('quit');
    t.guard.requestAppQuit('quit');
    t.guard.onAck(1, 1);
    t.guard.requestWindowClose(2);
    expect(t.of('ask')).toHaveLength(1);
    expect(t.of('focus')).toEqual([
      ['focus', 1],
      ['focus', 1],
    ]);
  });
});

describe('createQuitGrant', () => {
  function grantSetup() {
    const onExpire = vi.fn();
    const grant = createQuitGrant({
      ttlMs: GRANT_TTL_MS,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      onExpire,
    });
    return { grant, onExpire };
  }

  it('grant: consume true once; false when not issued; expiry calls onExpire and consume is false after', () => {
    const a = grantSetup();
    expect(a.grant.consume()).toBe(false);
    a.grant.issue();
    expect(a.grant.consume()).toBe(true);
    expect(a.grant.consume()).toBe(false);
    vi.advanceTimersByTime(GRANT_TTL_MS * 2);
    expect(a.onExpire).not.toHaveBeenCalled();

    const b = grantSetup();
    b.grant.issue();
    vi.advanceTimersByTime(GRANT_TTL_MS - 1);
    expect(b.onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(b.onExpire).toHaveBeenCalledTimes(1);
    expect(b.grant.consume()).toBe(false);
  });

  it('re-issuing re-arms the TTL once', () => {
    const t = grantSetup();
    t.grant.issue();
    vi.advanceTimersByTime(GRANT_TTL_MS - 1);
    t.grant.issue();
    vi.advanceTimersByTime(GRANT_TTL_MS - 1);
    expect(t.onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(t.onExpire).toHaveBeenCalledTimes(1);
  });

  it('constants match D7', () => {
    expect([ACK_TIMEOUT_MS, SHOWN_TIMEOUT_MS, GRANT_TTL_MS]).toEqual([3000, 12_000, 5000]);
  });
});
