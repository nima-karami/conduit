// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FileDiffDTO } from '../../src/protocol';
import type { OpenDoc } from '../../webview/docs';

// The host answers are held here, so a test decides which answer lands first.
const h = vi.hoisted(() => ({
  calls: [] as {
    root: string;
    op: string;
    args: unknown;
    resolve: (r: unknown) => void;
  }[],
  watches: new Map<string, (paths: string[]) => void>(),
  released: [] as string[],
}));

vi.mock('../../webview/remote-git-store', () => ({
  remoteGit: (_machineId: string, _sessionId: string, root: string, op: string, args: unknown) =>
    new Promise((resolve) => {
      h.calls.push({ root, op, args, resolve });
    }),
}));

vi.mock('../../webview/remote-files-store', () => ({
  watchRemote: (key: string, _m: string, _s: string, _path: string, cb: (p: string[]) => void) => {
    h.watches.set(key, cb);
    return () => {
      h.released.push(key);
      h.watches.delete(key);
    };
  },
}));

// The real DiffViewer is Monaco; the view's contract is what it is handed.
vi.mock('../../webview/components/diff-viewer', async () => {
  const { createElement: el } = await import('react');
  return {
    DiffViewer: ({ doc }: { doc: { path: string; work: string } }) =>
      el('pre', { 'data-testid': 'diff' }, `${doc.path}:${doc.work}`),
  };
});

import { RemoteDiffView } from '../../webview/components/remote-diff-view';
import { MACHINES_STR } from '../../webview/machines-strings';

const REPO = '/home/me/proj';
const PATH = '/home/me/proj/src/a.ts';
const DOC_ID = `remote-diff@M1:${PATH}`;
const DOC: OpenDoc = {
  id: DOC_ID,
  kind: 'remote-diff',
  path: PATH,
  title: 'a.ts',
  sessionId: 'remote:M1:S1',
  repoRoot: REPO,
  machine: { machineId: 'M1', sessionId: 'S1' },
};

const file = (work: string): FileDiffDTO => ({
  path: 'src/a.ts',
  head: 'old',
  work,
  binary: false,
});
const ok = (work: string) => ({ ok: true, value: { op: 'diff', file: file(work) } });

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const mounted: { root: Root; host: HTMLDivElement }[] = [];

async function mount(doc: OpenDoc = DOC): Promise<HTMLDivElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => {
    root.render(createElement(RemoteDiffView, { doc, machineName: 'box' }));
  });
  return host;
}

async function answer(i: number, result: unknown): Promise<void> {
  await act(async () => {
    h.calls[i]?.resolve(result);
  });
}

async function fire(key: string): Promise<void> {
  await act(async () => {
    h.watches.get(key)?.([PATH]);
  });
}

const shown = (host: HTMLElement) => host.textContent ?? '';

afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
  h.calls.length = 0;
  h.watches.clear();
  h.released.length = 0;
});

describe('RemoteDiffView', () => {
  it('asks B for the diff of the file in its repo and shows the file it answers with', async () => {
    const host = await mount();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ root: REPO, op: 'diff', args: { path: PATH } });
    expect(shown(host)).toBe(MACHINES_STR.diffLoading);

    await answer(0, ok('new text'));
    expect(host.querySelector('[data-testid="diff"]')?.textContent).toBe(`src/a.ts:new text`);
  });

  it('asks again when B reports the file changed, and keeps the last answer until the new one lands', async () => {
    const host = await mount();
    await answer(0, ok('v1'));
    expect(h.watches.has(`diff|${DOC_ID}`)).toBe(true);

    await fire(`diff|${DOC_ID}`);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toMatchObject({ root: REPO, op: 'diff', args: { path: PATH } });
    expect(host.querySelector('[data-testid="diff"]')?.textContent).toBe('src/a.ts:v1');

    await answer(1, ok('v2'));
    expect(host.querySelector('[data-testid="diff"]')?.textContent).toBe('src/a.ts:v2');
  });

  it('a stale answer, arriving after a newer one, never replaces it', async () => {
    const host = await mount();
    await answer(0, ok('v1'));
    await fire(`diff|${DOC_ID}`);
    await fire(`diff|${DOC_ID}`);
    expect(h.calls).toHaveLength(3);

    await answer(2, ok('newest'));
    expect(host.querySelector('[data-testid="diff"]')?.textContent).toBe('src/a.ts:newest');
    // The older request answers last; it must not overwrite what the newer one showed.
    await answer(1, ok('older'));
    expect(host.querySelector('[data-testid="diff"]')?.textContent).toBe('src/a.ts:newest');
  });

  it('shows the refused copy when B refuses the diff', async () => {
    const host = await mount();
    await answer(0, { ok: false, error: 'refused' });
    expect(shown(host)).toBe(MACHINES_STR.gitError('refused', 'box'));
    expect(host.querySelector('[data-testid="diff"]')).toBeNull();
  });

  it('releases its watch on unmount', async () => {
    const host = await mount();
    await answer(0, ok('v1'));
    const root = mounted[0]?.root;
    await act(async () => root?.unmount());
    mounted.splice(0);
    host.remove();
    expect(h.released).toEqual([`diff|${DOC_ID}`]);
  });

  it('names the missing target instead of asking when the doc has no machine', async () => {
    const host = await mount({ ...DOC, machine: undefined });
    expect(h.calls).toHaveLength(0);
    expect(shown(host)).toBe(MACHINES_STR.gitNoTarget);
  });
});
