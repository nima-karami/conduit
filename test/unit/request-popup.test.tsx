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

import { RequestPopup } from '../../webview/components/request-popup';
import { requestPopup, setRequestOpeners } from '../../webview/request-open';

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

const popupEl = () => host.querySelector<HTMLElement>('.reqtpl-popup');
const shownTitle = () => host.querySelector('.reqtpl-title')?.textContent ?? null;
const nextButton = () =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    (b.textContent ?? '').startsWith('Next:'),
  );
const press = (el: Element, key: string, shiftKey = false) =>
  act(() => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }),
    );
  });

beforeEach(() => {
  clock.t = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock.t);
  host = document.createElement('div');
  document.body.appendChild(host);
  bridge.post.mockReset();
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  requestPopup.close();
  host.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function mount(): Promise<void> {
  root = createRoot(host);
  await act(async () => {
    root?.render(<RequestPopup sessions={[{ id: 's1', name: 'Build' }]} />);
  });
}

describe('RequestPopup', () => {
  it('nothing renders until opened', async () => {
    setRequests([view({ id: 'a' })]);
    await mount();
    expect(popupEl()).toBeNull();
    act(() => requestPopup.open('a'));
    expect(popupEl()).not.toBeNull();
  });

  it('opening focuses the title', async () => {
    setRequests([view({ id: 'a' })]);
    await mount();
    act(() => requestPopup.open('a'));
    const title = host.querySelector('.reqtpl-head__title');
    expect(title).not.toBeNull();
    expect(document.activeElement).toBe(title);
  });

  it('Esc closes and returns focus', async () => {
    setRequests([view({ id: 'a' })]);
    const before = document.createElement('button');
    document.body.appendChild(before);
    before.focus();
    await mount();
    act(() => requestPopup.open('a'));
    press(popupEl() as HTMLElement, 'Escape');
    expect(popupEl()).toBeNull();
    expect(requestPopup.current()).toBeNull();
    expect(document.activeElement).toBe(before);
    before.remove();
  });

  it('Tab stays inside the dialog', async () => {
    setRequests([view({ id: 'a' })]);
    await mount();
    act(() => requestPopup.open('a'));
    const box = popupEl() as HTMLElement;
    const focusables = box.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled])',
    );
    const last = focusables[focusables.length - 1];
    const first = focusables[0];
    act(() => last.focus());
    press(last, 'Tab');
    expect(box.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(first);
    act(() => first.focus());
    press(first, 'Tab', true);
    expect(document.activeElement).toBe(last);
  });

  it('Next goes to the soonest other request and wraps', async () => {
    const waiting = view({
      id: 'a',
      title: 'First ask',
      waiting: true,
      waitingUntil: '2026-11-14T10:05:00.000Z',
    });
    const soon = view({ id: 'b', title: 'Second ask', expiresAt: '2026-11-14T11:00:00.000Z' });
    const later = view({ id: 'c', title: 'Third ask', expiresAt: '2026-11-14T12:00:00.000Z' });
    setRequests([later, soon, waiting]);
    await mount();
    act(() => requestPopup.open('a'));
    expect(shownTitle()).toBe('First ask');
    act(() => nextButton()?.click());
    expect(shownTitle()).toBe('Second ask');
    clock.t += 1000;
    act(() => nextButton()?.click());
    expect(shownTitle()).toBe('Third ask');
    clock.t += 1000;
    act(() => nextButton()?.click());
    expect(shownTitle()).toBe('First ask');
  });

  it('Next to a tab-sized request opens it as a tab and closes the pop-up', async () => {
    const openTab = vi.fn();
    setRequestOpeners({ openTab, openTerminal: vi.fn() });
    const light = view({
      id: 'a',
      title: 'Light ask',
      waiting: true,
      waitingUntil: '2026-11-14T10:05:00.000Z',
    });
    const heavy = view({ id: 'b', kind: 'review', title: 'Draft', draft: 'line' });
    setRequests([light, heavy]);
    await mount();
    act(() => requestPopup.open('a'));
    act(() => nextButton()?.click());
    expect(openTab).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
    expect(popupEl()).toBeNull();
    setRequestOpeners(null);
  });

  it('answering the last request closes the pop-up', async () => {
    const only = view({
      id: 'a',
      kind: 'choose',
      title: 'Only ask',
      options: [{ label: 'X' }, { label: 'Y' }],
    });
    setRequests([only]);
    await mount();
    act(() => requestPopup.open('a'));
    act(() => host.querySelector<HTMLInputElement>('input[data-key]')?.click());
    act(() => host.querySelector<HTMLButtonElement>('.reqtpl-send__btn')?.click());
    const answered = { ...only, state: 'answered' as const };
    emit({ type: 'mcp:requestResult', requestId: 'a', result: { ok: true, request: answered } });
    setRequests([], [answered]);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 450));
    });
    expect(requestPopup.current()).toBeNull();
    expect(popupEl()).toBeNull();
  });

  it('it closes when the request disappears', async () => {
    const a = view({ id: 'a' });
    setRequests([a, view({ id: 'b' })]);
    await mount();
    act(() => requestPopup.open('a'));
    expect(popupEl()).not.toBeNull();
    setRequests([view({ id: 'b' })]);
    expect(popupEl()).toBeNull();
    expect(requestPopup.current()).toBeNull();
  });
});
