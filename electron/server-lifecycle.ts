import { join } from 'node:path';
import type { HcClient, HcEvent } from '../src/contracts/hc';
import {
  APP_HELLO_TIMEOUT_MS,
  SERVER_PROTOCOL_GENERATION,
  SERVER_RESTART_EXIT_WAIT_MS,
  type ServerEvents,
  type ServerMethods,
  STOP_ALL_ANSWER_TIMEOUT_MS,
  versionOrder,
} from '../src/contracts/server-protocol';
import type { InstanceNames } from '../src/contracts/session-identity';
import type { AppLaunch } from '../src/contracts/tray-protocol';
import { HcRpcError } from '../src/hc-client';
import { type HcCliDeps, killSupervisor, startSupervisor, supervisorArgs } from './hc-cli';
import type { createHcEvents } from './hc-events';
import type { RuntimeLayout } from './runtime-layout';
import { type AppLog, ServerCallError, type ServerClient } from './server-client';

type Hello = ServerMethods['hello']['result'];

export type ServerLifecycleState =
  | { state: 'connecting' }
  | { state: 'connected'; hello: Hello }
  /** C2 down, supervisor live: input paused. */
  | { state: 'reconnecting' }
  | {
      state: 'unavailable';
      reason:
        | 'exhausted'
        | 'hello-timeout'
        | 'restart-wait-timeout'
        | 'start-failed'
        | 'hc-unresponsive';
      logPath: string;
      detail?: string;
    }
  /** D26 */
  | { state: 'downgrade'; serverVersion: string }
  /** F9 budget spent. */
  | { state: 'stopped'; reason: string; logPath: string };

export interface ServerLifecycleDeps {
  names: InstanceNames;
  layout: RuntimeLayout;
  userData: string;
  appVersion: string;
  serverArgs: string[];
  app?: AppLaunch;
  client: () => ServerClient;
  hc: HcClient;
  hcEvents: ReturnType<typeof createHcEvents>;
  cli: HcCliDeps;
  markerExists(): Promise<boolean>;
  deleteMarker(): Promise<void>;
  spawnDetachedSupervisor(args?: string[]): void;
  now(): number;
  log: AppLog;
}

/** F9: a supervisor that vanishes more often than this is left stopped until a person retries. */
export const VANISHED_RESTART_BUDGET = { attempts: 3, windowMs: 60 * 60_000 } as const;

const RECONNECT_BACKOFF_MS = { first: 500, max: 5_000 } as const;
const SUPERVISOR_LOOKUP_TIMEOUT_MS = 5_000;
const ENDED: ReadonlySet<HcEvent['type']> = new Set(['finished', 'lost', 'removed']);

class SupervisorLookupTimeout extends Error {}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The app's side of D17/F6/F9: it starts a supervisor only by the start rule, never kills one
 * without an explicit user action (restartService), and identifies it only by its unique hc name
 * and the address hello reports, never by the forgeable role label.
 */
