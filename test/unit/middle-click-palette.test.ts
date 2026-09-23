// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CommandPalette, type PaletteEntry } from '../../webview/components/command-palette';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = () => {};
});

let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function render(items: PaletteEntry[], onClose: () => void) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      createElement(CommandPalette, { items, placeholder: 'x', initialQuery: 'b', onClose }),
    ),
  );
}

const row = (title: string) =>
  Array.from(document.querySelectorAll('.palette__row')).find((r) =>
    r.textContent?.includes(title),
  ) as HTMLElement;

async function middle(el: Element) {
  const down = new MouseEvent('mousedown', { button: 1, bubbles: true, cancelable: true });
  await act(async () => {
    el.dispatchEvent(down);
    el.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));
  });
  return down;
}

describe('CommandPalette middle-click', () => {
  it('calls runBackground, not run, and stays open', async () => {
    const run = vi.fn();
    const runBackground = vi.fn();
    const onClose = vi.fn();
    await render([{ id: 'f', title: 'b.ts', group: 'Files', run, runBackground }], onClose);
    const down = await middle(row('b.ts'));
    expect(runBackground).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(down.defaultPrevented).toBe(true);
  });

  it('a row without runBackground does nothing on a middle-click', async () => {
    const run = vi.fn();
    const onClose = vi.fn();
    await render([{ id: 's', title: 'b session', group: 'Sessions', run }], onClose);
    await middle(row('b session'));
    expect(run).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
