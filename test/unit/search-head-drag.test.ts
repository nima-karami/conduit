// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { folderKey } from '../../src/folder-key';
import type { HostToWebview, WebviewToHost } from '../../src/protocol';
import { SearchPane, type SearchPaneHandle } from '../../webview/components/search-pane';

const listeners = vi.hoisted(() => new Set<(m: HostToWebview) => void>());
const posted = vi.hoisted((): WebviewToHost[] => []);
vi.mock('../../webview/bridge', async (orig) => ({
  ...(await orig<typeof import('../../webview/bridge')>()),
  isHosted: true,
  subscribe: (cb: (m: HostToWebview) => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  post: (m: WebviewToHost) => posted.push(m),
}));

const HOME = '/w/home';
const ABS = `${HOME}/src/a.txt`;
let host: HTMLDivElement;
let root: Root | null = null;

async function renderWithResult() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const paneRef: { current: SearchPaneHandle | null } = { current: null };
  await act(async () => {
    root?.render(
      createElement(SearchPane, {
        folders: [
          {
            path: HOME,
            key: folderKey(HOME),
            kind: 'home',
            missing: false,
            name: 'home',
            label: 'home',
          },
        ],
        onOpenMatch: () => {},
        paneRef,
      }),
    );
  });
  vi.useFakeTimers();
  await act(async () => {
    paneRef.current?.setQuery('needle');
    await vi.runOnlyPendingTimersAsync();
  });
  vi.useRealTimers();
  const req = posted.find(
    (m): m is Extract<WebviewToHost, { type: 'contentSearch' }> => m.type === 'contentSearch',
  );
  if (!req) throw new Error('no contentSearch posted');
  await act(async () => {
    for (const l of [...listeners])
      l({
        type: 'contentSearchResults',
        requestId: req.requestId,
        root: HOME,
        results: [
          { rel: 'src/a.txt', abs: ABS, matches: [{ line: 1, column: 1, lineText: 'needle' }] },
        ],
        truncated: false,
      });
  });
  posted.length = 0;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  listeners.clear();
  posted.length = 0;
});

describe('search result head drag', () => {
  it('drags the file out and to the terminal', async () => {
    await renderWithResult();
    const head = host.querySelector<HTMLElement>('.searchgroup__head');
    if (!head) throw new Error('no result head');
    expect(head.draggable).toBe(true);
    const data = new Map<string, string>();
    const dt = {
      effectAllowed: 'uninitialized',
      setData: (t: string, v: string) => data.set(t, v),
    };
    const ev = new Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    await act(async () => {
      head.dispatchEvent(ev);
    });
    expect(data.get('DownloadURL')).toBe('application/octet-stream:a.txt:file:///w/home/src/a.txt');
    expect(data.get('application/x-conduit-path')).toBe(ABS);
    expect(dt.effectAllowed).toBe('copy');
    expect(posted).toEqual([{ type: 'fs:armDragDownload', path: ABS }]);
  });
});
