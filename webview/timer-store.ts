import type { FireFailure, LimitOffer, TimedMessage, TimedMessageInput } from '../src/protocol';
import { post, subscribe } from './bridge';

/**
 * Renderer mirror of the host's timed messages (spec 2026-08-28-timed-messages §3). A
 * module-singleton external store, mirroring review-marks-store.ts: the chip, the dialog, the
 * stale card and the rail read it with useSyncExternalStore, and the host stays the single owner.
 *
 * `loaded` is the LOAD GATE: every control is disabled until the first push lands, so a click
 * during startup can't be silently dropped or overwritten by the snapshot that follows.
 *
 * Nothing is applied optimistically. Unlike a review mark — a local toggle the host echoes — a
 * schedule's `nextAt` is DERIVED host-side (§3), so a local guess would show a time the host
 * never agreed to.
 */

export interface FireRecord {
  id: string;
  sessionId: string;
  at: number;
  late: boolean;
  delivered: boolean;
  reason?: FireFailure;
}

export interface TimerSnapshot {
  loaded: boolean;
  schedules: readonly TimedMessage[];
  offer: LimitOffer | null;
  /** The most recent fire per session — the chip's `late` flash reads this. */
  fires: ReadonlyMap<string, FireRecord>;
}

/**
 * What just happened, as opposed to what is true now. `timer:state` alone cannot distinguish an
 * auto-arm from an edit from a fire, and §10 allows exactly six announcements — so the diff is
 * done here, once, rather than in every consumer.
 */
export type TimerEvent =
  | { kind: 'armed'; schedule: TimedMessage }
  | { kind: 'autoArmed'; schedule: TimedMessage }
  | { kind: 'cancelled'; schedule: TimedMessage }
  | { kind: 'waiting'; schedule: TimedMessage }
  | { kind: 'fired'; fire: FireRecord; schedule?: TimedMessage }
  | { kind: 'error'; message: string };

type Listener = () => void;
type EventListener = (e: TimerEvent) => void;

const EMPTY: TimerSnapshot = { loaded: false, schedules: [], offer: null, fires: new Map() };

let snapshot: TimerSnapshot = EMPTY;
const listeners = new Set<Listener>();
const eventListeners = new Set<EventListener>();

function emit(e: TimerEvent): void {
  eventListeners.forEach((l) => {
    l(e);
  });
}

function notify(next: TimerSnapshot): void {
  snapshot = next;
  listeners.forEach((l) => {
    l();
  });
}

function applyState(schedules: TimedMessage[], offer: LimitOffer | null): void {
  const previous = snapshot;
  notify({ loaded: true, schedules, offer, fires: previous.fires });
  // The FIRST push is the restore, not news: a schedule that came back waiting was announced
  // when it happened, in the run that armed it.
  if (!previous.loaded) return;
  const before = new Map(previous.schedules.map((s) => [s.id, s]));
  for (const s of schedules) {
    const was = before.get(s.id);
    if (!was && s.state !== 'done') {
      emit(
        s.origin === 'limit' ? { kind: 'autoArmed', schedule: s } : { kind: 'armed', schedule: s },
      );
    } else if (s.state === 'waiting' && was?.state !== 'waiting') {
      emit({ kind: 'waiting', schedule: s });
    }
  }
  const now = new Set(schedules.map((s) => s.id));
  // A record that simply vanished was cancelled — cancel deletes, there is no cancelled state.
  for (const was of previous.schedules) {
    if (!now.has(was.id)) emit({ kind: 'cancelled', schedule: was });
  }
}

subscribe((msg) => {
  if (msg.type === 'timer:state') {
    applyState(msg.schedules, msg.offer);
    return;
  }
  if (msg.type === 'timer:fired') {
    const fire: FireRecord = {
      id: msg.id,
      sessionId: msg.sessionId,
      at: msg.at,
      late: msg.late,
      delivered: msg.delivered,
      ...(msg.reason ? { reason: msg.reason } : {}),
    };
    const fires = new Map(snapshot.fires);
    fires.set(fire.sessionId, fire);
    notify({ ...snapshot, fires });
    emit({ kind: 'fired', fire, schedule: snapshot.schedules.find((s) => s.id === fire.id) });
    return;
  }
  if (msg.type === 'timer:error') emit({ kind: 'error', message: msg.message });
});

export function subscribeTimers(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function subscribeTimerEvents(cb: EventListener): () => void {
  eventListeners.add(cb);
  return () => {
    eventListeners.delete(cb);
  };
}

export function getTimerSnapshot(): TimerSnapshot {
  return snapshot;
}

export function schedulesFor(snap: TimerSnapshot, sessionId: string): TimedMessage[] {
  return snap.schedules.filter((s) => s.sessionId === sessionId);
}

/** Everything still on the clock — what the chip renders from. */
export function liveSchedulesFor(snap: TimerSnapshot, sessionId: string): TimedMessage[] {
  return snap.schedules.filter((s) => s.sessionId === sessionId && s.state !== 'done');
}

/** The Waiting count behind the stale card's line and the rail badge (§2 "Waiting"). */
export function waitingCountFor(snap: TimerSnapshot, sessionId: string): number {
  return snap.schedules.filter((s) => s.sessionId === sessionId && s.state === 'waiting').length;
}

export function armTimedMessage(schedule: TimedMessageInput): void {
  post({ type: 'timer:set', schedule });
}

export function cancelTimedMessage(id: string): void {
  post({ type: 'timer:cancel', id });
}

export function renewTimedMessage(id: string): void {
  post({ type: 'timer:renew', id });
}

export function sendTimedMessageNow(id: string): void {
  post({ type: 'timer:sendNow', id });
}

export function sendMessageOnce(sessionId: string, message: string): void {
  post({ type: 'timer:sendOnce', sessionId, message });
}

export function resolveLimitOffer(sessionId: string, action: 'arm' | 'dismiss'): void {
  post({ type: 'timer:offer', sessionId, action });
}

/** Test-only: reset the singleton between cases. */
export function __resetTimerStoreForTest(): void {
  snapshot = EMPTY;
  listeners.clear();
  eventListeners.clear();
}
