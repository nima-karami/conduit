import { describe, expect, it } from 'vitest';
import { GPU_GIVE_UP_LOSSES, GPU_LOSS_WINDOW_MS } from '../../webview/gpu-loss-policy';
import {
  createGpuCoordinator,
  GPU_REATTACH_DELAY_MS,
  GPU_UNAVAILABLE_RETRY_MS,
  MAX_WEBGL_TERMINALS,
} from '../../webview/terminal-gpu';

interface Handle {
  term: string;
  disposed: boolean;
  dispose(): void;
}

function harness({ failAttach = new Set<string>() } = {}) {
  let now = 0;
  let timers: { at: number; fn: () => void; live: boolean }[] = [];
  const handles: Handle[] = [];
  const events: string[] = [];
  const attempts: string[] = [];
  const gpu = createGpuCoordinator<string>({
    now: () => now,
    setTimer: (fn, ms) => {
      timers.push({ at: now + ms, fn, live: true });
    },
    attach: (term) => {
      attempts.push(term);
      if (failAttach.has(term)) return null;
      const h: Handle = {
        term,
        disposed: false,
        dispose() {
          h.disposed = true;
        },
      };
      handles.push(h);
      return h;
    },
    log: (event) => events.push(event),
  });
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const next = timers.filter((t) => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = next.at;
      next.live = false;
      next.fn();
    }
    now = until;
    timers = timers.filter((t) => t.live);
  };
  const live = (term?: string) =>
    handles.filter((h) => !h.disposed && (term === undefined || h.term === term));
  return { gpu, handles, events, attempts, advance, live };
}

