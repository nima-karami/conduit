import { describe, expect, it } from 'vitest';
import {
  BOOT_FONT_TIMEOUT_MS,
  createFontService,
  FONT_SAMPLE,
  type FontServiceDeps,
} from '../../webview/terminal-fonts';
import { monoStack } from '../../webview/xterm-theme';

interface Face {
  family: string;
}
type LoadImpl = (font: string) => Promise<Face[]>;
type LoadingDone = (event: { fontfaces: readonly Face[] }) => void;

const FACE: Face = { family: 'Some Face' };

function harness(loadImpl: LoadImpl = () => Promise.resolve([{ ...FACE }])) {
  const calls: string[] = [];
  const loads: { font: string; text?: string }[] = [];
  const warnings: string[] = [];
  const listeners: LoadingDone[] = [];
  const timers: { fn: () => void; cancelled: boolean }[] = [];
  const fonts = {
    load(font: string, text?: string) {
      loads.push({ font, text });
      calls.push(`load:${font}`);
      return loadImpl(font);
    },
    addEventListener(_type: 'loadingdone', fn: LoadingDone) {
      listeners.push(fn);
    },
  };
  const deps: FontServiceDeps = {
    fonts,
    gpu: {
      refreshFonts: () => calls.push('refreshFonts'),
      applyFontFamily: (family) => calls.push(`apply:${family}`),
    },
    setTimer: (fn, ms) => {
      expect(ms).toBe(BOOT_FONT_TIMEOUT_MS);
      const t = { fn, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    warn: (message) => warnings.push(message),
  };
  return { svc: createFontService(deps), calls, loads, warnings, listeners, timers };
}

const BOOT = { fontUi: 'figtree', fontMono: 'jetbrains', terminalFontSize: 14 };

describe('loadBootFonts', () => {
  it('loads the selected UI and mono faces at 400 and 700 with the symbol sample', async () => {
    const { svc, loads, warnings } = harness();
    await svc.loadBootFonts(BOOT);
    expect(loads.map((l) => l.font)).toEqual([
      "400 13px 'Figtree', system-ui, sans-serif",
      "700 13px 'Figtree', system-ui, sans-serif",
      `400 14px ${monoStack('jetbrains')}`,
      `700 14px ${monoStack('jetbrains')}`,
    ]);
    // The fallback faces are in the font string, so they load with the chosen one.
    expect(loads[2].font).toContain("'Cascadia Mono'");
    for (const l of loads) expect(l.text).toBe(FONT_SAMPLE);
    for (const ch of '✔❯⚠⏺⎿●') expect(FONT_SAMPLE).toContain(ch);
    expect(warnings).toEqual([]);
  });

  it('skips the UI request for the platform font, which has no bundled face', async () => {
    const { svc, loads, warnings } = harness();
    await svc.loadBootFonts({ ...BOOT, fontUi: 'system' });
    expect(loads.map((l) => l.font)).toEqual([
      `400 14px ${monoStack('jetbrains')}`,
      `700 14px ${monoStack('jetbrains')}`,
    ]);
    expect(warnings).toEqual([]);
  });

  it('an empty result is a failure: logged, and the boot still settles', async () => {
    const { svc, warnings } = harness(() => Promise.resolve([]));
    await expect(svc.loadBootFonts(BOOT)).resolves.toBeUndefined();
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toMatch(/no face/);
  });

  it('a rejected load is logged, and the boot still settles', async () => {
    const { svc, warnings } = harness((font) =>
      font.startsWith('700') ? Promise.reject(new Error('net')) : Promise.resolve([{ ...FACE }]),
    );
    await expect(svc.loadBootFonts(BOOT)).resolves.toBeUndefined();
    expect(warnings).toEqual(['font load failed', 'font load failed']);
  });

  it('a load that never settles gives up on the timer', async () => {
    const { svc, timers, warnings } = harness(() => new Promise(() => {}));
    const boot = svc.loadBootFonts(BOOT);
    expect(timers).toHaveLength(1);
    timers[0].fn();
    await expect(boot).resolves.toBeUndefined();
    expect(warnings).toEqual(['font load timed out']);
  });

  it('runs once: a second call shares the first load and listener', async () => {
    const { svc, loads, listeners } = harness();
    const a = svc.loadBootFonts(BOOT);
    const b = svc.loadBootFonts({ ...BOOT, fontMono: 'firacode' });
    expect(b).toBe(a);
    await a;
    expect(loads).toHaveLength(4);
    expect(listeners).toHaveLength(1);
  });

  it('a successful load cancels its timer, and a stray fire after it logs nothing', async () => {
    const { svc, timers, warnings } = harness();
    await svc.loadBootFonts(BOOT);
    expect(timers[0].cancelled).toBe(true);
    timers[0].fn();
    expect(warnings).toEqual([]);
  });

  it('a late face of the terminal stack refreshes every terminal, each time it lands', async () => {
    const { svc, calls, listeners } = harness();
    await svc.loadBootFonts(BOOT);
    calls.length = 0;
    listeners[0]({ fontfaces: [{ family: '"JetBrains Mono"' }] });
    listeners[0]({ fontfaces: [{ family: 'Cascadia Mono' }] });
    listeners[0]({ fontfaces: [{ family: 'Segoe UI Symbol' }] });
    expect(calls).toEqual(['refreshFonts', 'refreshFonts', 'refreshFonts']);
  });

  it('ignores faces outside the terminal stack: UI, codicon, KaTeX, another mono', async () => {
    const { svc, calls, listeners } = harness();
    await svc.loadBootFonts(BOOT);
    calls.length = 0;
    for (const family of ['Figtree', 'codicon', 'KaTeX_Main', 'Fira Code']) {
      listeners[0]({ fontfaces: [{ family }] });
    }
    expect(calls).toEqual([]);
  });

  it('a face the boot load already waited for needs no refresh', async () => {
    const face = { family: 'JetBrains Mono' };
    const { svc, calls, listeners } = harness(() => Promise.resolve([face]));
    await svc.loadBootFonts(BOOT);
    calls.length = 0;
    listeners[0]({ fontfaces: [face] });
    expect(calls).toEqual([]);
  });

  it('a face that missed the boot timeout refreshes when it lands', async () => {
    const face = { family: 'JetBrains Mono' };
    let land!: () => void;
    const { svc, calls, listeners, timers } = harness(
      () => new Promise((r) => (land = () => r([face]))),
    );
    const boot = svc.loadBootFonts(BOOT);
    timers[0].fn();
    await boot;
    land();
    await Promise.resolve();
    listeners[0]({ fontfaces: [face] });
    expect(calls.filter((c) => c === 'refreshFonts')).toHaveLength(1);
  });

  it('settles at once without a FontFaceSet', async () => {
    const svc = createFontService({
      fonts: undefined,
      gpu: { refreshFonts: () => {}, applyFontFamily: () => {} },
      setTimer: () => () => {},
      warn: () => {},
    });
    await expect(svc.loadBootFonts(BOOT)).resolves.toBeUndefined();
  });
});

describe('applyTerminalFontChange', () => {
  const deferred = () => {
    let resolve!: (v: Face[]) => void;
    const promise = new Promise<Face[]>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it('loads the new face before the option changes', async () => {
    const d = deferred();
    const { svc, calls } = harness(() => d.promise);
    const done = svc.applyTerminalFontChange('firacode', 14);
    await Promise.resolve();
    expect(calls.some((c) => c.startsWith('apply:'))).toBe(false);
    d.resolve([{ ...FACE }]);
    await done;
    expect(calls).toEqual([
      `load:400 14px ${monoStack('firacode')}`,
      `load:700 14px ${monoStack('firacode')}`,
      `apply:${monoStack('firacode')}`,
    ]);
  });

  it('shares an identical in-flight request', async () => {
    const d = deferred();
    const { svc, calls } = harness(() => d.promise);
    const a = svc.applyTerminalFontChange('firacode', 14);
    const b = svc.applyTerminalFontChange('firacode', 14);
    expect(b).toBe(a);
    d.resolve([{ ...FACE }]);
    await a;
    expect(calls.filter((c) => c.startsWith('load:'))).toHaveLength(2);
    expect(calls.filter((c) => c.startsWith('apply:'))).toHaveLength(1);
  });

  it('the latest request wins when an earlier one settles last', async () => {
    const slow = deferred();
    const { svc, calls } = harness((font) =>
      font.includes('Fira') ? slow.promise : Promise.resolve([{ ...FACE }]),
    );
    const first = svc.applyTerminalFontChange('firacode', 14);
    const second = svc.applyTerminalFontChange('plexmono', 14);
    await second;
    slow.resolve([{ ...FACE }]);
    await first;
    expect(calls.filter((c) => c.startsWith('apply:'))).toEqual([`apply:${monoStack('plexmono')}`]);
  });

  it('a failed load is logged and the change still applies', async () => {
    const { svc, calls, warnings } = harness(() => Promise.reject(new Error('gone')));
    await svc.applyTerminalFontChange('plexmono', 13);
    expect(warnings).toEqual(['font load failed', 'font load failed']);
    expect(calls.at(-1)).toBe(`apply:${monoStack('plexmono')}`);
  });

  it('a load past the timeout logs and applies anyway', async () => {
    const { svc, calls, timers, warnings } = harness(() => new Promise(() => {}));
    const done = svc.applyTerminalFontChange('firacode', 14);
    timers[0].fn();
    await done;
    expect(warnings).toEqual(['font load timed out']);
    expect(calls.at(-1)).toBe(`apply:${monoStack('firacode')}`);
  });

  it('a change refits once: its own faces landing never trigger a second refresh', async () => {
    const fira = { family: 'Fira Code' };
    const { svc, calls, listeners } = harness((font) =>
      Promise.resolve(font.includes('Fira') ? [fira] : [{ ...FACE }]),
    );
    await svc.loadBootFonts(BOOT);
    const done = svc.applyTerminalFontChange('firacode', 14);
    listeners[0]({ fontfaces: [fira] });
    await done;
    listeners[0]({ fontfaces: [fira] });
    expect(calls.filter((c) => c === 'refreshFonts')).toEqual([]);
    expect(calls.filter((c) => c.startsWith('apply:'))).toHaveLength(1);
  });

  it('after a change, the new stack is the one whose late faces refresh', async () => {
    const { svc, calls, listeners } = harness();
    await svc.loadBootFonts(BOOT);
    await svc.applyTerminalFontChange('firacode', 14);
    calls.length = 0;
    listeners[0]({ fontfaces: [{ family: 'JetBrains Mono' }] });
    expect(calls).toEqual([]);
    listeners[0]({ fontfaces: [{ family: 'Fira Code' }] });
    expect(calls).toEqual(['refreshFonts']);
  });
});
