import { describe, expect, it } from 'vitest';
import { createRemotePanes, type RemotePanesDeps } from '../../electron/remote-panes';
import { ServerCallError } from '../../electron/server-client';
import type { ServerEvents, ServerMethods } from '../../src/contracts/server-protocol';
import type { HostToWebview, WebviewToHost } from '../../src/protocol';

type RemoteMethod =
  | 'remote.attach'
  | 'remote.detach'
  | 'remote.input'
  | 'remote.resize'
  | 'remote.close';
type Results = { [M in RemoteMethod]: ServerMethods[M]['result'] };

const attachResult = (viewId: string): Results['remote.attach'] => ({
  viewId,
  firstPaint: 'paint',
  size: { cols: 80, rows: 24 },
  windowsPty: null,
  drive: true,
});

function rig() {
  const calls: Array<{ method: RemoteMethod; params: unknown }> = [];
  const sent: Array<{ windowId: number; message: HostToWebview }> = [];
  const logs: string[] = [];
  let nextView = 0;
  let failWith: { method: RemoteMethod; error: Error } | null = null;
  const results: Results = {
    'remote.attach': attachResult('view-0'),
    'remote.detach': {},
    'remote.input': {},
    'remote.resize': {},
    'remote.close': {},
  };
  const deps: RemotePanesDeps = {
    call: async <M extends RemoteMethod>(method: M, params: ServerMethods[M]['params']) => {
      calls.push({ method, params });
      if (failWith?.method === method) throw failWith.error;
      if (method === 'remote.attach') {
        nextView += 1;
        return attachResult(`view-${nextView}`);
      }
      return results[method];
    },
    sendTo: (windowId, message) => sent.push({ windowId, message }),
    log: (level, message) => logs.push(`${level}:${message}`),
  };
  return {
    panes: createRemotePanes(deps),
    calls,
    sent,
    logs,
    failNext: (method: RemoteMethod, error: Error) => {
      failWith = { method, error };
    },
  };
}

const attach = (
  machineId: string,
  sessionId: string,
  requestId = 1,
): Extract<WebviewToHost, { type: 'remote:attach' }> => ({
  type: 'remote:attach',
  requestId,
  machineId,
  sessionId,
});

const dataEvent = (viewId: string): ServerEvents['remote.data'] => ({ viewId, data: 'bytes' });

describe('remote panes routing', () => {
  it('routes data only to the window that attached', async () => {
    const { panes, sent } = rig();
    await panes.attach(1, attach('m', 'a'));
    await panes.attach(2, attach('m', 'b', 2));
    sent.length = 0;

    panes.data(dataEvent('view-1'));
    panes.state({ viewId: 'view-2', state: 'frozen', since: null, size: null });

    expect(sent).toEqual([
      { windowId: 1, message: { type: 'remote:data', viewId: 'view-1', data: 'bytes' } },
      {
        windowId: 2,
        message: {
          type: 'remote:state',
          viewId: 'view-2',
          state: 'frozen',
          since: null,
          size: null,
        },
      },
    ]);
  });

  it("a detach for another window's view is ignored", async () => {
    const { panes, calls, sent } = rig();
    await panes.attach(1, attach('m', 'a'));
    sent.length = 0;

    await panes.detach(2, 'view-1');

    expect(calls.some((c) => c.method === 'remote.detach')).toBe(false);
    panes.data(dataEvent('view-1'));
    expect(sent.map((s) => s.windowId)).toEqual([1]);
  });

  it('windowClosed detaches its views over C2', async () => {
    const { panes, calls, sent } = rig();
    await panes.attach(1, attach('m', 'a'));
    await panes.attach(1, attach('m', 'b', 2));
    await panes.attach(2, attach('m', 'c', 3));
    calls.length = 0;
    sent.length = 0;

    panes.windowClosed(1);
    await Promise.resolve();

    const detached = calls.filter((c) => c.method === 'remote.detach').map((c) => c.params);
    expect(detached).toEqual([{ viewId: 'view-1' }, { viewId: 'view-2' }]);
    panes.data(dataEvent('view-1'));
    panes.data(dataEvent('view-3'));
    expect(sent.map((s) => s.windowId)).toEqual([2]);
  });

  it('attach failure replies ok:false with the fault code', async () => {
    const { panes, failNext, sent } = rig();
    failNext('remote.attach', new ServerCallError('peer_unreachable', 'down'));

    await panes.attach(1, attach('m', 'a', 7));

    expect(sent).toEqual([
      {
        windowId: 1,
        message: {
          type: 'remote:attached',
          requestId: 7,
          result: { ok: false, error: 'peer_unreachable' },
        },
      },
    ]);
  });

  it('events for unknown viewIds are dropped', async () => {
    const { panes, sent } = rig();

    panes.data(dataEvent('never-attached'));
    panes.state({ viewId: 'never-attached', state: 'exited', since: null, size: null });

    expect(sent).toEqual([]);
  });

  it('close replies with the fault code of a refused close', async () => {
    const { panes, failNext, sent } = rig();
    failNext('remote.close', new ServerCallError('refused', 'shown locally'));

    await panes.close(1, { type: 'remote:close', requestId: 4, machineId: 'm', sessionId: 'a' });

    expect(sent).toEqual([
      { windowId: 1, message: { type: 'remote:closed', requestId: 4, error: 'refused' } },
    ]);
  });

  it('a view attached after its window closed is detached at once', async () => {
    const { panes, calls, sent } = rig();
    const pending = panes.attach(1, attach('m', 'a'));
    panes.windowClosed(1);
    await pending;

    expect(calls.map((c) => c.method)).toEqual(['remote.attach', 'remote.detach']);
    expect(calls[1].params).toEqual({ viewId: 'view-1' });
    expect(sent).toEqual([]);
  });

  it('a failed detach is logged, not thrown', async () => {
    const { panes, failNext, logs } = rig();
    await panes.attach(1, attach('m', 'a'));
    failNext('remote.detach', new ServerCallError('unavailable', 'gone'));

    await panes.detach(1, 'view-1');

    expect(logs).toEqual(['warn:remote detach failed']);
  });
});
