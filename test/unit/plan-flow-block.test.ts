// @vitest-environment jsdom
import { createTimer } from '@milkdown/kit/ctx';
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PlanEditor, type PlanEditorHandle } from '../../webview/components/plan-editor';
import { locateDiagram } from '../../webview/plan-diagram-write';

// Monaco does not load in jsdom; the diagram block — this file's subject — is the real one.
vi.mock('../../webview/components/plan-code-block', async () => {
  const react = await import('react');
  return {
    PlanDocContext: react.createContext({ root: '', slug: '', readOnly: false }),
    PlanCodeBlock: () => react.createElement('div', { className: 'plan__code' }),
    leaveBlock: () => {},
  };
});

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  (globalThis as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly ??= class {
    m22 = 1;
  };
  // An undo scrolls the selection into view, which measures it; jsdom has no layout to measure.
  const noRects = () => [] as unknown as DOMRectList;
  const zeroRect = () => new DOMRect();
  Range.prototype.getClientRects ??= noRects;
  Range.prototype.getBoundingClientRect ??= zeroRect;
  const textProto = Text.prototype as unknown as { getClientRects?: () => DOMRectList };
  textProto.getClientRects ??= noRects;
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

// Milkdown arms ctx timers it never clears; jsdom has to outlive them (see plan-editor-parity).
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, createTimer('default').timeout));
  await new Promise((resolve) => setImmediate(resolve));
});

async function mount(body: string, readOnly = false) {
  const handle = createRef<PlanEditorHandle>();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const { PlanDocContext } = await import('../../webview/components/plan-code-block');
  await act(async () => {
    root?.render(
      createElement(
        PlanDocContext.Provider,
        { value: { root: '', slug: '', readOnly } },
        createElement(PlanEditor, {
          ref: handle,
          body,
          readOnly,
          fileReadOnly: readOnly,
          onBody: () => {},
          onBodyRefused: () => {},
          onBlockFocus: () => {},
          agentChanged: new Set<string>(),
        }),
      ),
    );
  });
  for (let i = 0; i < 50 && !host.querySelector('.planflow'); i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return { el: host, handle };
}

describe('PlanFlowBlock', () => {
  it('a write finds its own fence even after a flowchart was inserted above without a re-render', async () => {
    const { el, handle } = await mount('# Plan\n\n```mermaid\nflowchart LR\n  a --> b\n```\n');
    const view = handle.current?.view();
    if (!view) throw new Error('no view');
    const ours = el.querySelector('.planflow');

    await act(async () => {
      const { schema } = view.state;
      const fence = schema.nodes.code_block.create(
        { language: 'mermaid' },
        schema.text('flowchart TD\n  x --> y'),
      );
      view.dispatch(view.state.tr.insert(0, fence));
    });
    expect(locateDiagram(view.state.doc, 'flow-0')?.node.textContent).toBe(
      'flowchart TD\n  x --> y',
    );

    const add = [...(ours?.querySelectorAll<HTMLButtonElement>('.planflow__button') ?? [])].find(
      (b) => b.textContent === 'Add node',
    );
    expect(add).toBeDefined();
    await act(async () => {
      add?.click();
      await Promise.resolve();
    });

    expect(locateDiagram(view.state.doc, 'flow-0')?.node.textContent).toBe(
      'flowchart TD\n  x --> y',
    );
    expect(locateDiagram(view.state.doc, 'flow-1')?.node.textContent).toBe(
      'flowchart LR\n  a --> b\n  n1',
    );
  });
});

describe('PlanFlowBlock undo', () => {
  it('Ctrl+Z on the canvas after a rename undoes it, and Ctrl+Shift+Z redoes it', async () => {
    const { el, handle } = await mount('# Plan\n\n```mermaid\nflowchart LR\n  a --> b\n```\n');
    const view = handle.current?.view();
    if (!view) throw new Error('no view');
    const fence = () => locateDiagram(view.state.doc, 'flow-0')?.node.textContent;
    const node = el.querySelector<HTMLElement>('.react-flow__node[data-id="a"]');
    await act(async () => {
      node?.focus();
      node?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const input = el.querySelector<HTMLInputElement>('.planflow__input');
    if (!input) throw new Error('no rename input');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'Alpha',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
    });
    expect(fence()).toBe('flowchart LR\n  a[Alpha] --> b');

    const target = el.querySelector<HTMLElement>('.react-flow__node[data-id="a"]');
    await act(async () => {
      target?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }),
      );
    });
    expect(fence()).toBe('flowchart LR\n  a --> b');
    await act(async () => {
      target?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Z', ctrlKey: true, shiftKey: true, bubbles: true }),
      );
    });
    expect(fence()).toBe('flowchart LR\n  a[Alpha] --> b');
  });

  it('on a read-only plan Ctrl+Z is still claimed, so no app-wide undo acts on it', async () => {
    const { el } = await mount('# Plan\n\n```mermaid\nflowchart LR\n  a --> b\n```\n', true);
    const node = el.querySelector<HTMLElement>('.react-flow__node[data-id="a"]');
    const press = new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      node?.dispatchEvent(press);
    });
    expect(press.defaultPrevented).toBe(true);
  });
});
