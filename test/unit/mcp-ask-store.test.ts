import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostToWebview } from '../../src/protocol';

const bridge = vi.hoisted(() => ({
  listeners: [] as ((m: HostToWebview) => void)[],
  post: vi.fn(),
}));
vi.mock('../../webview/bridge', () => ({
  subscribe: (cb: (m: HostToWebview) => void) => {
    bridge.listeners.push(cb);
    return () => {};
  },
  post: bridge.post,
}));
const toast = vi.hoisted(() => ({ pushToast: vi.fn() }));
vi.mock('../../webview/toast-store', () => toast);

type Store = typeof import('../../webview/mcp-ask-store');
let store: Store;

function emit(m: HostToWebview): void {
  for (const l of bridge.listeners) l(m);
}

function ask(askId: string, handle = 'fake-1'): HostToWebview {
  return {
    type: 'mcp:ask',
    askId,
    callerSessionId: `s-${askId}`,
    callerHandle: handle,
    tool: 'open_session',
    summary: { tool: 'open_session', path: '/w', agent: 'claude', focus: true },
    args: { path: '/w' },
    source: 'global',
  };
}

beforeEach(async () => {
  vi.resetModules();
  bridge.listeners.length = 0;
  bridge.post.mockReset();
  toast.pushToast.mockReset();
  store = await import('../../webview/mcp-ask-store');
});

describe('mcp-ask-store', () => {
  it('mcp:ask appends oldest first', () => {
    emit(ask('a1'));
    emit(ask('a2'));
    expect(store.getAsksSnapshot().map((a) => a.askId)).toEqual(['a1', 'a2']);
    expect(store.getAsksSnapshot()[0]).toEqual({
      askId: 'a1',
      callerSessionId: 's-a1',
      callerHandle: 'fake-1',
      tool: 'open_session',
      summary: { tool: 'open_session', path: '/w', agent: 'claude', focus: true },
      args: { path: '/w' },
      source: 'global',
    });
  });

  it('notifies subscribers on change and stops after unsubscribe', () => {
    const cb = vi.fn();
    const off = store.subscribeAsks(cb);
    emit(ask('a1'));
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    emit(ask('a2'));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('answerAsk posts mcp:askAnswer and removes it', () => {
    emit(ask('a1'));
    emit(ask('a2'));
    store.answerAsk('a1', 'approve');
    expect(bridge.post).toHaveBeenCalledWith({
      type: 'mcp:askAnswer',
      askId: 'a1',
      answer: 'approve',
    });
    expect(store.getAsksSnapshot().map((a) => a.askId)).toEqual(['a2']);
    expect(toast.pushToast).not.toHaveBeenCalled();
  });

  it('askClosed expired removes and toasts "Request from fake-1 expired"', () => {
    emit(ask('a1'));
    emit({ type: 'mcp:askClosed', askId: 'a1', outcome: 'expired' });
    expect(store.getAsksSnapshot()).toEqual([]);
    expect(toast.pushToast).toHaveBeenCalledWith({
      message: 'Request from fake-1 expired',
      variant: 'info',
    });
  });

  it('cancelled toasts the cancelled copy', () => {
    emit(ask('a1', 'codex-2'));
    emit({ type: 'mcp:askClosed', askId: 'a1', outcome: 'cancelled' });
    expect(store.getAsksSnapshot()).toEqual([]);
    expect(toast.pushToast).toHaveBeenCalledWith({
      message: 'Request from codex-2 was cancelled',
      variant: 'info',
    });
  });

  it('askClosed for an unknown id is ignored', () => {
    emit(ask('a1'));
    const before = store.getAsksSnapshot();
    emit({ type: 'mcp:askClosed', askId: 'nope', outcome: 'expired' });
    expect(store.getAsksSnapshot()).toBe(before);
    expect(toast.pushToast).not.toHaveBeenCalled();
  });

  it('requestAskFocus notifies focus subscribers', () => {
    const cb = vi.fn();
    const off = store.subscribeAskFocus(cb);
    store.requestAskFocus();
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    store.requestAskFocus();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
