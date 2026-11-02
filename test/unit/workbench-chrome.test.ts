// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AttentionEntry } from '../../src/attention';
import type { ChangesModel } from '../../src/changes-view-model';
import type { McpUiState } from '../../src/conduit-mcp/ui-types';
import { RightPane, type RightPaneHandle } from '../../webview/components/right-pane';
import { StatusBar } from '../../webview/components/status-bar';
import { changesBadgeCount, TopBar } from '../../webview/components/top-bar';
import { publishReviewNav, type ReviewNavModel } from '../../webview/review-nav-store';
import { SettingsProvider } from '../../webview/settings';
import {
  type WorkbenchChromeContextValue,
  WorkbenchChromeProvider,
} from '../../webview/workbench-chrome-state';

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
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
  document.body.innerHTML = '';
  publishReviewNav(null);
});

const noop = () => {};
function chrome(over: Partial<WorkbenchChromeContextValue> = {}): WorkbenchChromeContextValue {
  return {
    rightOpen: true,
    rightTab: 'files',
    togglePanel: vi.fn(),
    openPanel: vi.fn(),
    status: {
      branch: null,
      worktree: null,
      liveCount: 0,
      attentionCount: 0,
      firstAttention: null,
      showCommandHint: false,
    },
    commandHint: '',
    focusAttention: vi.fn(),
    update: { status: null, dismissed: false, dismiss: noop },
    ...over,
  };
}

