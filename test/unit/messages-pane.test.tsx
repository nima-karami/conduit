// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StoredMessage } from '../../src/conduit-mcp/types';
import type {
  McpAttachmentPayload,
  McpThreadSummary,
  McpThreadView,
  McpUiState,
} from '../../src/conduit-mcp/ui-types';
import type { Session } from '../../src/types';
import { mcpInstallStatus } from '../../webview/bridge';
import { MessagesPane, type MessagesPaneProps } from '../../webview/components/messages-pane';
import type { ConduitMcpApi } from '../../webview/use-conduit-mcp';

vi.mock('../../webview/bridge', async (orig) => ({
  ...(await orig<typeof import('../../webview/bridge')>()),
  mcpInstallStatus: vi.fn(async () => ({ clis: [] })),
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
  vi.useRealTimers();
});

function summary(o: Partial<McpThreadSummary> = {}): McpThreadSummary {
  return {
    threadId: 't1',
    subject: 'Build fix',
    firstLine: 'the build is red',
    participants: ['fake-1', 'you'],
    topPriority: 'normal',
    lastAt: '2026-10-25T10:00:00.000Z',
    messageCount: 1,
    unreadFor: [],
    paused: false,
    unreadForYou: false,
    ...o,
  };
}

function uiState(o: Partial<McpUiState> = {}): McpUiState {
  return {
    enabled: true,
    storeError: null,
    loading: false,
    sessions: {},
    threads: [],
    attention: [],
    youUnread: 0,
    youUrgent: 0,
    switchable: [],
    notConnected: {},
    ...o,
  };
}

function message(o: Partial<StoredMessage> = {}): StoredMessage {
  return {
    messageId: 'm1',
    threadId: 't1',
    from: 'fake-1',
    to: ['you', 'fake-2'],
    subject: 'Build fix',
    kind: 'request',
    priority: 'normal',
    sentAt: '2026-10-25T10:00:00.000Z',
    body: 'please look',
    attachments: [],
    recipients: {
      you: { status: 'queued', noticeCount: 0, updatedAt: '2026-10-25T10:00:00.000Z' },
      'fake-2': { status: 'read', noticeCount: 1, updatedAt: '2026-10-25T10:00:01.000Z' },
    },
    expired: false,
    ...o,
  };
}

function threadView(o: Partial<McpThreadView> = {}, m: Partial<StoredMessage> = {}): McpThreadView {
  return {
    threadId: 't1',
    paused: false,
    messages: [{ ...message(m), attachmentsExpired: false }],
    ...o,
  };
}

function fakeApi(state: McpUiState | null, o: Partial<ConduitMcpApi> = {}): ConduitMcpApi {
  return {
    state,
    getThread: vi.fn(async () => threadView()),
    send: vi.fn(async () => null),
    getAttachment: vi.fn(async () => null),
    markRead: vi.fn(),
    allowMore: vi.fn(),
    pause: vi.fn(),
    retry: vi.fn(),
    setToolOverride: vi.fn(async () => true),
    ...o,
  };
}

const SESSIONS: Session[] = [];

function props(api: ConduitMcpApi, o: Partial<MessagesPaneProps> = {}): MessagesPaneProps {
  return {
    api,
    sessions: SESSIONS,
    filterHandle: null,
    onClearFilter: vi.fn(),
    onOpenSettings: vi.fn(),
    initialThreadId: null,
    ...o,
  };
}

async function render(p: MessagesPaneProps) {
  host = document.createElement('div');
  document.body.append(host);
  const r = createRoot(host);
  root = r;
  await act(async () => {
    r.render(createElement(MessagesPane, p));
  });
  return (next: MessagesPaneProps) =>
    act(async () => {
      r.render(createElement(MessagesPane, next));
    });
}

const text = () => document.body.textContent ?? '';
const q = <T extends Element>(sel: string): T => {
  const el = document.body.querySelector<T>(sel);
  if (!el) throw new Error(`no ${sel}`);
  return el;
};
const byText = (label: string) => {
  const el = [...document.body.querySelectorAll<HTMLElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!el) throw new Error(`no button ${label}`);
  return el;
};
const click = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
const key = (el: Element, k: string) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });

