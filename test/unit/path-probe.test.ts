import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostToWebview, WebviewToHost } from '../../src/protocol';

vi.mock('monaco-editor', () => ({
  Uri: { parse: (s: string) => ({ toString: () => s, path: s }) },
  editor: { getModel: () => null },
  languages: {},
  typescript: {},
}));

import { PROBE_TIMEOUT_MS, type ProbeTransport, probePathExists } from '../../webview/path-probe';

type Reply = Extract<HostToWebview, { type: 'pathExistsResult' }>;

function fakeTransport(onPost?: (msg: WebviewToHost, emit: (m: HostToWebview) => void) => void) {
  const subs = new Set<(m: HostToWebview) => void>();
  const posted: WebviewToHost[] = [];
  const emit = (m: HostToWebview) => {
    for (const cb of [...subs]) cb(m);
  };
  const transport: ProbeTransport = {
    post(msg) {
      posted.push(msg);
      onPost?.(msg, emit);
    },
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
  return { transport, emit, posted, subs };
}

const reply = (path: string, exists: boolean, isDir = false): Reply => ({
  type: 'pathExistsResult',
  path,
  exists,
  isDir,
});

describe('probePathExists', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves true for a matching file reply', async () => {
    const t = fakeTransport();
    const p = probePathExists('C:/w/a.ts', t.transport);
    expect(t.posted).toEqual([{ type: 'pathExists', path: 'C:\\w\\a.ts' }]);
    t.emit(reply('C:\\w\\a.ts', true));
    await expect(p).resolves.toBe(true);
  });

  it('resolves false for a missing file', async () => {
    const t = fakeTransport();
    const p = probePathExists('/w/a.ts', t.transport);
    t.emit(reply('/w/a.ts', false));
    await expect(p).resolves.toBe(false);
  });

  it('resolves false for isDir', async () => {
    const t = fakeTransport();
    const p = probePathExists('/w/dir', t.transport);
    t.emit(reply('/w/dir', true, true));
    await expect(p).resolves.toBe(false);
  });

  it('ignores a reply for another path', async () => {
    const t = fakeTransport();
    let settled: boolean | undefined;
    const p = probePathExists('/w/a.ts', t.transport).then((v) => {
      settled = v;
      return v;
    });
    t.emit(reply('/w/other.ts', true));
    await Promise.resolve();
    expect(settled).toBeUndefined();
    t.emit(reply('/w/a.ts', true));
    await expect(p).resolves.toBe(true);
  });

  it('resolves false after PROBE_TIMEOUT_MS with no reply', async () => {
    const t = fakeTransport();
    let settled: boolean | undefined;
    const p = probePathExists('/w/a.ts', t.transport).then((v) => {
      settled = v;
      return v;
    });
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe(false);
  });

  it('unsubscribes after settling', async () => {
    const t = fakeTransport();
    const a = probePathExists('/w/a.ts', t.transport);
    t.emit(reply('/w/a.ts', true));
    await a;
    expect(t.subs.size).toBe(0);
    const b = probePathExists('/w/b.ts', t.transport);
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    await b;
    expect(t.subs.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('subscribes before posting', async () => {
    const t = fakeTransport((msg, emit) => {
      if (msg.type === 'pathExists') emit(reply(msg.path, true));
    });
    await expect(probePathExists('/w/a.ts', t.transport)).resolves.toBe(true);
  });
});
