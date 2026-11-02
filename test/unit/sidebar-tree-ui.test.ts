// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultSidebarUi, type SidebarUiState } from '../../src/sidebar-state';
import type { Project, Session } from '../../src/types';
import { Sidebar } from '../../webview/components/sidebar';
import {
  type SidebarTreeContextValue,
  SidebarTreeProvider,
} from '../../webview/sidebar-tree-state';

const requests = vi.hoisted(() => [] as unknown[]);
vi.mock('../../webview/host-request', () => ({
  requestHost: (build: (id: number) => unknown) => {
    requests.push(build(1));
    return Promise.resolve(null);
  },
}));
vi.mock('../../webview/bridge', async (orig) => ({
  ...(await orig<typeof import('../../webview/bridge')>()),
  post: () => {},
}));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  requests.length = 0;
  vi.useRealTimers();
});

const NOW = 100 * 60_000;

function session(id: string, o: Partial<Session> = {}): Session {
  return {
    id,
    name: id,
    agentId: 'shell:cmd',
    home: `/w/${id}`,
    roots: [],
    status: 'running',
    createdAt: 0,
    lastActiveAt: NOW,
    ...o,
  };
}

const projects: Project[] = [
  { id: 'p-a', name: 'Alpha', order: 0 },
  { id: 'p-b', name: 'Beta', order: 1 },
];

interface Setup {
  sessions: Session[];
  ui?: Partial<SidebarUiState>;
  tree?: Partial<SidebarTreeContextValue>;
  activeId?: string;
  onSelect?: (id: string) => void;
  onContextMenu?: (e: React.MouseEvent, s: Session) => void;
  onSetRenaming?: (id: string | null) => void;
  onKill?: (id: string) => void;
  onNew?: () => void;
  sessionsLoaded?: boolean;
}

const spies = {
  updateUi: vi.fn<(ui: SidebarUiState) => void>(),
  reportVisibleIds: vi.fn<(ids: readonly string[]) => void>(),
};
let bumpFilter: () => void = () => {};

async function render(s: Setup) {
  spies.updateUi.mockClear();
  spies.reportVisibleIds.mockClear();
  function Harness() {
    const [ui, setUi] = useState<SidebarUiState>({ ...defaultSidebarUi(), ...s.ui });
    const [filterRequest, setFilterRequest] = useState(0);
    bumpFilter = () => setFilterRequest((n) => n + 1);
    const value: SidebarTreeContextValue = {
      ui,
      runtime: { seen: {}, stateSince: {} },
      askSessionIds: new Set(),
      bindings: {},
      lastFocusedId: undefined,
      filterRequest,
      requestFilter: () => {},
      updateUi: (next) => {
        spies.updateUi(next);
        setUi(next);
      },
      reportVisibleIds: spies.reportVisibleIds,
      ...s.tree,
    };
    return createElement(
      SidebarTreeProvider,
      { value },
      createElement(Sidebar, {
        sessions: s.sessions,
        projects,
        windowCount: 1,
        onNewInProject: () => {},
        onOpenBoard: () => {},
        onConfirm: () => {},
        agents: [],
        activeId: s.activeId,
        onSelect: s.onSelect ?? (() => {}),
        onNew: s.onNew ?? (() => {}),
        onKill: s.onKill ?? (() => {}),
        onCloseAll: () => {},
        onCloseAllStale: () => {},
        onRename: () => {},
        onRelaunch: () => {},
        onOpenSettings: () => {},
        onContextMenu: s.onContextMenu,
        mcpBadges: {},
        mcpNotConnected: {},
        mcpEnabled: false,
        onSetRenaming: s.onSetRenaming ?? (() => {}),
        sessionsLoaded: s.sessionsLoaded,
      }),
    );
  }
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(createElement(Harness)));
}

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const qa = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
const rowEl = (id: string) => q(`.session[data-sessionid="${id}"]`);
const rowIds = () => qa('[role="treeitem"]').map((el) => el.dataset.sessionid);
const click = async (el: Element | null) => act(async () => (el as HTMLElement).click());
async function key(el: Element, k: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }),
    );
  });
}

/** Parent p (Alpha) with child c (Beta) and grandchild g (Alpha); loose l has no Space. */
const family = () => [
  session('p', { projectId: 'p-a', createdAt: 1 }),
  session('c', { projectId: 'p-b', openedBy: { sessionId: 'p', handle: 'p-1' }, createdAt: 2 }),
  session('g', { projectId: 'p-a', openedBy: { sessionId: 'c', handle: 'c-1' }, createdAt: 3 }),
  session('l', { createdAt: 4 }),
];

