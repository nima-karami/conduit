// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WebviewToHost } from '../../src/protocol';
import { defaultSidebarUi } from '../../src/sidebar-state';
import { DEFAULT_AGENTS_VIEW, DEFAULT_SPACES_VIEW } from '../../src/sidebar-view';
import type { Project, Session } from '../../src/types';
import type { ConfirmState } from '../../webview/components/confirm-dialog';
import { Sidebar } from '../../webview/components/sidebar';
import { SidebarTreeProvider } from '../../webview/sidebar-tree-state';

const posted = vi.hoisted((): WebviewToHost[] => []);
const requests = vi.hoisted(() => [] as unknown[]);
vi.mock('../../webview/bridge', async (orig) => ({
  ...(await orig<typeof import('../../webview/bridge')>()),
  post: (m: WebviewToHost) => posted.push(m),
}));
vi.mock('../../webview/host-request', () => ({
  requestHost: (build: (id: number) => unknown) => {
    requests.push(build(7));
    return Promise.resolve(null);
  },
}));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
});

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  posted.length = 0;
  requests.length = 0;
});

const projects: Project[] = [
  { id: 'p-a', name: 'Alpha', order: 0 },
  { id: 'p-b', name: 'Beta', order: 1 },
];

function session(id: string, projectId?: string): Session {
  return {
    id,
    name: id,
    agentId: 'shell:cmd',
    home: `/w/${id}`,
    roots: [],
    status: 'running',
    createdAt: 0,
    lastActiveAt: 0,
    projectId,
  };
}

const noop = () => {};

async function render(
  o: {
    onConfirm?: (c: ConfirmState) => void;
    onNewInProject?: (id: string | null) => void;
    onOpenBoard?: (id: string) => void;
    onCloseAll?: () => void;
  } = {},
) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(
        SidebarTreeProvider,
        {
          value: {
            ui: defaultSidebarUi(),
            runtime: { seen: {}, stateSince: {} },
            hydrated: true,
            askSessionIds: new Set<string>(),
            bindings: {},
            lastFocusedBySpace: {},
            filterRequest: 0,
            requestFilter: noop,
            updateUi: noop,
            agentsView: DEFAULT_AGENTS_VIEW,
            spacesView: DEFAULT_SPACES_VIEW,
            setAgentsView: noop,
            setSpacesView: noop,
            reportVisibleIds: noop,
          },
        },
        createElement(Sidebar, {
          sessions: [session('s1', 'p-a'), session('s2', 'p-b'), session('s3')],
          projects,
          windowCount: 1,
          onNewInProject: o.onNewInProject ?? noop,
          onOpenBoard: o.onOpenBoard ?? noop,
          onConfirm: o.onConfirm ?? noop,
          agents: [],
          activeId: undefined,
          onSelect: noop,
          onNew: noop,
          onKill: noop,
          onCloseAll: o.onCloseAll ?? noop,
          onCloseAllStale: noop,
          onRename: noop,
          onRelaunch: noop,
          onOpenSettings: noop,
          mcpBadges: {},
          mcpNotConnected: {},
          mcpEnabled: false,
          onSetRenaming: noop,
        }),
      ),
    );
  });
}

const space = (id: string) =>
  document.querySelector(`button[data-space-id="${id}"]`) as HTMLElement;
const menuLabels = () =>
  [...document.querySelectorAll<HTMLElement>('.ctxmenu__item')].map((el) => el.textContent);
const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('.ctxmenu__item')].find(
    (el) => el.textContent === label,
  );
async function contextMenu(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  });
}

