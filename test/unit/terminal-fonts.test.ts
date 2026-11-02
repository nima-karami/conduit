import { describe, expect, it } from 'vitest';
import {
  BOOT_FONT_TIMEOUT_MS,
  createFontService,
  FONT_SAMPLE,
  type FontServiceDeps,
} from '../../webview/terminal-fonts';
import { monoStack } from '../../webview/xterm-theme';

type LoadImpl = (font: string) => Promise<unknown[]>;

function harness(loadImpl: LoadImpl = () => Promise.resolve([{}])) {
  const calls: string[] = [];
  const loads: { font: string; text?: string }[] = [];
  const warnings: string[] = [];
  const listeners: (() => void)[] = [];
  const timers: (() => void)[] = [];
  const fonts = {
    load(font: string, text?: string) {
      loads.push({ font, text });
      calls.push(`load:${font}`);
      return loadImpl(font);
    },
    addEventListener(_type: 'loadingdone', fn: () => void) {
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
      timers.push(fn);
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
      font.startsWith('700') ? Promise.reject(new Error('net')) : Promise.resolve([{}]),
    );
    await expect(svc.loadBootFonts(BOOT)).resolves.toBeUndefined();
    expect(warnings).toEqual(['font load failed', 'font load failed']);
  });

  it('a load that never settles gives up on the timer', async () => {
    const { svc, timers, warnings } = harness(() => new Promise(() => {}));
    const boot = svc.loadBootFonts(BOOT);
    expect(timers).toHaveLength(1);
    timers[0]();
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

  it('every later loadingdone refreshes all terminals through the coordinator', async () => {
    const { svc, calls, listeners } = harness();
    await svc.loadBootFonts(BOOT);
    calls.length = 0;
    listeners[0]();
    listeners[0]();
    expect(calls).toEqual(['refreshFonts', 'refreshFonts']);
  });

  it('settles at once without a FontFaceSet', async () => {
    const svc = createFontService({
      fonts: undefined,
      gpu: { refreshFonts: () => {}, applyFontFamily: () => {} },
      setTimer: () => {},
      warn: () => {},
    });
    await expect(svc.loadBootFonts(BOOT)).resolves.toBeUndefined();
  });
});

describe('applyTerminalFontChange', () => {
  const deferred = () => {
    let resolve!: (v: unknown[]) => void;
    const promise = new Promise<unknown[]>((r) => {
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
    d.resolve([{}]);
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
    d.resolve([{}]);
    await a;
    expect(calls.filter((c) => c.startsWith('load:'))).toHaveLength(2);
    expect(calls.filter((c) => c.startsWith('apply:'))).toHaveLength(1);
  });

  it('the latest request wins when an earlier one settles last', async () => {
    const slow = deferred();
    const { svc, calls } = harness((font) =>
      font.includes('Fira') ? slow.promise : Promise.resolve([{}]),
    );
    const first = svc.applyTerminalFontChange('firacode', 14);
    const second = svc.applyTerminalFontChange('plexmono', 14);
    await second;
    slow.resolve([{}]);
    await first;
    expect(calls.filter((c) => c.startsWith('apply:'))).toEqual([`apply:${monoStack('plexmono')}`]);
  });

  it('a failed load is logged and the change still applies', async () => {
    const { svc, calls, warnings } = harness(() => Promise.reject(new Error('gone')));
    await svc.applyTerminalFontChange('plexmono', 13);
    expect(warnings).toEqual(['font load failed', 'font load failed']);
    expect(calls.at(-1)).toBe(`apply:${monoStack('plexmono')}`);
  });
});
