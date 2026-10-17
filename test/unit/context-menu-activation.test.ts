// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { triggerMenu } from '../../src/menu-position';
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

describe('triggerMenu', () => {
  // The sidebar and Changes ··· menus once hung from a fixed 200 px guess, so the menu's right
  // edge missed the button by however much the real menu differed from 200 px in each theme.
  it.each([150, 260])('a %i px menu ends at its trigger right edge', async (width) => {
    const trigger = { left: 300, right: 328, top: 40, bottom: 64 };
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      ...RECT,
      width,
      height: 120,
    });
    Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    const items: MenuItem[] = [{ label: 'Sort by name', onClick: vi.fn() }];
    await mount(
      createElement(ContextMenu, { menu: { ...triggerMenu(trigger), items }, onClose: vi.fn() }),
    );
    const frame = document.body.querySelector('.ctxmenu') as HTMLElement;
    expect(frame.style.left).toBe(`${328 - width}px`);
    expect(frame.style.top).toBe('68px');
    spy.mockRestore();
  });
});

describe('ContextMenu under a resting pointer (path-links QA r1 Q3)', () => {
  const items = (): MenuItem[] =>
    ['One', 'Two', 'Three'].map((label) => ({ label, onClick: vi.fn() }));
  const activeLabel = () => document.querySelector('.ctxmenu__item--active')?.textContent ?? null;
  const frame = () => document.querySelector('.ctxmenu') as HTMLElement;

  /** What Chromium sends a row that lands under a stationary cursor: boundary events plus a
   *  pointermove at the same point. */
  async function pointAt(el: Element, x: number, y: number) {
    await act(async () => {
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
      el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y }));
    });
  }

  it('a keyboard-opened menu keeps its first row active until the pointer really moves', async () => {
    const list = items();
    await mount(
      createElement(ContextMenu, {
        menu: { x: 5, y: 5, items: list, keyboard: true },
        onClose: vi.fn(),
      }),
    );
    expect(activeLabel()).toBe('One');
    await pointAt(row('Three'), 40, 60);
    await pointAt(row('Three'), 40, 60);
    expect(activeLabel()).toBe('One');
    expect(frame().dataset.pointer).toBe('resting');
    await keydown('Enter');
    expect(list[0].onClick).toHaveBeenCalledTimes(1);
    expect(list[2].onClick).not.toHaveBeenCalled();
  });

  it('a pointer-opened menu highlights nothing under a resting pointer, then follows a real move', async () => {
    await mount(
      createElement(ContextMenu, { menu: { x: 5, y: 5, items: items() }, onClose: vi.fn() }),
    );
    await pointAt(row('Two'), 40, 40);
    expect(activeLabel()).toBeNull();
    await pointAt(row('Two'), 41, 40);
    expect(activeLabel()).toBe('Two');
    expect(frame().dataset.pointer).toBe('armed');
  });
});

describe('ContextMenu keys', () => {
  // The terminal under a right-click menu keeps focus, and xterm ignores defaultPrevented.
  it('a key the menu acts on never reaches the focused element under it', async () => {
    const under = document.createElement('textarea');
    document.body.append(under);
    under.focus();
    const reached = vi.fn();
    under.addEventListener('keydown', (e) => reached(e.key));
    const items: MenuItem[] = [{ label: 'One', onClick: vi.fn() }];
    await mount(createElement(ContextMenu, { menu: { x: 5, y: 5, items }, onClose: vi.fn() }));
    for (const key of ['ArrowDown', 'Home', 'End', 'Enter']) {
      await act(async () => {
        under.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      });
    }
    expect(items[0].onClick).toHaveBeenCalledTimes(1);
    expect(reached).not.toHaveBeenCalled();
  });
});
