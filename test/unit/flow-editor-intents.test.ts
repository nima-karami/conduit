// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseFlowchart } from '../../src/mermaid-flow';
import type { FlowEdit, FlowEditRefusal } from '../../src/mermaid-flow-edit';
import { FlowEditor } from '../../webview/components/flow-editor';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has neither; xyflow only needs them to exist.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  (globalThis as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly ??= class {
    m22 = 1;
  };
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

function graphOf(source: string) {
  const parsed = parseFlowchart(source);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.doc.graph;
}

async function mount(onEdits: (edits: readonly FlowEdit[]) => FlowEditRefusal | 'gone' | null) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(FlowEditor, {
        graph: graphOf('flowchart LR\n  a --> b'),
        onEdits,
        readOnly: false,
      }),
    );
  });
  return host;
}

const notice = (el: HTMLElement) => el.querySelector('.planflow__notice')?.textContent ?? null;

describe('FlowEditor intents', () => {
  it('a refused duplicate shows "That connection already exists" and calls onEdits once', async () => {
    const onEdits = vi.fn((): FlowEditRefusal | 'gone' | null => 'duplicate-edge');
    const el = await mount(onEdits);

    const node = el.querySelector<HTMLElement>('.react-flow__node[data-id="a"]');
    expect(node).not.toBeNull();
    await act(async () => {
      node?.focus();
      node?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'C', shiftKey: true, bubbles: true }),
      );
    });
    const option = document.querySelector<HTMLElement>('#planflow-pick-b');
    expect(option).not.toBeNull();
    await act(async () => {
      option?.click();
    });

    expect(onEdits).toHaveBeenCalledTimes(1);
    expect(onEdits.mock.calls[0]).toEqual([
      [{ op: 'addEdge', source: 'a', target: 'b', kind: 'arrow', label: null }],
    ]);
    expect(notice(el)).toBe('That connection already exists');
    expect(el.querySelector('.planflow__notice')?.getAttribute('role')).toBe('status');

    onEdits.mockReturnValue(null);
    const add = [...el.querySelectorAll<HTMLButtonElement>('.planflow__button')].find(
      (b) => b.textContent === 'Add node',
    );
    await act(async () => {
      add?.click();
    });
    expect(onEdits).toHaveBeenCalledTimes(2);
    expect(notice(el)).toBe('');
  });
});

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('FlowEditor rendering and focus', () => {
  it('after a rename commits, focus returns to the renamed node', async () => {
    const onEdits = vi.fn(() => null);
    const el = await mount(onEdits);
    const node = el.querySelector<HTMLElement>('.react-flow__node[data-id="a"]');
    await act(async () => {
      node?.focus();
      node?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const input = el.querySelector<HTMLInputElement>('.planflow__input');
    expect(input).not.toBeNull();
    if (!input) return;
    await typeInto(input, 'Alpha');
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(onEdits).toHaveBeenCalledTimes(1);
    expect(onEdits).toHaveBeenCalledWith([{ op: 'renameNode', id: 'a', label: 'Alpha' }]);
    expect(document.activeElement?.getAttribute('data-id')).toBe('a');
  });

  it('Escape cancels a rename, writes nothing, and hands focus back to the node', async () => {
    const onEdits = vi.fn(() => null);
    const el = await mount(onEdits);
    const node = el.querySelector<HTMLElement>('.react-flow__node[data-id="a"]');
    await act(async () => {
      node?.focus();
      node?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const input = el.querySelector<HTMLInputElement>('.planflow__input');
    if (!input) throw new Error('no rename input');
    await typeInto(input, 'Discarded');
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await Promise.resolve();
    });

    expect(onEdits).not.toHaveBeenCalled();
    expect(document.activeElement?.getAttribute('data-id')).toBe('a');
  });

  it('an open edit ends, unsaved, when the fence changes underneath it', async () => {
    const onEdits = vi.fn(() => null);
    const el = await mount(onEdits);
    const node = el.querySelector<HTMLElement>('.react-flow__node[data-id="a"]');
    await act(async () => {
      node?.focus();
      node?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const input = el.querySelector<HTMLInputElement>('.planflow__input');
    if (!input) throw new Error('no rename input');
    await typeInto(input, 'Typed');

    await act(async () => {
      root?.render(
        createElement(FlowEditor, {
          graph: graphOf('flowchart LR\n  b --> a'),
          onEdits,
          readOnly: false,
        }),
      );
      await Promise.resolve();
    });

    expect(el.querySelector('.planflow__input')).toBeNull();
    expect(onEdits).not.toHaveBeenCalled();
  });
});
