/**
 * The timed-message scheduler (spec 2026-08-28-timed-messages §2 "The timer", "Lifecycle").
 * Owns the schedule set, ONE setTimeout, the waiting/settle machinery and the fire decision.
 *
 * Every dependency is injected — the clock, the timer, the liveness read, the write, the
 * persist and the broadcast — so this whole file is exercised without Electron and
 * electron/main.ts is left with wiring only. Node-free for the same reason as the model.
 *
 * The timer is NEVER the source of truth: every evaluation re-compares wall-clock `now`
 * against `nextAt`, so a timer that fired early, late, or not at all cannot produce a wrong
 * outcome. That is what makes `advanceClock` and the powerMonitor re-evaluation safe.
 */

import {
  advanceAfterFire,
  buildSchedule,
  capError,
  catchUp,
  type DueDecision,
  type FireFailure,
  LIMIT_MESSAGE,
  LIMIT_PADDING_MS,
  MAX_TOTAL,
  markWaiting,
  PTY_SETTLE_MS,
  renew,
  sanitizeMessage,
  type TimedMessage,
  type TimedMessageInput,
} from './timed-messages';

export interface FiredEvent {
  id: string;
  sessionId: string;
  at: number;
  late: boolean;
  delivered: boolean;
  reason?: FireFailure;
}

export interface SchedulerDeps {
  now(): number;
  setTimer(ms: number, fn: () => void): unknown;
  clearTimer(handle: unknown): void;
  isAlive(sessionId: string): boolean;
  /** Writes the message and then Enter into a LIVE PTY; resolves what actually landed. */
  deliver(sessionId: string, message: string): Promise<boolean>;
  sessionExists(sessionId: string): boolean;
  /** The set changed: persist it and broadcast timer:state. */
  onChange(): void;
  onFired(ev: FiredEvent): void;
  /** 0 under CONDUIT_E2E, so the smoke scenario can arm at +800 ms (§7). */
  minDelayMs: number;
  minIntervalMs: number;
}

export type SetResult = { ok: true; schedule: TimedMessage } | { ok: false; error: string };

/** setTimeout's ceiling. A longer wait is chunked; expiry re-arms from `nextAt`. */
const MAX_TIMEOUT_MS = 2_147_483_647;

