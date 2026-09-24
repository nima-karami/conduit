// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WebviewToHost } from '../../src/protocol';
import type { Project, Session } from '../../src/types';
import type { ConfirmState } from '../../webview/components/confirm-dialog';
import { Sidebar } from '../../webview/components/sidebar';
import { SettingsProvider } from '../../webview/settings';

const posted = vi.hoisted((): WebviewToHost[] => []);
vi.mock('../../webview/bridge', async (orig) => ({
  ...(await orig<typeof import('../../webview/bridge')>()),
  post: (m: WebviewToHost) => posted.push(m),
}));

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

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  posted.length = 0;
});

const projects: Project[] = [
  { id: 'p-a', name: 'Alpha', order: 0 },
  { id: 'p-b', name: 'Beta', order: 1 },
];

function session(id: string, projectId: string): Session {
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

async function render(onConfirm: (c: ConfirmState) => void) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(
        SettingsProvider,
        null,
        createElement(Sidebar, {
          sessions: [session('s1', 'p-a'), session('s2', 'p-b')],
          projects,
          windowCount: 1,
          onNewInProject: noop,
          onOpenBoard: noop,
          onConfirm,
          agents: [],
          activeId: undefined,
          onSelect: noop,
          onNew: noop,
          onKill: noop,
          onCloseAll: noop,
          onCloseAllStale: noop,
          onRename: noop,
          onRelaunch: noop,
          onOpenSettings: noop,
          onSnooze: noop,
          onSetRenaming: noop,
          onReorderSessions: noop,
        }),
      ),
    );
  });
}

const lastPersisted = () =>
  posted.filter((m) => m.type === 'updateSettings').at(-1) as
    | Extract<WebviewToHost, { type: 'updateSettings' }>
    | undefined;

describe('Sidebar: Delete project', () => {
  it('confirming the delete prunes the id from collapsedProjects and keeps the others', async () => {
    vi.useFakeTimers();
    try {
      let confirm: ConfirmState | undefined;
      await render((c) => {
        confirm = c;
      });
      for (const name of ['Alpha', 'Beta']) {
        const chevron = document.querySelector(`button[aria-label="Collapse ${name}"]`);
        await act(async () => (chevron as HTMLButtonElement).click());
      }
      await act(async () => vi.advanceTimersByTime(300));
      expect(lastPersisted()?.settings.collapsedProjects).toEqual(['p-a', 'p-b']);

      const header = document.querySelector('button[aria-label="Expand Alpha"]')?.parentElement;
      await act(async () => {
        header?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      });
      const del = [...document.querySelectorAll<HTMLElement>('.ctxmenu__item')].find((el) =>
        el.textContent?.includes('Delete project'),
      );
      await act(async () => del?.click());
      expect(confirm?.confirmLabel).toBe('Delete project');
      await act(async () => confirm?.onConfirm());
      await act(async () => vi.advanceTimersByTime(300));

      expect(posted).toContainEqual({ type: 'project:delete', id: 'p-a' });
      expect(lastPersisted()?.settings.collapsedProjects).toEqual(['p-b']);
    } finally {
      vi.useRealTimers();
    }
  });
});
