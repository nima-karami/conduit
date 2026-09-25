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
      { name: 'docs', kind: 'dir' },
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

/** jsdom has no DataTransfer; React reads the native event's. */
function dragStart(el: HTMLElement) {
  const data = new Map<string, string>();
  const dt = {
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
    setData: (t: string, v: string) => data.set(t, v),
    getData: (t: string) => data.get(t) ?? '',
    get types() {
      return [...data.keys()];
    },
  };
  const ev = new Event('dragstart', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: dt });
  el.dispatchEvent(ev);
  return { ev, data };
}

const armed = () =>
  posted.filter(
    (m): m is Extract<WebviewToHost, { type: 'fs:armDragDownload' }> =>
      m.type === 'fs:armDragDownload',
  );

describe('FilesView drag-out (S0 outcome B: DownloadURL)', () => {
  it('a file row stamps DownloadURL, arms the host, and keeps the HTML5 drag', async () => {
    await render();
    const a = `${HOME}/a.txt`;
    let r: ReturnType<typeof dragStart> | undefined;
    await act(async () => {
      r = dragStart(row(a));
    });
    expect(r?.data.get('DownloadURL')).toBe('application/octet-stream:a.txt:file:///w/home/a.txt');
    expect(r?.ev.defaultPrevented).toBe(false);
    expect(armed()).toEqual([{ type: 'fs:armDragDownload', path: a }]);
    expect(r?.data.get('text/plain')).toBe(a);
    expect(r?.data.get('application/x-conduit-path')).toBe(a);
  });

  it('a folder row carries no DownloadURL and arms nothing', async () => {
    await render();
    let r: ReturnType<typeof dragStart> | undefined;
    await act(async () => {
      r = dragStart(row(`${HOME}/docs`));
    });
    expect(r?.data.has('DownloadURL')).toBe(false);
    expect(armed()).toEqual([]);
    expect(r?.data.get('text/plain')).toBe(`${HOME}/docs`);
  });

  it('a multi-selection sends only one file: the grabbed row', async () => {
    await render();
    const a = `${HOME}/a.txt`;
    const b = `${HOME}/b.txt`;
    await act(async () => {
      row(a).click();
      row(b).dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    });
    let r: ReturnType<typeof dragStart> | undefined;
    await act(async () => {
      r = dragStart(row(b));
    });
    expect(r?.data.get('DownloadURL')).toBe('application/octet-stream:b.txt:file:///w/home/b.txt');
    expect(armed()).toEqual([{ type: 'fs:armDragDownload', path: b }]);
    expect(r?.data.get('text/plain')?.split('\n').sort()).toEqual([a, b]);
  });

  it('grabbing a selected folder sends the selection’s first file', async () => {
    await render();
    const a = `${HOME}/a.txt`;
    const docs = `${HOME}/docs`;
    await act(async () => {
      row(docs).click();
      row(a).dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    });
    let r: ReturnType<typeof dragStart> | undefined;
    await act(async () => {
      r = dragStart(row(docs));
    });
    expect(armed()).toEqual([{ type: 'fs:armDragDownload', path: a }]);
    expect(r?.data.get('DownloadURL')).toBe('application/octet-stream:a.txt:file:///w/home/a.txt');
  });
});