export function createServerLifecycle(d: ServerLifecycleDeps): {
  start(): Promise<void>;
  current(): ServerLifecycleState;
  client(): ServerClient | null;
  onState(cb: (s: ServerLifecycleState) => void): () => void;
  onConnected(cb: (c: ServerClient) => void): () => void;
  retry(): Promise<void>;
  restartService(): Promise<void>;
  stopAllAndContinue(): Promise<void>;
  noteStopping(reason: ServerEvents['server.stopping']['reason']): void;
  stopAll(): Promise<{ ok: boolean; killed?: number; reason?: string }>;
  dispose(): void;
} {
  const logPath = join(d.userData, 'server.log');
  const stateListeners = new Set<(s: ServerLifecycleState) => void>();
  const connectedListeners = new Set<(c: ServerClient) => void>();
  let state: ServerLifecycleState = { state: 'connecting' };
  /** The open connection, also while `downgrade` (stopAllAndContinue needs it). */
  let conn: ServerClient | null = null;
  let connHello: Hello | null = null;
  let offWatch: (() => void) | null = null;
  let vanishedAt: number[] = [];
  // See docs/specs/2026-11-03-tray-helper.md F3a.
  let orderlyEnd = false;
  const tray = d.layout.trayExe && d.app ? { source: d.layout.trayExe, app: d.app } : undefined;
  /** Every transition bumps it; an async step that finds it moved stops. */
  let epoch = 0;
  let disposed = false;

  const begin = () => ++epoch;
  const live = (e: number) => e === epoch && !disposed;

  const set = (s: ServerLifecycleState) => {
    state = s;
    for (const cb of [...stateListeners]) {
      try {
        cb(s);
      } catch (error) {
        d.log('error', 'server-lifecycle: state listener threw', { err: String(error) });
      }
    }
  };
  const unavailable = (
    reason: Extract<ServerLifecycleState, { state: 'unavailable' }>['reason'],
    detail?: string,
  ) => {
    d.log('warn', 'server unavailable', { reason, detail });
    set({ state: 'unavailable', reason, logPath, ...(detail ? { detail } : {}) });
  };

  const drop = () => {
    offWatch?.();
    offWatch = null;
    conn?.close();
    conn = null;
    connHello = null;
  };

  /** By the unique name; the role label decides nothing. */
  const supervisorLive = async (
    e: number,
  ): Promise<'live' | 'absent' | 'unreachable' | 'timeout'> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const t = await Promise.race([
        d.hc.call('terminal.get', { terminal: d.names.supervisorName }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new SupervisorLookupTimeout('supervisor lookup timed out')),
            SUPERVISOR_LOOKUP_TIMEOUT_MS,
          );
        }),
      ]);
      if (live(e) && t.state === 'live') watch(t.address);
      return t.state === 'live' ? 'live' : 'absent';
    } catch (error) {
      if (error instanceof SupervisorLookupTimeout) return 'timeout';
      if (error instanceof HcRpcError && error.kind === 'not_found') return 'absent';
      return 'unreachable';
    } finally {
      clearTimeout(timer);
    }
  };

  /** Resolves true once `terminal` finished (or is gone), false at the timeout. */
  const waitFinished = (terminal: string, timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      let done = false;
      const finish = (finished: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        off();
        offSnapshot();
        resolve(finished);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      const off = d.hcEvents.on(terminal, (e) => {
        if (ENDED.has(e.type)) finish(true);
      });
      const offSnapshot = d.hcEvents.onSnapshot((terminals) => {
        if (!terminals.some((t) => t.address === terminal && t.state === 'live')) finish(true);
      });
      // Covers an end that came before the subscription was up.
      void d.hcEvents.ready().then(async () => {
        try {
          const t = await d.hc.call('terminal.get', { terminal });
          if (t.state !== 'live') finish(true);
        } catch (error) {
          if (error instanceof HcRpcError && error.kind === 'not_found') finish(true);
          // Anything else: the event or the timeout decides.
          else d.log('info', 'server-lifecycle: terminal.get failed', { err: String(error) });
        }
      });
    });

  const waitClosed = (c: ServerClient, timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve(false);
      }, timeoutMs);
      const off = c.onClose(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });

  /** F6: the old server and its supervisor are gone before a new one is started. */
  const awaitSupervisorExit = (c: ServerClient, hello: Hello | null) =>
    hello?.supervisor
      ? waitFinished(hello.supervisor.terminal, SERVER_RESTART_EXIT_WAIT_MS)
      : waitClosed(c, SERVER_RESTART_EXIT_WAIT_MS);

  const stopAndWait = async (
    e: number,
    c: ServerClient,
    hello: Hello | null,
    method: 'server.restart' | 'server.stopAll',
  ): Promise<boolean> => {
    offWatch?.();
    offWatch = null;
    const exited = awaitSupervisorExit(c, hello);
    const reply =
      method === 'server.restart' ? c.call(method, { reason: 'update' }) : c.call(method, {});
    void reply.catch((error: unknown) => {
      d.log('info', `${method} reply lost; waiting for exit`, { err: String(error) });
    });
    const finished = await exited;
    if (!live(e)) return false;
    drop();
    if (!finished) unavailable('restart-wait-timeout');
    return finished;
  };

  const startRule = async (e: number): Promise<void> => {
    set({ state: 'connecting' });
    if (d.names.hcEndpointError) {
      unavailable('start-failed', d.names.hcEndpointError);
      return;
    }
    if (await d.markerExists()) {
      if (live(e)) unavailable('exhausted');
      return;
    }
    const supervisor = await supervisorLive(e);
    if (!live(e)) return;
    if (supervisor === 'timeout') {
      unavailable('hc-unresponsive');
      return;
    }
    if (supervisor !== 'live') {
      const run = await startSupervisor(d.cli, {
        names: d.names,
        nodeExe: d.layout.nodeExe,
        superviseJs: d.layout.superviseJs,
        userData: d.userData,
        serverArgs: d.serverArgs,
        tray,
      });
      if (!live(e)) return;
      // name_taken: a supervisor of this name is live after all (D21's rule for any hc name).
      if (!run.ok && !/name_taken|already named/i.test(run.reason)) {
        d.log('warn', 'starting the supervisor in hc failed; spawning it directly', {
          reason: run.reason,
        });
        d.spawnDetachedSupervisor(
          supervisorArgs(d.cli.hcExe, {
            superviseJs: d.layout.superviseJs,
            userData: d.userData,
            serverArgs: d.serverArgs,
            tray,
          }),
        );
      }
      const afterStart = await supervisorLive(e);
      if (!live(e)) return;
      if (afterStart === 'timeout') {
        unavailable('hc-unresponsive');
        return;
      }
    }
    await connect(e);
  };

  const connect = async (e: number): Promise<void> => {
    const deadline = d.now() + APP_HELLO_TIMEOUT_MS;
    let delay: number = RECONNECT_BACKOFF_MS.first;
    for (;;) {
      const c = d.client();
      conn = c;
      let hello: Hello;
      try {
        hello = await c.open();
      } catch (error) {
        c.close();
        if (!live(e)) return;
        if (error instanceof ServerCallError && error.kind === 'timeout')
          return unavailable('hello-timeout', error.message);
        const supervisor = await supervisorLive(e);
        if (!live(e)) return;
        if (supervisor === 'timeout') return unavailable('hc-unresponsive');
        if (supervisor === 'absent' && offWatch) return vanished();
        if (d.now() >= deadline) return unavailable('hello-timeout', String(error));
        await sleep(delay);
        delay = Math.min(delay * 2, RECONNECT_BACKOFF_MS.max);
        if (!live(e)) return;
        continue;
      }
      if (!live(e)) {
        c.close();
        return;
      }
      return greeted(e, c, hello);
    }
  };

  const greeted = async (e: number, c: ServerClient, hello: Hello): Promise<void> => {
    orderlyEnd = false;
    conn = c;
    connHello = hello;
    const order = versionOrder(
      { generation: SERVER_PROTOCOL_GENERATION, version: d.appVersion },
      { generation: hello.generation, version: hello.serverVersion },
    );
    if (hello.supervisor) watch(hello.supervisor.terminal);
    if (order === 'appOlder') {
      set({ state: 'downgrade', serverVersion: hello.serverVersion });
      return;
    }
    if (order === 'appNewer') {
      d.log('info', 'server is older; restarting it', { serverVersion: hello.serverVersion });
      if (await stopAndWait(e, c, hello, 'server.restart')) return startRule(e);
      return;
    }
    c.onClose(() => {
      if (conn === c && live(e)) void lostConnection();
    });
    set({ state: 'connected', hello });
    for (const cb of [...connectedListeners]) {
      try {
        cb(c);
      } catch (error) {
        d.log('error', 'server-lifecycle: onConnected listener threw', { err: String(error) });
      }
    }
  };

  /** F9: a supervisor that ends on its own (no marker) is restarted, within the budget. */
  const watch = (terminal: string) => {
    offWatch?.();
    const offEvent = d.hcEvents.on(terminal, (ev) => {
      if (ENDED.has(ev.type) && offWatch === off) void vanished();
    });
    const offSnapshot = d.hcEvents.onSnapshot((terminals) => {
      const supervisor = terminals.find(
        (t) => t.name === d.names.supervisorName && t.address === terminal,
      );
      if (offWatch === off && supervisor?.state !== 'live') void vanished();
    });
    const off = () => {
      offEvent();
      offSnapshot();
    };
    offWatch = off;
  };

  const vanished = async (): Promise<void> => {
    const e = begin();
    drop();
    if (await d.markerExists()) {
      if (live(e)) unavailable('exhausted');
      return;
    }
    if (!live(e)) return;
    if (orderlyEnd) {
      d.log('info', 'orderly end: no restart budget spent');
      orderlyEnd = false;
      await startRule(e);
      return;
    }
    const now = d.now();
    vanishedAt = vanishedAt.filter((t) => now - t < VANISHED_RESTART_BUDGET.windowMs);
    vanishedAt.push(now);
    if (vanishedAt.length > VANISHED_RESTART_BUDGET.attempts) {
      d.log('error', "Conduit's background service stopped", { restarts: vanishedAt.length });
      set({
        state: 'stopped',
        reason: `after ending ${vanishedAt.length} times within an hour`,
        logPath,
      });
      return;
    }
    await startRule(e);
  };

  const restoreAfterFailedStop = (
    e: number,
    c: ServerClient,
    hello: Hello | null,
    closed: boolean,
  ) => {
    if (!live(e)) return;
    if (closed) {
      void lostConnection();
      return;
    }
    const resumed = begin();
    c.onClose(() => {
      if (conn === c && live(resumed)) void lostConnection();
    });
    if (hello?.supervisor) watch(hello.supervisor.terminal);
  };

  /** C2 dropped: the supervisor restarts the server itself, so the app only reopens. */
  const lostConnection = async (): Promise<void> => {
    const e = begin();
    conn = null;
    connHello = null;
    set({ state: 'reconnecting' });
    const supervisor = await supervisorLive(e);
    if (!live(e)) return;
    if (supervisor === 'timeout') {
      unavailable('hc-unresponsive');
      return;
    }
    if (supervisor === 'absent') {
      await vanished();
      return;
    }
    let delay: number = RECONNECT_BACKOFF_MS.first;
    for (;;) {
      await sleep(delay);
      if (!live(e)) return;
      if (await d.markerExists()) {
        if (live(e)) {
          drop();
          unavailable('exhausted');
        }
        return;
      }
      if (!live(e)) return;
      const c = d.client();
      conn = c;
      try {
        const hello = await c.open();
        if (!live(e)) {
          c.close();
          return;
        }
        return greeted(e, c, hello);
      } catch (error) {
        c.close();
        if (!live(e)) return;
        if (error instanceof ServerCallError && error.kind === 'timeout') {
          drop();
          unavailable('hello-timeout', error.message);
          return;
        }
        if (!(error instanceof ServerCallError) || error.kind !== 'disconnected') {
          drop();
          unavailable('hello-timeout', String(error));
          return;
        }
        delay = Math.min(delay * 2, RECONNECT_BACKOFF_MS.max);
      }
    }
  };

  const fresh = (): number => {
    const e = begin();
    drop();
    return e;
  };

  return {
    noteStopping(reason) {
      if (reason === 'stopAll' || reason === 'idle') orderlyEnd = true;
    },
    async start() {
      await startRule(fresh());
    },
    current: () => state,
    client: () => (state.state === 'connected' ? conn : null),
    onState(cb) {
      stateListeners.add(cb);
      return () => stateListeners.delete(cb);
    },
    onConnected(cb) {
      connectedListeners.add(cb);
      return () => connectedListeners.delete(cb);
    },
    async retry() {
      const e = fresh();
      vanishedAt = [];
      await d.deleteMarker();
      if (live(e)) await startRule(e);
    },
    async restartService() {
      const e = fresh();
      if (d.names.hcEndpointError) return startRule(e);
      set({ state: 'connecting' });
      const killed = await killSupervisor(d.cli, d.names);
      if (!killed.ok) d.log('warn', 'hc kill of the supervisor failed', { reason: killed.reason });
      if (live(e)) await startRule(e);
    },
    async stopAllAndContinue() {
      const c = conn;
      const hello = connHello;
      const e = begin();
      offWatch?.();
      offWatch = null;
      set({ state: 'connecting' });
      if (!c) {
        if (live(e))
          unavailable('start-failed', 'server is not connected; agents were not stopped');
        return;
      }
      if (!(await stopAndWait(e, c, hello, 'server.stopAll'))) return;
      if (live(e)) await startRule(e);
    },
    async stopAll() {
      const c = conn;
      if (!c) return { ok: false, reason: 'The background service is unavailable.' };
      const e = begin();
      const hello = connHello;
      let closed = false;
      const offClose = c.onClose(() => {
        closed = true;
      });
      offWatch?.();
      offWatch = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), STOP_ALL_ANSWER_TIMEOUT_MS);
      });
      try {
        const r = await Promise.race([c.call('server.stopAll', {}), timeout]);
        if (r) return { ok: true, killed: r.killed };
        restoreAfterFailedStop(e, c, hello, closed);
        return { ok: false, reason: 'Timed out waiting for the agents to stop.' };
      } catch (error) {
        d.log('warn', 'server.stopAll failed', { err: String(error) });
        restoreAfterFailedStop(e, c, hello, closed);
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      } finally {
        clearTimeout(timer);
        offClose();
      }
    },
    dispose() {
      disposed = true;
      begin();
      drop();
      stateListeners.clear();
      connectedListeners.clear();
    },
  };
}
