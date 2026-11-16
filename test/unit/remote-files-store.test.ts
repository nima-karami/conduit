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

import { listRemoteDir, readRemoteFile, watchRemote } from '../../webview/remote-files-store';

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

describe('remote files store', () => {
  it('list/read map timeouts to error timeout', async () => {
    const list = listRemoteDir('M1', 'S1', '/home/me/p');
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(list).resolves.toEqual({ ok: false, error: 'timeout' });

    const read = readRemoteFile('M1', 'S1', '/home/me/p/a.txt');
    await vi.advanceTimersByTimeAsync(29_999);
    let settled = false;
    void read.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(read).resolves.toEqual({ ok: false, error: 'timeout' });
  });

  it('list answers with B entries or B error, keyed by the request id', async () => {
    const pending = listRemoteDir('M1', 'S1', '/home/me/p');
    const sent = h.posted[h.posted.length - 1];
    if (sent?.type !== 'remoteFs:list') throw new Error('no list request posted');
    emit({
      type: 'remoteFs:listed',
      requestId: sent.requestId,
      result: { ok: true, path: '/home/me/p', entries: [{ name: 'a.txt', kind: 'file' }] },
    });
    await expect(pending).resolves.toEqual({
      ok: true,
      entries: [{ name: 'a.txt', kind: 'file' }],
    });

    const denied = listRemoteDir('M1', 'S1', '/etc');
    const again = h.posted[h.posted.length - 1];
    if (again?.type !== 'remoteFs:list') throw new Error('no list request posted');
    emit({
      type: 'remoteFs:listed',
      requestId: again.requestId,
      result: { ok: false, error: 'refused' },
    });
    await expect(denied).resolves.toEqual({ ok: false, error: 'refused' });
  });

  it('watchRemote posts watch once and unwatch on cleanup', () => {
    const key = 'remote:M1:S1|dir|/home/me/p';
    const seen: string[][] = [];
    const first = watchRemote(key, 'M1', 'S1', '/home/me/p', (paths) => seen.push(paths));
    const second = watchRemote(key, 'M1', 'S1', '/home/me/p', () => {});
    const watches = h.posted.filter((m) => m.type === 'remoteFs:watch');
    expect(watches).toEqual([
      { type: 'remoteFs:watch', key, machineId: 'M1', sessionId: 'S1', path: '/home/me/p' },
    ]);

    emit({ type: 'remoteFs:changed', key, paths: ['/home/me/p/a.txt'] });
    expect(seen).toEqual([['/home/me/p/a.txt']]);

    first();
    first();
    expect(h.posted.filter((m) => m.type === 'remoteFs:unwatch')).toEqual([]);
    second();
    expect(h.posted.filter((m) => m.type === 'remoteFs:unwatch')).toEqual([
      { type: 'remoteFs:unwatch', key },
    ]);

    emit({ type: 'remoteFs:changed', key, paths: ['/home/me/p/b.txt'] });
    expect(seen).toEqual([['/home/me/p/a.txt']]);
  });
});
