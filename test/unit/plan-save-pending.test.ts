// @vitest-environment jsdom
import { createTimer } from '@milkdown/kit/ctx';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { act, createElement, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostToWebview, WebviewToHost } from '../../src/protocol';
import type { PlanEditorHandle } from '../../webview/components/plan-editor';
import { getPlanState, loadPlan } from '../../webview/plan-store';

/**
 * Production change that would make this fail: marking pending only from Milkdown's
 * 200 ms `updated` debounce, or collapsing pending/saving onto one `.plan__save` label.
 */

const bus = vi.hoisted(() => ({
  posted: [] as WebviewToHost[],
  emit: (_m: HostToWebview): void => {},
}));

const capture = vi.hoisted(() => ({
  ref: null as RefObject<PlanEditorHandle | null> | null,
}));

vi.mock('../../webview/bridge', () => ({
  post: (m: WebviewToHost) => {
    bus.posted.push(m);
  },
  subscribe: (cb: (m: HostToWebview) => void) => {
    bus.emit = cb;
    return () => {};
  },
  initialSettings: {},
}));

vi.mock('monaco-editor', () => ({
  editor: {
    create: () => ({ updateOptions() {}, dispose() {} }),
    createModel: () => ({
      getValue: () => '',
      setValue() {},
      onDidChangeContent: () => ({ dispose() {} }),
      dispose() {},
    }),
  },
}));

function blockStub(className: string) {
  return async () => {
    const react = await import('react');
    const adapter = await import('@prosemirror-adapter/react');
    return () => {
      const { node } = adapter.useNodeViewContext();
      return react.createElement('div', {
        className,
        'data-lang': String(node.attrs.language ?? ''),
      });
    };
  };
}

vi.mock('../../webview/components/plan-code-block', async () => ({
  PlanDocContext: (await import('react')).createContext({ root: '', slug: '', readOnly: false }),
  PlanCodeBlock: await blockStub('plan__code')(),
}));

vi.mock('../../webview/components/plan-flow-block', async () => ({
  PlanFlowBlock: await blockStub('planflow')(),
}));

vi.mock('../../webview/components/plan-editor', async () => {
  const actual = await vi.importActual<typeof import('../../webview/components/plan-editor')>(
    '../../webview/components/plan-editor',
  );
  const react = await import('react');
  function CapturingPlanEditor(
    props: Parameters<typeof actual.PlanEditor>[0],
  ): ReturnType<typeof actual.PlanEditor> {
    if (props.ref && typeof props.ref === 'object') capture.ref = props.ref;
    return react.createElement(actual.PlanEditor, props);
  }
  return { ...actual, PlanEditor: CapturingPlanEditor };
});

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const ROOT = 'C:/work/repo';
const SLUG = 'savepending';
const PATH = `${ROOT}/.conduit/plans/${SLUG}.md`;
const BODY = '# Title\n\nAlpha paragraph.\n';

const doc = (
  markdown: string | null,
  origin: 'load' | 'external' | 'write-ack',
): HostToWebview => ({ type: 'plan:doc', root: ROOT, slug: SLUG, markdown, origin });

const comments = (origin: 'load' | 'external' | 'ack'): HostToWebview => ({
  type: 'plan:comments',
  root: ROOT,
  slug: SLUG,
  comments: { version: 1, comments: [] },
  origin,
});

function endOfChild(proseDoc: ProseNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i += 1) pos += proseDoc.child(i).nodeSize;
  return pos + proseDoc.child(index).nodeSize - 1;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => {
    root?.unmount();
  });
  root = null;
  host?.remove();
  host = null;
  capture.ref = null;
});

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, createTimer('default').timeout));
  await new Promise((resolve) => setImmediate(resolve));
});

beforeEach(() => {
  bus.posted.length = 0;
});

async function settle(container: HTMLElement): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (container.querySelector('[data-milkdown-root] > *')) return;
  }
}

async function mountPlan(): Promise<HTMLDivElement> {
  const { PlanView } = await import('../../webview/components/plan-view');
  loadPlan(ROOT, SLUG);
  bus.emit(doc(BODY, 'load'));
  bus.emit(comments('load'));

  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(PlanView, {
        doc: {
          id: `file:${PATH}`,
          kind: 'file',
          path: PATH,
          title: `${SLUG}.md`,
          sessionId: 's1',
        },
        viewStateId: `file:${PATH}`,
        root: ROOT,
      }),
    );
  });
  await settle(host);
  return host;
}

function saveEl(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('.plan__save');
  if (!el) throw new Error('no .plan__save');
  return el;
}

function writes(): WebviewToHost[] {
  return bus.posted.filter((m) => m.type === 'plan:write');
}

describe('plan save pending-at-keystroke', () => {
  it('a doc-changing transaction marks pending synchronously; data-plan-save follows pending → saving → saved; write fires once 300 ms after the last edit', async () => {
    const container = await mountPlan();
    expect(saveEl(container).getAttribute('data-plan-save')).toBe('saved');
    expect(saveEl(container).textContent).toBe('Saved');

    vi.useFakeTimers();
    await act(async () => {
      const view = capture.ref?.current?.view();
      if (!view) throw new Error('the editor exposed no ProseMirror view');
      const at = endOfChild(view.state.doc, 1);
      view.dispatch(view.state.tr.insertText(' ONE', at));
      view.dispatch(view.state.tr.insertText('TWO', at + 4));
    });

    expect(getPlanState(ROOT, SLUG)?.pendingWrite).toBe(true);
    expect(saveEl(container).getAttribute('data-plan-save')).toBe('pending');
    expect(saveEl(container).textContent).toBe('Saving…');
    expect(writes()).toEqual([]);

    await act(async () => {
      vi.advanceTimersByTime(299);
    });
    expect(writes()).toEqual([]);
    expect(saveEl(container).getAttribute('data-plan-save')).toBe('pending');

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(writes()).toHaveLength(1);
    const write = writes()[0];
    expect(write).toMatchObject({ type: 'plan:write', root: ROOT, slug: SLUG });
    expect(write.type === 'plan:write' && write.markdown).toContain('ONETWO');
    expect(saveEl(container).getAttribute('data-plan-save')).toBe('saving');
    expect(saveEl(container).textContent).toBe('Saving…');

    const markdown = write.type === 'plan:write' ? write.markdown : BODY;
    await act(async () => {
      bus.emit(doc(markdown, 'write-ack'));
    });
    expect(getPlanState(ROOT, SLUG)?.pendingWrite).toBe(false);
    expect(saveEl(container).getAttribute('data-plan-save')).toBe('saved');
    expect(saveEl(container).textContent).toBe('Saved');
    expect(writes()).toHaveLength(1);
  });
});