describe('Sidebar: Space menus', () => {
  it('a Space offers New agent in Space, Open board, Rename and Delete', async () => {
    const onNewInProject = vi.fn();
    const onOpenBoard = vi.fn();
    await render({ onNewInProject, onOpenBoard });
    await contextMenu(space('p-a'));
    expect(menuLabels()).toEqual(['New agent in space', 'Open board', 'Rename…', 'Delete space…']);
    await act(async () => menuItem('New agent in space')?.click());
    expect(onNewInProject).toHaveBeenCalledWith('p-a');
    await contextMenu(space('p-a'));
    await act(async () => menuItem('Open board')?.click());
    expect(onOpenBoard).toHaveBeenCalledWith('s1');
  });

  it('confirming Delete space posts the delete with the Space copy', async () => {
    let confirm: ConfirmState | undefined;
    await render({
      onConfirm: (c) => {
        confirm = c;
      },
    });
    await contextMenu(space('p-a'));
    await act(async () => menuItem('Delete space…')?.click());
    expect(confirm?.confirmLabel).toBe('Delete space');
    expect(confirm?.danger).toBe(true);
    await act(async () => confirm?.onConfirm());
    expect(posted).toContainEqual({ type: 'project:delete', id: 'p-a' });
  });

  it('Rename… opens the inline input; Enter posts the rename', async () => {
    await render();
    await contextMenu(space('p-b'));
    await act(async () => menuItem('Rename…')?.click());
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Rename Beta"]');
    expect(input).not.toBeNull();
    if (!input) return;
    input.value = 'Beta 2';
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(posted).toContainEqual({ type: 'project:rename', id: 'p-b', name: 'Beta 2' });
  });

  it('No space offers New agent without a Space', async () => {
    const onNewInProject = vi.fn();
    await render({ onNewInProject });
    await contextMenu(space('no-space'));
    expect(menuLabels()).toEqual(['New agent without a space']);
    await act(async () => menuItem('New agent without a space')?.click());
    expect(onNewInProject).toHaveBeenCalledWith(null);
  });
});

describe('Sidebar: pane menu', () => {
  it('empty list space offers New agent and the bulk closes', async () => {
    const onCloseAll = vi.fn();
    await render({ onCloseAll });
    await contextMenu(document.querySelector('.sidebar__scroll') as Element);
    expect(menuLabels()).toEqual(['New agent', 'Close all sessions', 'Close all stale sessions']);
    await act(async () => menuItem('Close all sessions')?.click());
    expect(onCloseAll).toHaveBeenCalledTimes(1);
  });

  it('the sort and group-by-project controls are gone', async () => {
    await render();
    expect(document.querySelector('button[aria-label="Sort & filter sessions"]')).toBeNull();
    expect(document.querySelector('.proj__add')).toBeNull();
  });
});

describe('Sidebar: drag a row onto a Space', () => {
  const drag = async (el: Element, type: string) => {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: { effectAllowed: '' } });
    await act(async () => {
      el.dispatchEvent(ev);
    });
    return ev;
  };

  it('moves only that session; its own Space and All refuse the drop', async () => {
    await render();
    const row = document.querySelector('.session[data-sessionid="s1"]') as Element;
    await drag(row, 'dragstart');
    expect((await drag(space('all'), 'dragover')).defaultPrevented).toBe(false);
    expect((await drag(space('p-a'), 'dragover')).defaultPrevented).toBe(false);
    const over = await drag(space('p-b'), 'dragover');
    expect(over.defaultPrevented).toBe(true);
    expect(space('p-b').className).toContain('space--drop');
    await drag(space('p-b'), 'drop');
    expect(requests).toEqual([
      { type: 'session:setProject', sessionId: 's1', projectId: 'p-b', requestId: 7 },
    ]);
    expect(space('p-b').className).not.toContain('space--drop');
  });

  it('No space takes a session out of its Space', async () => {
    await render();
    await drag(document.querySelector('.session[data-sessionid="s2"]') as Element, 'dragstart');
    await drag(space('no-space'), 'dragover');
    await drag(space('no-space'), 'drop');
    expect(requests).toEqual([
      { type: 'session:setProject', sessionId: 's2', projectId: null, requestId: 7 },
    ]);
  });
});
