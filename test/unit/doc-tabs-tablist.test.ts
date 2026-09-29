// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WebviewToHost } from '../../src/protocol';
import { DocTabs } from '../../webview/components/doc-tabs';
import type { OpenDoc } from '../../webview/docs';

vi.mock('../../webview/bridge', async (orig) => ({
  ...(await orig<typeof import('../../webview/bridge')>()),
  isHosted: true,
  post: (_m: WebviewToHost) => {},
}));

const docs: OpenDoc[] = [
  { id: 'file:/w/a.ts', kind: 'file', path: '/w/a.ts', title: 'a.ts', sessionId: 'S' },
  { id: 'file:/w/b.ts', kind: 'file', path: '/w/b.ts', title: 'b.ts', sessionId: 'S' },
];
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
        onReorder: () => {},
      }),
    );
  });
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
});

// see split-editor spec §9 (amended in the review round)
describe('DocTabs tablist', () => {
  it('owns only the doc tabs; the Terminal is a plain button beside it in the strip', async () => {
    await render();
    const tablist = host.querySelector('[role="tablist"]');
    expect(tablist?.getAttribute('aria-label')).toBe('Left editor group tabs');
    const terminal = host.querySelector('[data-tabid="__terminal__"]');
    expect(terminal?.tagName).toBe('BUTTON');
    expect(terminal?.getAttribute('role')).toBeNull();
    expect(tablist?.contains(terminal ?? null)).toBe(false);
    expect(terminal?.parentElement?.classList.contains('tabbar')).toBe(true);
    expect(
      [...(tablist?.querySelectorAll('[data-tabid]') ?? [])].map((e) => e.getAttribute('role')),
    ).toEqual(['tab', 'tab']);
  });
});