export class TimerScheduler {
  private schedules: TimedMessage[] = [];
  private handle: unknown = null;
  /** Shifted only by `advanceClock`, which exists only under CONDUIT_E2E. */
  private clockOffset = 0;
  /** Per session: the instant its freshly started PTY is ready to be written to. */
  private readonly settleUntil = new Map<string, number>();
  /** Schedules with a delivery in flight — a second evaluate must not fire them again. */
  private readonly inFlight = new Set<string>();
  /**
   * One delivery at a time per SESSION. A delivery is two writes 120 ms apart, so two schedules
   * coming due together — which the restart catch-up makes deterministic, since every waiting
   * schedule for a session becomes deliverable at the same settle expiry — would otherwise
   * interleave into one garbled executed command. Send now joins the same queue.
   */
  private readonly sessionQueue = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: SchedulerDeps) {}

  private now(): number {
    return this.deps.now() + this.clockOffset;
  }

  list(): TimedMessage[] {
    return this.schedules;
  }

  /** Adopt the persisted set. Schedules for a session the manager no longer knows are dropped
   *  and never re-persisted (§4); nothing is written here, so the dirty gate stays closed. */
  load(schedules: readonly TimedMessage[]): void {
    this.schedules = schedules
      .filter((s) => s.state !== 'done' && this.deps.sessionExists(s.sessionId))
      .slice(0, MAX_TOTAL);
    this.evaluate();
  }

  set(input: TimedMessageInput): SetResult {
    if (!this.deps.sessionExists(input.sessionId)) {
      return { ok: false, error: 'That session is gone.' };
    }
    const editingId =
      input.id && this.schedules.some((s) => s.id === input.id) ? input.id : undefined;
    const cap = capError(this.schedules, input.sessionId, editingId);
    if (cap) return { ok: false, error: cap };

    const built = buildSchedule(input, this.now(), {
      minDelayMs: this.deps.minDelayMs,
      minIntervalMs: this.deps.minIntervalMs,
      ...(editingId ? { id: editingId } : {}),
    });
    if (!built.ok) return built;
    this.put(built.schedule, { insert: true });
    this.changed();
    return built;
  }

  /**
   * Auto-resume for a detected limit reset. Exactly ONE live limit schedule per session — a
   * session printing a notice a hundred times ends with one, not a hundred (§2 "Limit-aware").
   */
  armLimit(sessionId: string, resetAt: number): TimedMessage | null {
    if (!this.deps.sessionExists(sessionId)) return null;
    const now = this.now();
    const others = this.schedules.filter(
      (s) => !(s.sessionId === sessionId && s.origin === 'limit'),
    );
    if (capError(others, sessionId, undefined)) return null;
    const built = buildSchedule(
      {
        sessionId,
        message: LIMIT_MESSAGE,
        trigger: { kind: 'in', delayMs: Math.max(resetAt + LIMIT_PADDING_MS - now, 0) },
        origin: 'limit',
      },
      now,
      { minDelayMs: 0, minIntervalMs: this.deps.minIntervalMs },
    );
    if (!built.ok) return null;
    this.schedules = [...others, built.schedule];
    this.changed();
    return built.schedule;
  }

  cancel(id: string): boolean {
    const next = this.schedules.filter((s) => s.id !== id);
    if (next.length === this.schedules.length) return false;
    this.schedules = next;
    this.changed();
    return true;
  }

  renewSchedule(id: string): SetResult {
    const current = this.schedules.find((s) => s.id === id);
    if (!current) return { ok: false, error: 'That timed message is gone.' };
    const next = renew(current, this.now());
    if (!next) return { ok: false, error: 'That time could not be resolved again.' };
    this.put(next);
    this.changed();
    return { ok: true, schedule: next };
  }

  /** Deliver now. Consumes no repeat and does not move `nextAt` (§2 "The dialog"). */
  async sendNow(id: string): Promise<boolean> {
    const s = this.schedules.find((x) => x.id === id);
    if (!s) return false;
    return this.sendOnce(s.sessionId, s.message);
  }

  async sendOnce(sessionId: string, message: string): Promise<boolean> {
    const text = sanitizeMessage(message);
    // An empty message would press a bare Enter into someone's shell.
    if (!text) return false;
    return this.enqueue(sessionId, text);
  }

  /**
   * THE one place a message is handed to the write. Serialized per session, liveness re-read
   * inside the queue rather than before it (the process can exit while an earlier delivery is
   * still mid-flight), and the payload is sanitized here as well as at every boundary that
   * produced it — this is the last point before it becomes keystrokes.
   */
  private enqueue(sessionId: string, message: string): Promise<boolean> {
    const text = sanitizeMessage(message);
    if (!text) return Promise.resolve(false);
    const prior = this.sessionQueue.get(sessionId) ?? Promise.resolve();
    const run = prior.then(() =>
      this.deps.isAlive(sessionId) ? this.deps.deliver(sessionId, text) : false,
    );
    // The chain must not break on a rejected delivery, or every later fire on this session hangs.
    this.sessionQueue.set(
      sessionId,
      run.catch(() => false),
    );
    return run;
  }

  /**
   * That session's PTY just came up. Everything waiting on it delivers once the settle window
   * closes — a message written into a shell that has not printed its prompt is lost.
   */
  onPtyStart(sessionId: string): void {
    this.settleUntil.set(sessionId, this.now() + PTY_SETTLE_MS);
    this.arm();
  }

  onSessionDisposed(sessionId: string): void {
    this.settleUntil.delete(sessionId);
    this.sessionQueue.delete(sessionId);
    const next = this.schedules.filter((s) => s.sessionId !== sessionId);
    if (next.length === this.schedules.length) {
      this.arm();
      return;
    }
    this.schedules = next;
    this.changed();
  }

  /** CONDUIT_E2E only: shift the schedule clock so an interval or an expiry window can be
   *  proven in milliseconds instead of hours (§7). */
  advanceClock(ms: number): void {
    this.clockOffset += ms;
    this.evaluate();
  }

  stop(): void {
    if (this.handle === null) return;
    this.deps.clearTimer(this.handle);
    this.handle = null;
  }

  /**
   * Compare every schedule against the wall clock and act. Also the powerMonitor hook: a
   * suspend stops setTimeout but not the clock, so re-evaluating on resume is the whole fix.
   */
  evaluate(): void {
    const now = this.now();
    let mutated = false;

    for (const s of [...this.schedules]) {
      if (this.inFlight.has(s.id)) continue;
      const decision = catchUp(s, now);
      if (decision.action === 'wait') continue;

      if (!this.deps.isAlive(s.sessionId)) {
        // Due with no PTY: hold nextAt, write nothing, say so. The host never spawns one.
        const waiting = markWaiting(s, s.nextAt);
        if (waiting !== s) {
          this.put(waiting);
          mutated = true;
        }
        continue;
      }

      if (now < (this.settleUntil.get(s.sessionId) ?? 0)) continue; // re-armed below

      if (decision.action === 'skip') {
        const next = advanceAfterFire(s, now, {
          slots: decision.slots,
          late: true,
          delivered: false,
          reason: 'expired',
        });
        this.put(next);
        this.deps.onFired({
          id: s.id,
          sessionId: s.sessionId,
          at: now,
          late: true,
          delivered: false,
          reason: 'expired',
        });
        mutated = true;
        continue;
      }

      this.fire(s, decision);
    }

    if (mutated) this.deps.onChange();
    this.arm();
  }

  private fire(s: TimedMessage, decision: DueDecision): void {
    this.inFlight.add(s.id);
    void this.enqueue(s.sessionId, s.message).then((delivered) => {
      this.inFlight.delete(s.id);
      const at = this.now();
      this.put(
        advanceAfterFire(s, at, {
          slots: decision.slots,
          late: decision.late,
          delivered,
          ...(delivered ? {} : { reason: 'noSession' as const }),
        }),
      );
      this.deps.onFired({
        id: s.id,
        sessionId: s.sessionId,
        at,
        late: decision.late,
        delivered,
        ...(delivered ? {} : { reason: 'noSession' as const }),
      });
      this.deps.onChange();
      this.arm();
    });
  }

  private put(next: TimedMessage, opts: { insert?: boolean } = {}): void {
    const i = this.schedules.findIndex((s) => s.id === next.id);
    if (i >= 0) {
      this.schedules = this.schedules.map((s) => (s.id === next.id ? next : s));
      return;
    }
    if (opts.insert) this.schedules = [...this.schedules, next];
  }

  private changed(): void {
    this.deps.onChange();
    this.evaluate();
  }

  /**
   * One timer, to the earliest thing that could happen. A `waiting` schedule contributes none:
   * its window is applied when its PTY comes back, not on a clock (§4) — which is also what
   * keeps an idle app's timer set empty.
   */
  private arm(): void {
    this.stop();
    const now = this.now();
    let earliest = Number.POSITIVE_INFINITY;
    for (const s of this.schedules) {
      if (s.state === 'done' || s.state === 'waiting') continue;
      earliest = Math.min(earliest, Math.max(s.nextAt, now));
    }
    for (const at of this.settleUntil.values()) {
      if (at > now) earliest = Math.min(earliest, at);
    }
    if (!Number.isFinite(earliest)) return;
    const wait = Math.min(Math.max(earliest - now, 0), MAX_TIMEOUT_MS);
    this.handle = this.deps.setTimer(wait, () => {
      this.handle = null;
      this.evaluate();
    });
  }
}
