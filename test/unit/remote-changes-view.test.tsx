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
import { MACHINES_STR } from '../../webview/machines-strings';
import type { RemoteSessionRow } from '../../webview/remote-sessions';

const emit = (m: HostToWebview) => {
  for (const l of [...h.listeners]) l(m);
};

const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
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

function rowWith(
  machineState: RemoteSessionRow['machineState'],
  session: MonitorSession = SESSION,
): RemoteSessionRow {
  return {
    key: { machineId: 'M1', sessionId: 'S1' },
    id: 'remote:M1:S1',
    machineName: 'box',
    machineState,
    session,
    parentSessionId: null,
  };
}

const snapshot = (
  changes: RepoSnapshot['changes'],
  extra: Partial<RepoSnapshot> = {},
): RepoSnapshot => ({ changes, lines: true, refreshedAt: 1, ...extra });

const statusReqs = (root: string) =>
  h.posted.flatMap((m) => (m.type === 'remoteGit:request' && m.root === root ? [m] : []));

/** Answer the newest status request for `folder` with an ok status reply. */
function answerStatus(folder: string, value: { root: string; snap: RepoSnapshot | null }) {
  const req = statusReqs(folder).at(-1);
  if (!req) throw new Error(`no status request for ${folder}`);
  emit({
    type: 'remoteGit:result',
    requestId: req.requestId,
    result: {
      ok: true,
      value: { op: 'status', root: value.root, snapshot: value.snap },
    },
  });
}

function failStatus(folder: string, error: string) {
  const req = statusReqs(folder).at(-1);
  if (!req) throw new Error(`no status request for ${folder}`);
  emit({ type: 'remoteGit:result', requestId: req.requestId, result: { ok: false, error } });
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers();
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
  vi.useRealTimers();
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

const retryButtons = () =>
  [...(host?.querySelectorAll('.remote-changes__note button') ?? [])].filter(
    (el) => el.textContent === MACHINES_STR.changesRetry,
  ) as HTMLElement[];

/** Both folders of the session answer: home with two changes, the shared folder clean. */
async function answerBoth() {
  await act(async () => {
    answerStatus(HOME, {
      root: HOME,
      snap: snapshot([
        { path: 'src/a.ts', kind: 'M', added: 3, removed: 1, staged: false },
        { path: 'b.ts', kind: 'A', added: 10, removed: 0, staged: true },
      ]),
    });
    answerStatus(SHARED, { root: SHARED, snap: snapshot([]) });
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
    expect(changeRow('src/a.ts')?.textContent).toContain('unstaged');
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

  it('watches the repo folder, never its .git, which B refuses (security review M4)', async () => {
    await render(rowWith('up'));
    await answerBoth();
    const watched = h.posted.flatMap((m) => (m.type === 'remoteFs:watch' ? [m.path] : []));
    expect(watched).toContain(HOME);
    expect(watched.filter((p) => /[\\/]\.git([\\/]|$)/.test(p))).toEqual([]);
  });

  it('a change in the repo folder re-requests once after 300 ms and not before', async () => {
    await render(rowWith('up'));
    await answerBoth();
    const before = statusReqs(HOME).length;

    // Three events in a burst ask for one status, and none before the 300 ms quiet period.
    act(() => {
      for (let i = 0; i < 3; i += 1) {
        emit({ type: 'remoteFs:changed', key: `remote:M1:S1|git|${HOME}`, paths: [] });
      }
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(statusReqs(HOME).length).toBe(before);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(statusReqs(HOME).length - before).toBe(1);
  });

  it('polls status every 5 s while shown and stops on unmount', async () => {
    await render(rowWith('up'));
    await answerBoth();
    const first = statusReqs(HOME).length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(statusReqs(HOME).length).toBe(first);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(statusReqs(HOME).length).toBe(first + 1);

    act(() => root?.unmount());
    root = null;
    const atUnmount = statusReqs(HOME).length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(statusReqs(HOME).length).toBe(atUnmount);
  });

  it('a folder with no repo shows No git repository, not an error', async () => {
    await render(rowWith('up'));
    await act(async () => {
      answerStatus(HOME, { root: HOME, snap: null });
      answerStatus(SHARED, { root: SHARED, snap: null });
    });
    await flush();

    expect(host?.textContent).toContain('No git repository in this session’s folders.');
    expect(retryButtons()).toEqual([]);
  });

  it('a real error on a folder shows on its section with Retry even when another folder has a repo', async () => {
    await render(rowWith('up'));
    await act(async () => {
      answerStatus(HOME, {
        root: HOME,
        snap: snapshot([{ path: 'a.ts', kind: 'M', added: 1, removed: 0, staged: false }]),
      });
      failStatus(SHARED, 'refused');
    });
    await flush();

    expect(changeRow('a.ts')).toBeDefined();
    const errorNote = [...(host?.querySelectorAll('.remote-changes__note') ?? [])].find((el) =>
      el.textContent?.includes('That machine refused.'),
    );
    expect(errorNote?.textContent).toContain('shared');
    expect(retryButtons()).toHaveLength(1);

    const before = statusReqs(SHARED).length;
    await act(async () => retryButtons()[0]?.click());
    expect(statusReqs(SHARED).length - before).toBe(1);
  });

  it('repos are keyed by the root B returned: two folders in one repo show once', async () => {
    const sub = `${HOME}/sub`;
    await render(rowWith('up', { ...SESSION, roots: [HOME, sub] }));
    await act(async () => {
      answerStatus(HOME, { root: HOME, snap: snapshot([]) });
      // The sub folder sits inside the same repo, so B answers with the repo's own root.
      answerStatus(sub, { root: HOME, snap: snapshot([]) });
    });
    await flush();

    const names = [...(host?.querySelectorAll('.remote-changes__name') ?? [])].map(
      (el) => el.textContent,
    );
    expect(names).toEqual(['p']);
  });

  it('Retry on a stale repo asks its folder again', async () => {
    await render(rowWith('up'));
    await act(async () => {
      answerStatus(HOME, {
        root: HOME,
        snap: snapshot([], { error: 'failed' }),
      });
      answerStatus(SHARED, { root: SHARED, snap: snapshot([]) });
    });
    await flush();

    expect(host?.textContent).toContain('Could not read the latest status.');
    const before = statusReqs(HOME).length;
    await act(async () => retryButtons()[0]?.click());
    expect(statusReqs(HOME).length - before).toBe(1);
  });

  it('offline sends nothing', async () => {
    await render(rowWith('down'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(h.posted.filter((m) => m.type === 'remoteGit:request')).toEqual([]);
    expect(h.posted.filter((m) => m.type === 'remoteFs:watch')).toEqual([]);
    expect(host?.textContent).toContain('box is offline');
  });
});
