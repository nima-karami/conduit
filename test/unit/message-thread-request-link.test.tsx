// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestView } from '../../src/conduit-mcp/request-types';
import type { StoredMessage } from '../../src/conduit-mcp/types';
import type { McpThreadView, McpUiState } from '../../src/conduit-mcp/ui-types';
import { emptyPolicyUi } from '../../src/conduit-mcp/ui-types';
import { MessageThread } from '../../webview/components/message-thread';
import { openRequest } from '../../webview/request-open';
import type { ConduitMcpApi } from '../../webview/use-conduit-mcp';

vi.mock('../../webview/request-open', () => ({ openRequest: vi.fn(() => true) }));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = () => {};
});

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
  host?.remove();
  host = null;
  document.body.innerHTML = '';
  vi.mocked(openRequest).mockClear();
});

function message(): StoredMessage {
  return {
    messageId: 'm1',
    threadId: 't1',
    from: 'fake-1',
    to: ['you'],
    subject: 'Build fix',
    kind: 'request',
    priority: 'normal',
    sentAt: '2026-10-25T10:00:00.000Z',
    body: 'please look',
    attachments: [],
    recipients: {
      you: { status: 'queued', noticeCount: 0, updatedAt: '2026-10-25T10:00:00.000Z' },
    },
    expired: false,
  };
}

function threadView(): McpThreadView {
  return { threadId: 't1', paused: false, messages: [{ ...message(), attachmentsExpired: false }] };
}

function request(o: Partial<RequestView> = {}): RequestView {
  return {
    id: 'r1',
    origin: 'machine-1',
    source: 'agent',
    kind: 'confirm',
    requester: 'fake-1',
    session: 's1',
    space: null,
    lead: null,
    machine: 'machine-1',
    title: 'Run the migration?',
    body: '',
    options: [],
    multi: false,
    draft: null,
    thread: 't1',
    messageId: null,
    blocked: 'permission',
    priority: 'normal',
    createdAt: '2026-10-25T10:00:00.000Z',
    expiresAt: null,
    default: null,
    contentKey: 'k1',
    state: 'open',
    endedAt: null,
    answer: null,
    withdrawnBy: null,
    withdrawReason: null,
    supersededBy: null,
    deliveredAt: null,
    permission: null,
    waiting: false,
    waitingUntil: null,
    ...o,
  };
}

function fakeApi(open: RequestView[], ended: RequestView[] = []): ConduitMcpApi {
  const state: McpUiState = {
    enabled: true,
    storeError: null,
    native: {},
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
    policy: emptyPolicyUi(),
    requests: {
      open,
      ended,
      presence: { state: 'here', since: '2026-10-25T10:00:00.000Z', until: null, lastAway: null },
    },
  };
  return {
    state,
    getThread: vi.fn(async () => threadView()),
    send: vi.fn(async () => null),
    getAttachment: vi.fn(async () => null),
    markRead: vi.fn(),
    allowMore: vi.fn(),
    pause: vi.fn(),
    retry: vi.fn(),
    getActivity: async () => null,
    linkCodexThread: async () => ({ status: 'unavailable' as const }),
    codexPostureQuery: async () => ({ status: 'unavailable' as const }),
    setAssignment: async () => true,
    revokeGrant: async () => true,
    allowOnce: async () => true,
    saveAssignment: async () => ({ ok: true as const }),
    saveProfile: async () => ({ ok: true as const }),
    deleteProfile: async () => ({ ok: true as const }),
    retryPolicy: async () => ({ ok: true as const }),
    setToolPolicy: vi.fn(async () => true),
    setPointPolicy: vi.fn(async () => true),
    remotePolicy: vi.fn(async () => ({ ok: true as const })),
    remoteEdit: vi.fn(async () => ({ ok: true as const })),
    answerPermission: vi.fn(async () => ({ ok: true as const })),
    answerRequest: vi.fn(async () => ({
      ok: false as const,
      reason: 'not_found' as const,
      message: '',
      request: null,
    })),
    setAway: vi.fn(),
  };
}

async function render(api: ConduitMcpApi) {
  host = document.createElement('div');
  document.body.append(host);
  const r = createRoot(host);
  root = r;
  await act(async () => {
    r.render(createElement(MessageThread, { api, threadId: 't1', onReply: vi.fn() }));
  });
}

const linkButtons = () => [
  ...document.body.querySelectorAll<HTMLButtonElement>('button.needs-threadlink'),
];

describe('MessageThread request link (spec §4.4.7)', () => {
  it('shows a link for an open request in this thread and opens it on click', async () => {
    await render(fakeApi([request({ id: 'r1', title: 'Run the migration?' })]));

    const link = linkButtons();
    expect(link).toHaveLength(1);
    expect(link[0].textContent).toBe('Approve · Run the migration?');
    expect(link[0].getAttribute('aria-label')).toBe('Open request: Run the migration?');
    expect(link[0].querySelector('[dir="auto"]')?.textContent).toBe('Run the migration?');

    await act(async () => {
      link[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(openRequest).toHaveBeenCalledTimes(1);
    expect(openRequest).toHaveBeenCalledWith('r1');
  });

  it('shows nothing for requests in other threads or ended ones', async () => {
    await render(
      fakeApi(
        [request({ id: 'other', thread: 't2', title: 'Elsewhere' })],
        [request({ id: 'done', state: 'answered', title: 'Finished' })],
      ),
    );

    expect(linkButtons()).toHaveLength(0);
    expect(document.body.textContent).not.toContain('Elsewhere');
    expect(document.body.textContent).not.toContain('Finished');
  });
});
