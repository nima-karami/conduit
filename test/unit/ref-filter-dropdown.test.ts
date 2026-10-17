// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GitRef } from '../../src/protocol';
import { RefFilterDropdown } from '../../webview/components/ref-filter-dropdown';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
});

let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const refs = (): GitRef[] => [
  { kind: 'branch', name: 'main' },
  { kind: 'branch', name: 'dev' },
];

const render = (onRefFilter: (r: string | null) => void) =>
  act(async () =>
    root?.render(
      createElement(RefFilterDropdown, { refFilter: null, refOptions: refs(), onRefFilter }),
    ),
  );

const row = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.ctxmenu__item')).find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement;

const pointAt = (el: Element, x: number, y: number) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y }));
  });

// Review r2: the menu object is rebuilt per render, and ContextMenu restarts its hover gate and
// keyboard highlight on a new menu identity.
describe('RefFilterDropdown re-render', () => {
  it('a re-render with the same refs keeps the gate armed and the highlight', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const onRefFilter = vi.fn();
    await render((r) => onRefFilter(r));
    await act(async () => (document.querySelector('.gh__reffilter') as HTMLButtonElement).click());
    await pointAt(row('dev'), 40, 40);
    await pointAt(row('dev'), 41, 40);
    const frame = () => document.querySelector('.ctxmenu') as HTMLElement;
    const active = () => document.querySelector('.ctxmenu__item--active')?.textContent ?? null;
    expect([active(), frame().dataset.pointer]).toEqual(['dev', 'armed']);

    await render((r) => onRefFilter(r));
    expect([active(), frame().dataset.pointer]).toEqual(['dev', 'armed']);
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    });
    expect(onRefFilter).toHaveBeenCalledWith('dev');
  });
});
