// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WebviewToHost } from '../../src/protocol';
import { DocTabs } from '../../webview/components/doc-tabs';
import { updateDirty } from '../../webview/dirty-store';
import type { OpenDoc } from '../../webview/docs';

vi.mock('../../webview/bridge', async (orig) => ({
  ...(await orig<typeof import('../../webview/bridge')>()),
  isHosted: true,
  post: (_m: WebviewToHost) => {},
}));

const PATH = '/w/a.ts';
const localDoc: OpenDoc = {
  id: `file:${PATH}`,
  kind: 'file',
  path: PATH,
  title: 'local a.ts',
  sessionId: 'S',
};
const remoteDoc: OpenDoc = {
  id: `remote-file@M1:${PATH}`,
  kind: 'remote-file',
  path: PATH,
  title: 'remote a.ts',
  sessionId: 'remote:M1:S1',
  machine: { machineId: 'M1', sessionId: 'S1' },
};

let host: HTMLDivElement;
let root: Root | null = null;

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
  host?.remove();
  updateDirty(PATH, 'same', 'same');
});

async function render(docs: OpenDoc[]) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(DocTabs, {
        group: 1,
        groupActive: true,
        showTerminal: false,
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

/** The tab strip's tab for a doc, found by its title. */
function tabFor(title: string): Element | undefined {
  return [...host.querySelectorAll('.tab')].find((t) => t.textContent?.includes(title));
}

describe('DocTabs with a remote tab on a dirty local path', () => {
  it('a remote tab with the same path as a dirty local file shows no dirty dot', async () => {
    updateDirty(PATH, 'saved', 'edited');
    await render([localDoc, remoteDoc]);

    expect(tabFor('local a.ts')?.querySelector('.tab__dirty')).not.toBeNull();
    expect(tabFor('local a.ts')?.classList.contains('tab--dirty')).toBe(true);
    expect(tabFor('remote a.ts')?.querySelector('.tab__dirty')).toBeNull();
    expect(tabFor('remote a.ts')?.classList.contains('tab--dirty')).toBe(false);
  });
});
