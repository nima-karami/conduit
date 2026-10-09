// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type AppSettings, DEFAULT_SETTINGS } from '../../src/settings';
import { SettingsProvider, useSettings } from '../../webview/settings';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let host: HTMLDivElement;
let root: Root | null = null;

afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
  host?.remove();
  document.documentElement.removeAttribute('style');
});

async function mount() {
  const seen: { hydrate?: (s: AppSettings) => void; renders: number; settings?: AppSettings } = {
    renders: 0,
  };
  function Probe() {
    const ctx = useSettings();
    seen.hydrate = ctx.hydrate;
    seen.settings = ctx.settings;
    seen.renders += 1;
    return null;
  }
  host = document.createElement('div');
  document.body.append(host);
  const r = createRoot(host);
  root = r;
  await act(async () => {
    r.render(createElement(SettingsProvider, null, createElement(Probe)));
  });
  return seen;
}

const rootVar = (name: string) => document.documentElement.style.getPropertyValue(name);
// What PanelFrame does on every pointermove of a resize drag.
const dragTo = (px: number) => document.documentElement.style.setProperty('--right-w', `${px}px`);
const clone = (s: AppSettings): AppSettings => JSON.parse(JSON.stringify(s));

describe('SettingsProvider hydrate vs live DOM', () => {
  it('a broadcast carrying identical settings neither re-renders nor rewrites --right-w', async () => {
    const seen = await mount();
    expect(rootVar('--right-w')).toBe(`${DEFAULT_SETTINGS.rightWidth}px`);
    const before = seen.settings;
    const renders = seen.renders;
    dragTo(DEFAULT_SETTINGS.rightWidth - 120);

    await act(async () => seen.hydrate?.(clone(DEFAULT_SETTINGS)));

    expect(seen.settings).toBe(before);
    expect(seen.renders).toBe(renders);
    expect(rootVar('--right-w')).toBe(`${DEFAULT_SETTINGS.rightWidth - 120}px`);
  });

  it('identical settings in a different key order are still equal', async () => {
    const seen = await mount();
    const before = seen.settings;
    const reordered = Object.fromEntries(
      Object.entries(clone(DEFAULT_SETTINGS)).reverse(),
    ) as unknown as AppSettings;

    await act(async () => seen.hydrate?.(reordered));

    expect(seen.settings).toBe(before);
  });

  it('a drag-in-progress width survives a broadcast that changes an unrelated setting', async () => {
    const seen = await mount();
    dragTo(DEFAULT_SETTINGS.rightWidth - 120);

    await act(async () => seen.hydrate?.({ ...clone(DEFAULT_SETTINGS), bgBlur: 33 }));

    expect(rootVar('--bg-blur')).toBe('33px');
    expect(rootVar('--right-w')).toBe(`${DEFAULT_SETTINGS.rightWidth - 120}px`);
  });

  it('a broadcast that changes rightWidth itself still applies it', async () => {
    const seen = await mount();
    dragTo(DEFAULT_SETTINGS.rightWidth - 120);

    await act(async () =>
      seen.hydrate?.({ ...clone(DEFAULT_SETTINGS), rightWidth: DEFAULT_SETTINGS.rightWidth + 40 }),
    );

    expect(rootVar('--right-w')).toBe(`${DEFAULT_SETTINGS.rightWidth + 40}px`);
  });
});
