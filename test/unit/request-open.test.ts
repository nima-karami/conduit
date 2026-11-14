import { describe, expect, it, vi } from 'vitest';
import type { RequestView } from '../../src/conduit-mcp/request-types';
import type { OpenAs } from '../../webview/request-open';
import { createRequestOpen } from '../../webview/request-open';

function view(over: Partial<RequestView> & Pick<RequestView, 'id'>): RequestView {
  return {
    origin: 'machine-a',
    source: 'agent',
    kind: 'confirm',
    requester: 'conduit',
    session: 'sess-1',
    space: null,
    lead: null,
    machine: 'machine-a',
    title: 'Proceed?',
    body: 'Run the migration?',
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
    ...over,
  };
}

function harness(kinds: Record<string, OpenAs>, requests: RequestView[]) {
  const openTab = vi.fn();
  const openTerminal = vi.fn();
  const openAs = vi.fn((r: RequestView) => kinds[r.id] ?? 'popup');
  const api = createRequestOpen({ openAs, requests: () => requests });
  api.setRequestOpeners({ openTab, openTerminal });
  return { ...api, openTab, openTerminal, openAs };
}

describe('openRequest', () => {
  it('a light request opens the pop-up', () => {
    const h = harness({ light: 'popup' }, [view({ id: 'light' })]);
    expect(h.openRequest('light')).toBe(true);
    expect(h.requestPopup.current()).toBe('light');
    expect(h.openTab).not.toHaveBeenCalled();
    expect(h.openTerminal).not.toHaveBeenCalled();
  });

  it('a tab request calls openTab', () => {
    const r = view({ id: 'review-1', kind: 'review' });
    const h = harness({ 'review-1': 'tab' }, [r]);
    expect(h.openRequest('review-1')).toBe(true);
    expect(h.openTab).toHaveBeenCalledWith(r);
    expect(h.requestPopup.current()).toBeNull();
  });

  it('asTab forces a tab except for attend', () => {
    const light = view({ id: 'light' });
    const attend = view({ id: 'attend-1', kind: 'attend', blocked: 'permission' });
    const h = harness({ light: 'popup', 'attend-1': 'terminal' }, [light, attend]);

    expect(h.openRequest('light', { asTab: true })).toBe(true);
    expect(h.openTab).toHaveBeenCalledWith(light);
    expect(h.requestPopup.current()).toBeNull();

    expect(h.openRequest('attend-1', { asTab: true })).toBe(true);
    expect(h.openTerminal).toHaveBeenCalledWith('sess-1');
    expect(h.openTab).toHaveBeenCalledTimes(1);
  });

  it('an attend opens the terminal', () => {
    const attend = view({ id: 'attend-1', kind: 'attend', blocked: 'question', session: 'sess-9' });
    const h = harness({ 'attend-1': 'terminal' }, [attend]);
    expect(h.openRequest('attend-1')).toBe(true);
    expect(h.openTerminal).toHaveBeenCalledWith('sess-9');
    expect(h.openTab).not.toHaveBeenCalled();
  });

  it('an unknown id returns false', () => {
    const h = harness({}, [view({ id: 'known' })]);
    expect(h.openRequest('missing')).toBe(false);
    expect(h.openTab).not.toHaveBeenCalled();
    expect(h.openTerminal).not.toHaveBeenCalled();
    expect(h.requestPopup.current()).toBeNull();
  });
});
