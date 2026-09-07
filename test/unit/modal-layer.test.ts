// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ModalLayer, type ModalLayerProps } from '../../webview/components/modal-layer';

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
});

function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  return root;
}

/** Typed `createElement(ModalLayer, props)` wrapper — `ModalLayerProps.children` is required. */
function layer(props: ModalLayerProps & { key?: string }) {
  return createElement(ModalLayer, props);
}

describe('ModalLayer', () => {
  it('backdrop is a child of document.body with the default class', async () => {
    const r = mount();
    await act(async () => {
      r.render(layer({ children: createElement('div', null, 'box') }));
    });
    const backdrop = document.body.querySelector(':scope > .modal__backdrop');
    expect(backdrop).not.toBeNull();
  });

  it('backdropClass replaces the default', async () => {
    const r = mount();
    await act(async () => {
      r.render(
        layer({
          backdropClass: 'mermaid-zoom__backdrop',
          children: createElement('div', null, 'box'),
        }),
      );
    });
    expect(document.body.querySelector(':scope > .mermaid-zoom__backdrop')).not.toBeNull();
    expect(document.body.querySelector(':scope > .modal__backdrop')).toBeNull();
  });

  it('two layers get z-index strings calc(var(--layer-modal) + 0) and + 1, in mount order regardless of tree order', async () => {
    const r = mount();

    function Harness() {
      const [showA, setShowA] = useState(false);
      // B is first in the tree but A mounts first via the state flip below.
      return createElement(
        'div',
        null,
        showA && layer({ key: 'a', children: createElement('span', null, 'a') }),
        layer({ key: 'b', children: createElement('span', null, 'b') }),
        createElement('button', { onClick: () => setShowA(true) }),
      );
    }

    await act(async () => {
      r.render(createElement(Harness));
    });
    // Only B mounted so far.
    await act(async () => {});
    let backdrops = document.body.querySelectorAll<HTMLElement>(':scope > .modal__backdrop');
    expect(backdrops.length).toBe(1);

    host.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await act(async () => {});

    backdrops = document.body.querySelectorAll<HTMLElement>(':scope > .modal__backdrop');
    expect(backdrops.length).toBe(2);
    // B mounted first (depth 0), A mounted second (depth 1) — mount order, not tree order.
    const zB = backdrops[0].style.zIndex;
    const zA = backdrops[1].style.zIndex;
    expect(zB).toBe('calc(var(--layer-modal) + 0)');
    expect(zA).toBe('calc(var(--layer-modal) + 1)');
  });

  it('the later-mounted layer is later in document.body', async () => {
    const r = mount();
    await act(async () => {
      r.render(
        createElement('div', null, layer({ key: 'x', children: createElement('span', null, 'x') })),
      );
    });
    await act(async () => {
      r.render(
        createElement(
          'div',
          null,
          layer({ key: 'x', children: createElement('span', null, 'x') }),
          layer({ key: 'y', children: createElement('span', null, 'y') }),
        ),
      );
    });
    const backdrops = [...document.body.querySelectorAll<HTMLElement>(':scope > .modal__backdrop')];
    expect(backdrops.length).toBe(2);
    expect(backdrops[0].querySelector('span')?.textContent).toBe('x');
    expect(backdrops[1].querySelector('span')?.textContent).toBe('y');
  });

  it('closing the first re-derives the second to + 0', async () => {
    const r = mount();

    function Harness() {
      const [showA, setShowA] = useState(true);
      return createElement(
        'div',
        null,
        showA && layer({ key: 'a', children: createElement('span', null, 'a') }),
        layer({ key: 'b', children: createElement('span', null, 'b') }),
        createElement('button', { onClick: () => setShowA(false) }),
      );
    }

    await act(async () => {
      r.render(createElement(Harness));
    });
    await act(async () => {});

    host.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await act(async () => {});

    const backdrops = document.body.querySelectorAll<HTMLElement>(':scope > .modal__backdrop');
    expect(backdrops.length).toBe(1);
    expect(backdrops[0].style.zIndex).toBe('calc(var(--layer-modal) + 0)');
  });

  it('click on the backdrop calls onDismiss; click on a child does not', async () => {
    const onDismiss = vi.fn();
    const r = mount();
    await act(async () => {
      r.render(layer({ onDismiss, children: createElement('button', null, 'child') }));
    });
    const backdrop = document.body.querySelector('.modal__backdrop') as HTMLElement;
    const child = backdrop.querySelector('button') as HTMLElement;

    await act(async () => {
      child.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onDismiss).not.toHaveBeenCalled();

    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
