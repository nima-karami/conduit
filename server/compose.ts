import {
  SERVER_PROTOCOL_GENERATION,
  SERVER_SETTINGS_KEYS,
  type ServerLogging,
  type ServerMethods,
  type ServerSettings,
  type ServerSnapshot,
  versionOrder,
} from '../src/contracts/server-protocol';
import { formatRecord, type LogLevel, levelEnabled } from '../src/logging';
import { DEFAULT_SETTINGS } from '../src/settings';
import { ServerLifecycle, type ShellCore } from './lifecycle/shell';
import {
  type Peer,
  type PipeTransport,
  type RpcAnswer,
  RpcFault,
  type RpcHandler,
  RpcProtocolFault,
} from './transport/pipe';

/** Keyed by LogLevel so a level added to src/logging.ts fails to compile here instead of being refused. */
const LOG_LEVELS = {
  off: true,
  error: true,
  warn: true,
  info: true,
  debug: true,
  trace: true,
} as const satisfies Record<LogLevel, true>;

export function emptySnapshot(): Omit<ServerSnapshot, 'seq' | 'runtime'> {
  return {
    sessions: [],
    settings: Object.fromEntries(
      SERVER_SETTINGS_KEYS.map((key) => [key, DEFAULT_SETTINGS[key]]),
    ) as ServerSettings,
    stores: { agents: [], launchers: [], projects: [] },
    timers: { schedules: [], offer: null },
    mcp: {
      enabled: false,
      storeError: null,
      loading: false,
      sessions: {},
      threads: [],
      attention: [],
      youUnread: 0,
      youUrgent: 0,
      switchable: [],
      notConnected: {},
      awaitingApproval: [],
    },
    pendingAsks: [],
  };
}

export interface ComposeOptions {
  transport: PipeTransport;
  core: ShellCore;
  version: string;
  instance: string;
  logPath: string;
  supervisor?: { name: string; terminal: string };
  exit(code: number): Promise<void> | void;
  dispatch?: RpcHandler;
  /** A peer's connection closed: MCP's presence mirror and ask grace key on it (F7). */
  disconnected?: (peer: Peer) => void;
  writeLog?: (line: string) => void;
}

export function compose(options: ComposeOptions) {
  const logging: ServerLogging = {
    logging: DEFAULT_SETTINGS.logging,
    logLevel: DEFAULT_SETTINGS.logLevel,
  };
  const record = (
    level: Exclude<LogLevel, 'off'>,
    scope: string,
    msg: string,
    data?: Record<string, unknown>,
  ) => {
    if (logging.logging && levelEnabled(logging.logLevel, level)) {
      options.writeLog?.(
        formatRecord({ ts: Date.now(), level, scope, msg, ...(data ? { data } : {}) }),
      );
    }
  };
  const log = (level: Exclude<LogLevel, 'off'>, message: string) =>
    record(level, 'server', message);
  const lifecycle = new ServerLifecycle({
    ...options,
    emit: options.transport.emit,
    onError: (error) => log('error', String(error)),
  });
  options.transport.onConnect = () => lifecycle.connected();
  options.transport.onDisconnect = (peer) => {
    lifecycle.disconnected();
    options.disconnected?.(peer);
  };
  const handle: RpcHandler = (request, peer) => {
    const params = request.params;
    if (typeof params !== 'object' || params === null || Array.isArray(params))
      throw new RpcFault('invalid', 'Expected object params');
    const p = params as Record<string, unknown>;
    if (request.method === 'hello') {
      if (typeof p.appVersion !== 'string' || typeof p.generation !== 'number')
        throw new RpcFault('invalid', 'Invalid hello');
      peer.order = versionOrder(
        { generation: p.generation, version: p.appVersion },
        { generation: SERVER_PROTOCOL_GENERATION, version: options.version },
      );
      const result: ServerMethods['hello']['result'] = {
        serverVersion: options.version,
        generation: SERVER_PROTOCOL_GENERATION,
        instance: options.instance,
        pid: process.pid,
        ...(options.supervisor ? { supervisor: options.supervisor } : {}),
      };
      return { result };
    }
    if (!peer.order) throw new RpcFault('invalid', 'hello required');
    if (request.method === 'events.subscribe') {
      const result: ServerSnapshot = {
        ...options.core.snapshot(),
        seq: options.transport.seq,
        runtime: lifecycle.runtime,
      };
      peer.subscribed = true;
      return { result };
    }
    if (request.method === 'server.setLogging') {
      if (
        typeof p.logging !== 'boolean' ||
        typeof p.logLevel !== 'string' ||
        !Object.hasOwn(LOG_LEVELS, p.logLevel)
      )
        throw new RpcFault('invalid', 'Invalid logging settings');
      logging.logging = p.logging;
      logging.logLevel = p.logLevel as ServerLogging['logLevel'];
      return { result: {} };
    }
    if (request.method === 'server.restart' || request.method === 'server.stopAll') {
      const stopAll = request.method === 'server.stopAll';
      if (!stopAll && peer.order === 'appOlder')
        throw new RpcFault('refused', 'A newer Conduit is running its agents');
      if (!stopAll && p.reason !== 'update' && p.reason !== 'user')
        throw new RpcFault('invalid', 'Invalid restart reason');
      return lifecycle
        .stop(
          stopAll ? 'stopAll' : 'restart',
          stopAll ? 'stopAll' : (p.reason as 'update' | 'user'),
        )
        .then((stopped): RpcAnswer => {
          if (stopped.kind === 'late') return { reply: false };
          if (stopped.kind === 'failed') {
            log('error', `${request.method} failed: ${String(stopped.error)}`);
            return { error: stopped.error, afterReply: stopped.afterReply };
          }
          return {
            result: stopAll ? { killed: stopped.killed } : {},
            afterReply: stopped.afterReply,
          };
        });
    }
    if (lifecycle.stopping) {
      if (request.method === 'sessions.create')
        throw new RpcFault('server_stopping', 'Conduit is stopping');
      if (request.method === 'sessions.start' || request.method === 'sessions.retryLaunch') {
        return { result: { ok: false, refusal: { reason: 'server_stopping' } } };
      }
    }
    if (options.dispatch) return options.dispatch(request, peer);
    throw new RpcProtocolFault(-32601, 'Method not found');
  };
  return { lifecycle, handle, logging, log, record };
}
