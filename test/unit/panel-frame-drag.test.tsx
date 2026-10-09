// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PanelFrame } from '../../webview/components/panel-frame';

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
  document.body.classList.remove('resizing');
});

const dock = {
  isOver: false,
  onDragStart: () => {},
  onDragEnd: () => {},
  onDragOver: () => {},
  onDrop: () => {},
};

async function render(onWidthCommit: (w: number) => void) {
  const r = root ?? createRoot(host);
  root = r;
  await act(async () => {
    r.render(
      <PanelFrame
        region="explorer"
        title="Explorer"
        widthVar="--right-w"
        edge="left"
        onWidthCommit={onWidthCommit}
        dock={dock}
      >
        <div />
      </PanelFrame>,
    );
  });
}

async function startDragTo(px: number) {
  host = document.createElement('div');
  document.body.append(host);
  document.documentElement.style.setProperty('--right-w', '340px');
  const onWidthCommit = vi.fn();
  await render(onWidthCommit);
  const panel = host.querySelector<HTMLElement>('.panel');
  const handle = host.querySelector<HTMLElement>('.panel__resize');
  if (!panel || !handle) throw new Error('panel not rendered');
  panel.getBoundingClientRect = () => ({ left: 0, right: 800 }) as DOMRect;
  await act(async () => {
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1 }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 800 - px, buttons: 1 }));
  });
  expect(document.documentElement.style.getPropertyValue('--right-w')).toBe(`${px}px`);
  return onWidthCommit;
}

describe('PanelFrame resize drag always ends in a commit', () => {
  it('mouseup commits the live width', async () => {
    const commit = await startDragTo(260);
    await act(async () => window.dispatchEvent(new MouseEvent('mouseup')));
    expect(commit).toHaveBeenCalledExactlyOnceWith(260);
    expect(document.body.classList.contains('resizing')).toBe(false);
  });

  it('a re-render mid-drag with a fresh onWidthCommit does not end the drag', async () => {
    const first = await startDragTo(260);
    const second = vi.fn();
    await render(second);
    expect(first).not.toHaveBeenCalled();
    expect(document.body.classList.contains('resizing')).toBe(true);
    await act(async () => window.dispatchEvent(new MouseEvent('mouseup')));
    expect(second).toHaveBeenCalledExactlyOnceWith(260);
  });

  it('unmounting mid-drag commits the live width and clears body.resizing', async () => {
    const commit = await startDragTo(260);
    const r = root;
    root = null;
    await act(async () => r?.unmount());
    expect(commit).toHaveBeenCalledExactlyOnceWith(260);
    expect(document.body.classList.contains('resizing')).toBe(false);
  });

  it('window blur (alt-tab swallows the mouseup) ends the drag', async () => {
    const commit = await startDragTo(260);
    await act(async () => window.dispatchEvent(new FocusEvent('blur')));
    expect(commit).toHaveBeenCalledExactlyOnceWith(260);
    expect(document.body.classList.contains('resizing')).toBe(false);
  });

  it('a move with no button held (mouseup released outside the window) ends the drag', async () => {
    const commit = await startDragTo(260);
    await act(async () =>
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 300, buttons: 0 })),
    );
    expect(commit).toHaveBeenCalledExactlyOnceWith(260);
    expect(document.documentElement.style.getPropertyValue('--right-w')).toBe('260px');
    expect(document.body.classList.contains('resizing')).toBe(false);
  });
});
