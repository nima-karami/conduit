import { describe, expect, it } from 'vitest';
import {
  createRemoteFiles,
  type RemoteFilesDeps,
  type RemoteFsMethod,
} from '../../electron/remote-files';
import { ServerCallError } from '../../electron/server-client';
import type { ServerEvents, ServerMethods } from '../../src/contracts/server-protocol';
import type { FileContentDTO, HostToWebview, WebviewToHost } from '../../src/protocol';

const file: FileContentDTO = {
  path: '/w/a.txt',
  content: 'hello',
  language: 'plaintext',
  truncated: false,
  binary: false,
};

function rig() {
  const calls: Array<{ method: RemoteFsMethod; params: unknown }> = [];
  const sent: Array<{ windowId: number; message: HostToWebview }> = [];
  const logs: string[] = [];
  let nextWatch = 0;
  let failWith: { method: RemoteFsMethod; error: Error } | null = null;
  // Each watch mints a fresh watch id, so a test can tell the watches apart.
  const replies: { [M in RemoteFsMethod]: () => ServerMethods[M]['result'] } = {
    'remote.fs.list': () => ({ path: '/w', entries: [{ name: 'a.txt', kind: 'file' }] }),
    'remote.fs.read': () => file,
    'remote.fs.stat': () => ({ kind: 'file', size: 5, mtimeMs: 0 }),
    'remote.fs.watch': () => {
      nextWatch += 1;
      return { watchId: `w-${nextWatch}` };
    },
    'remote.fs.unwatch': () => ({}),
  };
  const deps: RemoteFilesDeps = {
    call: async <M extends RemoteFsMethod>(method: M, params: ServerMethods[M]['params']) => {
      calls.push({ method, params });
      if (failWith?.method === method) throw failWith.error;
      return replies[method]();
    },
    sendTo: (windowId, message) => sent.push({ windowId, message }),
    log: (level, message) => logs.push(`${level}:${message}`),
  };
  return {
    files: createRemoteFiles(deps),
    calls,
    sent,
    logs,
    failNext: (method: RemoteFsMethod, error: Error) => {
      failWith = { method, error };
    },
  };
}

const watchMsg = (key: string): Extract<WebviewToHost, { type: 'remoteFs:watch' }> => ({
  type: 'remoteFs:watch',
  key,
  machineId: 'm',
  sessionId: 's',
  path: '/w',
});

const changeEvent = (watchId: string): ServerEvents['remote.fs.changed'] => ({
  watchId,
  paths: ['/w/a.txt'],
});

describe('remote files routing', () => {
  it('list replies to the asking window with entries', async () => {
    const { files, calls, sent } = rig();

    await files.list(1, {
      type: 'remoteFs:list',
      requestId: 3,
      machineId: 'm',
      sessionId: 's',
      path: '/w',
    });

    expect(calls).toEqual([
      { method: 'remote.fs.list', params: { machineId: 'm', sessionId: 's', path: '/w' } },
    ]);
    expect(sent).toEqual([
      {
        windowId: 1,
        message: {
          type: 'remoteFs:listed',
          requestId: 3,
          result: { ok: true, path: '/w', entries: [{ name: 'a.txt', kind: 'file' }] },
        },
      },
    ]);
  });

  it('a failed read replies ok:false with the fault code', async () => {
    const { files, failNext, sent } = rig();
    failNext('remote.fs.read', new ServerCallError('refused', 'outside the session'));

    await files.read(1, {
      type: 'remoteFs:read',
      requestId: 5,
      machineId: 'm',
      sessionId: 's',
      path: '/etc/passwd',
    });

    expect(sent).toEqual([
      {
        windowId: 1,
        message: {
          type: 'remoteFs:content',
          requestId: 5,
          result: { ok: false, error: 'refused' },
        },
      },
    ]);
  });

  it('changed reaches only the window that watched', async () => {
    const { files, sent } = rig();
    await files.watch(1, watchMsg('a'));
    await files.watch(2, watchMsg('b'));
    sent.length = 0;

    files.changed(changeEvent('w-1'));

    expect(sent).toEqual([
      {
        windowId: 1,
        message: { type: 'remoteFs:changed', key: 'a', paths: ['/w/a.txt'] },
      },
    ]);
  });

  it('unwatch from another window is ignored', async () => {
    const { files, calls, sent } = rig();
    await files.watch(1, watchMsg('a'));
    sent.length = 0;

    files.unwatch(2, 'a');

    expect(calls.some((c) => c.method === 'remote.fs.unwatch')).toBe(false);
    files.changed(changeEvent('w-1'));
    expect(sent.map((s) => s.windowId)).toEqual([1]);
  });

  it('windowClosed unwatches its keys over C2', async () => {
    const { files, calls, sent } = rig();
    await files.watch(1, watchMsg('a'));
    await files.watch(1, watchMsg('b'));
    await files.watch(2, watchMsg('c'));
    calls.length = 0;
    sent.length = 0;

    files.windowClosed(1);

    const unwatched = calls.filter((c) => c.method === 'remote.fs.unwatch').map((c) => c.params);
    expect(unwatched).toEqual([{ watchId: 'w-1' }, { watchId: 'w-2' }]);
    files.changed(changeEvent('w-1'));
    files.changed(changeEvent('w-3'));
    expect(sent.map((s) => s.windowId)).toEqual([2]);
  });

  it('a watch that resolves after its window closed is unwatched', async () => {
    const { files, calls, sent } = rig();

    const pending = files.watch(1, watchMsg('a'));
    files.windowClosed(1);
    await pending;

    expect(calls.map((c) => c.method)).toEqual(['remote.fs.watch', 'remote.fs.unwatch']);
    expect(calls[1].params).toEqual({ watchId: 'w-1' });
    files.changed(changeEvent('w-1'));
    expect(sent).toEqual([]);
  });

  it('re-watching a key replaces the old watch', async () => {
    const { files, calls, sent } = rig();
    await files.watch(1, watchMsg('a'));

    await files.watch(1, watchMsg('a'));

    expect(calls.map((c) => c.method)).toEqual([
      'remote.fs.watch',
      'remote.fs.unwatch',
      'remote.fs.watch',
    ]);
    expect(calls[1].params).toEqual({ watchId: 'w-1' });
    sent.length = 0;
    files.changed(changeEvent('w-1'));
    files.changed(changeEvent('w-2'));
    expect(sent).toEqual([
      { windowId: 1, message: { type: 'remoteFs:changed', key: 'a', paths: ['/w/a.txt'] } },
    ]);
  });
});
