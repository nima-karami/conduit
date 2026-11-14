import { describe, expect, it } from 'vitest';
import { createOutputQuiet, type OutputQuietDeps } from '../../server/runtime/output-quiet';
import type { RuntimeEvent } from '../../src/contracts/terminal-runtime';

interface FakeTimer {
  at: number;
  fn: () => void;
  cancelled: boolean;
}

function harness() {
  let now = 0;
  let listener: ((e: RuntimeEvent) => void) | null = null;
  let unsubscribes = 0;
  const timers: FakeTimer[] = [];
  const deps: OutputQuietDeps = {
    on: (l) => {
      listener = l;
      return () => {
        unsubscribes += 1;
        listener = null;
      };
    },
    now: () => now,
    setTimer: (ms, fn) => {
      const timer: FakeTimer = { at: now + ms, fn, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      const timer = handle as FakeTimer | undefined;
      if (timer) timer.cancelled = true;
    },
  };
  const quiet = createOutputQuiet(deps);
  const emit = (sessionId: string) =>
    listener?.({ type: 'data', sessionId, generation: 1, data: 'x' });
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => !t.cancelled && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      due.cancelled = true;
      due.fn();
    }
    now = end;
  };
  const track = (p: Promise<void>) => {
    const rec: { done: boolean; at: number } = { done: false, at: -1 };
    void p.then(() => {
      rec.done = true;
      rec.at = now;
    });
    return rec;
  };
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };
  return {
    quiet,
    emit,
    advance,
    track,
    settle,
    now: () => now,
    unsubscribes: () => unsubscribes,
    attached: () => listener !== null,
  };
}

describe('createOutputQuiet', () => {
  it('resolves after quietMs with no data', async () => {
    const h = harness();
    const rec = h.track(h.quiet.wait('a', 300, 5000));
    h.advance(299);
    await h.settle();
    expect(rec.done).toBe(false);
    h.advance(1);
    await h.settle();
    expect(rec).toEqual({ done: true, at: 300 });
  });

  it('data pushes it out', async () => {
    const h = harness();
    const rec = h.track(h.quiet.wait('a', 300, 5000));
    h.advance(200);
    h.emit('a');
    h.advance(299);
    await h.settle();
    expect(rec.done).toBe(false);
    h.advance(1);
    await h.settle();
    expect(rec).toEqual({ done: true, at: 500 });
  });

  it('measures quiet from the later of the call and the last data', async () => {
    const h = harness();
    h.emit('a');
    h.advance(1000);
    const rec = h.track(h.quiet.wait('a', 300, 5000));
    h.advance(300);
    await h.settle();
    expect(rec).toEqual({ done: true, at: 1300 });
  });

  it('resolves at maxMs under constant output', async () => {
    const h = harness();
    const rec = h.track(h.quiet.wait('a', 300, 1000));
    for (let i = 0; i < 10; i += 1) {
      h.emit('a');
      h.advance(100);
    }
    await h.settle();
    expect(rec).toEqual({ done: true, at: 1000 });
  });

  it("other sessions' data is ignored", async () => {
    const h = harness();
    const rec = h.track(h.quiet.wait('a', 300, 5000));
    h.emit('b');
    h.advance(300);
    await h.settle();
    expect(rec).toEqual({ done: true, at: 300 });
  });

  it('dispose unsubscribes', async () => {
    const h = harness();
    h.quiet.dispose();
    expect(h.unsubscribes()).toBe(1);
    expect(h.attached()).toBe(false);
  });
});
