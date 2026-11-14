// see docs/specs/2026-11-13-scheduler-auto-resume.md §2 "Job states", R7, R8, R9

import {
  type DeliveryResult,
  JOB_HISTORY_MAX,
  type Job,
  type JobHistoryEntry,
  type JobState,
  type JobTrigger,
  type PreFireVerdict,
  TERMINAL_JOB_STATES,
} from './contracts/scheduler';
import { normalizeMessage } from './message-text';
import { parseJobTrigger } from './scheduler-store';
import {
  CATCHUP_MS,
  type FireFailure,
  LATE_GRACE_MS,
  type LastFire,
  MAX_EPOCH_MS,
  MAX_PER_SESSION,
  MAX_REPEATS,
  MAX_TOTAL,
  newTimedMessageId,
  nextFireAt,
  PTY_SETTLE_MS,
  type TimedMessage,
  type TimedMessageInput,
  type TriggerInput,
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
  sessionExists(sessionId: string): boolean;
  /** Runs only for limit-reset jobs, at fire time and again when a waiting job becomes deliverable. */
  preFire(job: Job): PreFireVerdict;
  /** Writes the message; the domain does normalisation, bracketing and joining. */
  deliver(job: Job): Promise<DeliveryResult>;
  onChange(): void;
  onFired(ev: FiredEvent): void;
  /** A limit-reset job reached `failed`; the monitor raises "needs you". */
  onJobFailed(job: Job, reason: string): void;
  verifyMs(): number;
  minDelayMs: number;
  minIntervalMs: number;
}

export type SetResult = { ok: true; job: Job } | { ok: false; error: string };

export interface ArmResumeInput {
  sessionId: string;
  episodeId: string;
  resetAt: number;
  marginMs: number;
  message: string;
  maxAttempts: number;
  proposed: boolean;
}

type LimitTrigger = Extract<JobTrigger, { kind: 'limit-reset' }>;
type Pending = 'not-live';

/** setTimeout's ceiling; a longer wait is clamped and evaluate() re-arms from nextAt. */
const MAX_TIMEOUT_MS = 2_147_483_647;
/** Time jobs never verify, so attempts only ever count limit-reset deliveries. */
const TIME_JOB_ATTEMPTS = 1;
const JOINED_REASON = 'lines joined (no bracketed paste)';
const NO_SESSION_REASON = 'no session';
/** The fixed fire vocabulary; the dialog reads it back through lastFire. */
const FIRE_OUTCOMES = [
  'delivered',
  'delivered late',
  'expired',
  'no session',
  'no session late',
] as const;
export type FireOutcome = (typeof FIRE_OUTCOMES)[number];

function isFireOutcome(v: string): v is FireOutcome {
  return FIRE_OUTCOMES.some((o) => o === v);
}

/** The IPC trigger, rebuilt from validated fields with the store's own rules, so an armed job always survives a restart. */
function timeTriggerOf(v: unknown): TriggerInput | null {
  const t = parseJobTrigger(v);
  return t && t.kind !== 'limit-reset' ? t : null;
}

function lastFireOf(entry: JobHistoryEntry & { reason: FireOutcome }): LastFire {
  const delivered = entry.reason === 'delivered' || entry.reason === 'delivered late';
  const late =
    entry.reason === 'delivered late' ||
    entry.reason === 'expired' ||
    entry.reason === 'no session late';
  if (delivered) return { at: entry.at, late, delivered };
  return {
    at: entry.at,
    late,
    delivered,
    reason: entry.reason === 'expired' ? 'expired' : 'noSession',
  };
}

const RESUME_BUSY_STATES: readonly JobState[] = ['checking', 'sending', 'verifying'];
const RESUME_DONE_STATES: readonly JobState[] = ['checking', 'sending', 'verifying', 'done'];
const RE_ARMED_REASON = 're-armed';

