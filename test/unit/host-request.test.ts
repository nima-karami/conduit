import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostToWebview, WebviewToHost } from '../../src/protocol';

const h = vi.hoisted(() => ({
  posted: [] as WebviewToHost[],
  listeners: new Set<(m: HostToWebview) => void>(),
}));

vi.mock('../../webview/bridge', () => ({
  post: (m: WebviewToHost) => h.posted.push(m),
  subscribe: (cb: (m: HostToWebview) => void) => {
    h.listeners.add(cb);
    return () => h.listeners.delete(cb);
  },
}));

import { requestHost } from '../../webview/host-request';

const emit = (m: HostToWebview) => {
  for (const l of [...h.listeners]) l(m);
};

beforeEach(() => {
  vi.useFakeTimers();
  h.posted.length = 0;
  h.listeners.clear();
});
afterEach(() => vi.useRealTimers());

const pick = (requestId: number): WebviewToHost => ({ type: 'folder:pick', requestId });

describe('requestHost', () => {
  it('resolves the reply with its requestId, ignores others', async () => {
    const p = requestHost(pick, ['folder:picked'], 1000);
    const id = (h.posted[0] as { requestId: number }).requestId;
    emit({ type: 'folder:picked', requestId: id + 100, path: '/other' });
    emit({ type: 'folder:probeResult', requestId: id, results: [] });
    emit({ type: 'folder:picked', requestId: id, path: '/mine' });
    expect(await p).toEqual({ type: 'folder:picked', requestId: id, path: '/mine' });
    expect(h.listeners.size).toBe(0);
  });

  it('accepts any of several types', async () => {
    const p = requestHost(
      (requestId) => ({ type: 'project:create', name: 'x', requestId }),
      ['project:created', 'project:opResult'],
      1000,
    );
    const id = (h.posted[0] as { requestId: number }).requestId;
    emit({ type: 'project:opResult', requestId: id, ok: false, reason: 'invalid-name' });
    expect((await p)?.type).toBe('project:opResult');
  });

  it('null after timeout and unsubscribed', async () => {
    const p = requestHost(pick, ['folder:picked'], 500);
    expect(h.listeners.size).toBe(1);
    vi.advanceTimersByTime(500);
    expect(await p).toBeNull();
    expect(h.listeners.size).toBe(0);
  });

  it('ids increase per call', () => {
    void requestHost(pick, ['folder:picked'], 10);
    void requestHost(pick, ['folder:picked'], 10);
    const [a, b] = h.posted.map((m) => (m as { requestId: number }).requestId);
    expect(b).toBeGreaterThan(a);
  });
});
