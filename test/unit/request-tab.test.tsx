// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestView } from '../../src/conduit-mcp/request-types';
import type { McpUiState } from '../../src/conduit-mcp/ui-types';
import type { HostToWebview } from '../../src/protocol';

const bridge = vi.hoisted(() => ({
  listeners: [] as ((m: HostToWebview) => void)[],
  post: vi.fn(),
}));
vi.mock('../../webview/bridge', () => ({
  subscribe: (cb: (m: HostToWebview) => void) => {
    bridge.listeners.push(cb);
    return () => {
      bridge.listeners = bridge.listeners.filter((l) => l !== cb);
    };
  },
  post: bridge.post,
}));

import { RequestTab } from '../../webview/components/request-tab';
import { setRequestOpeners } from '../../webview/request-open';

const clock = { t: 1_000_000 };

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

function view(over: Partial<RequestView> & Pick<RequestView, 'id'>): RequestView {
  return {
    origin: 'machine-a',
    source: 'agent',
    kind: 'confirm',
    requester: 'claude-7',
    session: 's1',
    space: null,
    lead: null,
    machine: 'machine-a',
    title: `Ask ${over.id}`,
    body: 'Body text.',
    options: [],
    multi: false,
    draft: null,
    thread: null,
    messageId: null,
    blocked: null,
    priority: 'normal',
    createdAt: '2026-11-14T10:00:00.000Z',
    expiresAt: null,
    default: null,
    contentKey: `k-${over.id}`,
    state: 'open',
    endedAt: null,
    answer: null,
    withdrawnBy: null,
    withdrawReason: null,
    supersededBy: null,
    deliveredAt: null,
    waiting: false,
    waitingUntil: null,
    ...over,
  };
}

function mcpState(open: RequestView[], ended: RequestView[] = []): McpUiState {
  return {
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
    requests: {
      open,
      ended,
      presence: { state: 'here', since: '2026-11-14T09:00:00.000Z', until: null, lastAway: null },
    },
  };
}

let host: HTMLDivElement;
let root: Root | null = null;

const emit = (m: HostToWebview) => {
  act(() => {
    for (const l of [...bridge.listeners]) l(m);
  });
};
const setRequests = (open: RequestView[], ended: RequestView[] = []) =>
  emit({ type: 'mcp:state', state: mcpState(open, ended) });

const closeTab = vi.fn();

beforeEach(() => {
  clock.t = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock.t);
  host = document.createElement('div');
  document.body.appendChild(host);
  bridge.post.mockReset();
  closeTab.mockReset();
  setRequestOpeners({ openTab: vi.fn(), openTerminal: vi.fn(), closeTab });
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  setRequestOpeners(null);
  host.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function mount(id: string, onTitle?: (title: string) => void): Promise<void> {
  root = createRoot(host);
  await act(async () => {
    root?.render(<RequestTab requestId={id} sessionName="Build" onTitle={onTitle} />);
  });
}

const review = () => view({ id: 'a', kind: 'review', title: 'Changelog', draft: 'line one' });

describe('RequestTab', () => {
  it('answering here closes the tab', async () => {
    setRequests([review()]);
    await mount('a');
    const written = [...host.querySelectorAll<HTMLLabelElement>('.reqtpl-option')].find((l) =>
      (l.textContent ?? '').includes('Approve as written'),
    );
    act(() => written?.querySelector('input')?.click());
    act(() => host.querySelector<HTMLButtonElement>('.reqtpl-send__btn')?.click());
    const answered = { ...review(), state: 'answered' as const };
    emit({ type: 'mcp:requestResult', requestId: 'a', result: { ok: true, request: answered } });
    setRequests([], [answered]);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 450));
    });
    expect(closeTab).toHaveBeenCalledWith('a');
  });

  it('a request withdrawn elsewhere keeps its tab and shows the ending', async () => {
    setRequests([review()]);
    await mount('a');
    setRequests([], [{ ...review(), state: 'withdrawn', withdrawnBy: 'requester' }]);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 450));
    });
    expect(closeTab).not.toHaveBeenCalled();
    expect(host.querySelector('.reqtpl-ended')).not.toBeNull();
  });

  it('names the tab by type and title', async () => {
    const onTitle = vi.fn();
    setRequests([review(), view({ id: 'b', kind: 'choose', title: 'Drop nested rows?' })]);
    await mount('a', onTitle);
    expect(onTitle).toHaveBeenLastCalledWith('Review: Changelog');
    await act(async () => root?.unmount());
    root = null;
    await mount('b', onTitle);
    expect(onTitle).toHaveBeenLastCalledWith('Answer: Drop nested rows?');
  });
});
