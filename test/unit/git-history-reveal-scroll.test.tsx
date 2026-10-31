// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { assignLanes, ROW_HEIGHT } from '../../src/git-graph-render';
import type { CommitNode, HostToWebview, WebviewToHost } from '../../src/protocol';
import { GitHistoryView } from '../../webview/components/git-history-view';
import { requestHistoryReveal } from '../../webview/history-reveal';
import { SettingsProvider } from '../../webview/settings';
import { setViewState } from '../../webview/view-state-store';

// Reveal scroll (review B-S1 E9): an MCP open_git_history of a commit in the loaded pages brings
// its row into the virtualized list's view; one beyond them leaves the scroll alone.

const bridge = vi.hoisted(() => ({
  listeners: [] as ((m: HostToWebview) => void)[],
  posted: [] as WebviewToHost[],
}));
vi.mock('../../webview/bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../webview/bridge')>()),
  subscribe: (cb: (m: HostToWebview) => void) => {
    bridge.listeners.push(cb);
    return () => {
      bridge.listeners = bridge.listeners.filter((l) => l !== cb);
    };
  },
  post: (m: WebviewToHost) => {
    bridge.posted.push(m);
  },
}));

// The detail pane pulls in Monaco, which jsdom can't load; this test is about the list.
vi.mock('../../webview/components/commit-view', () => ({ CommitView: () => null }));

const VIEWPORT = 200;
/** jsdom has no layout: each element keeps the scrollTop it was given; every list is VIEWPORT tall. */
const tops = new WeakMap<Element, number>();

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
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) {
      return tops.get(this) ?? 0;
    },
    set(this: HTMLElement, v: number) {
      tops.set(this, v);
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => VIEWPORT,
  });
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  bridge.listeners = [];
  bridge.posted = [];
});

const commit = (i: number): CommitNode => ({
  sha: `${i}`.padStart(40, '0'),
  parents: [`${i + 1}`.padStart(40, '0')],
  refs: [],
  author: 'a',
  email: 'a@x',
  date: 2_000_000_000 - i,
  subject: `c${i}`,
});
const LOADED = Array.from({ length: 300 }, (_, i) => commit(i));

const view = (repoRoot: string, viewStateId?: string) =>
  createElement(
    SettingsProvider,
    null,
    createElement(GitHistoryView, {
      sessionId: 'S',
      repoRoot,
      repos: [],
      onRetarget: () => {},
      viewStateId,
    }),
  );

function mount(repoRoot = '/r', viewStateId?: string) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(view(repoRoot, viewStateId)));
}

function deliverHistory(repoRoot = '/r') {
  const req = bridge.posted.filter((m) => m.type === 'git:history').at(-1);
  if (req?.type !== 'git:history') throw new Error('no git:history request');
  act(() => {
    for (const l of [...bridge.listeners])
      l({
        type: 'git:historyResult',
        sessionId: 'S',
        repoRoot,
        requestId: req.requestId,
        commits: LOADED,
        layout: assignLanes(LOADED),
        hasMore: true,
        state: 'ok',
      });
  });
}

const list = () => {
  const el = document.querySelector('.gh__list');
  if (!el) throw new Error('no list');
  return el;
};

describe('history reveal scroll', () => {
  it('a reveal cleared by a retarget no longer suppresses the persisted-selection restore', () => {
    setViewState('vs', { kind: 'scroll', top: 0, selectedSha: LOADED[3].sha });
    requestHistoryReveal('S', '/r', LOADED[120]);
    mount('/r', 'vs');
    act(() => root?.render(view('/q', 'vs')));
    deliverHistory('/q');
    expect(list().querySelector('[aria-selected="true"]')?.textContent ?? 'none').toContain('c3');
  });

  it('a revealed commit in the loaded pages is scrolled into view', () => {
    mount();
    deliverHistory();
    expect(list().scrollTop).toBe(0);
    act(() => requestHistoryReveal('S', '/r', LOADED[250]));
    expect(list().scrollTop).toBe(251 * ROW_HEIGHT - VIEWPORT);
    expect(list().querySelector('[aria-selected="true"]')?.textContent).toContain('c250');
  });

  it('a reveal taken before the first page lands scrolls once the list shows it', () => {
    requestHistoryReveal('S', '/r', LOADED[120]);
    mount();
    deliverHistory();
    expect(list().scrollTop).toBe(121 * ROW_HEIGHT - VIEWPORT);
  });

  it('a revealed commit already in view leaves the scroll alone', () => {
    mount();
    deliverHistory();
    act(() => requestHistoryReveal('S', '/r', LOADED[1]));
    expect(list().scrollTop).toBe(0);
  });

  it('a revealed commit beyond the loaded pages leaves the scroll alone', () => {
    mount();
    deliverHistory();
    act(() => requestHistoryReveal('S', '/r', commit(5000)));
    expect(list().scrollTop).toBe(0);
  });
});
