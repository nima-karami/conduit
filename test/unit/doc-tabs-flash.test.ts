// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DocTabs } from '../../webview/components/doc-tabs';
import type { OpenDoc } from '../../webview/docs';

const docs: OpenDoc[] = [
  { id: 'file:/a.ts', kind: 'file', path: '/a.ts', title: 'a.ts', sessionId: 'S' },
  { id: 'file:/b.ts', kind: 'file', path: '/b.ts', title: 'b.ts', sessionId: 'S' },
  { id: 'file:/far.ts', kind: 'file', path: '/far.ts', title: 'far.ts', sessionId: 'S' },
];

/** Strip 0–300 px; `far.ts` sits at 400–500, i.e. scrolled out of view. */
function rectFor(el: Element): DOMRect {
  const box = (left: number, right: number) =>
    ({
      left,
      right,
      top: 0,
      bottom: 30,
      width: right - left,
      height: 30,
      x: left,
      y: 0,
    }) as DOMRect;
  if (el.classList.contains('tabbar')) return box(0, 300);
  if (el.getAttribute('data-tabid') === 'file:/far.ts') return box(400, 500);
  return box(0, 100);
}

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
  if (!globalThis.CSS?.escape) vi.stubGlobal('CSS', { escape: (s: string) => s });
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return rectFor(this);
  };
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('tabbar') ? 600 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('tabbar') ? 300 : 0;
    },
  });
});

let root: Root | null = null;
let host: HTMLDivElement;
const onClose = vi.fn();

async function render(flashTabId: string | null) {
  if (!root) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () =>
    root?.render(
      createElement(DocTabs, {
        docs,
        activeId: 'file:/a.ts',
        terminalLabel: 'Terminal',
        terminalIcon: { kind: 'terminal' } as never,
        onSelect: () => {},
        onClose,
        flashTabId,
      }),
    ),
  );
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  onClose.mockReset();
});

const tabEl = (id: string) => host.querySelector(`[data-tabid="${id}"]`) as HTMLElement;

describe('DocTabs background-open cue', () => {
  it('flashTabId adds tab--flash to that tab only', async () => {
    await render(null);
    await render('file:/b.ts');
    expect(tabEl('file:/b.ts').classList.contains('tab--flash')).toBe(true);
    expect(host.querySelectorAll('.tab--flash')).toHaveLength(1);
    expect(host.querySelector('.tabbar__overflow-btn--flash')).toBeNull();
  });

  it('a clipped flashed tab flashes the overflow chevron, not the tab', async () => {
    await render(null);
    await render('file:/far.ts');
    expect(tabEl('file:/far.ts').classList.contains('tab--flash')).toBe(false);
    expect(host.querySelector('.tabbar__overflow-btn--flash')).not.toBeNull();
  });

  it('a middle mousedown on a tab is default-prevented and a middle auxclick still closes it', async () => {
    await render(null);
    const down = new MouseEvent('mousedown', { button: 1, bubbles: true, cancelable: true });
    tabEl('file:/b.ts').dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    const left = new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true });
    tabEl('file:/b.ts').dispatchEvent(left);
    expect(left.defaultPrevented).toBe(false);
    tabEl('file:/b.ts').dispatchEvent(
      new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }),
    );
    expect(onClose).toHaveBeenCalledWith('file:/b.ts');
  });
});
