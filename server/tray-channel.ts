import type { ServerEventSink } from '../src/contracts/server-ports';
import type { RuntimeHealth, ServerEvents } from '../src/contracts/server-protocol';
import {
  type ServerToSupervisor,
  TRAY_LIMITS,
  type TrayCounts,
} from '../src/contracts/tray-protocol';
import type { SessionStateFields } from '../src/session-icon';
import { type TrayNeeds, trayCounts } from '../src/tray-counts';
import type { ShellStopAll } from './compose';

// See docs/plans/2026-11-03-tray-helper.plan.md S5 and P8.
export const STOP_ALREADY_STOPPING = 'The background service is already stopping.';

export type TrayEvent = Parameters<ServerEventSink>;
export type TrayTap = (cb: (...event: TrayEvent) => void) => () => void;

export type TrayProc = Pick<NodeJS.Process, 'send' | 'on' | 'off' | 'connected'>;

type TraySessions = readonly (SessionStateFields & { id: string })[];
export interface TraySeed {
  sessions: TraySessions;
  needs: TrayNeeds;
  health: RuntimeHealth['state'];
}

export interface TrayChannelOptions {
  proc: TrayProc;
  tap: TrayTap;
  /** The count inputs as they stand now, read once at ready() for any input no event has set yet. */
  seed(): TraySeed;
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

  let sessions: TraySessions | null = null;
  let needs: TrayNeeds | null = null;
  let health: RuntimeHealth['state'] | null = null;
  let stopping: TrayCounts['stopping'] = null;
  let current: TrayCounts | null = null;
  let sent: TrayCounts | null = null;
  let announced = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const flush = (): void => {
    clearTimeout(timer);
    timer = undefined;
    if (disposed || !announced || current === null || (sent && sameCounts(sent, current))) return;
    sent = current;
    send({ type: 'counts', counts: current });
  };

  const recompute = (flushNow: boolean): void => {
    if (!announced || sessions === null || needs === null || health === null) return;
    current = trayCounts(sessions, health, stopping, needs);
    if (sent && sameCounts(sent, current)) return;
    // The server exits right after announcing a stop, so the stopping state cannot wait out a window.
    if (flushNow) flush();
    else timer ??= setTimeout(flush, TRAY_LIMITS.countsCoalesceMs);
  };

  const untap = options.tap((type, data) => {
    if (type === 'sessions.changed') {
      sessions = (data as { sessions: TraySessions }).sessions;
      recompute(false);
    } else if (type === 'ui.post') {
      const message = (data as ServerEvents['ui.post']).message;
      if (message.type === 'mcp:state') {
        needs = {
          openRequests: message.state.requests.open,
          waitingAsks: message.state.waitingAsks,
        };
        recompute(false);
      }
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
      // Events seen before ready already set their inputs; the seed fills only the rest.
      const seed = options.seed();
      sessions ??= seed.sessions;
      needs ??= seed.needs;
      health ??= seed.health;
      current = trayCounts(sessions, health, stopping, needs);
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
