// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileContentDTO, HostToWebview, WebviewToHost } from '../../src/protocol';
import { MACHINES_STR } from '../../webview/machines-strings';
import type { RemoteFileDoc } from '../../webview/remote-files-store';

const h = vi.hoisted(() => ({
  posted: [] as WebviewToHost[],
  listeners: new Set<(m: HostToWebview) => void>(),
}));

vi.mock('../../webview/bridge', () => ({
  post: (m: WebviewToHost) => h.posted.push(m),
  subscribe: (cb: (m: HostToWebview) => void) => {
    h.listeners.add(cb);
    return () => h.listeners.delete(cb);
  },
}));

// The viewers are Monaco and pdf.js: this test is about what the tab reads and shows, and the
// viewers are covered on their own. The stub records the source it was handed.
vi.mock('../../webview/components/code-viewer', () => ({
  CodeViewer: ({ doc, source }: { doc: FileContentDTO; source?: { machineName: string } }) =>
    createElement('pre', { 'data-source': source?.machineName ?? 'local' }, doc.content),
}));
vi.mock('../../webview/components/pdf-viewer', () => ({
  PdfViewer: () => createElement('div', null, 'pdf'),
}));

import { RemoteDocView } from '../../webview/components/remote-doc-view';

const emit = (m: HostToWebview) => {
  for (const l of [...h.listeners]) l(m);
};

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

const docFor = (path: string): RemoteFileDoc => ({
  id: `remote-file@M1:${path}`,
  kind: 'remote-file',
  path,
  title: 'a.txt',
  sessionId: 'remote:M1:S1',
  machine: { machineId: 'M1', sessionId: 'S1' },
});

const reads = () => h.posted.flatMap((m) => (m.type === 'remoteFs:read' ? [m] : []));
const unwatches = () => h.posted.filter((m) => m.type === 'remoteFs:unwatch');

/** Answer the newest read of `path` with `result`. */
function answerRead(
  path: string,
  result: { ok: true; text: string } | { ok: false; error: string },
) {
  const req = reads()
    .reverse()
    .find((m) => m.path === path);
  if (!req) throw new Error(`no read for ${path}`);
  emit({
    type: 'remoteFs:content',
    requestId: req.requestId,
    result: result.ok
      ? {
          ok: true,
          file: {
            path,
            content: result.text,
            language: 'plaintext',
            truncated: false,
            binary: false,
          },
        }
      : { ok: false, error: result.error },
  });
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  h.posted.length = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  h.listeners.clear();
});

describe('RemoteDocView', () => {
  it('loads the remote doc on mount and releases on unmount', async () => {
    const path = '/srv/app/loads.ts';
    const doc = docFor(path);
    await act(async () => {
      root?.render(createElement(RemoteDocView, { doc, machineName: 'build-box' }));
    });

    expect(host?.textContent).toBe(MACHINES_STR.filesLoading);
    expect(reads().map((m) => m.path)).toEqual([path]);
    expect(h.posted.some((m) => m.type === 'remoteFs:watch')).toBe(true);

    await act(async () => answerRead(path, { ok: true, text: 'export {};' }));
    await flush();
    expect(host?.textContent).toBe('export {};');
    expect(host?.querySelector('pre')?.dataset.source).toBe('build-box');

    await act(async () => {
      root?.unmount();
    });
    root = null;
    expect(unwatches()).toHaveLength(1);
  });

  it('shows the error text for a refused read', async () => {
    const path = '/srv/app/secret.env';
    await act(async () => {
      root?.render(createElement(RemoteDocView, { doc: docFor(path), machineName: 'build-box' }));
    });

    await act(async () => answerRead(path, { ok: false, error: 'refused' }));
    await flush();
    expect(host?.textContent).toBe(MACHINES_STR.fileError('refused'));
    expect(host?.querySelector('pre')).toBeNull();
  });
});
