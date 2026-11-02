import {
  AGENT_CLIS,
  type McpInstallRequest,
  type McpInstallResult,
  type McpInstallStatus,
} from '../src/conduit-mcp/install-types';
import {
  APP_HELLO_TIMEOUT_MS,
  type ServerMethod,
  type ServerMethods,
} from '../src/contracts/server-protocol';
import type { HostToWebview, WebviewToHost } from '../src/protocol';
import { ServerCallError, type ServerClient } from './server-client';
import type { createServerLifecycle } from './server-lifecycle';

type Lifecycle = Pick<ReturnType<typeof createServerLifecycle>, 'current' | 'onState'>;
type ConnectionLifecycle = Pick<ReturnType<typeof createServerLifecycle>, 'current' | 'client'>;
const terminalState = (state: string) =>
  state === 'unavailable' || state === 'stopped' || state === 'downgrade';
const disconnected = () =>
  new ServerCallError('disconnected', "Conduit's background service is not connected");
const isServerDown = (error: unknown): error is ServerCallError =>
  error instanceof ServerCallError && (error.kind === 'disconnected' || error.kind === 'timeout');

export function serverDownReply(m: WebviewToHost, error: unknown): HostToWebview | undefined {
  if (!isServerDown(error) || !('requestId' in m) || typeof m.requestId !== 'number')
    return undefined;
  const { requestId } = m;
  switch (m.type) {
    case 'brief:probe':
      return { type: 'brief:probed', requestId, ok: false, error: 'brief-io' };
    case 'brief:agentPreview':
      return {
        type: 'brief:agentPreviewed',
        requestId,
        supported: false,
        has: false,
        error: 'brief-io',
      };
    case 'launch:preview':
      return {
        type: 'launch:previewResult',
        requestId,
        skippedAddDirRoots: [],
        error: 'unresolvable',
      };
    case 'session:addDirsToAgent':
    case 'session:restart':
      return {
        type: 'agentScope:result',
        requestId,
        sessionId: m.sessionId,
        ok: false,
        reason: 'notReady',
      };
    case 'launcher:addCustom':
      return { type: 'launcher:added', requestId, error: error.message };
    case 'project:create':
      return { type: 'project:opResult', requestId, ok: false, reason: 'store-unavailable' };
    case 'openRepo':
      return { type: 'openRepo:result', requestId, droppedRoots: [], error: 'server-unavailable' };
    case 'folder:probe':
      return { type: 'folder:probeResult', requestId, results: [], error: 'server-unavailable' };
    case 'session:addRoot':
    case 'session:removeRoot':
    case 'session:setHome':
    case 'session:setProject':
      return { type: 'session:opResult', requestId, ok: false, reason: 'server-unavailable' };
    case 'session:locateFolder':
      return { type: 'session:locateResult', requestId, ok: false, reason: 'server-unavailable' };
    default:
      return undefined;
  }
}

export function installDownStatus(error: unknown): McpInstallStatus {
  if (!isServerDown(error)) throw error;
  return {
    clis: AGENT_CLIS.map((cli) => ({
      cli,
      found: false,
      user: { state: 'error', path: '', errorCode: error.kind },
      project: null,
    })),
  };
}

export function installDownResult(request: McpInstallRequest, error: unknown): McpInstallResult {
  const status = installDownStatus(error).clis.find((s) => s.cli === request.cli);
  if (!status) throw error;
  return {
    ok: false,
    status,
    errorCode: error instanceof ServerCallError ? error.kind : 'disconnected',
  };
}

export function waitForServerSnapshot(
  snapshot: Promise<void>,
  lifecycle: Lifecycle,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      off();
      if (error) reject(error);
      else resolve();
    };
    const off = lifecycle.onState((s) => {
      if (terminalState(s.state)) finish(disconnected());
    });
    if (terminalState(lifecycle.current().state)) finish(disconnected());
    void snapshot.then(
      () => finish(),
      (error: unknown) => finish(error),
    );
  });
}

/** A person's action can wait for reconnect; terminal input continues to be dropped (D29). */
export function createServerCalls(lifecycle: () => ConnectionLifecycle | null) {
  const waiters = new Set<{ settle(c: ServerClient | null): void }>();
  const settle = (client: ServerClient | null) => {
    for (const waiter of [...waiters]) waiter.settle(client);
  };
  const whenConnected = (timeoutMs = APP_HELLO_TIMEOUT_MS): Promise<ServerClient> => {
    const current = lifecycle();
    const client = current?.client();
    if (client) return Promise.resolve(client);
    const state = current?.current().state ?? 'connecting';
    if (state !== 'connecting' && state !== 'reconnecting') return Promise.reject(disconnected());
    return new Promise((resolve, reject) => {
      const waiter = {
        settle: (connection: ServerClient | null) => {
          clearTimeout(timer);
          waiters.delete(waiter);
          if (connection) resolve(connection);
          else reject(disconnected());
        },
      };
      const timer = setTimeout(() => waiter.settle(null), timeoutMs);
      waiters.add(waiter);
    });
  };
  return {
    whenConnected,
    connected: (client: ServerClient) => settle(client),
    stateChanged: (s: ReturnType<Lifecycle['current']>) => {
      if (terminalState(s.state)) settle(null);
    },
    call: async <M extends ServerMethod>(
      method: M,
      params: ServerMethods[M]['params'],
    ): Promise<ServerMethods[M]['result']> => (await whenConnected()).call(method, params),
  };
}
