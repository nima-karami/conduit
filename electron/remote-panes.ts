import type { ServerEvents, ServerMethods } from '../src/contracts/server-protocol';
import type { HostToWebview, WebviewToHost } from '../src/protocol';
import { faultCode } from './server-calls';

export type RemoteMethod =
  | 'remote.attach'
  | 'remote.detach'
  | 'remote.input'
  | 'remote.resize'
  | 'remote.close';
type Message<T extends WebviewToHost['type']> = Extract<WebviewToHost, { type: T }>;

export interface RemotePanesDeps {
  call<M extends RemoteMethod>(
    method: M,
    params: ServerMethods[M]['params'],
  ): Promise<ServerMethods[M]['result']>;
  sendTo(windowId: number, message: HostToWebview): void;
  log(level: 'info' | 'warn', message: string, data?: Record<string, unknown>): void;
}

export type RemotePanes = ReturnType<typeof createRemotePanes>;

/** Routes the remote pane's messages and C2 events; the window that attached a view owns it. */
export function createRemotePanes(d: RemotePanesDeps) {
  /** viewId → the window that attached it: the only route for that view's data and state. */
  const owners = new Map<string, number>();
  /** Attaches still awaiting C2, so a window that closes mid-attach cannot leave a view behind. */
  const inFlight = new Set<{ windowId: number; closed: boolean }>();

  const releaseOverC2 = async (viewId: string): Promise<void> => {
    try {
      await d.call('remote.detach', { viewId });
    } catch (error) {
      d.log('warn', 'remote detach failed', { viewId, err: String(error) });
    }
  };

  const detach = async (windowId: number, viewId: string): Promise<void> => {
    if (owners.get(viewId) !== windowId) return;
    owners.delete(viewId);
    await releaseOverC2(viewId);
  };

  const attach = async (windowId: number, m: Message<'remote:attach'>): Promise<void> => {
    const pending = { windowId, closed: false };
    inFlight.add(pending);
    let result: ServerMethods['remote.attach']['result'];
    try {
      result = await d.call('remote.attach', { machineId: m.machineId, sessionId: m.sessionId });
    } catch (error) {
      inFlight.delete(pending);
      d.log('warn', 'remote attach failed', {
        machineId: m.machineId,
        sessionId: m.sessionId,
        err: String(error),
      });
      d.sendTo(windowId, {
        type: 'remote:attached',
        requestId: m.requestId,
        result: { ok: false, error: faultCode(error) },
      });
      return;
    }
    inFlight.delete(pending);
    if (pending.closed) {
      void releaseOverC2(result.viewId);
      return;
    }
    owners.set(result.viewId, windowId);
    d.sendTo(windowId, {
      type: 'remote:attached',
      requestId: m.requestId,
      result: { ok: true, ...result },
    });
  };

  const close = async (windowId: number, m: Message<'remote:close'>): Promise<void> => {
    try {
      await d.call('remote.close', { machineId: m.machineId, sessionId: m.sessionId });
    } catch (error) {
      d.log('warn', 'remote close failed', {
        machineId: m.machineId,
        sessionId: m.sessionId,
        err: String(error),
      });
      d.sendTo(windowId, {
        type: 'remote:closed',
        requestId: m.requestId,
        error: faultCode(error),
      });
      return;
    }
    d.sendTo(windowId, { type: 'remote:closed', requestId: m.requestId, error: null });
  };

  // Keystrokes and resizes are fire-and-forget (the pane never waits on them), so their failures
  // are logged here rather than replied.
  const logFailure =
    (action: 'remote input' | 'remote resize', m: { machineId: string; sessionId: string }) =>
    (error: unknown): void =>
      d.log('warn', `${action} failed`, {
        machineId: m.machineId,
        sessionId: m.sessionId,
        err: String(error),
      });

  const input = (m: Message<'remote:input'>): void => {
    d.call('remote.input', { machineId: m.machineId, sessionId: m.sessionId, data: m.data }).catch(
      logFailure('remote input', m),
    );
  };

  const resize = (m: Message<'remote:resize'>): void => {
    d.call('remote.resize', {
      machineId: m.machineId,
      sessionId: m.sessionId,
      cols: m.cols,
      rows: m.rows,
    }).catch(logFailure('remote resize', m));
  };

  // An event can outlive its view (a detach races the last frame of output), so an unowned one
  // is dropped rather than sent to whichever window last looked.
  const routeToOwner = (viewId: string, message: HostToWebview): void => {
    const windowId = owners.get(viewId);
    if (windowId === undefined) return;
    d.sendTo(windowId, message);
  };

  return {
    attach,
    detach,
    input,
    resize,
    close,
    data: (e: ServerEvents['remote.data']): void =>
      routeToOwner(e.viewId, { type: 'remote:data', ...e }),
    state: (e: ServerEvents['remote.state']): void =>
      routeToOwner(e.viewId, { type: 'remote:state', ...e }),
    windowClosed(windowId: number): void {
      for (const pending of inFlight) if (pending.windowId === windowId) pending.closed = true;
      for (const [viewId, owner] of [...owners]) if (owner === windowId) void detach(owner, viewId);
    },
  };
}
