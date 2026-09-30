// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WebviewToHost } from '../../src/protocol';
import { DocTabs } from '../../webview/components/doc-tabs';
import type { OpenDoc } from '../../webview/docs';
import { currentTabDrag, endTabDrag, TAB_DRAG_MIME } from '../../webview/tab-drag';

const posted = vi.hoisted((): WebviewToHost[] => []);
vi.mock('../../webview/bridge', async (orig) => ({
  ...(await orig<typeof import('../../webview/bridge')>()),
  isHosted: true,
  post: (m: WebviewToHost) => posted.push(m),
}));

const docs: OpenDoc[] = [
  { id: 'file:/w/a.ts', kind: 'file', path: '/w/a.ts', title: 'a.ts', sessionId: 'S' },
  { id: 'diff:/w/b.ts', kind: 'diff', path: '/w/b.ts', title: 'b.ts', sessionId: 'S' },
  { id: 'file:/w/c.ts', kind: 'file', path: '/w/c.ts', title: 'c.ts', sessionId: 'S' },
  { id: 'web:https://x.test/', kind: 'web', path: 'https://x.test/', title: 'x', sessionId: 'S' },
];
const onReorder = vi.fn();
let host: HTMLDivElement;
let root: Root | null = null;

async function render() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(DocTabs, {
        group: 1,
        groupActive: true,
        showTerminal: true,
        split: { disabledReason: null, onSplit: () => {} },
        docs,
        activeId: null,
        previewIds: new Set<string>(),
        terminalLabel: 'Terminal',
        terminalIcon: { type: 'lucide', name: 'terminal' },
        onSelect: () => {},
        onClose: () => {},
        onReorder,
      }),
    );
  });
}

const tab = (id: string) => {
  const el = host.querySelector<HTMLElement>(`[data-tabid="${id}"]`);
  if (!el) throw new Error(`no tab ${id}`);
  return el;
};

function dragEvent(type: string, el: EventTarget, dt: object | null) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: dt });
  el.dispatchEvent(ev);
}

function stubDt() {
  const data = new Map<string, string>();
  return {
    data,
    dt: {
      effectAllowed: 'uninitialized',
      dropEffect: 'none',
      setData: (t: string, v: string) => data.set(t, v),
      get types() {
        return [...data.keys()];
      },
    },
  };
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
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  posted.length = 0;
  onReorder.mockReset();
  endTabDrag();
});

describe('DocTabs drag-out', () => {
  it('a file tab stamps DownloadURL and allows copy; reorder still works', async () => {
    await render();
    const { data, dt } = stubDt();
    await act(async () => {
      dragEvent('dragstart', tab('file:/w/a.ts'), dt);
    });
    expect(data.get('DownloadURL')).toBe('application/octet-stream:a.ts:file:///w/a.ts');
    expect(data.get(TAB_DRAG_MIME)).toBe('file:/w/a.ts');
    expect(dt.effectAllowed).toBe('copyMove');
    expect(posted).toEqual([{ type: 'fs:armDragDownload', path: '/w/a.ts' }]);
    await act(async () => {
      dragEvent('drop', tab('file:/w/c.ts'), dt);
    });
    expect(onReorder).toHaveBeenCalledWith('file:/w/a.ts', 'file:/w/c.ts');
  });

  it('a diff tab stamps only the private tab type and allows the Ctrl duplicate', async () => {
    await render();
    const { data, dt } = stubDt();
    await act(async () => {
      dragEvent('dragstart', tab('diff:/w/b.ts'), dt);
    });
    expect([...data.keys()]).toEqual([TAB_DRAG_MIME]);
    expect(dt.effectAllowed).toBe('copyMove');
    expect(posted).toEqual([]);
  });

  it('a web tab is move-only', async () => {
    await render();
    const { dt } = stubDt();
    await act(async () => {
      dragEvent('dragstart', tab('web:https://x.test/'), dt);
    });
    expect(dt.effectAllowed).toBe('move');
  });
});

describe('DocTabs drop gating', () => {
  it('a drag without the private tab type is never a tab move, even mid tab drag', async () => {
    await render();
    const { dt } = stubDt();
    await act(async () => {
      dragEvent('dragstart', tab('file:/w/a.ts'), dt);
    });
    const osFile = { effectAllowed: 'copy', dropEffect: 'none', types: ['Files'] };
    await act(async () => {
      dragEvent('drop', tab('file:/w/c.ts'), osFile);
    });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it.each(['dragend', 'drop'])('a window %s ends the tab drag', async (type) => {
    await render();
    const { dt } = stubDt();
    await act(async () => {
      dragEvent('dragstart', tab('file:/w/a.ts'), dt);
    });
    expect(currentTabDrag()).not.toBeNull();
    await act(async () => {
      dragEvent(type, window, null);
    });
    expect(currentTabDrag()).toBeNull();
  });
});
