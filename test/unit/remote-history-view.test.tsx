// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CommitNode, FileDiffDTO } from '../../src/protocol';
import type { OpenDoc } from '../../webview/docs';

// The host answers are held here, so a test decides when each one lands.
const h = vi.hoisted(() => ({
  calls: [] as {
    op: string;
    args: unknown;
    resolve: (r: unknown) => void;
  }[],
}));

vi.mock('../../webview/remote-git-store', () => ({
  remoteGit: (_machineId: string, _sessionId: string, _root: string, op: string, args: unknown) =>
    new Promise((resolve) => {
      h.calls.push({ op, args, resolve });
    }),
}));

// The real DiffViewer is Monaco; the view's contract is which file it is handed.
vi.mock('../../webview/components/diff-viewer', async () => {
  const { createElement: el } = await import('react');
  return {
    DiffViewer: ({ doc }: { doc: { path: string } }) =>
      el('pre', { 'data-testid': 'diff' }, doc.path),
  };
});

import { RemoteHistoryView } from '../../webview/components/remote-history-view';
import { MACHINES_STR } from '../../webview/machines-strings';

const REPO = '/home/me/proj';
const DOC: OpenDoc = {
  id: `remote-history@M1:${REPO}`,
  kind: 'remote-history',
  path: REPO,
  title: 'proj history',
  sessionId: 'remote:M1:S1',
  machine: { machineId: 'M1', sessionId: 'S1' },
};

const SHA = (n: number) => n.toString(16).padStart(40, '0');
const commit = (n: number, subject = `commit ${n}`): CommitNode => ({
  sha: SHA(n),
  parents: [],
  refs: [],
  author: 'Ann',
  date: 1_700_000_000 - n,
  subject,
});
const layout = { rows: [], edges: [], laneCount: 0 };
const log = (commits: CommitNode[], hasMore: boolean, state: 'ok' | 'empty' | 'error' = 'ok') => ({
  ok: true,
  value: { op: 'log', commits, layout, hasMore, state },
});
const file = (path: string, counts?: { added: number; removed: number }): FileDiffDTO => ({
  path,
  head: '',
  work: '',
  binary: false,
  ...(counts ? { counts } : {}),
});
const show = (files: FileDiffDTO[], truncated = false) => ({
  ok: true,
  value: { op: 'show', files, truncated },
});

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const mounted: { root: Root; host: HTMLDivElement }[] = [];

async function mount(): Promise<HTMLDivElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => {
    root.render(createElement(RemoteHistoryView, { doc: DOC, machineName: 'box' }));
  });
  return host;
}

async function answer(i: number, result: unknown): Promise<void> {
  await act(async () => {
    h.calls[i]?.resolve(result);
  });
}

async function click(el: Element | null | undefined): Promise<void> {
  await act(async () => {
    (el as HTMLElement | null | undefined)?.click();
  });
}

const rows = (host: HTMLElement) => [
  ...host.querySelectorAll<HTMLButtonElement>('.remote-history__commit'),
];
const diffPath = (host: HTMLElement) => host.querySelector('[data-testid="diff"]')?.textContent;
const findButton = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label);

afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
  h.calls.length = 0;
});

describe('RemoteHistoryView', () => {
  it('lists B’s commits newest first, each row a button, and asks for the first page', async () => {
    const host = await mount();
    expect(h.calls[0]).toMatchObject({ op: 'log', args: { limit: 100 } });

    await answer(0, log([commit(1, 'add parser'), commit(2, 'first')], false));
    const items = rows(host);
    expect(items).toHaveLength(2);
    expect(items.every((b) => b.tagName === 'BUTTON')).toBe(true);
    expect(items[0]?.querySelector('.remote-history__sha')?.textContent).toBe(SHA(1).slice(0, 7));
    expect(items[0]?.textContent).toContain('add parser');
    expect(items[1]?.textContent).toContain('first');
    expect(host.querySelector('.remote-history__more')).toBeNull();
  });

  it('Load more asks for the page before the last sha and appends it', async () => {
    const host = await mount();
    await answer(0, log([commit(1), commit(2)], true));
    expect(rows(host)).toHaveLength(2);

    await click(findButton(host, MACHINES_STR.historyLoadMore));
    expect(h.calls[1]).toMatchObject({ op: 'log', args: { limit: 100, before: SHA(2) } });
    await answer(1, log([commit(3)], false));

    expect(rows(host)).toHaveLength(3);
    expect(rows(host)[2]?.textContent).toContain('commit 3');
    expect(findButton(host, MACHINES_STR.historyLoadMore)).toBeUndefined();
  });

  it('shows the Load more button only while B says there is more', async () => {
    const host = await mount();
    await answer(0, log([commit(1)], false));
    expect(findButton(host, MACHINES_STR.historyLoadMore)).toBeUndefined();
    expect(h.calls).toHaveLength(1);
  });

  it('clicking a commit asks for its show and renders the first file in the diff', async () => {
    const host = await mount();
    await answer(0, log([commit(1), commit(2)], false));

    await click(rows(host)[0]);
    expect(h.calls[1]).toMatchObject({ op: 'show', args: { sha: SHA(1) } });
    await answer(1, show([file('src/a.ts', { added: 2, removed: 1 }), file('README.md')]));

    expect(diffPath(host)).toBe('src/a.ts');
    expect(host.textContent).toContain('+2');
    expect(host.textContent).toContain('−1');
  });

  it('clicking a second file switches the diff to it', async () => {
    const host = await mount();
    await answer(0, log([commit(1)], false));
    await click(rows(host)[0]);
    await answer(1, show([file('src/a.ts'), file('README.md')]));
    expect(diffPath(host)).toBe('src/a.ts');

    const fileRows = [...host.querySelectorAll<HTMLButtonElement>('.remote-history__file-row')];
    await click(fileRows[1]);
    expect(diffPath(host)).toBe('README.md');
    expect(fileRows[1]?.getAttribute('aria-current')).toBe('true');
  });

  it('a truncated commit shows the note that only part of it is shown', async () => {
    const host = await mount();
    await answer(0, log([commit(1)], false));
    await click(rows(host)[0]);
    await answer(1, show([file('src/a.ts')], true));
    expect(host.textContent).toContain(MACHINES_STR.historyTruncated);
  });

  it('a commit whose show is not truncated shows no truncation note', async () => {
    const host = await mount();
    await answer(0, log([commit(1)], false));
    await click(rows(host)[0]);
    await answer(1, show([file('src/a.ts')], false));
    expect(host.textContent).not.toContain(MACHINES_STR.historyTruncated);
  });

  it('an empty history shows the plain empty state', async () => {
    const host = await mount();
    await answer(0, log([], false, 'empty'));
    expect(host.textContent).toBe(MACHINES_STR.historyEmpty);
    expect(rows(host)).toHaveLength(0);
  });

  it('a refused history shows the refused copy', async () => {
    const host = await mount();
    await answer(0, { ok: false, error: 'refused' });
    expect(host.textContent).toBe(MACHINES_STR.gitError('refused', 'box'));
  });
});