async function render(value: WorkbenchChromeContextValue, child: ReactElement): Promise<void> {
  if (!root) {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  const r = root;
  await act(async () =>
    r.render(
      createElement(
        SettingsProvider,
        null,
        createElement(WorkbenchChromeProvider, { value }, child),
      ),
    ),
  );
}

const ready = (count: number): ChangesModel =>
  ({ kind: 'ready', count }) as unknown as Extract<ChangesModel, { kind: 'ready' }>;
const mcp = (youUnread: number, youUrgent: number): McpUiState =>
  ({ youUnread, youUrgent }) as unknown as McpUiState;

function topBar(props: { changesModel?: ChangesModel; mcpState?: McpUiState | null } = {}) {
  return createElement(TopBar, {
    onOpenSearch: noop,
    onBack: noop,
    onForward: noop,
    canBack: false,
    canForward: false,
    ...props,
  });
}

const toggle = (view: string) =>
  document.querySelector<HTMLButtonElement>(`button[data-right-view="${view}"]`);

describe('header toggles (selector contract: Header toggles)', () => {
  it('renders Files, Changes, Messages in order with label, pressed state and controls', async () => {
    await render(chrome({ rightOpen: true, rightTab: 'changes' }), topBar());
    const views = [...document.querySelectorAll<HTMLButtonElement>('button[data-right-view]')];
    expect(views.map((b) => b.dataset.rightView)).toEqual(['files', 'changes', 'messages']);
    expect(views.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Files',
      'Changes',
      'Messages',
    ]);
    expect(views.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
    for (const b of views) expect(b.getAttribute('aria-controls')).toBe('right-pane');
  });

  it('a closed panel presses nothing, even on the remembered view', async () => {
    await render(chrome({ rightOpen: false, rightTab: 'changes' }), topBar());
    expect(toggle('changes')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('a click hands App the view, active or not — App decides open versus close', async () => {
    const value = chrome({ rightOpen: true, rightTab: 'files' });
    await render(value, topBar());
    await act(async () => toggle('files')?.click());
    await act(async () => toggle('messages')?.click());
    expect(value.togglePanel).toHaveBeenNthCalledWith(1, 'files');
    expect(value.togglePanel).toHaveBeenNthCalledWith(2, 'messages');
  });

  it('badges are described, not part of the name; urgent messages take the urgent badge', async () => {
    await render(chrome(), topBar({ changesModel: ready(6), mcpState: mcp(2, 1) }));
    const changes = toggle('changes');
    expect(changes?.getAttribute('aria-label')).toBe('Changes');
    const desc = document.getElementById(changes?.getAttribute('aria-describedby') ?? '');
    expect(desc?.textContent).toBe('6 changes');
    const messages = toggle('messages');
    const mdesc = document.getElementById(messages?.getAttribute('aria-describedby') ?? '');
    expect(mdesc?.textContent).toBe('2 unread messages, 1 urgent message');
    expect(messages?.querySelector('.topbar__badge--urgent')).not.toBeNull();
    expect(toggle('files')?.hasAttribute('aria-describedby')).toBe(false);
  });

  it('no count, no badge', async () => {
    await render(chrome(), topBar({ changesModel: ready(0), mcpState: mcp(0, 0) }));
    expect(document.querySelector('.topbar__badge')).toBeNull();
  });

  it('the header has the identity and no view switcher or attention chip', async () => {
    await render(chrome(), topBar());
    expect(document.querySelector('.topbar__wordmark')?.textContent).toBe('Conduit');
    expect(document.querySelector('button[aria-label="Back"]')).not.toBeNull();
    expect(document.querySelector('button[aria-label="Forward"]')).not.toBeNull();
    expect(document.querySelector('.viewswitch, .attnchip, [role="tablist"]')).toBeNull();
  });
});

describe('changesBadgeCount', () => {
  it('counts the review navigator in review mode, the model otherwise', () => {
    const nav = { files: [1, 2, 3] } as unknown as ReviewNavModel;
    expect(changesBadgeCount(true, nav, ready(9))).toBe(3);
    expect(changesBadgeCount(false, nav, ready(9))).toBe(9);
    expect(changesBadgeCount(true, null, ready(9))).toBe(9);
    expect(changesBadgeCount(false, null, { kind: 'detecting' })).toBe(0);
    expect(changesBadgeCount(false, null, undefined)).toBe(0);
  });
});

function rightPane(
  paneRef?: { current: RightPaneHandle | null },
  onMoveMenu?: (anchor: DOMRect) => void,
) {
  return createElement(RightPane, {
    onMoveMenu,
    sessionId: undefined,
    activeTarget: null,
    sections: [],
    rowChanges: new Map(),
    osDropSeam: false,
    reviewRepoChanges: undefined,
    changesModel: { kind: 'no-session' },
    onOpenFile: noop,
    onOpenMatch: noop,
    setMenu: noop,
    revealPath: noop,
    openExternalApp: noop,
    openWithChooser: noop,
    openAsSession: noop,
    copyToClipboard: noop,
    onDeleteFiles: noop,
    onFileRenamed: noop,
    onReviewScope: noop,
    reviewMode: false,
    reviewTitle: 'Review changes',
    onReview: noop,
    onRefresh: noop,
    onRetryRepo: noop,
    onSetView: noop,
    onOpenDiff: noop,
    onAction: async () => {},
    onChangeContextMenu: noop,
    onRepoHeadContextMenu: noop,
    onRepoContext: noop,
    onPickActiveRepo: noop,
    renderChip: () => null,
    moveGrip: { onDragStart: noop, onDragEnd: noop },
    paneRef,
    mcp: {
      state: null,
      getThread: async () => null,
      send: async () => null,
      getAttachment: async () => null,
      markRead: noop,
      allowMore: noop,
      pause: noop,
      retry: noop,
      setToolPolicy: async () => true,
    },
    sessions: [],
    onOpenSettings: noop,
  });
}

const pane = () => document.querySelector<HTMLElement>('aside#right-pane');

describe('right panel (selector contract: Right panel)', () => {
  it('opens the panel move menu from its focusable grip with the keyboard', async () => {
    const open = vi.fn();
    await render(chrome(), rightPane(undefined, open));
    const grip = document.querySelector<HTMLElement>('.rightpane__grip');
    expect(grip?.tabIndex).toBe(0);
    expect(grip?.getAttribute('aria-label')).toBe('Move side panel');
    for (const key of ['Enter', ' ', 'ContextMenu', 'F10']) {
      await act(async () => {
        grip?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key,
            shiftKey: key === 'F10',
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    }
    expect(open).toHaveBeenCalledTimes(4);
  });
  it('names its effective view and has no tab row', async () => {
    await render(chrome({ rightTab: 'changes' }), rightPane());
    expect(pane()?.dataset.rightView).toBe('changes');
    expect(pane()?.getAttribute('aria-label')).toBe('Changes');
    expect(document.querySelector('.rightpane__tabs, .rtab')).toBeNull();
    expect(pane()?.textContent).toContain('Start a session to see its changes here.');
  });

  it('is fully controlled: the content follows App state alone', async () => {
    await render(chrome({ rightTab: 'files' }), rightPane());
    expect(pane()?.textContent).toContain('see its folders here');
    await render(chrome({ rightTab: 'changes' }), rightPane());
    expect(pane()?.dataset.rightView).toBe('changes');
    expect(pane()?.textContent).toContain('see its changes here');
    await render(chrome({ rightTab: 'files' }), rightPane());
    expect(pane()?.dataset.rightView).toBe('files');
  });

  it('imperative calls never switch the view themselves — App does (runInPane)', async () => {
    const ref: { current: RightPaneHandle | null } = { current: null };
    await render(chrome({ rightTab: 'changes' }), rightPane(ref));
    await act(async () => {
      ref.current?.openSearch();
      ref.current?.revealInTree('/x');
      ref.current?.showMessages(null);
    });
    expect(pane()?.dataset.rightView).toBe('changes');
  });

  it('keeps a dedicated, draggable Move side panel grip', async () => {
    await render(chrome(), rightPane());
    const grip = document.querySelector<HTMLElement>('.rightpane__grip');
    expect(grip?.getAttribute('title')).toBe('Move side panel');
    expect(grip?.getAttribute('draggable')).toBe('true');
  });
});

const entry = (over: Partial<AttentionEntry> = {}): AttentionEntry => ({
  key: 'session:a',
  kind: 'session',
  sessionId: 'a',
  threadId: null,
  reason: null,
  handle: null,
  ...over,
});

const item = (name: string) => document.querySelector<HTMLElement>(`[data-status-item="${name}"]`);
const items = () =>
  [...document.querySelectorAll<HTMLElement>('[data-status-item]')].map(
    (e) => e.dataset.statusItem,
  );

describe('status bar (selector contract: Footer)', () => {
  it('shows machine, branch, worktree, live, need-you and the hint for an active session', async () => {
    await render(
      chrome({
        status: {
          branch: 'feat/x',
          worktree: 'tp-app',
          liveCount: 3,
          attentionCount: 2,
          firstAttention: entry(),
          showCommandHint: true,
        },
        commandHint: 'Ctrl+Shift+P',
      }),
      createElement(StatusBar),
    );
    const footer = document.querySelector('footer[data-status-bar]');
    expect(footer?.getAttribute('aria-label')).toBe('Session status');
    expect(items()).toEqual(['machine', 'branch', 'worktree', 'live', 'attention', 'commands']);
    expect(item('machine')?.textContent).toBe('This computer');
    expect(item('branch')?.textContent).toBe('feat/x');
    expect(item('worktree')?.textContent).toBe('worktree tp-app');
    expect(item('live')?.textContent).toBe('3 agents');
    expect(item('commands')?.textContent).toBe('Ctrl+Shift+P commands');
    const attn = item('attention');
    expect(attn?.tagName).toBe('BUTTON');
    expect(attn?.textContent).toBe('2 need you');
  });

  it('the need-you button routes the first projected entry', async () => {
    const first = entry({ kind: 'ask', key: 'ask:1', handle: 'claude-1' });
    const value = chrome({
      status: {
        branch: null,
        worktree: null,
        liveCount: 1,
        attentionCount: 1,
        firstAttention: first,
        showCommandHint: true,
      },
    });
    await render(value, createElement(StatusBar));
    expect(item('attention')?.textContent).toBe('1 needs you');
    expect(item('attention')?.getAttribute('title')).toBe('claude-1 is waiting for your approval');
    await act(async () => item('attention')?.click());
    expect(value.focusAttention).toHaveBeenCalledWith(first);
  });

  it('no active session: machine and counts only; zero need-you and unbound hint are omitted', async () => {
    await render(
      chrome({
        status: {
          branch: null,
          worktree: null,
          liveCount: 1,
          attentionCount: 0,
          firstAttention: null,
          showCommandHint: false,
        },
        commandHint: 'Ctrl+Shift+P',
      }),
      createElement(StatusBar),
    );
    expect(items()).toEqual(['machine', 'live']);
    expect(item('live')?.textContent).toBe('1 agent');
  });

  it('an unbound commands shortcut hides the hint', async () => {
    await render(
      chrome({
        status: {
          branch: 'main',
          worktree: null,
          liveCount: 0,
          attentionCount: 0,
          firstAttention: null,
          showCommandHint: true,
        },
        commandHint: '',
      }),
      createElement(StatusBar),
    );
    expect(items()).toEqual(['machine', 'branch', 'live']);
  });
});