describe('terminal GPU coordinator', () => {
  it('attaches WebGL to a terminal as it registers', () => {
    const { gpu, live } = harness();
    gpu.register('a');
    gpu.register('b');
    expect(live().map((h) => h.term)).toEqual(['a', 'b']);
  });

  it('a loss on one terminal detaches every terminal at once', () => {
    const { gpu, live } = harness();
    gpu.register('a');
    gpu.register('b');
    gpu.register('c');
    gpu.reportLoss('b');
    expect(live()).toEqual([]);
  });

  it('re-attaches fresh addons only after the backoff', () => {
    const { gpu, handles, live, advance } = harness();
    gpu.register('a');
    gpu.register('b');
    const first = [...handles];
    gpu.reportLoss('a');
    advance(GPU_REATTACH_DELAY_MS - 1);
    expect(live()).toEqual([]);
    advance(1);
    expect(live().map((h) => h.term)).toEqual(['a', 'b']);
    for (const h of live()) expect(first).not.toContain(h);
  });

  it('treats the burst of losses from one GPU reset as a single loss', () => {
    const { gpu, live, advance } = harness();
    gpu.register('a');
    gpu.register('b');
    gpu.reportLoss('a');
    gpu.reportLoss('b');
    gpu.reportLoss('a');
    advance(GPU_REATTACH_DELAY_MS);
    expect(live()).toHaveLength(2);
  });

  it('a terminal registering during the fallback waits for the re-attach', () => {
    const { gpu, live, advance } = harness();
    gpu.register('a');
    gpu.reportLoss('a');
    gpu.register('late');
    expect(live()).toEqual([]);
    advance(GPU_REATTACH_DELAY_MS);
    expect(live().map((h) => h.term)).toEqual(['a', 'late']);
  });

  it('unregistering during the fallback is safe and the terminal is never re-attached', () => {
    const { gpu, live, advance } = harness();
    const offA = gpu.register('a');
    gpu.register('b');
    gpu.reportLoss('b');
    offA();
    expect(() => offA()).not.toThrow();
    advance(GPU_REATTACH_DELAY_MS);
    expect(live().map((h) => h.term)).toEqual(['b']);
  });

  it('unregistering a WebGL terminal disposes its addon', () => {
    const { gpu, live } = harness();
    const off = gpu.register('a');
    gpu.register('b');
    off();
    expect(live().map((h) => h.term)).toEqual(['b']);
  });

  it('ignores a loss reported for a terminal that is not registered', () => {
    const { gpu, live } = harness();
    const off = gpu.register('a');
    gpu.register('b');
    off();
    gpu.reportLoss('a');
    expect(live().map((h) => h.term)).toEqual(['b']);
  });

  it(`stays on the DOM renderer after ${GPU_GIVE_UP_LOSSES + 1} losses within the window`, () => {
    const { gpu, live, advance, events } = harness();
    gpu.register('a');
    for (let i = 0; i < GPU_GIVE_UP_LOSSES; i++) {
      gpu.reportLoss('a');
      advance(GPU_REATTACH_DELAY_MS);
      expect(live()).toHaveLength(1);
    }
    gpu.reportLoss('a');
    advance(GPU_LOSS_WINDOW_MS * 10);
    expect(live()).toEqual([]);
    gpu.register('later');
    advance(GPU_REATTACH_DELAY_MS);
    expect(live()).toEqual([]);
    expect(events.at(-1)).toBe('give-up');
  });

  it('losses spread wider than the window never trip the cap', () => {
    const { gpu, live, advance } = harness();
    gpu.register('a');
    for (let i = 0; i < GPU_GIVE_UP_LOSSES * 3; i++) {
      gpu.reportLoss('a');
      advance(GPU_LOSS_WINDOW_MS / GPU_GIVE_UP_LOSSES + 1);
    }
    expect(live()).toHaveLength(1);
  });

  it('a terminal whose re-attach fails stays on the DOM renderer without blocking the rest', () => {
    const failAttach = new Set<string>();
    const { gpu, live, advance } = harness({ failAttach });
    gpu.register('a');
    gpu.register('b');
    gpu.reportLoss('a');
    failAttach.add('a');
    advance(GPU_REATTACH_DELAY_MS);
    expect(live().map((h) => h.term)).toEqual(['b']);
  });

  it('logs the loss and the re-attach', () => {
    const { gpu, advance, events } = harness();
    gpu.register('a');
    gpu.reportLoss('a');
    advance(GPU_REATTACH_DELAY_MS);
    expect(events).toEqual(['context-lost', 'reattach']);
  });

  describe('live WebGL cap', () => {
    const names = (n: number, prefix = 't') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

    it(`attaches at most ${MAX_WEBGL_TERMINALS} terminals; the rest register on the DOM renderer`, () => {
      const { gpu, live } = harness();
      for (const t of names(MAX_WEBGL_TERMINALS + 3)) gpu.register(t);
      expect(live().map((h) => h.term)).toEqual(names(MAX_WEBGL_TERMINALS));
    });

    it('promotes the oldest waiting terminal when a WebGL terminal unregisters', () => {
      const { gpu, live } = harness();
      const offs = names(MAX_WEBGL_TERMINALS).map((t) => gpu.register(t));
      gpu.register('wait0');
      gpu.register('wait1');
      offs[3]();
      expect(live('wait0')).toHaveLength(1);
      expect(live('wait1')).toHaveLength(0);
      expect(live()).toHaveLength(MAX_WEBGL_TERMINALS);
    });

    it('unregistering a waiting DOM terminal promotes nobody', () => {
      const { gpu, live } = harness();
      for (const t of names(MAX_WEBGL_TERMINALS)) gpu.register(t);
      const offWait = gpu.register('wait0');
      gpu.register('wait1');
      offWait();
      expect(live('wait1')).toHaveLength(0);
      expect(live()).toHaveLength(MAX_WEBGL_TERMINALS);
    });

    it('the re-attach after a loss honours the cap, oldest first', () => {
      const { gpu, live, advance } = harness();
      for (const t of names(MAX_WEBGL_TERMINALS + 2)) gpu.register(t);
      gpu.reportLoss('t0');
      advance(GPU_REATTACH_DELAY_MS);
      expect(live().map((h) => h.term)).toEqual(names(MAX_WEBGL_TERMINALS));
    });

    it('promotes nobody while in the fallback window', () => {
      const { gpu, live, advance } = harness();
      const offs = names(MAX_WEBGL_TERMINALS).map((t) => gpu.register(t));
      gpu.register('wait0');
      gpu.reportLoss('t0');
      offs[1]();
      expect(live()).toEqual([]);
      advance(GPU_REATTACH_DELAY_MS);
      expect(live()).toHaveLength(MAX_WEBGL_TERMINALS);
      expect(live('wait0')).toHaveLength(1);
    });

    it('promotes nobody after giving up', () => {
      const { gpu, live, advance } = harness();
      const offs = names(MAX_WEBGL_TERMINALS).map((t) => gpu.register(t));
      gpu.register('wait0');
      for (let i = 0; i <= GPU_GIVE_UP_LOSSES; i++) {
        gpu.reportLoss('t0');
        advance(GPU_REATTACH_DELAY_MS);
      }
      offs[2]();
      expect(live()).toEqual([]);
    });

    it('a terminal whose attach failed is not retried until the next re-attach', () => {
      const failAttach = new Set(['bad']);
      const { gpu, live, attempts, advance } = harness({ failAttach });
      const offs = names(MAX_WEBGL_TERMINALS).map((t) => gpu.register(t));
      gpu.register('bad');
      gpu.register('w0');
      offs[0]();
      expect(live('w0')).toHaveLength(1);
      offs[1]();
      expect(attempts.filter((t) => t === 'bad')).toHaveLength(1);
      gpu.reportLoss('t2');
      advance(GPU_REATTACH_DELAY_MS);
      expect(attempts.filter((t) => t === 'bad')).toHaveLength(2);
    });
  });

  // After a repeat GPU reset Chromium can refuse every new WebGL context for the page for a while.
  describe('WebGL unavailable after a re-attach', () => {
    const count = (attempts: string[], term: string) => attempts.filter((t) => t === term).length;

    it('leaves the terminals it could not attach on the DOM renderer and says so', () => {
      const failAttach = new Set<string>();
      const { gpu, live, advance, events } = harness({ failAttach });
      gpu.register('a');
      gpu.register('b');
      gpu.reportLoss('a');
      failAttach.add('b');
      advance(GPU_REATTACH_DELAY_MS);
      expect(live().map((h) => h.term)).toEqual(['a']);
      expect(events).toEqual(['context-lost', 'unavailable']);
    });

    it('retries on the backoff schedule and regains WebGL once contexts are allowed again', () => {
      const failAttach = new Set(['a']);
      const { gpu, live, advance, attempts, events } = harness({ failAttach });
      gpu.register('a');
      gpu.reportLoss('a');
      advance(GPU_REATTACH_DELAY_MS);
      expect(live()).toEqual([]);
      const before = count(attempts, 'a');
      advance(GPU_UNAVAILABLE_RETRY_MS[0] - 1);
      expect(count(attempts, 'a')).toBe(before);
      failAttach.delete('a');
      advance(1);
      expect(live().map((h) => h.term)).toEqual(['a']);
      expect(events.at(-1)).toBe('reattach');
    });

    it(`gives up on WebGL after ${GPU_UNAVAILABLE_RETRY_MS.length} failed retries`, () => {
      const failAttach = new Set(['a']);
      const { gpu, live, advance, attempts } = harness({ failAttach });
      gpu.register('a');
      gpu.reportLoss('a');
      advance(GPU_REATTACH_DELAY_MS);
      const afterReattach = count(attempts, 'a');
      for (const [i, ms] of GPU_UNAVAILABLE_RETRY_MS.entries()) {
        advance(ms);
        expect(count(attempts, 'a')).toBe(afterReattach + i + 1);
      }
      advance(GPU_UNAVAILABLE_RETRY_MS.reduce((x, y) => x + y) * 10);
      expect(count(attempts, 'a')).toBe(afterReattach + GPU_UNAVAILABLE_RETRY_MS.length);
      expect(live()).toEqual([]);
    });

    it('a failed attach is not a loss: the loss cap still allows the next reset', () => {
      const failAttach = new Set(['a']);
      const { gpu, live, advance, events } = harness({ failAttach });
      gpu.register('a');
      gpu.reportLoss('a');
      advance(GPU_REATTACH_DELAY_MS);
      for (const ms of GPU_UNAVAILABLE_RETRY_MS) advance(ms);
      failAttach.delete('a');
      gpu.register('b');
      gpu.reportLoss('b');
      advance(GPU_REATTACH_DELAY_MS);
      expect(events).not.toContain('give-up');
      expect(live().map((h) => h.term)).toEqual(['a', 'b']);
    });

    it('a loss during the retry wait cancels the stale retry', () => {
      const failAttach = new Set(['a']);
      const { gpu, live, advance, attempts } = harness({ failAttach });
      gpu.register('a');
      gpu.register('b');
      gpu.reportLoss('a');
      advance(GPU_REATTACH_DELAY_MS);
      advance(GPU_UNAVAILABLE_RETRY_MS[0] / 2);
      gpu.reportLoss('b');
      advance(GPU_REATTACH_DELAY_MS);
      expect(live().map((h) => h.term)).toEqual(['b']);
      const afterSecondReattach = count(attempts, 'a');
      advance(GPU_UNAVAILABLE_RETRY_MS[0] / 2);
      expect(count(attempts, 'a')).toBe(afterSecondReattach);
    });
  });
});
