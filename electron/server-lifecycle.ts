import { join } from 'node:path';
import type { HcClient, HcEvent } from '../src/contracts/hc';
import {
  APP_HELLO_TIMEOUT_MS,
  SERVER_PROTOCOL_GENERATION,
  SERVER_RESTART_EXIT_WAIT_MS,
  type ServerMethods,
  STOP_ALL_ANSWER_TIMEOUT_MS,
  versionOrder,
} from '../src/contracts/server-protocol';
import type { InstanceNames } from '../src/contracts/session-identity';
import { HcRpcError } from '../src/hc-client';
import { type HcCliDeps, killSupervisor, startSupervisor } from './hc-cli';
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
      reason: 'exhausted' | 'hello-timeout' | 'restart-wait-timeout' | 'start-failed';
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
  client: () => ServerClient;
  hc: HcClient;
  hcEvents: ReturnType<typeof createHcEvents>;
  cli: HcCliDeps;
  markerExists(): Promise<boolean>;
  deleteMarker(): Promise<void>;
  spawnDetachedSupervisor(): void;
  now(): number;
  log: AppLog;
}

/** F9: a supervisor that vanishes more often than this is left stopped until a person retries. */
export const VANISHED_RESTART_BUDGET = { attempts: 3, windowMs: 60 * 60_000 } as const;

