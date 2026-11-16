// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostToWebview, WebviewToHost } from '../../src/protocol';
import type { OpenDoc } from '../../webview/docs';

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

import { getRemoteFile, loadRemoteDoc, useRemoteFile } from '../../webview/remote-files-store';

const emit = (m: HostToWebview) => {
  for (const l of [...h.listeners]) l(m);
};

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

const docFor = (path: string): OpenDoc => ({
  id: `remote-file@M1:${path}`,
  kind: 'remote-file',
  path,
  title: 'a.txt',
  sessionId: 'remote:M1:S1',
  machine: { machineId: 'M1', sessionId: 'S1' },
});

const reads = () => h.posted.flatMap((m) => (m.type === 'remoteFs:read' ? [m] : []));
const unwatches = () => h.posted.filter((m) => m.type === 'remoteFs:unwatch');

/** Answer the newest read request with `text`. */
function answerRead(path: string, text: string) {
  const req = reads()
    .reverse()
    .find((m) => m.path === path);
  if (!req) throw new Error(`no read for ${path}`);
  emit({
    type: 'remoteFs:content',
    requestId: req.requestId,
    result: {
      ok: true,
      file: { path, content: text, language: 'plaintext', truncated: false, binary: false },
    },
  });
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function Probe({ id }: { id: string }) {
  const file = useRemoteFile(id);
  return createElement('pre', null, file ? file.content : 'none');
}

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

describe('loadRemoteDoc and useRemoteFile', () => {
  it('loads, re-reads on change, and a second owner keeps it alive after the first releases', async () => {
    const path = '/home/me/p/owner.txt';
    const doc = docFor(path);
    const id = doc.id;
    await act(async () => {
      root?.render(createElement(Probe, { id }));
    });

    const first = loadRemoteDoc(doc);
    expect(reads()).toHaveLength(1);
    await act(async () => answerRead(path, 'v1'));
    await flush();
    expect(host?.textContent).toBe('v1');

    const watch = h.posted.find((m) => m.type === 'remoteFs:watch');
    if (watch?.type !== 'remoteFs:watch') throw new Error('no watch posted');
    await act(async () => {
      emit({ type: 'remoteFs:changed', key: watch.key, paths: [path] });
    });
    expect(reads()).toHaveLength(2);
    await act(async () => answerRead(path, 'v2'));
    await flush();
    expect(host?.textContent).toBe('v2');

    // A second mount of the same doc shares the read: no new request, no new watch.
    const second = loadRemoteDoc(doc);
    expect(reads()).toHaveLength(2);
    expect(h.posted.filter((m) => m.type === 'remoteFs:watch')).toHaveLength(1);

    first();
    first();
    expect(unwatches()).toEqual([]);
    await act(async () => {
      emit({ type: 'remoteFs:changed', key: watch.key, paths: [path] });
    });
    expect(reads()).toHaveLength(3);
    await act(async () => answerRead(path, 'v3'));
    await flush();
    expect(host?.textContent).toBe('v3');

    second();
    expect(unwatches()).toEqual([{ type: 'remoteFs:unwatch', key: watch.key }]);
    await flush();
    expect(host?.textContent).toBe('none');
  });

  it('a failed read is the doc error, not content', async () => {
    const path = '/home/me/p/denied.env';
    const doc = docFor(path);
    const release = loadRemoteDoc(doc);
    const req = reads()[0];
    if (!req) throw new Error('no read posted');
    emit({
      type: 'remoteFs:content',
      requestId: req.requestId,
      result: { ok: false, error: 'refused' },
    });
    await flush();
    expect(getRemoteFile(doc.id)).toMatchObject({ error: 'refused', content: '' });
    release();
  });
});
