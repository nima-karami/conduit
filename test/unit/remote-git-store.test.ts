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

import { remoteGit } from '../../webview/remote-git-store';

const emit = (m: HostToWebview) => {
  for (const l of [...h.listeners]) l(m);
};

beforeEach(() => {
  vi.useFakeTimers();
  h.posted.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  h.listeners.clear();
});

describe('remote git store', () => {
  it('timeout maps to error timeout', async () => {
    const pending = remoteGit('M1', 'S1', '/home/me/p', 'status', {});
    await vi.advanceTimersByTimeAsync(39_999);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: false, error: 'timeout' });
  });

  it('sends the request with its op, root and args, and resolves with B reply', async () => {
    const pending = remoteGit('M1', 'S1', '/home/me/p', 'log', { limit: 50 });
    const sent = h.posted[h.posted.length - 1];
    if (sent?.type !== 'remoteGit:request') throw new Error('no git request posted');
    expect(sent).toMatchObject({
      machineId: 'M1',
      sessionId: 'S1',
      root: '/home/me/p',
      op: 'log',
      args: { limit: 50 },
    });
    emit({
      type: 'remoteGit:result',
      requestId: sent.requestId + 1,
      result: { ok: false, error: 'not_for_me' },
    });
    emit({
      type: 'remoteGit:result',
      requestId: sent.requestId,
      result: { ok: false, error: 'refused' },
    });
    await expect(pending).resolves.toEqual({ ok: false, error: 'refused' });
  });
});
