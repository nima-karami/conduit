// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ContextMenu, type MenuItem } from '../../webview/components/context-menu';
import { Popover, type PopoverProps } from '../../webview/components/popover';

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

async function mount(el: React.ReactElement) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(el));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

/** `PopoverProps.children` is required, so props go through a typed wrapper (as popover.test.ts). */
const popover = (props: PopoverProps) => createElement(Popover, props);

const RECT = { left: 10, right: 190, top: 40, bottom: 60, width: 180, height: 20 } as DOMRect;

const row = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.ctxmenu__item')).find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement;

async function keydown(key: string) {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

describe('ContextMenu activation', () => {
  it('click passes the row rect', async () => {
    const onClick = vi.fn();
    const items: MenuItem[] = [{ label: 'Move to project…', onClick }];
    await mount(createElement(ContextMenu, { menu: { x: 5, y: 5, items }, onClose: vi.fn() }));
    const btn = row('Move to project…');
    btn.getBoundingClientRect = () => RECT;
    await act(async () => btn.click());
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick.mock.calls[0][0]).toEqual({ rect: RECT });
    expect(onClick.mock.calls[0][0].rect.right).toBe(190);
  });

  it('Enter on a keyboard-highlighted row passes its rect', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const items: MenuItem[] = [
      { label: 'One', onClick: first },
      { label: 'Two', onClick: second },
    ];
    await mount(
      createElement(ContextMenu, {
        menu: { x: 5, y: 5, items, keyboard: true },
        onClose: vi.fn(),
      }),
    );
    row('Two').getBoundingClientRect = () => RECT;
    await keydown('ArrowDown');
    await keydown('Enter');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({ rect: RECT });
  });
});

describe('Popover onEscape', () => {
  it('Popover: Escape calls onEscape, not onClose; outside mousedown still calls onClose', async () => {
    const onClose = vi.fn();
    const onEscape = vi.fn();
    await mount(popover({ at: { x: 0, y: 0 }, onClose, onEscape, children: 'x' }));
    await keydown('Escape');
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Popover without onEscape: Escape calls onClose', async () => {
    const onClose = vi.fn();
    await mount(popover({ at: { x: 0, y: 0 }, onClose, children: 'x' }));
    await keydown('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
