import type { ServerEventSink } from '../src/contracts/server-ports';
import type { RuntimeHealth } from '../src/contracts/server-protocol';
import {
  type ServerToSupervisor,
  TRAY_LIMITS,
  type TrayCounts,
} from '../src/contracts/tray-protocol';
import type { SessionStateFields } from '../src/session-icon';
import { trayCounts } from '../src/tray-counts';
import type { ShellStopAll } from './compose';

// See docs/plans/2026-11-03-tray-helper.plan.md S5 and P8.
export const STOP_ALREADY_STOPPING = 'The background service is already stopping.';

export type TrayEvent = Parameters<ServerEventSink>;
export type TrayTap = (cb: (...event: TrayEvent) => void) => () => void;

export type TrayProc = Pick<NodeJS.Process, 'send' | 'on' | 'off' | 'connected'>;

export interface TrayChannelOptions {
  proc: TrayProc;
  tap: TrayTap;
  initial(): TrayCounts;
  stopAll(): Promise<ShellStopAll>;
  log(message: string): void;
}

/** One tap on the transport's emit so the channel sees every event without a second subscription. */
export function createEventTap(emit: ServerEventSink): { emit: ServerEventSink; tap: TrayTap } {
  const listeners = new Set<(...event: TrayEvent) => void>();
  return {
    emit: (type, data) => {
      emit(type, data);
      for (const listener of [...listeners]) listener(type, data);
    },
    tap: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

function sameCounts(a: TrayCounts, b: TrayCounts): boolean {
  return (
    a.running === b.running &&
    a.needsYou === b.needsYou &&
    a.health === b.health &&
    a.stopping === b.stopping
  );
}

function stopAllId(message: unknown): number | null {
  if (typeof message !== 'object' || message === null) return null;
  const m = message as { type?: unknown; id?: unknown };
  return m.type === 'stopAll' && typeof m.id === 'number' ? m.id : null;
}

export function startTrayChannel(options: TrayChannelOptions): {
  ready(): void;
  dispose(): void;
} {
  const { proc } = options;
  if (typeof proc.send !== 'function') return { ready() {}, dispose() {} };

  const send = (message: ServerToSupervisor, done?: () => void): void => {
    if (!proc.connected || !proc.send) {
      done?.();
      return;
    }
    try {
      proc.send(message, (error) => {
        if (error) options.log(`tray channel send failed: ${error.message}`);
        done?.();
      });
    } catch (error) {
      options.log(`tray channel send failed: ${String(error)}`);
      done?.();
    }
  };

  let sessions: readonly SessionStateFields[] | null = null;
  let current = options.initial();
  let health = current.health;
  let stopping = current.stopping;
  let sent: TrayCounts | null = null;
  let announced = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const flush = (): void => {
    clearTimeout(timer);
    timer = undefined;
    if (disposed || !announced || (sent && sameCounts(sent, current))) return;
    sent = current;
    send({ type: 'counts', counts: current });
  };

  const recompute = (flushNow: boolean): void => {
    current = sessions ? trayCounts(sessions, health, stopping) : { ...current, health, stopping };
    if (!announced || (sent && sameCounts(sent, current))) return;
    // The server exits right after announcing a stop, so the stopping state cannot wait out a window.
    if (flushNow) flush();
    else timer ??= setTimeout(flush, TRAY_LIMITS.countsCoalesceMs);
  };

  const untap = options.tap((type, data) => {
    if (type === 'sessions.changed') {
      sessions = (data as { sessions: readonly SessionStateFields[] }).sessions;
      recompute(false);
    } else if (type === 'runtime.changed') {
      health = (data as RuntimeHealth).state;
      recompute(false);
    } else if (type === 'server.stopping') {
      stopping = (data as { reason: NonNullable<TrayCounts['stopping']> }).reason;
      recompute(true);
    }
  });

  const onMessage = (message: unknown): void => {
    const id = stopAllId(message);
    if (id === null) return;
    void options.stopAll().then(
      (outcome) => {
        if (outcome.kind === 'ok')
          send({ type: 'stopAllResult', id, ok: true, killed: outcome.killed }, () => {
            void outcome.afterReply();
          });
        else if (outcome.kind === 'late')
          send({ type: 'stopAllResult', id, ok: false, reason: STOP_ALREADY_STOPPING });
        else
          send({ type: 'stopAllResult', id, ok: false, reason: String(outcome.error) }, () => {
            void outcome.afterReply();
          });
      },
      (error: unknown) => send({ type: 'stopAllResult', id, ok: false, reason: String(error) }),
    );
  };
  proc.on('message', onMessage);

  return {
    ready() {
      if (disposed || announced) return;
      announced = true;
      // Events seen before ready already updated the tracked parts; initial() only seeds the sessions.
      if (!sessions) current = { ...options.initial(), health, stopping };
      send({ type: 'ready' });
      sent = current;
      send({ type: 'counts', counts: current });
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      untap();
      proc.off('message', onMessage);
    },
  };
}
