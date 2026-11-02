import type { ServerEventSink } from '../../src/contracts/server-ports';
import {
  type RuntimeHealth,
  SERVER_STARTUP_DEADLINE_MS,
  type ServerSnapshot,
  STOP_KILL_PERSIST_BUDGET_MS,
} from '../../src/contracts/server-protocol';
import { SERVER_EXIT } from '../../src/contracts/session-identity';
import type { TerminalRuntime } from '../../src/contracts/terminal-runtime';

export interface ShellCore {
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
}

export class ServerLifecycle {
  runtime: RuntimeHealth = { state: 'starting' };
  stopping = false;
  private disposed = false;
  private connections = 0;
  private epoch = 0;
  private idlePending = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private stopPromise?: Promise<{ killed: number; afterReply(): Promise<void> }>;
  private stopMode?: 'restart' | 'stopAll';
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
    this.armIdle(10 * 60_000);
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
      }, 1_000);
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
    if (this.connections === 0) this.armIdle(10 * 60_000);
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
        this.armIdle(1_000);
        return;
      }
      this.idlePending = true;
      this.stopping = true;
      await this.options.core.persist();
      if (this.disposed || epoch !== this.epoch || this.connections || this.stopPromise) return;
      this.options.emit('server.stopping', { reason: 'idle' });
      await this.options.exit(SERVER_EXIT.doneCoreIdle);
    } catch (error) {
      this.idlePending = false;
      if (!this.stopPromise) this.stopping = false;
      this.health({ state: 'unavailable', reason: String(error), logPath: this.options.logPath });
      this.armIdle(1_000);
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.startupTimer);
    clearTimeout(this.retryTimer);
  }

  stop(mode: 'restart' | 'stopAll', reason: 'update' | 'user' | 'stopAll') {
    if (mode === 'stopAll' || !this.stopMode) this.stopMode = mode;
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.epoch++;
    clearTimeout(this.idleTimer);
    this.options.emit('server.stopping', { reason });
    this.stopPromise = this.finishStop(mode);
    return this.stopPromise;
  }

  private async finishStop(mode: 'restart' | 'stopAll') {
    await this.options.core.beginStopping(mode);
    if (mode !== this.stopMode) {
      mode = 'stopAll';
      await this.options.core.beginStopping(mode);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = async () => {
      for (;;) {
        const killed = mode === 'stopAll' ? await this.options.core.killSessions() : 0;
        await this.options.core.persist();
        if (mode === this.stopMode) return killed;
        mode = 'stopAll';
        await this.options.core.beginStopping(mode);
      }
    };
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('stop kill/persist timeout')),
        STOP_KILL_PERSIST_BUDGET_MS,
      );
    });
    let killed: number;
    try {
      killed = await Promise.race([work(), timeout]);
    } finally {
      clearTimeout(timer);
    }
    let exited = false;
    return {
      killed,
      afterReply: async () => {
        if (exited) return;
        exited = true;
        await this.options.exit(mode === 'stopAll' ? SERVER_EXIT.doneCoreIdle : SERVER_EXIT.done);
      },
    };
  }
}
