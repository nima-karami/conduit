import { describe, expect, it } from 'vitest';
import {
  createRemoteFiles,
  type RemoteFilesDeps,
  type RemoteFilesMethod,
} from '../../electron/remote-files';
import { ServerCallError, type ServerCallOptions } from '../../electron/server-client';
import type { ServerEvents, ServerMethods } from '../../src/contracts/server-protocol';
import type {
  FileContentDTO,
  HostToWebview,
  RemoteWriteResult,
  WebviewToHost,
} from '../../src/protocol';

const file: FileContentDTO = {
  path: '/w/a.txt',
  content: 'hello',
  language: 'plaintext',
  truncated: false,
  binary: false,
};

const gitValue: ServerMethods['remote.git']['result'] = { op: 'show', files: [], truncated: false };

function rig() {
  const calls: Array<{ method: RemoteFilesMethod; params: unknown; opts?: ServerCallOptions }> = [];
  const sent: Array<{ windowId: number; message: HostToWebview }> = [];
  const logs: string[] = [];
  let nextWatch = 0;
  let failWith: { method: RemoteFilesMethod; error: Error } | null = null;
  let writeReply: RemoteWriteResult = { kind: 'written', hash: 'h1' };
  // Each watch mints a fresh watch id, so a test can tell the watches apart.
  const replies: { [M in RemoteFilesMethod]: () => ServerMethods[M]['result'] } = {
    'remote.fs.list': () => ({ path: '/w', entries: [{ name: 'a.txt', kind: 'file' }] }),
    'remote.fs.read': () => file,
    'remote.fs.write': () => writeReply,
    'remote.fs.stat': () => ({ kind: 'file', size: 5, mtimeMs: 0 }),
    'remote.fs.watch': () => {
      nextWatch += 1;
      return { watchId: `w-${nextWatch}` };
    },
    'remote.fs.unwatch': () => ({}),
    'remote.git': () => gitValue,
  };
  const deps: RemoteFilesDeps = {
    call: async <M extends RemoteFilesMethod>(
      method: M,
      params: ServerMethods[M]['params'],
      opts?: ServerCallOptions,
    ) => {
      calls.push({ method, params, opts });
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
    failNext: (method: RemoteFilesMethod, error: Error) => {
      failWith = { method, error };
    },
    setWriteReply: (result: RemoteWriteResult) => {
      writeReply = result;
    },
  };
}

const writeMsg = (
  requestId: number,
  expect: string | null,
): Extract<WebviewToHost, { type: 'remoteFs:write' }> => ({
  type: 'remoteFs:write',
  requestId,
  machineId: 'm',
  sessionId: 's',
  path: '/w/a.txt',
  data: 'new text',
  expect,
});

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

  it('a git request replies to the asking window with the result', async () => {
    const { files, calls, sent } = rig();

    await files.git(1, {
      type: 'remoteGit:request',
      requestId: 7,
      machineId: 'm',
      sessionId: 's',
      root: '/w',
      op: 'show',
      args: { sha: 'abc123' },
    });

    expect(calls).toEqual([
      {
        method: 'remote.git',
        params: { machineId: 'm', sessionId: 's', root: '/w', op: 'show', args: { sha: 'abc123' } },
        opts: { timeoutMs: 35_000 },
      },
    ]);
    expect(sent).toEqual([
      {
        windowId: 1,
        message: {
          type: 'remoteGit:result',
          requestId: 7,
          result: { ok: true, value: gitValue },
        },
      },
    ]);
  });

  it('a failed git request replies ok:false with the fault code', async () => {
    const { files, failNext, sent } = rig();
    failNext('remote.git', new ServerCallError('timeout', 'remote.git: no reply within 35000 ms'));

    await files.git(2, {
      type: 'remoteGit:request',
      requestId: 8,
      machineId: 'm',
      sessionId: 's',
      root: '/w',
      op: 'status',
      args: {},
    });

    expect(sent).toEqual([
      {
        windowId: 2,
        message: {
          type: 'remoteGit:result',
          requestId: 8,
          result: { ok: false, error: 'timeout' },
        },
      },
    ]);
  });

  it('a written save replies to the asking window with its requestId', async () => {
    const { files, sent } = rig();

    await files.write(4, writeMsg(11, 'h0'));

    expect(sent).toEqual([
      {
        windowId: 4,
        message: {
          type: 'remoteFs:written',
          requestId: 11,
          result: { kind: 'written', hash: 'h1' },
        },
      },
    ]);
  });

  it('a conflict whose file is gone passes currentHash null through', async () => {
    const { files, setWriteReply, sent } = rig();
    setWriteReply({ kind: 'conflict', currentHash: null });

    await files.write(1, writeMsg(12, 'h0'));

    expect(sent).toEqual([
      {
        windowId: 1,
        message: {
          type: 'remoteFs:written',
          requestId: 12,
          result: { kind: 'conflict', currentHash: null },
        },
      },
    ]);
  });

  it('a failed write replies kind error with the fault code', async () => {
    const { files, failNext, sent } = rig();
    failNext(
      'remote.fs.write',
      new ServerCallError('peer_incompatible', 'B predates fs.write; update Conduit there'),
    );

    await files.write(1, writeMsg(13, null));

    expect(sent).toEqual([
      {
        windowId: 1,
        message: {
          type: 'remoteFs:written',
          requestId: 13,
          result: { kind: 'error', error: 'peer_incompatible' },
        },
      },
    ]);
  });

  it('the write reaches C2 with exactly the saved fields and the write budget', async () => {
    const { files, calls } = rig();

    await files.write(1, writeMsg(14, 'h0'));

    expect(calls).toEqual([
      {
        method: 'remote.fs.write',
        params: {
          machineId: 'm',
          sessionId: 's',
          path: '/w/a.txt',
          data: 'new text',
          expect: 'h0',
        },
        opts: { timeoutMs: 35_000 },
      },
    ]);
  });
});