describe('selector contract', () => {
  it('one [data-agent-tree] tree named Agents, with status groups and treeitems', async () => {
    await render({ sessions: family(), activeId: 'c' });
    const tree = q('[data-agent-tree]');
    expect(tree.getAttribute('role')).toBe('tree');
    expect(tree.getAttribute('aria-label')).toBe('Agents');
    const group = q('button.proj__label[data-agent-group="idle"]');
    expect(group.getAttribute('aria-expanded')).toBe('true');
    // Two roots (p and l); the descendants are not counted.
    expect(group.getAttribute('aria-label')).toBe('Idle (2)');
    const content = document.getElementById(group.getAttribute('aria-controls') ?? '');
    expect(content?.getAttribute('role')).toBe('group');
    expect(rowIds()).toEqual(['p', 'c', 'g', 'l']);
    expect(rowEl('p').getAttribute('aria-level')).toBe('1');
    expect(rowEl('c').getAttribute('aria-level')).toBe('2');
    expect(rowEl('g').getAttribute('aria-level')).toBe('3');
    expect(rowEl('c').getAttribute('aria-selected')).toBe('true');
    expect(rowEl('p').getAttribute('aria-selected')).toBe('false');
    expect(rowEl('p').getAttribute('aria-expanded')).toBe('true');
    expect(rowEl('l').hasAttribute('aria-expanded')).toBe(false);
  });

  it('row names carry the Space only under All', async () => {
    await render({ sessions: family() });
    expect(rowEl('p').getAttribute('aria-label')).toBe('p, Idle, Alpha');
    expect(rowEl('l').getAttribute('aria-label')).toBe('l, Idle');
    expect(rowEl('p').querySelector('.session__space')?.textContent).toBe(' · Alpha');
    // Children carry it in the name only, not as a dim suffix.
    expect(rowEl('c').querySelector('.session__space')).toBeNull();
  });

  it('Spaces: All, each Space and No space, pressed per selection', async () => {
    await render({ sessions: family() });
    expect(qa('button[data-space-id]').map((b) => b.dataset.spaceId)).toEqual([
      'all',
      'p-a',
      'p-b',
      'no-space',
    ]);
    expect(q('button[data-space-id="all"]').getAttribute('aria-pressed')).toBe('true');
    expect(q('button[data-space-id="all"]').getAttribute('aria-label')).toBe('All');
    expect(q('button[data-space-id="no-space"]').getAttribute('aria-label')).toBe('No space');
    expect(q('button[data-space-id="p-a"]').getAttribute('aria-label')).toBe('Alpha');
    const desc = q('button[data-space-id="all"]').getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(desc)?.textContent).toBe('4 agents');
  });

  it('No space hides when nothing is loose', async () => {
    await render({ sessions: [session('a', { projectId: 'p-a' })] });
    expect(q('button[data-space-id="no-space"]')).toBeNull();
    expect(q('button[data-space-id="p-b"]')).not.toBeNull();
  });

  it('a descendant that needs you promotes the root and says so in its name', async () => {
    const sessions = family();
    sessions[2] = { ...sessions[2], attentionReason: 'blocked' };
    await render({ sessions });
    const header = q('button.proj__label[data-agent-group="blocked"]');
    expect(header.getAttribute('aria-label')).toBe('Needs you (1)');
    expect(rowEl('p').className).toContain('session--attention');
    expect(rowEl('p').getAttribute('aria-label')).toBe('p, Idle, a sub-agent needs you, Alpha');
    expect(rowEl('g').getAttribute('aria-label')).toBe('g, Needs you, Alpha');
  });
});

describe('Space filter', () => {
  it('selecting a Space persists it and re-roots cross-Space children', async () => {
    await render({ sessions: family() });
    await click(q('button[data-space-id="p-b"]'));
    expect(spies.updateUi).toHaveBeenLastCalledWith(
      expect.objectContaining({ selection: { kind: 'space', projectId: 'p-b' } }),
    );
    expect(rowIds()).toEqual(['c']);
    expect(rowEl('c').getAttribute('aria-level')).toBe('1');
    expect(rowEl('c').getAttribute('aria-label')).toBe('c, Idle');
    await click(q('button[data-space-id="no-space"]'));
    expect(rowIds()).toEqual(['l']);
  });

  it('an empty selected Space says so', async () => {
    await render({ sessions: family(), ui: { selection: { kind: 'space', projectId: 'p-x' } } });
    expect(q('[data-agent-tree]')).toBeNull();
    expect(document.body.textContent).toContain('No agents in this Space');
  });
});

