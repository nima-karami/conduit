import { describe, expect, it } from 'vitest';
import {
  createWindowWaits,
  type UnansweredEnd,
  type Wait,
  type WaitEnd,
} from '../../src/conduit-mcp/window-waits';

type Meta = { tool: string };

function setup() {
  const clock = { t: 1000 };
  const timers = new Map<number, { fn: () => void; at: number }>();
  let n = 0;
  const unanswered: Array<[string, UnansweredEnd]> = [];
  const waits = createWindowWaits<string, Meta>({
    now: () => clock.t,
    setTimer: (fn, ms) => {
      timers.set(++n, { fn, at: clock.t + ms });
      return n;
    },
    clearTimer: (h) => {
      timers.delete(h as number);
    },
    onUnanswered: (w, end) => unanswered.push([w.id, end]),
  });
  /** Advances the clock and fires due timers, like the real timer queue. */
  const advance = (ms: number) => {
    clock.t += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= clock.t) {
        timers.delete(id);
        t.fn();
      }
    }
  };
  const settled = new Map<string, WaitEnd<string>>();
  const open = (id: string, extra: Partial<Omit<Wait<Meta>, 'openedAt'>> = {}, ms = 50_000) => {
    const p = waits.open(
      {
        id,
        callerSessionId: 's1',
        key: { connId: 1, requestId: id },
        windowId: 1,
        meta: { tool: 'open_session' },
        ...extra,
      },
      ms,
    );
    void p.then((e) => settled.set(id, e));
    return p;
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { waits, timers, unanswered, advance, open, settled, flush, clock };
}

describe('createWindowWaits', () => {
  it('answer ends once, from its window only', async () => {
    const t = setup();
    const p = t.open('a', { windowId: 1 });
    expect(t.waits.answer('a', 2, 'approve')).toBe(false);
    expect(t.waits.pending().map((w) => w.id)).toEqual(['a']);
    expect(t.waits.answer('a', 1, 'approve')).toBe(true);
    expect(await p).toEqual({ kind: 'answered', answer: 'approve' });
    expect(t.waits.answer('a', 1, 'deny')).toBe(false);
    expect(t.unanswered).toEqual([]);
    expect(t.timers.size).toBe(0);
  });

  it('records openedAt from the clock', () => {
    const t = setup();
    t.open('a');
    expect(t.waits.pending()[0]?.openedAt).toBe(1000);
  });

  it('timeout expires and calls onUnanswered once', async () => {
    const t = setup();
    const p = t.open('a', {}, 25_000);
    t.advance(24_999);
    await t.flush();
    expect(t.settled.has('a')).toBe(false);
    t.advance(1);
    expect(await p).toEqual({ kind: 'expired' });
    expect(t.unanswered).toEqual([['a', { kind: 'expired' }]]);
    expect(t.waits.answer('a', 1, 'approve')).toBe(false);
    expect(t.waits.cancel(() => true, true)).toBe(0);
    expect(t.unanswered).toHaveLength(1);
  });

  it('cancel by predicate carries reply and clears timers', async () => {
    const t = setup();
    const a = t.open('a', { key: { connId: 1, requestId: 1 } });
    const b = t.open('b', { key: { connId: 1, requestId: 2 } });
    t.open('c', { key: { connId: 2, requestId: 1 } });
    expect(t.waits.cancel((w) => w.key.connId === 1, false)).toBe(2);
    expect(await a).toEqual({ kind: 'cancelled', reply: false });
    expect(await b).toEqual({ kind: 'cancelled', reply: false });
    expect(t.waits.pending().map((w) => w.id)).toEqual(['c']);
    expect(t.timers.size).toBe(1);
    expect(t.unanswered).toEqual([
      ['a', { kind: 'cancelled', reply: false }],
      ['b', { kind: 'cancelled', reply: false }],
    ]);
    t.advance(60_000);
    await t.flush();
    expect(t.unanswered.map(([id]) => id)).toEqual(['a', 'b', 'c']);
    expect(t.settled.get('c')).toEqual({ kind: 'expired' });
  });

  it('countFor counts per caller and drops after an end', () => {
    const t = setup();
    t.open('a', { callerSessionId: 's1' });
    t.open('b', { callerSessionId: 's1' });
    t.open('c', { callerSessionId: 's2' });
    expect(t.waits.countFor('s1')).toBe(2);
    expect(t.waits.countFor('s2')).toBe(1);
    expect(t.waits.countFor('s3')).toBe(0);
    t.waits.answer('a', 1, 'deny');
    expect(t.waits.countFor('s1')).toBe(1);
    t.waits.cancel((w) => w.id === 'c', true);
    expect(t.waits.countFor('s2')).toBe(0);
  });

  it('dispose ends all with reply false', async () => {
    const t = setup();
    const a = t.open('a');
    const b = t.open('b', { callerSessionId: 's2', windowId: 2 });
    t.waits.dispose();
    expect(await a).toEqual({ kind: 'cancelled', reply: false });
    expect(await b).toEqual({ kind: 'cancelled', reply: false });
    expect(t.waits.pending()).toEqual([]);
    expect(t.timers.size).toBe(0);
  });
});