describe('MessagesPane states (spec §8)', () => {
  it('first-run text and New message', async () => {
    await render(props(fakeApi(uiState())));
    expect(text()).toContain(
      'Agents in your sessions can message each other and you. Messages appear here.',
    );
    expect(byText('New message')).toBeTruthy();
  });

  describe('empty state setup prompt (install spec §2.6)', () => {
    const FIRST_RUN =
      'Agents in your sessions can message each other and you. Messages appear here.';
    const cli = (found: boolean, state: 'installed' | 'not-installed') => ({
      cli: 'claude' as const,
      found,
      user: { state, path: '/h/.claude.json' },
      project: null,
    });
    const status = (...clis: ReturnType<typeof cli>[]) =>
      ({ clis }) as Awaited<ReturnType<typeof mcpInstallStatus>>;

    it('no threads + needsSetup shows the setup copy; the button opens settings (AC13)', async () => {
      vi.mocked(mcpInstallStatus).mockResolvedValue(status(cli(true, 'not-installed')));
      const p = props(fakeApi(uiState()));
      await render(p);
      expect(text()).toContain('Install Conduit for your agent CLIs');
      expect(text()).not.toContain(FIRST_RUN);
      await click(byText('Set up agent CLIs'));
      expect(p.onOpenSettings).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['all found CLIs installed', status(cli(true, 'installed'))],
      ['no CLI found', status(cli(false, 'not-installed'))],
    ])('%s keeps the first-run copy and no button', async (_n, s) => {
      vi.mocked(mcpInstallStatus).mockResolvedValue(s);
      await render(props(fakeApi(uiState())));
      expect(text()).toContain(FIRST_RUN);
      expect(text()).not.toContain('Set up agent CLIs');
    });

    it('a rejected status falls back to the first-run copy', async () => {
      vi.mocked(mcpInstallStatus).mockRejectedValue(new Error('boom'));
      await render(props(fakeApi(uiState())));
      expect(text()).toContain(FIRST_RUN);
      expect(text()).not.toContain('Set up agent CLIs');
    });

    it('messaging off keeps the off state and never asks for status', async () => {
      vi.mocked(mcpInstallStatus).mockClear();
      await render(props(fakeApi(uiState({ enabled: false }))));
      expect(text()).toContain('Messaging is turned off');
      expect(mcpInstallStatus).not.toHaveBeenCalled();
    });
  });

  it('loading skeleton while state is null', async () => {
    await render(props(fakeApi(null)));
    expect(q('[aria-busy="true"] .mcpmsg-skeleton__row')).toBeTruthy();
  });

  it('store error with its cause; Retry calls api.retry', async () => {
    const api = fakeApi(uiState({ storeError: 'EACCES: permission denied' }));
    await render(props(api));
    expect(q('[role="alert"]').textContent).toContain('Messages couldn’t be loaded');
    expect(text()).toContain('EACCES: permission denied');
    await click(byText('Retry'));
    expect(api.retry).toHaveBeenCalledTimes(1);
  });

  it('server off; Open Settings', async () => {
    const p = props(fakeApi(uiState({ enabled: false })));
    await render(p);
    expect(text()).toContain('Messaging is turned off');
    await click(byText('Open Settings'));
    expect(p.onOpenSettings).toHaveBeenCalled();
  });

  it('"No unread messages" + Show all under the unread filter', async () => {
    await render(props(fakeApi(uiState({ threads: [summary()] }))));
    await click(byText('Unread only'));
    expect(text()).toContain('No unread messages');
    await click(byText('Show all'));
    expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(1);
  });

  it('populated list is a listbox of options driven by ↑/↓/Home/End/Enter', async () => {
    const api = fakeApi(
      uiState({
        threads: [
          summary({ threadId: 'a', subject: 'A', lastAt: '2026-10-25T12:00:00.000Z' }),
          summary({
            threadId: 'b',
            subject: 'B',
            lastAt: '2026-10-25T11:00:00.000Z',
            unreadForYou: true,
            topPriority: 'urgent',
          }),
          summary({ threadId: 'c', subject: 'C', lastAt: '2026-10-25T10:00:00.000Z' }),
        ],
      }),
    );
    await render(props(api));
    const list = q('[role="listbox"]');
    const opts = [...list.querySelectorAll('[role="option"]')];
    expect(opts.map((o) => o.getAttribute('aria-label')?.split(',')[0])).toEqual(['A', 'B', 'C']);
    expect(opts[1].getAttribute('aria-label')).toMatch(/unread.*urgent/);
    const selected = () =>
      list.querySelector('[aria-selected="true"]')?.getAttribute('aria-label')?.split(',')[0];
    expect(selected()).toBe('A');
    await key(list, 'ArrowDown');
    expect(selected()).toBe('B');
    await key(list, 'End');
    expect(selected()).toBe('C');
    await key(list, 'Home');
    expect(selected()).toBe('A');
    await key(list, 'ArrowUp');
    expect(selected()).toBe('A');
    await key(list, 'ArrowDown');
    await key(list, 'Enter');
    expect(api.getThread).toHaveBeenCalledWith('b');
  });

  it('a thread is a log of articles showing per-recipient states', async () => {
    await render(props(fakeApi(uiState({ threads: [summary()] })), { initialThreadId: 't1' }));
    const log = q('[role="log"]');
    const arts = log.querySelectorAll('article');
    expect(arts).toHaveLength(1);
    expect(arts[0].textContent).toContain('please look');
    expect(arts[0].textContent).toContain('fake-2: Read');
    expect(arts[0].textContent).toContain('you: Queued');
  });

  it('paused thread offers Allow 20 more', async () => {
    const api = fakeApi(uiState({ threads: [summary({ paused: true })] }), {
      getThread: vi.fn(async () => threadView({ paused: true })),
    });
    await render(props(api, { initialThreadId: 't1' }));
    expect(text()).toContain('Paused after 20 agent messages');
    await click(byText('Allow 20 more'));
    expect(api.allowMore).toHaveBeenCalledWith('t1');
  });

  it('an expired attachment shows in place of the chip', async () => {
    const api = fakeApi(uiState({ threads: [summary()] }), {
      getThread: vi.fn(async () => ({
        threadId: 't1',
        paused: false,
        messages: [
          {
            ...message({
              expired: true,
              body: '',
              attachments: [
                { attachmentId: 'a1', name: 'log.txt', mime: 'text/plain', bytes: 3, sha256: 'x' },
              ],
            }),
            attachmentsExpired: true,
          },
        ],
      })),
    });
    await render(props(api, { initialThreadId: 't1' }));
    expect(text()).toContain('Attachment expired');
    expect(document.body.querySelector('button[aria-label^="Open attachment"]')).toBeNull();
  });

  it('Open attachment shows the view modal', async () => {
    const payload: McpAttachmentPayload = {
      name: 'log.txt',
      mime: 'text/plain',
      bytes: 3,
      base64: btoa('abc'),
    };
    const api = fakeApi(uiState({ threads: [summary()] }), {
      getThread: vi.fn(async () =>
        threadView(
          {},
          {
            attachments: [
              { attachmentId: 'a1', name: 'log.txt', mime: 'text/plain', bytes: 3, sha256: 'x' },
            ],
          },
        ),
      ),
      getAttachment: vi.fn(async () => payload),
    });
    await render(props(api, { initialThreadId: 't1' }));
    await click(q('button[aria-label="Open attachment: log.txt"]'));
    await act(async () => {});
    expect(api.getAttachment).toHaveBeenCalledWith('m1', 'a1');
    expect(q('[role="dialog"] pre').textContent).toBe('abc');
  });

  it('opening a thread marks the human’s unread messages read', async () => {
    const api = fakeApi(uiState({ threads: [summary({ unreadForYou: true })] }));
    await render(props(api));
    await click(q('[role="option"]'));
    expect(api.markRead).toHaveBeenCalledWith(['m1']);
  });

  it('announces new messages at most once per 5 s', async () => {
    vi.useFakeTimers();
    const s0 = uiState({ threads: [] });
    const rerender = await render(props(fakeApi(s0)));
    const region = () => q('[aria-live="polite"]').textContent;
    const withThreads = (n: number) =>
      uiState({
        threads: Array.from({ length: n }, (_, i) => summary({ threadId: `t${i}` })),
      });
    await rerender(props(fakeApi(withThreads(1))));
    expect(region()).toBe('1 new message');
    await rerender(props(fakeApi(withThreads(2))));
    await rerender(props(fakeApi(withThreads(4))));
    expect(region()).toBe('1 new message');
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(region()).toBe('3 new messages');
  });

  it('one live region survives view switches, and a repeated announcement still mutates it', async () => {
    vi.useFakeTimers();
    const one = (id: string) => uiState({ threads: [summary({ threadId: id })] });
    const two = uiState({
      threads: [summary({ threadId: 'a' }), summary({ threadId: 'b', subject: 'Second' })],
    });
    const rerender = await render(props(fakeApi(uiState())));
    const region = () => q('[aria-live="polite"]');
    await rerender(props(fakeApi(one('a'))));
    const first = region();
    const said = first.textContent;
    expect(said).toBe('1 new message');
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    await rerender(props(fakeApi(two)));
    expect(region()).toBe(first);
    expect(first.textContent).not.toBe(said);
    expect(first.textContent).toBe(`1 new message${String.fromCharCode(0x200b)}`);
    await click(q('[role="option"]'));
    expect(q('[role="log"]')).toBeTruthy();
    expect(document.body.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
    expect(region()).toBe(first);
  });

  it('the active thread follows its id when a newer thread arrives above it', async () => {
    const a = summary({ threadId: 'a', subject: 'A', lastAt: '2026-10-25T12:00:00.000Z' });
    const b = summary({ threadId: 'b', subject: 'B', lastAt: '2026-10-25T11:00:00.000Z' });
    const z = summary({ threadId: 'z', subject: 'Z', lastAt: '2026-10-25T13:00:00.000Z' });
    const rerender = await render(props(fakeApi(uiState({ threads: [a, b] }))));
    await key(q('[role="listbox"]'), 'ArrowDown');
    await rerender(props(fakeApi(uiState({ threads: [a, b, z] }))));
    const list = q('[role="listbox"]');
    const activeId = list.getAttribute('aria-activedescendant') ?? '';
    expect(document.getElementById(activeId)?.getAttribute('aria-label')?.split(',')[0]).toBe('B');
  });
});

describe('MessagesPane focus (spec §10)', () => {
  const threeThreads = () =>
    uiState({
      threads: [
        summary({ threadId: 'a', subject: 'A', lastAt: '2026-10-25T12:00:00.000Z' }),
        summary({ threadId: 'b', subject: 'B', lastAt: '2026-10-25T11:00:00.000Z' }),
        summary({ threadId: 'c', subject: 'C', lastAt: '2026-10-25T10:00:00.000Z' }),
      ],
    });
  const selected = () =>
    q('[role="listbox"]')
      .querySelector('[aria-selected="true"]')
      ?.getAttribute('aria-label')
      ?.split(',')[0];

  it('opening a thread focuses its first message', async () => {
    await render(props(fakeApi(threeThreads())));
    await click(document.body.querySelectorAll('[role="option"]')[1]);
    expect(document.activeElement).toBe(q('[role="log"] article'));
  });

  it('Back focuses the list with the thread just left active', async () => {
    await render(props(fakeApi(threeThreads())));
    await click(document.body.querySelectorAll('[role="option"]')[1]);
    await click(q('button[aria-label="Back to threads"]'));
    expect(document.activeElement).toBe(q('[role="listbox"]'));
    expect(selected()).toBe('B');
  });

  it('a new compose cancelled focuses New message', async () => {
    await render(props(fakeApi(threeThreads())));
    await click(byText('New message'));
    await click(byText('Cancel'));
    expect(document.activeElement).toBe(byText('New message'));
  });

  it('a reply cancelled returns to the thread with its first message focused', async () => {
    await render(props(fakeApi(threeThreads()), { initialThreadId: 'b' }));
    await click(byText('Reply'));
    expect(document.activeElement).toBe(q('textarea'));
    await click(byText('Cancel'));
    expect(document.activeElement).toBe(q('[role="log"] article'));
  });
});
