import { describe, expect, it } from 'vitest';
import { createMessageBus } from '../../webview/message-bus';

/** A manual scheduler so the microtask flush is deterministic in tests: captured, run on demand. */
function manualScheduler() {
  const q: (() => void)[] = [];
  return {
    schedule: (fn: () => void) => q.push(fn),
    run: () => {
      for (const f of q.splice(0)) f();
    },
  };
}

describe('createMessageBus', () => {
  it('buffers messages that arrive before any subscriber', () => {
    const s = manualScheduler();
    const bus = createMessageBus<{ n: number }>(s.schedule);
    bus.emit({ n: 1 });
    const got: number[] = [];
    bus.subscribe((m) => got.push(m.n));
    expect(got).toEqual([]); // not delivered synchronously on subscribe…
    s.run();
    expect(got).toEqual([1]); // …delivered on the deferred flush
  });

  // THE REGRESSION: the original bridge drained the backlog to whichever subscriber registered
  // FIRST and cleared it, so a state-ignoring child (mounted before its parent) swallowed the
  // initial `state` and the parent's hydrate handler got nothing. The backlog must reach BOTH.
  it('delivers the startup backlog to EVERY subscriber, not just the first to mount', () => {
    const s = manualScheduler();
    const bus = createMessageBus<{ t: string }>(s.schedule);
    bus.emit({ t: 'state' }); // arrives before React mounts

    const child: string[] = []; // a child effect subscribes first (and would ignore 'state')
    const app: string[] = []; // the parent (App) subscribes second, same synchronous tick
    bus.subscribe((m) => child.push(m.t));
    bus.subscribe((m) => app.push(m.t));

    s.run(); // the deferred flush

    expect(child).toEqual(['state']);
    expect(app).toEqual(['state']); // <-- was empty with the drain-to-first bug
  });

  it('preserves arrival order across a multi-message backlog', () => {
    const s = manualScheduler();
    const bus = createMessageBus<{ n: number }>(s.schedule);
    bus.emit({ n: 1 });
    bus.emit({ n: 2 });
    bus.emit({ n: 3 });
    const got: number[] = [];
    bus.subscribe((m) => got.push(m.n));
    s.run();
    expect(got).toEqual([1, 2, 3]);
  });

  it('keeps ordering when a message is emitted during the buffering window', () => {
    const s = manualScheduler();
    const bus = createMessageBus<{ n: number }>(s.schedule);
    bus.emit({ n: 1 }); // buffered (no listener)
    const got: number[] = [];
    bus.subscribe((m) => got.push(m.n)); // schedules the flush
    bus.emit({ n: 2 }); // arrives before the flush runs — must stay after #1
    s.run();
    expect(got).toEqual([1, 2]);
  });

  it('delivers live to all listeners once the backlog has drained', () => {
    const s = manualScheduler();
    const bus = createMessageBus<{ n: number }>(s.schedule);
    const a: number[] = [];
    const b: number[] = [];
    bus.subscribe((m) => a.push(m.n));
    bus.subscribe((m) => b.push(m.n));
    s.run(); // nothing pending; flush is a no-op
    bus.emit({ n: 5 }); // live: no buffering, delivered synchronously to both
    expect(a).toEqual([5]);
    expect(b).toEqual([5]);
  });

  it('stops delivering after unsubscribe', () => {
    const s = manualScheduler();
    const bus = createMessageBus<{ n: number }>(s.schedule);
    const got: number[] = [];
    const off = bus.subscribe((m) => got.push(m.n));
    s.run();
    off();
    bus.emit({ n: 9 });
    expect(got).toEqual([]);
  });

  it('defaults to queueMicrotask when no scheduler is injected', async () => {
    const bus = createMessageBus<{ n: number }>();
    bus.emit({ n: 1 });
    const got: number[] = [];
    bus.subscribe((m) => got.push(m.n));
    expect(got).toEqual([]); // deferred, not synchronous
    await Promise.resolve(); // let the microtask run
    expect(got).toEqual([1]);
  });
});