const isTerminal = (state: JobState): boolean => TERMINAL_JOB_STATES.includes(state);

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function limitTriggerOf(job: Job): LimitTrigger | null {
  return job.trigger.kind === 'limit-reset' ? job.trigger : null;
}

function withoutWaiting(job: Job): Job {
  if (job.waitingSince === undefined) return job;
  const next = { ...job };
  delete next.waitingSince;
  return next;
}

function repeatsOf(job: Job): number {
  return job.trigger.kind === 'every' ? job.trigger.maxRepeats : 1;
}

export class Scheduler {
  private jobs: Job[] = [];
  private handle: unknown = null;
  /** Shifted only by `advanceClock`, which exists only under CONDUIT_E2E. */
  private clockOffset = 0;
  private readonly settleUntil = new Map<string, number>();
  /** Jobs with a delivery in flight — a second evaluate must not fire them again. */
  private readonly inFlight = new Set<string>();
  /** Limit-reset jobs the pre-fire check deferred; only `recheck` re-runs them. */
  private readonly deferred = new Set<string>();
  // two jobs coming due together would otherwise interleave into one garbled command
  private readonly sessionQueue = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: SchedulerDeps) {}

  private now(): number {
    return this.deps.now() + this.clockOffset;
  }

  list(): Job[] {
    return this.jobs;
  }

  history(sessionId: string): Job[] {
    return this.jobs.filter((j) => j.sessionId === sessionId).reverse();
  }

  load(jobs: readonly Job[]): void {
    this.jobs = jobs.filter((j) => this.deps.sessionExists(j.sessionId));
    this.evaluate();
  }

  set(input: TimedMessageInput): SetResult {
    if (!this.deps.sessionExists(input.sessionId)) {
      return { ok: false, error: 'That session is gone.' };
    }
    if (input.origin === 'limit') {
      return { ok: false, error: 'Limit resumes are armed by the Limit monitor.' };
    }
    const trigger = timeTriggerOf(input.trigger);
    if (!trigger) return { ok: false, error: 'Unknown trigger.' };
    const editing = input.id === undefined ? undefined : this.find(input.id);
    if (editing && editing.trigger.kind === 'limit-reset') {
      return { ok: false, error: 'That timed message is gone.' };
    }
    // The in-flight fire would land on the edited schedule and consume it unsent.
    if (editing && this.inFlight.has(editing.id)) {
      return { ok: false, error: 'That message is being sent right now — try again in a moment.' };
    }
    const cap = this.capError(input.sessionId, editing?.id);
    if (cap) return { ok: false, error: cap };
    const check = normalizeMessage(input.message);
    if (!check.ok) return { ok: false, error: check.error };
    const triggerError = this.triggerError(trigger);
    if (triggerError) return { ok: false, error: triggerError };
    const now = this.now();
    const nextAt = nextFireAt(trigger, now);
    const lastSlot =
      nextAt === null || trigger.kind !== 'every'
        ? nextAt
        : nextAt + (trigger.maxRepeats - 1) * trigger.everyMs;
    if (
      nextAt === null ||
      lastSlot === null ||
      !Number.isFinite(lastSlot) ||
      lastSlot > MAX_EPOCH_MS
    ) {
      return { ok: false, error: 'That time could not be read — use HH:MM.' };
    }

    const base: Job = {
      id: editing?.id ?? newTimedMessageId(now),
      sessionId: input.sessionId,
      origin: 'user',
      trigger,
      action: { kind: 'send', message: check.message },
      nextAt,
      state: 'armed',
      attempts: 0,
      maxAttempts: TIME_JOB_ATTEMPTS,
      createdAt: now,
      // An edit is a new schedule: the old one's last fire must not show against it.
      history: [],
      firedCount: 0,
    };
    const job = this.record(base, now, 'armed');
    this.put(job);
    this.changed();
    return { ok: true, job };
  }

  /**
   * Auto-resume for a limit. At most ONE live limit-reset job per session: a second arm updates
   * the live job rather than adding one. Never refused for caps (R7).
   */
  armResume(input: ArmResumeInput): SetResult {
    if (!this.deps.sessionExists(input.sessionId)) {
      return { ok: false, error: 'That session is gone.' };
    }
    const check = normalizeMessage(input.message);
    if (!check.ok) return { ok: false, error: check.error };
    const now = this.now();
    const trigger: LimitTrigger = {
      kind: 'limit-reset',
      episodeId: input.episodeId,
      resetAt: input.resetAt,
      marginMs: input.marginMs,
    };
    const nextAt = Math.max(input.resetAt + input.marginMs, now);
    const live = this.jobs.find(
      (j) => j.sessionId === input.sessionId && limitTriggerOf(j) !== null && !isTerminal(j.state),
    );

    if (live) {
      if (RESUME_BUSY_STATES.includes(live.state)) {
        return { ok: false, error: 'A resume is already in flight.' };
      }
      const episodeChanged = limitTriggerOf(live)?.episodeId !== input.episodeId;
      const state: JobState = input.proposed ? 'proposed' : 'armed';
      const updated = this.record(
        withoutWaiting({
          ...live,
          origin: 'limit',
          trigger,
          action: { kind: 'send', message: check.message },
          nextAt,
          attempts: episodeChanged ? 0 : live.attempts,
          maxAttempts: input.maxAttempts,
        }),
        now,
        state,
        state === 'armed' ? RE_ARMED_REASON : undefined,
      );
      this.put(updated);
      this.changed();
      return { ok: true, job: updated };
    }

    const state: JobState = input.proposed ? 'proposed' : 'armed';
    const job = this.record(
      {
        id: newTimedMessageId(now),
        sessionId: input.sessionId,
        origin: 'limit',
        trigger,
        action: { kind: 'send', message: check.message },
        nextAt,
        state,
        attempts: 0,
        maxAttempts: input.maxAttempts,
        createdAt: now,
        history: [],
      },
      now,
      state,
    );
    this.put(job);
    this.changed();
    return { ok: true, job };
  }

  /** R8: the user accepted a proposed resume, so it arms. */
  accept(jobId: string): boolean {
    const job = this.find(jobId);
    if (!job || job.state !== 'proposed') return false;
    this.put(this.record(job, this.now(), 'armed'));
    this.changed();
    return true;
  }

  cancel(jobId: string, reason: string): boolean {
    const job = this.find(jobId);
    if (!job || isTerminal(job.state)) return false;
    this.put(this.record(job, this.now(), 'cancelled', reason));
    this.changed();
    return true;
  }

  cancelSession(sessionId: string, reason: string): void {
    const at = this.now();
    const live = this.jobs.filter((j) => j.sessionId === sessionId && !isTerminal(j.state));
    if (live.length === 0) {
      this.arm();
      return;
    }
    for (const j of live) this.put(this.record(j, at, 'cancelled', reason));
    this.changed();
  }

  resolveVerify(
    sessionId: string,
    outcome: { kind: 'resumed' } | { kind: 'limited'; resetAt: number },
  ): void {
    const job = this.jobs.find((j) => j.sessionId === sessionId && j.state === 'verifying');
    if (!job) return;
    const now = this.now();
    if (outcome.kind === 'resumed') {
      this.put(this.record(job, now, 'done', 'resumed'));
      this.changed();
      return;
    }
    const trigger = limitTriggerOf(job);
    if (!trigger) return;
    if (job.attempts >= job.maxAttempts) {
      this.fail(job, now, 'still limited');
      this.changed();
      return;
    }
    const rearmed: Job = {
      ...job,
      trigger: { ...trigger, resetAt: outcome.resetAt },
      nextAt: Math.max(outcome.resetAt + trigger.marginMs, now),
    };
    this.put(this.record(rearmed, now, 'armed', 'limited again'));
    this.changed();
  }

  /**
   * Re-runs the pre-fire check for a limit-reset job the verdict deferred. A PTY that is not
   * alive keeps it waiting for onPtyStart; any other state is left alone.
   */
  recheck(jobId: string): void {
    const job = this.find(jobId);
    if (!job || job.state !== 'waiting' || limitTriggerOf(job) === null) return;
    this.deferred.delete(job.id);
    if (!this.deps.isAlive(job.sessionId)) return;
    if (this.now() < (this.settleUntil.get(job.sessionId) ?? 0)) return;
    this.checkResume(job, this.now());
    this.onChangeAndArm();
  }

  renewSchedule(id: string): SetResult {
    const job = this.find(id);
    if (!job || job.trigger.kind === 'limit-reset' || job.state === 'cancelled') {
      return { ok: false, error: 'That timed message is gone.' };
    }
    const now = this.now();
    const nextAt = nextFireAt(job.trigger, now);
    if (nextAt === null) return { ok: false, error: 'That time could not be resolved again.' };
    const renewed = this.record({ ...withoutWaiting(job), nextAt, firedCount: 0 }, now, 'armed');
    this.put(renewed);
    this.changed();
    return { ok: true, job: renewed };
  }

  /** Deliver now. Consumes no repeat and does not move `nextAt` (spec 2026-08-28-timed-messages §2 "The dialog"). */
  async sendNow(id: string): Promise<boolean> {
    const job = this.find(id);
    if (!job || job.trigger.kind === 'limit-reset' || isTerminal(job.state)) return false;
    return this.sendOnce(job.sessionId, job.action.message);
  }

  async sendOnce(sessionId: string, message: string): Promise<boolean> {
    const check = normalizeMessage(message);
    if (!check.ok) return false;
    const now = this.now();
    // An immediate send is not stored, so it carries no real trigger; deliver() reads only the
    // session and the message.
    const job: Job = {
      id: newTimedMessageId(now),
      sessionId,
      origin: 'user',
      trigger: { kind: 'in', delayMs: 0 },
      action: { kind: 'send', message: check.message },
      nextAt: now,
      state: 'sending',
      attempts: 0,
      maxAttempts: TIME_JOB_ATTEMPTS,
      createdAt: now,
      history: [],
      firedCount: 0,
    };
    const result = await this.enqueue(job);
    return result !== 'not-live' && result.ok;
  }

  // liveness is re-read inside the queue: the PTY can exit while an earlier delivery is in flight
  private enqueue(job: Job): Promise<DeliveryResult | Pending> {
    const prior = this.sessionQueue.get(job.sessionId) ?? Promise.resolve();
    const run = prior.then(() => this.deliverNow(job));
    this.sessionQueue.set(
      job.sessionId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  // a queued job records a rejected delivery as a failed result; sendOnce lets it propagate
  private dispatch(job: Job): Promise<DeliveryResult | Pending> {
    return this.enqueue(job).catch(
      (e: unknown): DeliveryResult => ({ ok: false, reason: errorText(e) }),
    );
  }

  private async deliverNow(job: Job): Promise<DeliveryResult | Pending> {
    if (!this.deps.isAlive(job.sessionId)) return 'not-live';
    const check = normalizeMessage(job.action.message);
    if (!check.ok) return { ok: false, reason: check.error };
    return this.deps.deliver({ ...job, action: { kind: 'send', message: check.message } });
  }

  onPtyStart(sessionId: string): void {
    this.settleUntil.set(sessionId, this.now() + PTY_SETTLE_MS);
    this.arm();
  }

  onSessionDisposed(sessionId: string): void {
    this.settleUntil.delete(sessionId);
    this.sessionQueue.delete(sessionId);
    this.cancelSession(sessionId, 'session closed');
  }

  /** CONDUIT_E2E only: shift the clock so an interval or an expiry window can be proven in ms. */
  advanceClock(ms: number): void {
    this.clockOffset += ms;
    this.evaluate();
  }

  stop(): void {
    if (this.handle === null) return;
    this.deps.clearTimer(this.handle);
    this.handle = null;
  }

  /** Compare every job against the wall clock and act. Also the wake-from-suspend hook. */
  evaluate(): void {
    const now = this.now();
    let mutated = false;

    for (const job of [...this.jobs]) {
      if (this.inFlight.has(job.id) || isTerminal(job.state)) continue;

      const limit = limitTriggerOf(job);
      if (limit && job.state !== 'verifying' && now - limit.resetAt > CATCHUP_MS.limit) {
        this.put(this.record(job, now, 'cancelled', 'expired'));
        mutated = true;
        continue;
      }
      if (this.deferred.has(job.id)) continue;

      if (job.state === 'verifying') {
        if (now >= job.nextAt) {
          this.fail(job, now, 'no response');
          mutated = true;
        }
        continue;
      }
      if (job.state === 'proposed' || now < job.nextAt) continue;

      if (!this.deps.isAlive(job.sessionId)) {
        if (job.state === 'armed') {
          this.put(this.record({ ...job, waitingSince: job.nextAt }, now, 'waiting'));
          mutated = true;
        }
        continue;
      }

      if (now < (this.settleUntil.get(job.sessionId) ?? 0)) continue;

      if (limit) {
        this.checkResume(job, now);
        mutated = true;
        continue;
      }

      if (repeatsOf(job) - (job.firedCount ?? 0) <= 0) {
        this.put(this.advanceTime(job, now, 0));
        mutated = true;
        continue;
      }

      const decision = this.timeDecision(job, now);
      if (decision.skip) {
        const advanced = this.advanceTime(job, now, decision.slots, 'expired');
        this.put(advanced);
        this.deps.onFired({
          id: job.id,
          sessionId: job.sessionId,
          at: now,
          late: true,
          delivered: false,
          reason: 'expired',
        });
        mutated = true;
        continue;
      }
      this.fireTime(job, decision.slots, decision.late);
    }

    if (mutated) this.deps.onChange();
    this.arm();
  }

  private timeDecision(job: Job, now: number): { skip: boolean; late: boolean; slots: number } {
    const overdue = now - job.nextAt;
    const every = job.trigger.kind === 'every' ? job.trigger.everyMs : 0;
    const remaining = Math.max(repeatsOf(job) - (job.firedCount ?? 0), 0);
    const elapsed = every > 0 ? 1 + Math.floor(overdue / every) : 1;
    const slots = Math.min(elapsed, remaining);
    if (overdue > CATCHUP_MS.manual) return { skip: true, late: true, slots };
    return { skip: false, late: job.state === 'waiting' || overdue > LATE_GRACE_MS, slots };
  }

  private advanceTime(job: Job, at: number, slots: number, outcome?: FireOutcome): Job {
    const repeats = repeatsOf(job);
    const firedCount = Math.min((job.firedCount ?? 0) + slots, repeats);
    const done = firedCount >= repeats;
    const every = job.trigger.kind === 'every' ? job.trigger.everyMs : 0;
    const nextAt = done || every === 0 ? job.nextAt : job.nextAt + slots * every;
    return this.record(
      { ...withoutWaiting(job), firedCount, nextAt },
      at,
      done ? 'done' : 'armed',
      outcome,
    );
  }

  private fireTime(job: Job, slots: number, late: boolean): void {
    this.inFlight.add(job.id);
    void this.dispatch(job).then((result) => {
      this.inFlight.delete(job.id);
      const at = this.now();
      const delivered = result !== 'not-live' && result.ok;
      const outcome: FireOutcome = delivered
        ? late
          ? 'delivered late'
          : 'delivered'
        : late
          ? 'no session late'
          : 'no session';
      const current = this.find(job.id);
      if (current && !isTerminal(current.state)) {
        const joined = result !== 'not-live' && result.ok && result.joined;
        // A failed write on a live session keeps its own reason; 'no session' alone would hide it.
        const failure = result !== 'not-live' && !result.ok ? result.reason : undefined;
        const noted =
          joined || failure !== undefined
            ? this.record(current, at, current.state, failure ?? JOINED_REASON)
            : current;
        this.put(this.advanceTime(noted, at, slots, outcome));
      }
      this.deps.onFired({
        id: job.id,
        sessionId: job.sessionId,
        at,
        late,
        delivered,
        ...(delivered ? {} : { reason: 'noSession' as const }),
      });
      this.deps.onChange();
      this.arm();
    });
  }

  private checkResume(job: Job, now: number): void {
    const late = now - job.nextAt > LATE_GRACE_MS;
    const checking = this.record(job, now, 'checking', late ? 'late' : undefined);
    this.put(checking);
    const verdict = this.deps.preFire(checking);
    if (verdict.go === 'wait') {
      this.put(this.record(checking, now, 'waiting', verdict.reason));
      this.deferred.add(job.id);
      return;
    }
    if (verdict.go === false) {
      this.put(this.record(checking, now, 'skipped', verdict.reason));
      return;
    }
    const sending = this.record(checking, now, 'sending');
    this.put(sending);
    this.inFlight.add(job.id);
    void this.dispatch(sending).then((result) => {
      this.inFlight.delete(job.id);
      const at = this.now();
      const latest = this.find(job.id);
      if (latest && latest.state === 'sending') this.settleDelivery(latest, result, at, late);
      this.onChangeAndArm();
    });
  }

  private settleDelivery(
    job: Job,
    result: DeliveryResult | Pending,
    at: number,
    late: boolean,
  ): void {
    if (result === 'not-live') {
      this.put(this.record({ ...job, waitingSince: at }, at, 'waiting', NO_SESSION_REASON));
      return;
    }
    if (!result.ok) {
      this.fail(job, at, result.reason);
      return;
    }
    const verifying: Job = {
      ...job,
      attempts: job.attempts + 1,
      nextAt: at + this.deps.verifyMs(),
    };
    this.put(this.record(verifying, at, 'verifying', result.joined ? JOINED_REASON : undefined));
    this.deps.onFired({ id: job.id, sessionId: job.sessionId, at, late, delivered: true });
  }

  private fail(job: Job, at: number, reason: string): void {
    const failed = this.record(job, at, 'failed', reason);
    this.put(failed);
    this.deps.onJobFailed(failed, reason);
  }

  private record(job: Job, at: number, state: JobState, reason?: string): Job {
    const entry: JobHistoryEntry = { at, state, ...(reason === undefined ? {} : { reason }) };
    return { ...job, state, history: [...job.history, entry].slice(-JOB_HISTORY_MAX) };
  }

  private find(id: string): Job | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  private put(next: Job): void {
    if (next.state !== 'waiting') this.deferred.delete(next.id);
    const i = this.jobs.findIndex((j) => j.id === next.id);
    if (i < 0) {
      this.jobs = [...this.jobs, next];
      return;
    }
    this.jobs = this.jobs.map((j) => (j.id === next.id ? next : j));
  }

  private onChangeAndArm(): void {
    this.deps.onChange();
    this.arm();
  }

  private changed(): void {
    this.deps.onChange();
    this.evaluate();
  }

  private capError(sessionId: string, editingId: string | undefined): string | null {
    const live = this.jobs.filter(
      (j) => j.trigger.kind !== 'limit-reset' && !isTerminal(j.state) && j.id !== editingId,
    );
    if (live.length >= MAX_TOTAL) {
      return `${MAX_TOTAL} timed messages already armed — cancel one first.`;
    }
    if (live.filter((j) => j.sessionId === sessionId).length >= MAX_PER_SESSION) {
      return `${MAX_PER_SESSION} timed messages already on this session — cancel one first.`;
    }
    return null;
  }

  private triggerError(t: TriggerInput): string | null {
    if (t.kind === 'in' && !(t.delayMs >= this.deps.minDelayMs)) {
      return `Wait at least ${Math.round(this.deps.minDelayMs / 1000)} seconds.`;
    }
    if (t.kind === 'every') {
      if (!(t.everyMs >= this.deps.minIntervalMs)) {
        return 'Repeat no faster than once a minute.';
      }
      if (!Number.isInteger(t.maxRepeats) || t.maxRepeats < 1 || t.maxRepeats > MAX_REPEATS) {
        return `Repeats must be between 1 and ${MAX_REPEATS}.`;
      }
    }
    return null;
  }

  /**
   * One timer, to the earliest thing that could happen. A `waiting` job contributes none: it
   * wakes when its PTY comes back, not on a clock.
   */
  private arm(): void {
    this.stop();
    const now = this.now();
    let earliest = Number.POSITIVE_INFINITY;
    for (const job of this.jobs) {
      if (this.inFlight.has(job.id) || isTerminal(job.state)) continue;
      const limit = limitTriggerOf(job);
      if (limit && job.state !== 'verifying') {
        // +1: evaluate() expires a job only once it is strictly more than 24 h past its reset
        earliest = Math.min(earliest, Math.max(limit.resetAt + CATCHUP_MS.limit + 1, now));
      }
      if (job.state === 'verifying') {
        earliest = Math.min(earliest, Math.max(job.nextAt, now));
        continue;
      }
      if (job.state !== 'armed') continue;
      // Floored by the session's settle expiry: a job already due inside that window is skipped
      // by evaluate(), so arming at `now` would spin setTimeout(0) for the rest of the window.
      const actionableAt = Math.max(job.nextAt, this.settleUntil.get(job.sessionId) ?? 0);
      earliest = Math.min(earliest, Math.max(actionableAt, now));
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

// see spec 2026-11-13-scheduler-auto-resume §3 "Producers / consumers"
export function toTimedMessage(job: Job): TimedMessage | null {
  if (job.state === 'proposed' || job.state === 'skipped' || job.state === 'failed') return null;
  if (job.state === 'cancelled') return null;
  const limit = job.trigger.kind === 'limit-reset';
  const delivered = limit && RESUME_DONE_STATES.includes(job.state);
  const lastDelivery = [...job.history].reverse().find((e) => e.state === 'verifying');
  const state: TimedMessage['state'] = delivered
    ? 'done'
    : job.state === 'done'
      ? 'done'
      : job.state === 'waiting'
        ? 'waiting'
        : 'armed';
  const timing =
    job.trigger.kind === 'every'
      ? { kind: 'interval' as const, everyMs: job.trigger.everyMs }
      : job.trigger.kind === 'at'
        ? {
            kind: 'once' as const,
            spec: {
              clock: job.trigger.clock,
              ...(job.trigger.zone === undefined ? {} : { zone: job.trigger.zone }),
            },
          }
        : { kind: 'once' as const };
  const fire = limit
    ? undefined
    : [...job.history]
        .reverse()
        .find(
          (e): e is JobHistoryEntry & { reason: FireOutcome } =>
            e.reason !== undefined && isFireOutcome(e.reason),
        );
  return {
    id: job.id,
    sessionId: job.sessionId,
    message: job.action.message,
    ...timing,
    nextAt: delivered ? (lastDelivery?.at ?? job.nextAt) : job.nextAt,
    maxRepeats: job.trigger.kind === 'every' ? job.trigger.maxRepeats : 1,
    firedCount: delivered ? 1 : (job.firedCount ?? 0),
    state,
    origin: limit ? 'limit' : 'manual',
    createdAt: job.createdAt,
    ...(job.waitingSince === undefined ? {} : { waitingSince: job.waitingSince }),
    ...(fire === undefined ? {} : { lastFire: lastFireOf(fire) }),
  };
}
