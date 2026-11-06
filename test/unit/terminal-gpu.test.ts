import { describe, expect, it } from 'vitest';
import { GPU_GIVE_UP_LOSSES, GPU_LOSS_WINDOW_MS } from '../../webview/gpu-loss-policy';
import {
  createGpuCoordinator,
  GPU_REATTACH_DELAY_MS,
  GPU_UNAVAILABLE_RETRY_MS,
  MAX_WEBGL_TERMINALS,
  RECENT_WEBGL_TERMINALS,
  remeasureFont,
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
  // Every font-side call in order, e.g. 'measure:a', 'clear:a', 'refresh:a', 'family:a=X'.
  const fontCalls: string[] = [];
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
    remeasureFont: (term) => fontCalls.push(`measure:${term}`),
    clearFontAtlas: (term) => fontCalls.push(`clear:${term}`),
    refreshTerminal: (term) => fontCalls.push(`refresh:${term}`),
    applyFontFamily: (term, family) => fontCalls.push(`family:${term}=${family}`),
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
  return { gpu, handles, events, attempts, fontCalls, advance, live };
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

  // A hidden pane keeps WebGL while among the RECENT_WEBGL_TERMINALS (= the cap) most recently
  // shown: a fresh attach on show blanks the frame (see the constant).
  describe('hidden terminals', () => {
    const names = (n: number, prefix = 't') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
    type Gpu = ReturnType<typeof harness>['gpu'];
    /** Show `term` and hide `prev`, as one session switch does. */
    const switchTo = (gpu: Gpu, prev: string, term: string) => {
      gpu.setVisible(prev, false);
      gpu.setVisible(term, true);
    };
    /** Register `ts[0]` shown and the rest hidden, then show each in turn. */
    const cycle = (gpu: Gpu, ts: string[]) => {
      gpu.register(ts[0] as string);
      for (const t of ts.slice(1)) gpu.register(t, undefined, { visible: false });
      for (let i = 1; i < ts.length; i++) switchTo(gpu, ts[i - 1] as string, ts[i] as string);
    };

    it('a terminal registered hidden holds no WebGL until it is shown', () => {
      const { gpu, live, attempts } = harness();
      gpu.register('a', undefined, { visible: false });
      expect(attempts).toEqual([]);
      gpu.setVisible('a', true);
      expect(live('a')).toHaveLength(1);
    });

    it('a recently shown terminal keeps its addon while hidden and is not re-attached on show', () => {
      const { gpu, attempts, live } = harness();
      cycle(gpu, ['a', 'b']);
      switchTo(gpu, 'b', 'a');
      expect(live().map((h) => h.term)).toEqual(['a', 'b']);
      expect(attempts).toEqual(['a', 'b']);
    });

    it(`keeps the ${RECENT_WEBGL_TERMINALS} most recently shown, releasing the one before them`, () => {
      const { gpu, handles, live } = harness();
      cycle(gpu, names(RECENT_WEBGL_TERMINALS));
      expect(handles[0]?.disposed).toBe(false);
      gpu.register('next', undefined, { visible: false });
      switchTo(gpu, `t${RECENT_WEBGL_TERMINALS - 1}`, 'next');
      expect(handles[0]?.disposed).toBe(true);
      expect(live()).toHaveLength(RECENT_WEBGL_TERMINALS);
    });

    it('showing a released terminal attaches a fresh addon', () => {
      const { gpu, live, handles } = harness();
      const ts = names(RECENT_WEBGL_TERMINALS + 1);
      cycle(gpu, ts);
      const first = handles[0];
      switchTo(gpu, ts[ts.length - 1] as string, 't0');
      expect(live('t0')).toHaveLength(1);
      expect(live('t0')[0]).not.toBe(first);
    });

    it('a visible terminal is never released by recency', () => {
      const { gpu, live } = harness();
      gpu.register('split');
      gpu.register('a');
      for (const t of names(RECENT_WEBGL_TERMINALS + 2, 'h')) {
        gpu.register(t, undefined, { visible: false });
        switchTo(gpu, 'a', t);
        switchTo(gpu, t, 'a');
      }
      expect(live('split')).toHaveLength(1);
      expect(live('a')).toHaveLength(1);
    });

    it('a repeated show or hide changes nothing', () => {
      const { gpu, attempts } = harness();
      gpu.register('a');
      gpu.setVisible('a', true);
      gpu.setVisible('a', false);
      gpu.setVisible('a', false);
      gpu.setVisible('a', true);
      expect(attempts).toEqual(['a']);
    });

    it('ignores visibility for a terminal that is not registered', () => {
      const { gpu, attempts } = harness();
      const off = gpu.register('a');
      off();
      gpu.setVisible('a', true);
      gpu.setVisible('ghost', true);
      expect(attempts).toEqual(['a']);
    });

    it('an unregistered terminal leaves the recent set', () => {
      const { gpu, live } = harness();
      const ts = names(RECENT_WEBGL_TERMINALS);
      const offs = ts.map((t) => gpu.register(t));
      for (const t of ts) gpu.setVisible(t, false);
      offs[0]?.();
      gpu.register('n');
      expect(live().map((h) => h.term)).toEqual([...ts.slice(1), 'n']);
    });

    it(`at the cap of ${MAX_WEBGL_TERMINALS} a shown terminal takes the slot of the least recent hidden one`, () => {
      const { gpu, live } = harness();
      gpu.register('old');
      gpu.setVisible('old', false);
      for (const t of names(MAX_WEBGL_TERMINALS - 1, 'v')) gpu.register(t);
      gpu.register('n', undefined, { visible: false });
      gpu.setVisible('n', true);
      expect(live('old')).toHaveLength(0);
      expect(live('n')).toHaveLength(1);
      expect(live()).toHaveLength(MAX_WEBGL_TERMINALS);
    });

    it('a terminal shown while every slot is visible waits on the DOM renderer', () => {
      const { gpu, live } = harness();
      for (const t of names(MAX_WEBGL_TERMINALS)) gpu.register(t);
      gpu.register('h', undefined, { visible: false });
      gpu.setVisible('h', true);
      expect(live('h')).toHaveLength(0);
      expect(live()).toHaveLength(MAX_WEBGL_TERMINALS);
    });

    it('the re-attach after a loss attaches visible terminals only and counts itself complete', () => {
      const { gpu, live, advance, events } = harness();
      gpu.register('a');
      gpu.register('b');
      gpu.setVisible('b', false);
      gpu.reportLoss('a');
      advance(GPU_REATTACH_DELAY_MS);
      expect(live().map((h) => h.term)).toEqual(['a']);
      expect(events).toEqual(['context-lost', 'reattach']);
      gpu.setVisible('b', true);
      expect(live('b')).toHaveLength(1);
    });

    it('a terminal shown during the fallback waits for the re-attach', () => {
      const { gpu, live, advance } = harness();
      gpu.register('a');
      gpu.register('b', undefined, { visible: false });
      gpu.reportLoss('a');
      gpu.setVisible('b', true);
      expect(live()).toEqual([]);
      advance(GPU_REATTACH_DELAY_MS);
      expect(live().map((h) => h.term)).toEqual(['a', 'b']);
    });

    it('a terminal shown after giving up stays on the DOM renderer', () => {
      const { gpu, live, advance } = harness();
      gpu.register('a');
      gpu.register('b', undefined, { visible: false });
      for (let i = 0; i <= GPU_GIVE_UP_LOSSES; i++) {
        gpu.reportLoss('a');
        advance(GPU_REATTACH_DELAY_MS);
      }
      gpu.setVisible('b', true);
      expect(live()).toEqual([]);
    });

    it('fonts still refresh on a hidden terminal', () => {
      const { gpu, fontCalls } = harness();
      gpu.register('a', () => fontCalls.push('fit:a'), { visible: false });
      gpu.refreshFonts();
      expect(fontCalls).toEqual(['measure:a', 'clear:a', 'refresh:a', 'fit:a']);
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

    it('a full recovery restores the retry budget for the next episode', () => {
      const failAttach = new Set(['a']);
      const { gpu, advance, attempts } = harness({ failAttach });
      gpu.register('a');
      gpu.reportLoss('a');
      advance(GPU_REATTACH_DELAY_MS);
      for (const ms of GPU_UNAVAILABLE_RETRY_MS) advance(ms);
      failAttach.delete('a');
      gpu.register('b');
      gpu.reportLoss('b');
      advance(GPU_REATTACH_DELAY_MS);
      failAttach.add('a');
      gpu.reportLoss('b');
      advance(GPU_REATTACH_DELAY_MS);
      const before = count(attempts, 'a');
      advance(GPU_UNAVAILABLE_RETRY_MS[0]);
      expect(count(attempts, 'a')).toBe(before + 1);
    });

    it('a retry attaches only the refused terminals', () => {
      const failAttach = new Set(['a']);
      const { gpu, handles, live, advance } = harness({ failAttach });
      gpu.register('a');
      gpu.register('b');
      gpu.reportLoss('a');
      advance(GPU_REATTACH_DELAY_MS);
      failAttach.delete('a');
      advance(GPU_UNAVAILABLE_RETRY_MS[0]);
      expect(live().map((h) => h.term)).toEqual(['b', 'a']);
      const created = (t: string) => handles.filter((h) => h.term === t).length;
      expect(created('b')).toBe(2);
      expect(created('a')).toBe(1);
    });

    it('a retry with no terminals left does nothing', () => {
      const failAttach = new Set(['a']);
      const { gpu, advance, events } = harness({ failAttach });
      const off = gpu.register('a');
      gpu.reportLoss('a');
      advance(GPU_REATTACH_DELAY_MS);
      off();
      const logged = events.length;
      advance(GPU_UNAVAILABLE_RETRY_MS[0]);
      expect(events).toHaveLength(logged);
    });
  });

  describe('font refresh', () => {
    it('re-measures and clears every live terminal before any repaints, then refits each pane', () => {
      const { gpu, fontCalls } = harness();
      gpu.register('a', () => fontCalls.push('fit:a'));
      gpu.register('b', () => fontCalls.push('fit:b'));
      gpu.refreshFonts();
      expect(fontCalls).toEqual([
        'measure:a',
        'clear:a',
        'measure:b',
        'clear:b',
        'refresh:a',
        'refresh:b',
        'fit:a',
        'fit:b',
      ]);
    });

    it('a second late event for the same family clears the atlas again', () => {
      const { gpu, fontCalls } = harness();
      gpu.register('a');
      gpu.refreshFonts();
      gpu.refreshFonts();
      expect(fontCalls.filter((c) => c === 'clear:a')).toHaveLength(2);
      expect(fontCalls.some((c) => c.startsWith('family:'))).toBe(false);
    });

    it('skips a terminal once it unregisters, callback included', () => {
      const { gpu, fontCalls } = harness();
      const offA = gpu.register('a', () => fontCalls.push('fit:a'));
      gpu.register('b', () => fontCalls.push('fit:b'));
      offA();
      gpu.refreshFonts();
      expect(fontCalls).toEqual(['measure:b', 'clear:b', 'refresh:b', 'fit:b']);
    });

    it('refreshes terminals on the DOM renderer too, without touching the loss budget', () => {
      const { gpu, fontCalls, events, live } = harness({ failAttach: new Set(['b']) });
      gpu.register('a');
      gpu.register('b');
      const logged = events.length;
      gpu.refreshFonts();
      expect(fontCalls).toEqual([
        'measure:a',
        'clear:a',
        'measure:b',
        'clear:b',
        'refresh:a',
        'refresh:b',
      ]);
      expect(events).toHaveLength(logged);
      expect(live().map((h) => h.term)).toEqual(['a']);
    });

    it('refreshes never spend the loss budget the reset policy allows', () => {
      const { gpu, live, advance, events } = harness();
      gpu.register('a');
      for (let i = 0; i < GPU_GIVE_UP_LOSSES; i++) {
        gpu.refreshFonts();
        gpu.reportLoss('a');
        advance(GPU_REATTACH_DELAY_MS);
        gpu.refreshFonts();
      }
      expect(events).not.toContain('give-up');
      expect(live()).toHaveLength(1);
    });

    it('applies a family to every terminal, then repaints and refits them', () => {
      const { gpu, fontCalls } = harness();
      gpu.register('a', () => fontCalls.push('fit:a'));
      gpu.register('b');
      gpu.applyFontFamily('X');
      expect(fontCalls).toEqual(['family:a=X', 'family:b=X', 'refresh:a', 'refresh:b', 'fit:a']);
    });
  });

  describe('remeasureFont', () => {
    // xterm skips an identical assignment, so the cell is re-measured only through a real change.
    const recording = (fontFamily: string | undefined) => {
      const sets: (string | undefined)[] = [];
      let value = fontFamily;
      const options = {
        get fontFamily() {
          return value;
        },
        set fontFamily(v: string | undefined) {
          sets.push(v);
          value = v;
        },
      };
      return { term: { options }, sets };
    };

    it('changes the family to another value, then back', () => {
      const { term, sets } = recording("'Fira Code', monospace");
      remeasureFont(term);
      expect(sets).toHaveLength(2);
      expect(sets[0]).not.toBe("'Fira Code', monospace");
      expect(sets[1]).toBe("'Fira Code', monospace");
    });

    it('still makes a real change when the family is the bare generic', () => {
      const { term, sets } = recording('monospace');
      remeasureFont(term);
      expect(sets).toEqual(['serif', 'monospace']);
    });
  });
});
