import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostToWebview, LimitOffer, TimedMessage, WebviewToHost } from '../../src/protocol';
import {
  __resetTimerStoreForTest,
  armTimedMessage,
  cancelTimedMessage,
  getTimerSnapshot,
  liveSchedulesFor,
  resolveLimitOffer,
  schedulesFor,
  sendMessageOnce,
  subscribeTimerEvents,
  subscribeTimers,
  type TimerEvent,
  waitingCountFor,
} from '../../webview/timer-store';

const bus = vi.hoisted(() => ({
  posted: [] as WebviewToHost[],
  emit: (_m: HostToWebview): void => {},
}));

vi.mock('../../webview/bridge', () => ({
  post: (m: WebviewToHost) => {
    bus.posted.push(m);
  },
  subscribe: (cb: (m: HostToWebview) => void) => {
    bus.emit = cb;
    return () => {};
  },
}));

const NOW = Date.UTC(2026, 7, 28, 15, 0, 0);

const schedule = (over: Partial<TimedMessage> = {}): TimedMessage => ({
  id: 'tm-1',
  sessionId: 's1',
  message: 'Continue',
  kind: 'once',
  nextAt: NOW + 60_000,
  maxRepeats: 1,
  firedCount: 0,
  state: 'armed',
  origin: 'manual',
  createdAt: NOW,
  ...over,
});

const push = (schedules: TimedMessage[], offer: LimitOffer | null = null) =>
  bus.emit({ type: 'timer:state', schedules, offer });

beforeEach(() => {
  bus.posted.length = 0;
  __resetTimerStoreForTest();
});

describe('the load gate', () => {
  it('is not loaded until the first push', () => {
    expect(getTimerSnapshot().loaded).toBe(false);
    push([]);
    expect(getTimerSnapshot().loaded).toBe(true);
  });

  it('treats an EMPTY push as a real answer', () => {
    push([]);
    expect(getTimerSnapshot()).toMatchObject({ loaded: true, schedules: [], offer: null });
  });

  it('notifies subscribers and hands out a stable snapshot between pushes', () => {
    const seen = vi.fn();
    const off = subscribeTimers(seen);
    const before = getTimerSnapshot();
    expect(getTimerSnapshot()).toBe(before);
    push([schedule()]);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(getTimerSnapshot()).not.toBe(before);
    off();
  });

  it('replaces the list wholesale — the host is authoritative', () => {
    push([schedule(), schedule({ id: 'tm-2' })]);
    push([schedule({ id: 'tm-2' })]);
    expect(getTimerSnapshot().schedules.map((s) => s.id)).toEqual(['tm-2']);
  });
});

describe('selectors', () => {
  it('filters by session and by liveness', () => {
    push([
      schedule(),
      schedule({ id: 'tm-2', state: 'done' }),
      schedule({ id: 'tm-3', sessionId: 's2' }),
    ]);
    expect(schedulesFor(getTimerSnapshot(), 's1').map((s) => s.id)).toEqual(['tm-1', 'tm-2']);
    expect(liveSchedulesFor(getTimerSnapshot(), 's1').map((s) => s.id)).toEqual(['tm-1']);
  });

  it('counts only waiting schedules for the rail badge and the stale card', () => {
    push([
      schedule({ state: 'waiting', waitingSince: NOW }),
      schedule({ id: 'tm-2', state: 'waiting', waitingSince: NOW }),
      schedule({ id: 'tm-3' }),
      schedule({ id: 'tm-4', sessionId: 's2', state: 'waiting', waitingSince: NOW }),
    ]);
    expect(waitingCountFor(getTimerSnapshot(), 's1')).toBe(2);
    expect(waitingCountFor(getTimerSnapshot(), 's2')).toBe(1);
    expect(waitingCountFor(getTimerSnapshot(), 's3')).toBe(0);
  });
});

