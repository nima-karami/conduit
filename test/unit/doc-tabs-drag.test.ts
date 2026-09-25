// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WebviewToHost } from '../../src/protocol';
import { DocTabs } from '../../webview/components/doc-tabs';
import type { OpenDoc } from '../../webview/docs';

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
        docs,
        activeId: null,
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

function dragEvent(type: string, el: HTMLElement, dt: object) {
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
});

describe('DocTabs drag-out', () => {
  it('a file tab stamps DownloadURL and allows copy; reorder still works', async () => {
    await render();
    const { data, dt } = stubDt();
    await act(async () => {
      dragEvent('dragstart', tab('file:/w/a.ts'), dt);
    });
    expect(data.get('DownloadURL')).toBe('application/octet-stream:a.ts:file:///w/a.ts');
    expect(dt.effectAllowed).toBe('copyMove');
    expect(posted).toEqual([{ type: 'fs:armDragDownload', path: '/w/a.ts' }]);
    await act(async () => {
      dragEvent('drop', tab('file:/w/c.ts'), dt);
    });
    expect(onReorder).toHaveBeenCalledWith('file:/w/a.ts', 'file:/w/c.ts');
  });

  it('a diff tab stamps nothing and stays move-only', async () => {
    await render();
    const { data, dt } = stubDt();
    await act(async () => {
      dragEvent('dragstart', tab('diff:/w/b.ts'), dt);
    });
    expect(data.size).toBe(0);
    expect(dt.effectAllowed).toBe('move');
    expect(posted).toEqual([]);
  });
});
