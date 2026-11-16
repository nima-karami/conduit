// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonitorSession } from '../../src/contracts/link-protocol';
import type { DirEntryDTO, HostToWebview, WebviewToHost } from '../../src/protocol';

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

vi.mock('../../webview/settings', () => ({
  useSettings: () => ({ settings: { iconPack: 'minimal' }, update: () => {} }),
}));

import { RemoteFilesView } from '../../webview/components/remote-files-view';
import type { RemoteSessionRow } from '../../webview/remote-sessions';

const emit = (m: HostToWebview) => {
  for (const l of [...h.listeners]) l(m);
};

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

const HOME = '/home/me/p';
const SESSION: MonitorSession = {
  sessionId: 'S1',
  handle: 'claude-3',
  label: 'Claude',
  agent: 'cli:claude',
  presence: 'busy',
  messaging: 'connected',
  messageable: true,
  notices: 'typed',
  home: HOME,
  roots: [HOME, '/srv/shared'],
  attention: { attentionReason: 'blocked', completions: 0 },
  completions: 0,
  limit: null,
  status: 'running',
};

function rowWith(machineState: RemoteSessionRow['machineState']): RemoteSessionRow {
  return {
    key: { machineId: 'M1', sessionId: 'S1' },
    id: 'remote:M1:S1',
    machineName: 'box',
    machineState,
    session: SESSION,
    parentSessionId: null,
  };
}

const listsPosted = () => h.posted.flatMap((m) => (m.type === 'remoteFs:list' ? [m] : []));
const watchesPosted = () => h.posted.flatMap((m) => (m.type === 'remoteFs:watch' ? [m] : []));

/** Answer the newest list request for `path` with `entries`. */
function answerList(path: string, entries: DirEntryDTO[]) {
  const req = [...listsPosted()].reverse().find((m) => m.path === path);
  if (!req) throw new Error(`no list request for ${path}`);
  emit({
    type: 'remoteFs:listed',
    requestId: req.requestId,
    result: { ok: true, path, entries },
  });
}

function answerError(path: string, error: string) {
  const req = [...listsPosted()].reverse().find((m) => m.path === path);
  if (!req) throw new Error(`no list request for ${path}`);
  emit({ type: 'remoteFs:listed', requestId: req.requestId, result: { ok: false, error } });
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
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  h.listeners.clear();
});

async function render(
  row: RemoteSessionRow,
  onOpenFile?: (path: string, mode: 'preview' | 'permanent' | 'background') => void,
) {
  root = createRoot(host as HTMLDivElement);
  await act(async () => {
    root?.render(createElement(RemoteFilesView, { row, onOpenFile }));
  });
  await flush();
}

const treeitem = (name: string) =>
  [...(host?.querySelectorAll('[role="treeitem"]') ?? [])].find((el) => el.textContent === name) as
    | HTMLElement
    | undefined;

describe('RemoteFilesView', () => {
  it('lists the session folders and expands a directory on click', async () => {
    await render(rowWith('up'));
    expect(listsPosted().map((m) => m.path)).toEqual([HOME, '/srv/shared']);
    answerList(HOME, [
      { name: 'src', kind: 'dir' },
      { name: 'README.md', kind: 'file' },
    ]);
    answerList('/srv/shared', []);
    await flush();

    expect(host?.querySelectorAll('section')).toHaveLength(2);
    expect(host?.querySelector('[title="/srv/shared"]')).not.toBeNull();
    expect(treeitem('README.md')).toBeDefined();
    expect(treeitem('src')?.getAttribute('aria-expanded')).toBe('false');

    await act(async () => {
      treeitem('src')?.click();
    });
    await flush();
    expect(listsPosted().map((m) => m.path)).toContain(`${HOME}/src`);
    expect(treeitem('src')?.getAttribute('aria-expanded')).toBe('true');
    answerList(`${HOME}/src`, [{ name: 'index.ts', kind: 'file' }]);
    await flush();
    expect(treeitem('index.ts')?.getAttribute('aria-level')).toBe('2');
  });

  it('opening a file passes its path and mode', async () => {
    const onOpenFile = vi.fn();
    await render(rowWith('up'), onOpenFile);
    answerList(HOME, [{ name: 'a.txt', kind: 'file' }]);
    answerList('/srv/shared', []);
    await flush();

    await act(async () => {
      treeitem('a.txt')?.click();
    });
    expect(onOpenFile).toHaveBeenLastCalledWith(`${HOME}/a.txt`, 'preview');

    await act(async () => {
      treeitem('a.txt')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(onOpenFile).toHaveBeenLastCalledWith(`${HOME}/a.txt`, 'permanent');
  });

  it('a change under an expanded dir re-lists it', async () => {
    await render(rowWith('up'));
    answerList(HOME, [{ name: 'src', kind: 'dir' }]);
    answerList('/srv/shared', []);
    await flush();
    await act(async () => {
      treeitem('src')?.click();
    });
    await flush();
    answerList(`${HOME}/src`, [{ name: 'a.ts', kind: 'file' }]);
    await flush();

    const watch = watchesPosted().find((m) => m.path === `${HOME}/src`);
    if (!watch) throw new Error('no watch for the expanded dir');
    const before = listsPosted().filter((m) => m.path === `${HOME}/src`).length;
    await act(async () => {
      emit({ type: 'remoteFs:changed', key: watch.key, paths: [`${HOME}/src/b.ts`] });
    });
    await flush();
    expect(listsPosted().filter((m) => m.path === `${HOME}/src`).length).toBe(before + 1);
  });

  it('an offline machine sends no requests', async () => {
    await render(rowWith('down'));
    expect(h.posted.filter((m) => m.type.startsWith('remoteFs:'))).toEqual([]);
    expect(host?.textContent).toContain('box is offline');
  });

  it('an error shows Retry and Retry re-lists', async () => {
    await render(rowWith('up'));
    answerError(HOME, 'failed');
    answerList('/srv/shared', []);
    await flush();
    const retry = [...(host?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === 'Retry',
    );
    if (!retry) throw new Error('no Retry button');
    expect(host?.textContent).toContain('Something went wrong talking to that machine.');

    const before = listsPosted().filter((m) => m.path === HOME).length;
    await act(async () => {
      retry.click();
    });
    await flush();
    expect(listsPosted().filter((m) => m.path === HOME).length).toBe(before + 1);
  });
});
