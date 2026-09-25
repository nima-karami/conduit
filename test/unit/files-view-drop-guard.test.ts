// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { folderKey } from '../../src/folder-key';
import type { HostToWebview, WebviewToHost } from '../../src/protocol';
import type { MenuState } from '../../webview/components/context-menu';
import { FilesView } from '../../webview/components/files-view';
import { SettingsProvider } from '../../webview/settings';

const listeners = vi.hoisted(() => new Set<(m: HostToWebview) => void>());
const posted = vi.hoisted((): WebviewToHost[] => []);
vi.mock('../../webview/bridge', async (orig) => ({
  ...(await orig<typeof import('../../webview/bridge')>()),
  subscribe: (cb: (m: HostToWebview) => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  post: (m: WebviewToHost) => posted.push(m),
}));

const noop = () => {};
let host: HTMLDivElement;
let root: Root | null = null;

async function render(setMenu: (m: MenuState | null) => void) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const home = '/w/home';
  await act(async () => {
    root?.render(
      createElement(
        SettingsProvider,
        null,
        createElement(FilesView, {
          sessionId: 's1',
          sections: [
            {
              path: home,
              key: folderKey(home),
              kind: 'home',
              missing: false,
              name: 'home',
              label: 'home',
            },
          ],
          rowChanges: new Map(),
          osDropSeam: true,
          folderUi: { treeCache: new Map(), collapsed: new Set<string>() },
          onOpenFile: noop,
          onOpenMatch: noop,
          setMenu,
          revealPath: noop,
          openExternalApp: noop,
          openWithChooser: noop,
          openAsSession: noop,
          copyToClipboard: noop,
          filesPaneRef: { current: null },
          onDelete: noop,
          onRenamed: noop,
          searchPaneRef: { current: null },
        }),
      ),
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
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  listeners.clear();
  posted.length = 0;
});

describe('FilesView OS-drop guard', () => {
  it('a second drop while the first is still probing opens no second menu (review N1)', async () => {
    const menus: MenuState[] = [];
    await render((m) => {
      if (m) menus.push(m);
    });
    const seam = window.__conduitOsDrop;
    if (!seam) throw new Error('seam not installed');
    // isDir unknown (webkitGetAsEntry returned null) is what sends a drop to folder:probe.
    const drop = (p: string) =>
      seam({
        items: [{ path: p, isDir: null as unknown as boolean }],
        targetDir: '/w/home',
        x: 10,
        y: 10,
      });
    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();
    await act(async () => {
      first = drop('/x/one');
      second = drop('/x/two');
    });
    const probes = posted.filter(
      (m): m is Extract<WebviewToHost, { type: 'folder:probe' }> => m.type === 'folder:probe',
    );
    await act(async () => {
      for (const p of probes) {
        for (const l of listeners) {
          l({
            type: 'folder:probeResult',
            requestId: p.requestId,
            results: p.paths.map((path) => ({ path, exists: true })),
          } as HostToWebview);
        }
      }
      await Promise.all([first, second]);
    });
    expect(menus).toHaveLength(1);
    expect(probes).toHaveLength(1);
  });
});