const RECONNECT_BACKOFF_MS = { first: 500, max: 5_000 } as const;
const ENDED: ReadonlySet<HcEvent['type']> = new Set(['finished', 'lost', 'removed']);

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
  stopAll(): Promise<{ ok: boolean; killed?: number }>;
  dispose(): void;
} {
  const logPath = join(d.userData, 'server.log');
  const stateListeners = new Set<(s: ServerLifecycleState) => void>();
  const connectedListeners = new Set<(c: ServerClient) => void>();
  let state: ServerLifecycleState = { state: 'connecting' };
  /** The open connection, also while `downgrade` (stopAllAndContinue needs it). */
  let conn: ServerClient | null = null;
  let offWatch: (() => void) | null = null;
  let vanishedAt: number[] = [];
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
  };

  /** By the unique name; the role label decides nothing. */
  const supervisorLive = async (): Promise<'live' | 'absent' | 'unreachable'> => {
    try {
      const t = await d.hc.call('terminal.get', { terminal: d.names.supervisorName });
      return t.state === 'live' ? 'live' : 'absent';
    } catch (error) {
      if (error instanceof HcRpcError && error.kind === 'not_found') return 'absent';
      return 'unreachable';
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
        resolve(finished);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      const off = d.hcEvents.on(terminal, (e) => {
        if (ENDED.has(e.type)) finish(true);
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
  const awaitSupervisorExit = (c: ServerClient, hello: Hello) =>
    hello.supervisor
      ? waitFinished(hello.supervisor.terminal, SERVER_RESTART_EXIT_WAIT_MS)
      : waitClosed(c, SERVER_RESTART_EXIT_WAIT_MS);

  const startRule = async (e: number): Promise<void> => {
    set({ state: 'connecting' });
    if (await d.markerExists()) {
      if (live(e)) unavailable('exhausted');
      return;
    }
    const supervisor = await supervisorLive();
    if (!live(e)) return;
    if (supervisor !== 'live') {
      const run = await startSupervisor(d.cli, {
        names: d.names,
        nodeExe: d.layout.nodeExe,
        superviseJs: d.layout.superviseJs,
        userData: d.userData,
        serverArgs: d.serverArgs,
      });
      if (!live(e)) return;
      // name_taken: a supervisor of this name is live after all (D21's rule for any hc name).
      if (!run.ok && !/name_taken|already named/i.test(run.reason)) {
        d.log('warn', 'hc run of the supervisor failed; spawning it directly', {
          reason: run.reason,
        });
        d.spawnDetachedSupervisor();
      }
    }
    await connect(e);
  };

  const connect = async (e: number): Promise<void> => {
    const deadline = d.now() + APP_HELLO_TIMEOUT_MS;
    let delay: number = RECONNECT_BACKOFF_MS.first;
    for (;;) {
      const c = d.client();
      let hello: Hello;
      try {
        hello = await c.open();
      } catch (error) {
        c.close();
        if (!live(e)) return;
        if (error instanceof ServerCallError && error.kind === 'timeout')
          return unavailable('hello-timeout', error.message);
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
    conn = c;
    const order = versionOrder(
      { generation: SERVER_PROTOCOL_GENERATION, version: d.appVersion },
      { generation: hello.generation, version: hello.serverVersion },
    );
    if (order === 'appOlder') {
      set({ state: 'downgrade', serverVersion: hello.serverVersion });
      return;
    }
    if (order === 'appNewer') {
      d.log('info', 'server is older; restarting it', { serverVersion: hello.serverVersion });
      const exited = awaitSupervisorExit(c, hello);
      try {
        await c.call('server.restart', { reason: 'update' });
      } catch (error) {
        // The server may exit before its reply lands; the exit wait decides.
        d.log('info', 'server.restart reply lost', { err: String(error) });
      }
      const finished = await exited;
      if (!live(e)) return;
      drop();
      if (!finished) return unavailable('restart-wait-timeout');
      return startRule(e);
    }
    if (hello.supervisor) watch(hello.supervisor.terminal);
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
    const off = d.hcEvents.on(terminal, (ev) => {
      if (ENDED.has(ev.type) && offWatch === off) void vanished();
    });
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
    const now = d.now();
    vanishedAt = vanishedAt.filter((t) => now - t < VANISHED_RESTART_BUDGET.windowMs);
    vanishedAt.push(now);
    if (vanishedAt.length > VANISHED_RESTART_BUDGET.attempts) {
      d.log('error', "Conduit's background service stopped", { restarts: vanishedAt.length });
      set({
        state: 'stopped',
        reason: `the background service ended ${vanishedAt.length} times within an hour`,
        logPath,
      });
      return;
    }
    await startRule(e);
  };

  /** C2 dropped: the supervisor restarts the server itself, so the app only reopens. */
  const lostConnection = async (): Promise<void> => {
    const e = begin();
    conn = null;
    set({ state: 'reconnecting' });
    const supervisor = await supervisorLive();
    if (!live(e)) return;
    if (supervisor === 'absent') {
      await vanished();
      return;
    }
    let delay: number = RECONNECT_BACKOFF_MS.first;
    for (;;) {
      await sleep(delay);
      if (!live(e)) return;
      const c = d.client();
      try {
        const hello = await c.open();
        if (!live(e)) {
          c.close();
          return;
        }
        return greeted(e, c, hello);
      } catch {
        c.close();
        if (!live(e)) return;
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
      set({ state: 'connecting' });
      const killed = await killSupervisor(d.cli, d.names);
      if (!killed.ok) d.log('warn', 'hc kill of the supervisor failed', { reason: killed.reason });
      if (live(e)) await startRule(e);
    },
    async stopAllAndContinue() {
      const c = conn;
      const hello = state.state === 'connected' ? state.hello : null;
      const e = begin();
      offWatch?.();
      offWatch = null;
      set({ state: 'connecting' });
      if (c) {
        const exited = hello
          ? awaitSupervisorExit(c, hello)
          : waitClosed(c, SERVER_RESTART_EXIT_WAIT_MS);
        try {
          await c.call('server.stopAll', {});
        } catch (error) {
          d.log('warn', 'server.stopAll failed', { err: String(error) });
        }
        const finished = await exited;
        if (!live(e)) return;
        drop();
        if (!finished) return unavailable('restart-wait-timeout');
      }
      if (live(e)) await startRule(e);
    },
    async stopAll() {
      const c = conn;
      if (!c) return { ok: false };
      begin();
      offWatch?.();
      offWatch = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), STOP_ALL_ANSWER_TIMEOUT_MS);
      });
      try {
        const r = await Promise.race([c.call('server.stopAll', {}), timeout]);
        return r ? { ok: true, killed: r.killed } : { ok: false };
      } catch (error) {
        d.log('warn', 'server.stopAll failed', { err: String(error) });
        return { ok: false };
      } finally {
        clearTimeout(timer);
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
