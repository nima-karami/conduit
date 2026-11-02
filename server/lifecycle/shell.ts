import type { ServerEventSink } from '../../src/contracts/server-ports';
import {
  type RuntimeHealth,
  SERVER_STARTUP_DEADLINE_MS,
  type ServerSnapshot,
  STOP_KILL_PERSIST_BUDGET_MS,
} from '../../src/contracts/server-protocol';
import { SERVER_EXIT } from '../../src/contracts/session-identity';
import type { TerminalRuntime } from '../../src/contracts/terminal-runtime';

/**
 * Outside SERVER_EXIT, so the supervisor counts it as a crash and restarts us; the replacement
 * reconciles and adopts (D21). A stop that failed must neither wedge the server nor claim success.
 */
export const STOP_FAILED_EXIT = 1;

export interface ShellCore {
  /**
   * Rejecting means "not reachable yet": the shell retries every second. Resolving is the runtime's
   * verdict, published as-is and not retried by the shell.
   */
  start(): Promise<RuntimeHealth>;
  beginStopping: TerminalRuntime['beginStopping'];
  killSessions(): Promise<number>;
  persist(): Promise<void>;
  idleState(): Promise<{ liveTerminals: number; pendingTimers: boolean; busyTokens: boolean }>;
  snapshot(): Omit<ServerSnapshot, 'seq' | 'runtime'>;
}

export interface ShellOptions {
  core: ShellCore;
  logPath: string;
  emit: ServerEventSink;
  exit(code: number): Promise<void> | void;
  onError(error: unknown): void;
}

type StopMode = 'restart' | 'stopAll';
export type StopOutcome =
  | { kind: 'stopped'; killed: number; afterReply(): Promise<void> }
  | { kind: 'failed'; error: unknown; afterReply(): Promise<void> }
  /** A stopAll after a restart already decided not to kill: unanswered, so the client falls back (F12). */
  | { kind: 'late' };

const IDLE_EXIT_MS = 10 * 60_000;
const IDLE_RECHECK_MS = 1_000;
const START_RETRY_MS = 1_000;

export class ServerLifecycle {
  runtime: RuntimeHealth = { state: 'starting' };
  stopping = false;
  private disposed = false;
  private exited = false;
  private connections = 0;
  private epoch = 0;
  private idlePending = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private stopPromise?: Promise<StopOutcome>;
  private stopMode: StopMode = 'restart';
  private frozenMode?: StopMode;
  constructor(readonly options: ShellOptions) {}

  start(): void {
    this.startupTimer = setTimeout(() => {
      if (this.runtime.state === 'starting')
        this.health({
          state: 'unavailable',
          reason: 'startup timeout',
          logPath: this.options.logPath,
        });
    }, SERVER_STARTUP_DEADLINE_MS);
    void this.tryStart();
    this.armIdle(IDLE_EXIT_MS);
  }

  private health(value: RuntimeHealth): void {
    if (this.disposed) return;
    this.runtime = value;
    this.options.emit('runtime.changed', value);
  }

  private async tryStart(): Promise<void> {
    try {
      const health = await this.options.core.start();
      if (this.disposed) return;
      this.health(health);
      clearTimeout(this.startupTimer);
    } catch (error) {
      if (this.disposed) return;
      this.health({ state: 'unavailable', reason: String(error), logPath: this.options.logPath });
      this.retryTimer = setTimeout(() => {
        void this.tryStart();
      }, START_RETRY_MS);
    }
  }

  connected(): void {
    this.connections++;
    this.epoch++;
    clearTimeout(this.idleTimer);
    if (this.idlePending) {
      this.idlePending = false;
      this.stopping = false;
    }
  }

  disconnected(): void {
    this.connections = Math.max(0, this.connections - 1);
    if (this.connections === 0) this.armIdle(IDLE_EXIT_MS);
  }

  private armIdle(delay: number): void {
    clearTimeout(this.idleTimer);
    if (this.connections || this.disposed || this.stopPromise) return;
    this.idleTimer = setTimeout(() => {
      void this.idle();
    }, delay);
  }

  private async idle(): Promise<void> {
    const epoch = this.epoch;
    try {
      const busy = await this.options.core.idleState();
      if (this.disposed || this.connections || epoch !== this.epoch || this.stopPromise) return;
      if (busy.liveTerminals || busy.pendingTimers || busy.busyTokens) {
        this.armIdle(IDLE_RECHECK_MS);
        return;
      }
      this.idlePending = true;
      this.stopping = true;
      await this.options.core.persist();
      if (this.disposed || epoch !== this.epoch || this.connections || this.stopPromise) return;
      this.options.emit('server.stopping', { reason: 'idle' });
      await this.exitOnce(SERVER_EXIT.doneCoreIdle);
    } catch (error) {
      this.idlePending = false;
      if (!this.stopPromise) this.stopping = false;
      this.options.onError(error);
      this.armIdle(IDLE_RECHECK_MS);
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.startupTimer);
    clearTimeout(this.retryTimer);
  }

  private async exitOnce(code: number): Promise<void> {
    if (this.exited) return;
    this.exited = true;
    await this.options.exit(code);
  }

  stop(mode: StopMode, reason: 'update' | 'user' | 'stopAll'): Promise<StopOutcome> {
    if (this.stopPromise) {
      if (mode === 'stopAll' && this.stopMode === 'restart') {
        if (this.frozenMode) return Promise.resolve({ kind: 'late' });
        this.stopMode = 'stopAll';
        this.options.emit('server.stopping', { reason: 'stopAll' });
      }
      return this.stopPromise;
    }
    this.stopMode = mode;
    this.stopping = true;
    this.epoch++;
    clearTimeout(this.idleTimer);
    this.options.emit('server.stopping', { reason });
    this.stopPromise = this.finishStop(mode);
    return this.stopPromise;
  }

  private async finishStop(first: StopMode): Promise<StopOutcome> {
    try {
      await this.options.core.beginStopping(first);
      if (this.stopMode !== first) await this.options.core.beginStopping(this.stopMode);
      const mode = this.stopMode;
      this.frozenMode = mode;
      const killed = await withinBudget(async () => {
        const count = mode === 'stopAll' ? await this.options.core.killSessions() : 0;
        await this.options.core.persist();
        return count;
      });
      return {
        kind: 'stopped',
        killed,
        afterReply: () =>
          this.exitOnce(mode === 'stopAll' ? SERVER_EXIT.doneCoreIdle : SERVER_EXIT.done),
      };
    } catch (error) {
      return { kind: 'failed', error, afterReply: () => this.exitOnce(STOP_FAILED_EXIT) };
    }
  }
}

async function withinBudget<T>(work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('stop kill/persist timeout')),
      STOP_KILL_PERSIST_BUDGET_MS,
    );
  });
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
