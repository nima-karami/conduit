import { describe, expect, it } from 'vitest';
import {
  createGpuCoordinator,
  GPU_GIVE_UP_LOSSES,
  GPU_LOSS_WINDOW_MS,
  GPU_REATTACH_DELAY_MS,
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
  const gpu = createGpuCoordinator<string>({
    now: () => now,
    setTimer: (fn, ms) => {
      timers.push({ at: now + ms, fn, live: true });
    },
    attach: (term) => {
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
  return { gpu, handles, events, advance, live };
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
});
