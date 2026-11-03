// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { canonicalPath } from '../../src/canonical-path';
import { folderKey } from '../../src/folder-key';
import type { HostToWebview, WebviewToHost } from '../../src/protocol';
import { activeTarget } from '../../webview/active-target';
import { FilesView, type FilesViewHandle } from '../../webview/components/files-view';
import type { TreeNode } from '../../webview/file-tree';
import { SettingsProvider } from '../../webview/settings';

const listeners = vi.hoisted(() => new Set<(m: HostToWebview) => void>());
const posted = vi.hoisted(() => [] as WebviewToHost[]);
vi.mock('../../webview/bridge', async (orig) => ({
  ...(await orig<typeof import('../../webview/bridge')>()),
  subscribe: (cb: (m: HostToWebview) => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  post: (m: WebviewToHost) => posted.push(m),
}));

const noop = () => {};
let root: Root | null = null;
const pane = { current: null as FilesViewHandle | null };
const home = 'D:\\work\\conduit';
const path = `${home}/webview/components/right-pane.tsx`;
let open: () => void;
let showSections: () => void;

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
  HTMLElement.prototype.scrollIntoView = noop;
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  listeners.clear();
  posted.length = 0;
});

async function reply(dir: string, name: string, kind: 'dir' | 'file') {
  await act(async () => {
    for (const l of listeners) l({ type: 'dirEntries', path: dir, entries: [{ name, kind }] });
  });
}

const cases = [false, true].flatMap((delayed) =>
  [false, true].flatMap((cached) =>
    [false, true].map((caseVariant) => ({ delayed, cached, caseVariant })),
  ),
);

it.each(cases)('reveals a search hit: %j', async ({ delayed, cached, caseVariant }) => {
  const folderUi = {
    treeCache: new Map<string, TreeNode[]>(
      cached
        ? [
            [
              folderKey(home),
              [
                {
                  name: 'webview',
                  path: `${home}/webview`,
                  kind: 'dir',
                  expanded: false,
                  children: [
                    {
                      name: 'components',
                      path: `${home}/webview/components`,
                      kind: 'dir',
                      expanded: false,
                    },
                  ],
                },
              ],
            ],
          ]
        : [],
    ),
    collapsed: new Set([folderKey(home)]),
  };
  function Harness() {
    const [target, setTarget] = useState<ReturnType<typeof activeTarget>>(null);
    const [ready, setReady] = useState(!delayed);
    showSections = () => setReady(true);
    open = () => {
      const targetPath = canonicalPath(caseVariant ? path.replace('webview', 'WEBVIEW') : path);
      setTarget(activeTarget({ kind: 'file', path: targetPath }, 'editor'));
      pane.current?.revealInTree(targetPath);
    };
    return createElement(FilesView, {
      sessionId: 's',
      sections: ready
        ? [
            {
              path: home,
              key: folderKey(home),
              name: 'conduit',
              label: 'conduit',
              kind: 'home',
              missing: false,
            },
          ]
        : [],
      folderUi,
      activeTarget: target,
      rowChanges: new Map(),
      osDropSeam: false,
      filesPaneRef: pane,
      searchPaneRef: { current: null },
      onOpenFile: noop,
      onOpenMatch: noop,
      setMenu: noop,
      revealPath: noop,
      openExternalApp: noop,
      openWithChooser: noop,
      openAsSession: noop,
      copyToClipboard: noop,
      onDelete: noop,
      onRenamed: noop,
    });
  }
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(createElement(SettingsProvider, null, createElement(Harness))),
  );
  if (!delayed) await reply(home, 'webview', 'dir');
  await act(async () => open());
  if (delayed) {
    await act(async () => showSections());
    await reply(home, 'webview', 'dir');
  }
  expect(folderUi.collapsed.size).toBe(0);
  await reply(`${home}/webview`, 'components', 'dir');
  await reply(`${home}/webview/components`, 'right-pane.tsx', 'file');
  expect(host.querySelector('.filerow--revealed')?.getAttribute('data-path')).toBe(path);
  if (!cached) expect(posted).toContainEqual({ type: 'readDir', path: `${home}/webview` });
  expect(posted).toContainEqual({ type: 'readDir', path: `${home}/webview/components` });
});