describe('keyboard', () => {
  it('one tab stop; arrows, Home and End walk the visible order', async () => {
    await render({ sessions: family(), activeId: 'c' });
    expect(qa('[role="treeitem"][tabindex="0"]').map((e) => e.dataset.sessionid)).toEqual(['c']);
    for (const b of qa('.session button')) expect(b.getAttribute('tabindex')).toBe('-1');
    await act(async () => rowEl('c').focus());
    await key(rowEl('c'), 'ArrowDown');
    expect(document.activeElement).toBe(rowEl('g'));
    await key(rowEl('g'), 'End');
    expect(document.activeElement).toBe(rowEl('l'));
    await key(rowEl('l'), 'Home');
    expect(document.activeElement).toBe(rowEl('p'));
    await key(rowEl('p'), 'ArrowUp');
    expect(document.activeElement).toBe(rowEl('p'));
    expect(qa('[role="treeitem"][tabindex="0"]').map((e) => e.dataset.sessionid)).toEqual(['p']);
  });

  it('Left folds then goes to the parent; Right unfolds then enters the first child', async () => {
    await render({ sessions: family() });
    await act(async () => rowEl('c').focus());
    await key(rowEl('c'), 'ArrowLeft');
    expect(spies.updateUi).toHaveBeenLastCalledWith(
      expect.objectContaining({ foldedSessions: ['c'] }),
    );
    expect(rowEl('g')).toBeNull();
    expect(document.activeElement).toBe(rowEl('c'));
    await key(rowEl('c'), 'ArrowLeft');
    expect(document.activeElement).toBe(rowEl('p'));
    await key(rowEl('c'), 'ArrowRight');
    expect(rowEl('g')).not.toBeNull();
    await key(rowEl('c'), 'ArrowRight');
    expect(document.activeElement).toBe(rowEl('g'));
  });

  it('folding the parent of the focused row hands focus to the parent', async () => {
    await render({ sessions: family() });
    await act(async () => rowEl('g').focus());
    await click(rowEl('p').querySelector('[data-agent-action="fold"]'));
    expect(rowEl('g')).toBeNull();
    expect(document.activeElement).toBe(rowEl('p'));
    expect(rowEl('p').querySelector('.session__kids')?.textContent).toBe('2');
  });

  it('Enter goes to the agent; F2 renames; buttons never activate the row', async () => {
    const onSelect = vi.fn();
    const onSetRenaming = vi.fn();
    const onKill = vi.fn();
    await render({ sessions: family(), onSelect, onSetRenaming, onKill });
    await key(rowEl('l'), 'Enter');
    expect(onSelect).toHaveBeenCalledWith('l');
    await key(rowEl('l'), 'F2');
    expect(onSetRenaming).toHaveBeenCalledWith('l');
    onSelect.mockClear();
    await click(rowEl('l').querySelector('[data-agent-action="close"]'));
    expect(onKill).toHaveBeenCalledWith('l');
    await click(rowEl('l').querySelector('[data-agent-action="pin"]'));
    expect(onSelect).not.toHaveBeenCalled();
    await click(rowEl('l').querySelector('[data-agent-action="select"]'));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('reports the visible order on change only', async () => {
    await render({ sessions: family() });
    expect(spies.reportVisibleIds).toHaveBeenLastCalledWith(['p', 'c', 'g', 'l']);
    const calls = spies.reportVisibleIds.mock.calls.length;
    await click(rowEl('c').querySelector('[data-agent-action="fold"]'));
    expect(spies.reportVisibleIds).toHaveBeenLastCalledWith(['p', 'c', 'l']);
    expect(spies.reportVisibleIds.mock.calls.length).toBe(calls + 1);
  });

  it('the context menu reaches the App with the row session', async () => {
    // The App's handler claims the event, so the pane menu underneath stays shut.
    const onContextMenu = vi.fn((e: React.MouseEvent, _s: Session) => e.preventDefault());
    await render({ sessions: family(), onContextMenu });
    await act(async () => {
      rowEl('g').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    expect(onContextMenu.mock.calls[0]?.[1].id).toBe('g');
  });
});

describe('pins and groups', () => {
  it('Pin to top makes a Pinned group, and a pinned child roots there once', async () => {
    await render({ sessions: family() });
    await click(rowEl('g').querySelector('[data-agent-action="pin"]'));
    expect(spies.updateUi).toHaveBeenLastCalledWith(expect.objectContaining({ pinnedIds: ['g'] }));
    expect(q('button.proj__label[data-agent-group="pinned"]').getAttribute('aria-label')).toBe(
      'Pinned (1)',
    );
    expect(rowIds()).toEqual(['g', 'p', 'c', 'l']);
    expect(rowEl('g').getAttribute('aria-level')).toBe('1');
    expect(rowEl('g').querySelector('[data-agent-action="pin"]')?.getAttribute('aria-label')).toBe(
      'Unpin',
    );
  });

  it('a group folds and stays out of the visible order; Stopped starts folded', async () => {
    await render({ sessions: [...family(), session('x', { status: 'exited' })] });
    expect(q('button.proj__label[data-agent-group="stopped"]').getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(rowEl('x')).toBeNull();
    await click(q('button.proj__label[data-agent-group="idle"]'));
    expect(rowIds()).toEqual([]);
    expect(spies.reportVisibleIds).toHaveBeenLastCalledWith([]);
  });
});

describe('search', () => {
  it('Search agents reveals the filter; Escape clears, hides and returns focus', async () => {
    await render({ sessions: family() });
    const search = q<HTMLButtonElement>('button[aria-label="Search agents"]');
    expect(search.getAttribute('aria-expanded')).toBe('false');
    expect(q('input.sessbar__filter')).toBeNull();
    await click(search);
    const input = q<HTMLInputElement>('input.sessbar__filter');
    expect(input.getAttribute('aria-label')).toBe('Filter sessions');
    expect(document.activeElement).toBe(input);
    expect(search.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(search.getAttribute('aria-controls') ?? '')).not.toBeNull();
    await key(input, 'Escape');
    expect(q('input.sessbar__filter')).toBeNull();
    expect(document.activeElement).toBe(search);
  });

  it('a filter request from the App reveals and focuses it', async () => {
    await render({ sessions: family() });
    await act(async () => bumpFilter());
    expect(document.activeElement).toBe(q('input.sessbar__filter'));
  });

  it('matching filters before ancestry, and a miss offers Clear filter', async () => {
    await render({ sessions: family() });
    await click(q('button[aria-label="Search agents"]'));
    const input = q<HTMLInputElement>('input.sessbar__filter');
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      set?.call(input, 'g');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(rowIds()).toEqual(['g']);
    expect(rowEl('g').getAttribute('aria-level')).toBe('1');
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      set?.call(input, 'zzz');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(document.body.textContent).toContain('No sessions match “zzz”');
    await click(qa('button').find((b) => b.textContent === 'Clear filter') ?? null);
    expect(rowIds()).toEqual(['p', 'c', 'g', 'l']);
  });
});

describe('states and ages', () => {
  it('hydrating shows a loading placeholder, not the first-run state', async () => {
    await render({ sessions: [], sessionsLoaded: false });
    expect(document.body.textContent).toContain('Loading agents…');
    expect(document.body.textContent).not.toContain('No agents yet');
  });

  it('first run: no agents yet with Start an agent', async () => {
    const onNew = vi.fn();
    await render({ sessions: [], onNew });
    expect(document.body.textContent).toContain('No agents yet');
    await click(qa('button').find((b) => b.textContent === 'Start an agent') ?? null);
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(q('button[data-space-id="all"]').getAttribute('aria-describedby')).not.toBeNull();
  });

  it('Done needs an unseen server completion, and the age is the state age', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    await render({
      sessions: [session('d', { completions: 2 })],
      tree: { runtime: { seen: { d: 1 }, stateSince: { d: NOW - 59_000 } } },
    });
    expect(q('button.proj__label[data-agent-group="done"]')).not.toBeNull();
    expect(rowEl('d').querySelector('.agentmark__dot--done')).not.toBeNull();
    expect(rowEl('d').querySelector('.session__age')?.textContent).toBe('<1m');
    // One shared clock wakes at the next minute boundary.
    await act(async () => vi.advanceTimersByTime(1_500));
    expect(rowEl('d').querySelector('.session__age')?.textContent).toBe('1m');
  });

  it('Add space names a new Space inline and posts the create', async () => {
    await render({ sessions: family() });
    await click(q('button[aria-label="Add space"]'));
    const input = q<HTMLInputElement>('input[aria-label="New space name"]');
    expect(document.activeElement).toBe(input);
    input.value = 'Gamma';
    await key(input, 'Enter');
    expect(requests).toEqual([{ type: 'project:create', name: 'Gamma', requestId: 1 }]);
    expect(q('input[aria-label="New space name"]')).toBeNull();
  });
});