describe('actions post exactly one message each', () => {
  it('arms through timer:set without inventing a nextAt', () => {
    armTimedMessage({
      sessionId: 's1',
      message: 'Continue',
      trigger: { kind: 'in', delayMs: 60_000 },
    });
    expect(bus.posted).toEqual([
      {
        type: 'timer:set',
        schedule: {
          sessionId: 's1',
          message: 'Continue',
          trigger: { kind: 'in', delayMs: 60_000 },
        },
      },
    ]);
  });

  it('cancels, sends once and resolves an offer', () => {
    cancelTimedMessage('tm-1');
    sendMessageOnce('s1', 'Continue');
    resolveLimitOffer('s1', 'dismiss');
    expect(bus.posted).toEqual([
      { type: 'timer:cancel', id: 'tm-1' },
      { type: 'timer:sendOnce', sessionId: 's1', message: 'Continue' },
      { type: 'timer:offer', sessionId: 's1', action: 'dismiss' },
    ]);
  });

  it('applies nothing optimistically — the host owns the set', () => {
    push([]);
    cancelTimedMessage('tm-1');
    expect(getTimerSnapshot().schedules).toEqual([]);
  });
});

describe('events', () => {
  const collect = () => {
    const events: TimerEvent[] = [];
    const off = subscribeTimerEvents((e) => events.push(e));
    return { events, off };
  };

  it('raises fired with the schedule it belongs to', () => {
    push([schedule({ state: 'done', firedCount: 1 })]);
    const { events, off } = collect();
    bus.emit({
      type: 'timer:fired',
      id: 'tm-1',
      sessionId: 's1',
      at: NOW,
      late: true,
      delivered: true,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'fired' });
    if (events[0].kind === 'fired') {
      expect(events[0].fire).toMatchObject({ late: true, delivered: true });
      expect(events[0].schedule?.id).toBe('tm-1');
    }
    off();
  });

  it('records the last fire per session, for the chip flash', () => {
    bus.emit({
      type: 'timer:fired',
      id: 'tm-1',
      sessionId: 's1',
      at: NOW,
      late: false,
      delivered: true,
    });
    bus.emit({
      type: 'timer:fired',
      id: 'tm-2',
      sessionId: 's1',
      at: NOW + 1000,
      late: true,
      delivered: true,
    });
    expect(getTimerSnapshot().fires.get('s1')).toMatchObject({ id: 'tm-2', late: true });
  });

  it('raises autoArmed only for a limit schedule that was not there before', () => {
    push([]);
    const { events, off } = collect();
    const limit = schedule({ id: 'tm-auto', origin: 'limit' });
    push([limit]);
    push([limit]); // a redraw of the same state must not announce twice
    expect(events.filter((e) => e.kind === 'autoArmed')).toHaveLength(1);
    off();
  });

  it('raises armed, not autoArmed, for a manual schedule', () => {
    push([]);
    const { events, off } = collect();
    push([schedule()]);
    expect(events.map((e) => e.kind)).toEqual(['armed']);
    off();
  });

  it('raises cancelled for a record that simply vanished', () => {
    push([schedule()]);
    const { events, off } = collect();
    push([]);
    expect(events.map((e) => e.kind)).toEqual(['cancelled']);
    off();
  });

  it('raises waiting once, on the transition into waiting', () => {
    push([schedule()]);
    const { events, off } = collect();
    const waiting = schedule({ state: 'waiting', waitingSince: NOW });
    push([waiting]);
    push([waiting]);
    expect(events.filter((e) => e.kind === 'waiting')).toHaveLength(1);
    off();
  });

  it('raises error for a rejected write', () => {
    const { events, off } = collect();
    bus.emit({ type: 'timer:error', message: '3 timed messages already on this session' });
    expect(events).toEqual([
      { kind: 'error', message: '3 timed messages already on this session' },
    ]);
    off();
  });

  it('raises nothing for the very first push, so a relaunch does not re-announce', () => {
    const { events, off } = collect();
    push([
      schedule({ id: 'tm-auto', origin: 'limit' }),
      schedule({ id: 'tm-w', state: 'waiting' }),
    ]);
    expect(events).toEqual([]);
    off();
  });
});
