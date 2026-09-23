// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ContextMenu, type MenuItem } from '../../webview/components/context-menu';

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

async function render(items: MenuItem[], onClose: () => void) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(createElement(ContextMenu, { menu: { x: 10, y: 10, items }, onClose })),
  );
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const rowButton = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.ctxmenu__item')).find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement;

async function middle(el: Element) {
  const down = new MouseEvent('mousedown', { button: 1, bubbles: true, cancelable: true });
  const aux = new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true });
  await act(async () => {
    el.dispatchEvent(down);
    el.dispatchEvent(aux);
  });
  return { down, aux };
}

describe('ContextMenu middle-click', () => {
  it('a row with onMiddleClick calls it (not onClick) and closes the menu', async () => {
    const onClick = vi.fn();
    const onMiddleClick = vi.fn();
    const onClose = vi.fn();
    await render([{ label: 'b.ts', onClick, onMiddleClick }], onClose);
    const { down, aux } = await middle(rowButton('b.ts'));
    expect(onMiddleClick).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(down.defaultPrevented).toBe(true);
    expect(aux.defaultPrevented).toBe(true);
  });

  it('a row without onMiddleClick does nothing on a middle-click', async () => {
    const onClick = vi.fn();
    const onClose = vi.fn();
    await render([{ label: 'dir', onClick }], onClose);
    const { down } = await middle(rowButton('dir'));
    expect(onClick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(down.defaultPrevented).toBe(true);
  });
});
