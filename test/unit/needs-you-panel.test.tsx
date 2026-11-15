// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestsUiState, RequestView } from '../../src/conduit-mcp/request-types';
import type { McpUiState } from '../../src/conduit-mcp/ui-types';
import type { Session } from '../../src/types';
import { NeedsYouPanel } from '../../webview/components/needs-you-panel';
import { REQ_STR } from '../../webview/request-strings';
import type { ConduitMcpApi } from '../../webview/use-conduit-mcp';

vi.mock('../../webview/bridge', async (orig) => ({
  ...(await orig<typeof import('../../webview/bridge')>()),
  mcpInstallStatus: vi.fn(async () => ({ clis: [] })),
  onMcpInstallChanged: () => () => {},
}));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = vi.fn();
});

const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

function rv(p: Partial<RequestView> & { id: string }): RequestView {
  return {
    origin: 'm1',
    source: 'agent',
    kind: 'confirm',
    requester: 'claude-7',
    session: 's1',
    space: 'sp1',
    lead: null,
    machine: 'this computer',
    title: 'Delete 41 stale snapshot files?',
    body: '',
    options: [],
    multi: false,
    draft: null,
    thread: null,
    messageId: null,
    blocked: null,
    priority: 'normal',
    createdAt: ago(8),
    expiresAt: null,
    default: null,
    contentKey: 'k',
    state: 'open',
    endedAt: null,
    answer: null,
    withdrawnBy: null,
    withdrawReason: null,
    supersededBy: null,
    deliveredAt: null,
    waiting: false,
    waitingUntil: null,
    ...p,
  };
}

function sess(id: string, name: string, handle: string): Session {
  return {
    id,
    name,
    agentId: 'claude',
    home: `/w/${id}`,
    roots: [],
    status: 'running',
    createdAt: NOW,
    lastActiveAt: NOW,
    mcpHandle: handle,
  };
}

const SESSIONS = [sess('s1', 'Nav parity', 'claude-7')];
const OPEN = [rv({ id: 'r1', title: 'Delete 41 stale snapshot files?' })];

function mcp(open: RequestView[]): ConduitMcpApi {
  const requests: RequestsUiState = {
    open,
    ended: [],
    presence: { state: 'here', since: ago(60), until: null, lastAway: null },
  };
  const state = {
    enabled: true,
    storeError: null,
    loading: false,
    sessions: {},
    threads: [],
    attention: [],
    youUnread: 0,
    youUrgent: 0,
    youUnreadByThread: [],
    switchable: [],
    notConnected: {},
    awaitingApproval: [],
    waitingAsks: 0,
    requests,
  } as unknown as McpUiState;
  return {
    state,
    getThread: vi.fn(async () => null),
    send: vi.fn(async () => null),
    getAttachment: vi.fn(async () => null),
    markRead: vi.fn(),
    allowMore: vi.fn(),
    pause: vi.fn(),
    retry: vi.fn(),
    setToolPolicy: vi.fn(async () => true),
    answerRequest: vi.fn(async () => ({
      ok: false as const,
      reason: 'not_found' as const,
      message: '',
      request: null,
    })),
    setAway: vi.fn(),
  } as unknown as ConduitMcpApi;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(api: ConduitMcpApi): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(<NeedsYouPanel mcp={api} sessions={SESSIONS} spaceNames={new Map()} />));
  return host;
}

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  host?.remove();
  host = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const q = <T extends Element = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

const trigger = () => q<HTMLButtonElement>('.needs-menu__trigger');
const menuItem = (label: string) => {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find(
    (el) => el.textContent?.includes(label),
  );
  if (!item) throw new Error(`no menu item ${label}`);
  return item;
};

describe('NeedsYouPanel', () => {
  it('renders the panel and the menu trigger', () => {
    render(mcp(OPEN));
    expect(q('.needs-pane')).toBeTruthy();
    expect(trigger().getAttribute('aria-label')).toBe(REQ_STR.needsMenu.trigger);
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
  });

  it('Clear resets the filters', () => {
    render(mcp(OPEN));
    act(() => trigger().click());
    act(() => menuItem(REQ_STR.filterSection.type).click());
    act(() => {
      const approve = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find(
        (el) => el.textContent?.includes(REQ_STR.typeWord.approve),
      );
      approve?.click();
    });
    expect(q('.needs-filterbar')).toBeTruthy();
    act(() => q<HTMLButtonElement>('.needs-filterbar__clear').click());
    expect(document.querySelector('.needs-filterbar')).toBeNull();
  });

  it('What the icons mean opens the legend', () => {
    render(mcp(OPEN));
    act(() => trigger().click());
    act(() => menuItem(REQ_STR.legend).click());
    expect(q('.needs-legend')).toBeTruthy();
  });
});
