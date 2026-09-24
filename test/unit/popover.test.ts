// @vitest-environment jsdom
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Popover, type PopoverProps } from '../../webview/components/popover';

// jsdom has no ResizeObserver; the real app runs in Chromium, where it does. Stub a minimal
// implementation so the component's own (unconditional) `new ResizeObserver(...)` doesn't throw.
class StubResizeObserver {
  static instances: StubResizeObserver[] = [];
  observed: Element[] = [];
  constructor(public callback: ResizeObserverCallback) {
    StubResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = StubResizeObserver;
});

beforeEach(() => {
  StubResizeObserver.instances = [];
});

let host: HTMLDivElement;
let root: Root | null = null;

/** Typed `createElement(Popover, props)` wrapper — `PopoverProps.children` is required. */
function popover(props: PopoverProps) {
  return createElement(Popover, props);
}

async function render(props: PopoverProps) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(popover(props));
  });
}

afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
  host?.remove();
});

describe('Popover', () => {
  it('renders its frame as a child of document.body with class popover plus the caller class', async () => {
    await render({
      at: { x: 10, y: 10 },
      onClose: () => {},
      className: 'ctxmenu',
      children: createElement('span', null, 'hi'),
    });

    const frame = document.body.querySelector(':scope > .popover');
    expect(frame).not.toBeNull();
    expect(frame?.className).toBe('popover ctxmenu');
    expect(frame?.parentElement).toBe(document.body);
  });

  it('mousedown outside calls onClose once; inside does not', async () => {
    const onClose = vi.fn();
    await render({ at: { x: 10, y: 10 }, onClose, children: createElement('span', null, 'hi') });
    const frame = document.body.querySelector('.popover') as HTMLElement;

    await act(async () => {
      frame.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('mousedown inside triggerRef does not close', async () => {
    const onClose = vi.fn();
    const trigger = document.createElement('button');
    document.body.append(trigger);
    const triggerRef = { current: trigger };

    await render({
      at: { x: 10, y: 10 },
      onClose,
      triggerRef,
      children: createElement('span', null, 'hi'),
    });

    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    trigger.remove();
  });

  it('capture-phase scroll outside closes, scroll inside the frame does not', async () => {
    const onClose = vi.fn();
    await render({ at: { x: 10, y: 10 }, onClose, children: createElement('span', null, 'hi') });
    const frame = document.body.querySelector('.popover') as HTMLElement;

    await act(async () => {
      frame.dispatchEvent(new Event('scroll', { bubbles: false }));
    });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      document.dispatchEvent(new Event('scroll'));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('window blur and resize close', async () => {
    const onClose = vi.fn();
    await render({ at: { x: 10, y: 10 }, onClose, children: createElement('span', null, 'hi') });

    await act(async () => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('anchor mode with align start places left = rect.left', async () => {
    const rect = { left: 100, right: 200, top: 10, bottom: 30 };
    const getRectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 100,
      height: 50,
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON() {},
    });
    Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

    await render({
      anchor: rect,
      align: 'start',
      side: 'below',
      onClose: () => {},
      children: createElement('span', null, 'hi'),
    });
    const frame = document.body.querySelector('.popover') as HTMLElement;
    expect(frame.style.left).toBe('100px');
    expect(frame.style.top).toBe('34px');

    getRectSpy.mockRestore();
  });

  it('align end lines the MEASURED right edge up with the anchor when content outgrows `width` (QA F3)', async () => {
    const rect = { left: 500, right: 600, top: 10, bottom: 30 };
    const getRectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 260,
      height: 50,
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON() {},
    });
    Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

    await render({
      anchor: rect,
      align: 'end',
      width: 210,
      onClose: () => {},
      children: createElement('span', null, 'a label wider than 210px'),
    });
    const frame = document.body.querySelector('.popover') as HTMLElement;
    expect(frame.style.left).toBe(`${600 - 260}px`);
    expect(frame.style.minWidth).toBe('210px');
    expect(frame.style.width).toBe('');

    getRectSpy.mockRestore();
  });

  it('side above places top = rect.top - gap - height', async () => {
    const rect = { left: 100, right: 200, top: 100, bottom: 130 };
    const getRectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 100,
      height: 50,
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON() {},
    });
    Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

    await render({
      anchor: rect,
      align: 'start',
      side: 'above',
      gap: 4,
      onClose: () => {},
      children: createElement('span', null, 'hi'),
    });
    const frame = document.body.querySelector('.popover') as HTMLElement;
    expect(frame.style.top).toBe(`${100 - 4 - 50}px`);

    getRectSpy.mockRestore();
  });

  it('a forwarded ref receives the frame element', async () => {
    const ref = createRef<HTMLDivElement>();
    await render({
      at: { x: 10, y: 10 },
      onClose: () => {},
      ref,
      children: createElement('span', null, 'hi'),
    });
    expect(ref.current).not.toBeNull();
    expect(ref.current?.className).toContain('popover');
  });

  it('hovering (re-rendering with new children) does not re-measure', async () => {
    const getRectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 100,
      height: 50,
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON() {},
    });

    await render({
      at: { x: 10, y: 10 },
      onClose: () => {},
      children: createElement('span', null, 'one'),
    });
    const countAfterMount = getRectSpy.mock.calls.length;
    expect(StubResizeObserver.instances.length).toBe(1);
    const frame = document.body.querySelector('.popover') as HTMLElement;
    expect(StubResizeObserver.instances[0]?.observed).toContain(frame);

    await act(async () => {
      root?.render(
        popover({
          at: { x: 10, y: 10 },
          onClose: () => {},
          children: createElement('span', null, 'two'),
        }),
      );
    });
    expect(getRectSpy.mock.calls.length).toBe(countAfterMount);

    getRectSpy.mockRestore();
  });
});
