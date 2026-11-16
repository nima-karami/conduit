// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonitorSession } from '../../src/contracts/link-protocol';
import type { HostToWebview, RepoSnapshot, WebviewToHost } from '../../src/protocol';

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

import { RemoteChangesView } from '../../webview/components/remote-changes-view';
import type { RemoteSessionRow } from '../../webview/remote-sessions';

const emit = (m: HostToWebview) => {
  for (const l of [...h.listeners]) l(m);
};

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

const HOME = '/home/me/p';
const SHARED = '/srv/shared';
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
  roots: [HOME, SHARED],
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

const snapshot = (changes: RepoSnapshot['changes'], lines = true): RepoSnapshot => ({
  changes,
  lines,
  refreshedAt: 1,
});

const statusReqs = (root: string) =>
  h.posted.flatMap((m) => (m.type === 'remoteGit:request' && m.root === root ? [m] : []));

/** Answer the newest status request for `root` with `snap`. */
function answerStatus(root: string, snap: RepoSnapshot) {
  const req = statusReqs(root).at(-1);
  if (!req) throw new Error(`no status request for ${root}`);
  emit({
    type: 'remoteGit:result',
    requestId: req.requestId,
    result: { ok: true, value: { op: 'status', root, snapshot: snap } },
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
  props: {
    onOpenDiff?: (path: string, root: string) => void;
    onOpenHistory?: (root: string) => void;
  } = {},
) {
  root = createRoot(host as HTMLDivElement);
  await act(async () => {
    root?.render(createElement(RemoteChangesView, { row, ...props }));
  });
  await flush();
}

const changeRow = (path: string) =>
  [...(host?.querySelectorAll('.remote-changes__row') ?? [])].find(
    (el) => el.querySelector('bdi')?.textContent === path,
  ) as HTMLElement | undefined;

const headerButton = (label: string) =>
  [...(host?.querySelectorAll('.remote-changes__repo button') ?? [])].find(
    (el) => el.textContent === label,
  ) as HTMLElement | undefined;

/** Both folders of the session answer: home with two changes, the shared folder clean. */
async function answerBoth() {
  await act(async () => {
    answerStatus(
      HOME,
      snapshot([
        { path: 'src/a.ts', kind: 'M', added: 3, removed: 1, staged: false },
        { path: 'b.ts', kind: 'A', added: 10, removed: 0, staged: true },
      ]),
    );
    answerStatus(SHARED, snapshot([]));
  });
  await flush();
}

describe('remote Changes view', () => {
  it('lists changes per repo from B status', async () => {
    await render(rowWith('up'));
    await answerBoth();

    expect(host?.querySelector('[role="list"]')).not.toBeNull();
    const names = [...(host?.querySelectorAll('.remote-changes__name') ?? [])].map(
      (el) => el.textContent,
    );
    expect(names).toEqual(['p', 'shared']);
    expect(changeRow('src/a.ts')?.textContent).toContain('+3');
    expect(changeRow('src/a.ts')?.textContent).toContain('−1');
    expect(changeRow('b.ts')?.textContent).toContain('staged');
    expect(host?.textContent).toContain('No changes.');
  });

  it('a change opens its diff with path and root', async () => {
    const onOpenDiff = vi.fn();
    await render(rowWith('up'), { onOpenDiff });
    await answerBoth();

    await act(async () => changeRow('src/a.ts')?.click());
    expect(onOpenDiff).toHaveBeenCalledTimes(1);
    expect(onOpenDiff).toHaveBeenCalledWith('src/a.ts', HOME);
  });

  it('History opens with the repo root', async () => {
    const onOpenHistory = vi.fn();
    await render(rowWith('up'), { onOpenHistory });
    await answerBoth();

    await act(async () => headerButton('History')?.click());
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
    expect(onOpenHistory).toHaveBeenCalledWith(HOME);
  });

  it('a change under the folder re-requests status once (debounced)', async () => {
    await render(rowWith('up'));
    await answerBoth();
    const before = statusReqs(HOME).length;

    // Three change events in a burst ask for one status, once the burst has been quiet 300 ms.
    act(() => {
      for (let i = 0; i < 3; i += 1) {
        emit({
          type: 'remoteFs:changed',
          key: `remote:M1:S1|git|${HOME}`,
          paths: [`${HOME}/a.ts`],
        });
      }
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    expect(statusReqs(HOME).length - before).toBe(1);
  });

  it('offline sends nothing', async () => {
    await render(rowWith('down'));
    await flush();
    expect(h.posted.filter((m) => m.type === 'remoteGit:request')).toEqual([]);
    expect(h.posted.filter((m) => m.type === 'remoteFs:watch')).toEqual([]);
    expect(host?.textContent).toContain('box is offline');
  });
});
