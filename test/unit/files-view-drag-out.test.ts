// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { folderKey } from '../../src/folder-key';
import type { HostToWebview, WebviewToHost } from '../../src/protocol';
import { FilesView } from '../../webview/components/files-view';
import { SettingsProvider } from '../../webview/settings';

const listeners = vi.hoisted(() => new Set<(m: HostToWebview) => void>());
const posted = vi.hoisted((): WebviewToHost[] => []);
vi.hoisted(() => {
  Object.defineProperty(globalThis.navigator, 'platform', {
    value: 'Win32',
    configurable: true,
  });
});
vi.mock('../../webview/bridge', async (orig) => ({
  ...(await orig<typeof import('../../webview/bridge')>()),
  isHosted: true,
  subscribe: (cb: (m: HostToWebview) => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  post: (m: WebviewToHost) => posted.push(m),
}));

const noop = () => {};
const HOME = '/w/home';
let host: HTMLDivElement;
let root: Root | null = null;

const emit = (m: HostToWebview) =>
  act(async () => {
    for (const l of [...listeners]) l(m);
  });

async function render() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(
        SettingsProvider,
        null,
        createElement(FilesView, {
          sessionId: 's1',
          sections: [
            {
              path: HOME,
              key: folderKey(HOME),
              kind: 'home',
              missing: false,
              name: 'home',
              label: 'home',
            },
          ],
          rowChanges: new Map(),
          osDropSeam: false,
          folderUi: { treeCache: new Map(), collapsed: new Set<string>() },
          onOpenFile: noop,
          onOpenMatch: noop,
          setMenu: noop,
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
  await emit({
    type: 'dirEntries',
    path: HOME,
    entries: [
      { name: 'a.txt', kind: 'file' },
      { name: 'b.txt', kind: 'file' },
    ],
  });
}

function row(path: string): HTMLElement {
  const el = host.querySelector<HTMLElement>(`[data-path="${path}"]`);
  if (!el) throw new Error(`no row for ${path}`);
  return el;
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

describe('FilesView OS clipboard copy', () => {
  it('Ctrl+C posts fs:copyToOsClipboard and announces before any reply', async () => {
    await render();
    const a = `${HOME}/a.txt`;
    await act(async () => {
      row(a).click();
    });
    const tree = host.querySelector<HTMLElement>('[role="tree"]');
    if (!tree) throw new Error('no tree');
    await act(async () => {
      tree.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });
    const sent = posted.filter(
      (m): m is Extract<WebviewToHost, { type: 'fs:copyToOsClipboard' }> =>
        m.type === 'fs:copyToOsClipboard',
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ sessionId: 's1', paths: [a] });
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Copied 1 item');
  });

  it('Ctrl+C under Caps Lock (key "C") still copies', async () => {
    await render();
    const a = `${HOME}/a.txt`;
    await act(async () => {
      row(a).click();
    });
    await act(async () => {
      host.querySelector('[role="tree"]')?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'C',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(posted.filter((m) => m.type === 'fs:copyToOsClipboard')).toHaveLength(1);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Copied 1 item');
  });

  it('Ctrl+Shift+C is not Copy', async () => {
    await render();
    await act(async () => {
      row(`${HOME}/a.txt`).click();
    });
    await act(async () => {
      host.querySelector('[role="tree"]')?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'C',
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(posted.some((m) => m.type === 'fs:copyToOsClipboard')).toBe(false);
  });

  it('Cut never writes the OS clipboard (D5)', async () => {
    await render();
    await act(async () => {
      row(`${HOME}/a.txt`).click();
    });
    await act(async () => {
      host.querySelector('[role="tree"]')?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'x',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Cut 1 item');
    expect(posted.some((m) => m.type === 'fs:copyToOsClipboard')).toBe(false);
  });
});
