import { describe, expect, it } from 'vitest';
import {
  CATCHUP_MS,
  LIMIT_MESSAGE,
  PTY_SETTLE_MS,
  type TimedMessage,
} from '../../src/timed-messages';
import { type FiredEvent, type SchedulerDeps, TimerScheduler } from '../../src/timer-scheduler';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 7, 28, 15, 0, 0);

/** Let the scheduler's async delivery settle. Only the SCHEDULER's timer is faked. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function harness(over: Partial<SchedulerDeps> = {}) {
  let clock = NOW;
  let pending: { at: number; fn: () => void } | null = null;
  const alive = new Set<string>(['s1']);
  const known = new Set<string>(['s1', 's2']);
  const delivered: { sessionId: string; message: string }[] = [];
  const fired: FiredEvent[] = [];
  let changes = 0;
  let deliverOk = true;

  const deps: SchedulerDeps = {
    now: () => clock,
    setTimer: (ms, fn) => {
      pending = { at: clock + ms, fn };
      return pending;
    },
    clearTimer: () => {
      pending = null;
    },
    isAlive: (id) => alive.has(id),
    deliver: async (sessionId, message) => {
      if (!alive.has(sessionId)) return false;
      delivered.push({ sessionId, message });
      return deliverOk;
    },
    sessionExists: (id) => known.has(id),
    onChange: () => {
      changes += 1;
    },
    onFired: (ev) => {
      fired.push(ev);
    },
    minDelayMs: 0,
    minIntervalMs: 0,
    ...over,
  };

  const scheduler = new TimerScheduler(deps);

  return {
    scheduler,
    delivered,
    fired,
    alive,
    known,
    changes: () => changes,
    nextWaitMs: () => (pending === null ? null : pending.at - clock),
    /** Advance the wall clock and run the armed timer if it is now due. */
    async tick(ms: number) {
      clock += ms;
      if (pending && pending.at <= clock) {
        const due = pending;
        pending = null;
        due.fn();
      }
      await flush();
    },
    setDeliverOk(v: boolean) {
      deliverOk = v;
    },
    now: () => clock,
  };
}

const arm = (h: ReturnType<typeof harness>, over: Record<string, unknown> = {}) =>
  h.scheduler.set({
    sessionId: 's1',
    message: 'Continue',
    trigger: { kind: 'in', delayMs: 60_000 },
    ...over,
  });

describe('arming', () => {
  it('accepts a schedule, derives nextAt from the trigger and arms the earliest timer', () => {
    const h = harness();
    const r = arm(h);
    expect(r.ok).toBe(true);
    expect(h.scheduler.list()).toHaveLength(1);
    expect(h.scheduler.list()[0].nextAt).toBe(NOW + 60_000);
    expect(h.nextWaitMs()).toBe(60_000);
    expect(h.changes()).toBe(1);
  });

  it('arms to the EARLIEST nextAt across schedules, not the newest', () => {
    const h = harness();
    arm(h, { trigger: { kind: 'in', delayMs: 10 * 60_000 } });
    arm(h, { trigger: { kind: 'in', delayMs: 2 * 60_000 } });
    expect(h.nextWaitMs()).toBe(2 * 60_000);
  });

  it('refuses a schedule for a session the manager does not know', () => {
    const h = harness();
    expect(arm(h, { sessionId: 'ghost' })).toEqual({ ok: false, error: 'That session is gone.' });
    expect(h.scheduler.list()).toHaveLength(0);
  });

  it('refuses a fourth schedule on one session', () => {
    const h = harness();
    for (let i = 0; i < 3; i++) expect(arm(h).ok).toBe(true);
    const r = arm(h);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/already on this session/);
  });

  it('replaces by id when the composer saves an edit, keeping one row', () => {
    const h = harness();
    const first = arm(h);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const again = h.scheduler.set({
      id: first.schedule.id,
      sessionId: 's1',
      message: 'Do this again',
      trigger: { kind: 'in', delayMs: 5 * 60_000 },
    });
    expect(again.ok).toBe(true);
    expect(h.scheduler.list()).toHaveLength(1);
    expect(h.scheduler.list()[0].message).toBe('Do this again');
    expect(h.scheduler.list()[0].firedCount).toBe(0);
  });

  it('arms no timer at all when nothing is scheduled', () => {
    const h = harness();
    h.scheduler.evaluate();
    expect(h.nextWaitMs()).toBeNull();
  });
});

describe('firing into a live PTY', () => {
  it('delivers the message once and marks a once schedule done', async () => {
    const h = harness();
    arm(h);
    await h.tick(60_000);
    expect(h.delivered).toEqual([{ sessionId: 's1', message: 'Continue' }]);
    expect(h.scheduler.list()[0]).toMatchObject({ state: 'done', firedCount: 1 });
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]).toMatchObject({ sessionId: 's1', delivered: true, late: false });
  });

  it('drops the timer once nothing is armed', async () => {
    const h = harness();
    arm(h);
    await h.tick(60_000);
    expect(h.nextWaitMs()).toBeNull();
  });

  it('re-arms an interval until its repeat count and then stops', async () => {
    const h = harness();
    expect(
      h.scheduler.set({
        sessionId: 's1',
        message: 'again',
        trigger: { kind: 'every', everyMs: 1000, maxRepeats: 3 },
      }).ok,
    ).toBe(true);
    for (let i = 0; i < 4; i++) await h.tick(1000);
    expect(h.delivered).toHaveLength(3);
    expect(h.scheduler.list()[0]).toMatchObject({ state: 'done', firedCount: 3 });
    expect(h.nextWaitMs()).toBeNull();
  });

  it('collapses several elapsed interval slots into ONE delivery', async () => {
    const h = harness();
    h.scheduler.set({
      sessionId: 's1',
      message: 'again',
      trigger: { kind: 'every', everyMs: HOUR, maxRepeats: 10 },
    });
    // Four slots elapse while the process is busy elsewhere; the timer fires once, late.
    await h.tick(4 * HOUR);
    expect(h.delivered).toHaveLength(1);
    expect(h.scheduler.list()[0].firedCount).toBe(4);
    expect(h.scheduler.list()[0].nextAt).toBeGreaterThan(h.now());
  });

  it('reports delivered:false when the process dies between the text and the Enter', async () => {
    const h = harness();
    arm(h);
    h.setDeliverOk(false);
    await h.tick(60_000);
    expect(h.fired[0]).toMatchObject({ delivered: false, reason: 'noSession' });
    // The slot is consumed: half the message is already in the PTY (plan assumption 6).
    expect(h.scheduler.list()[0]).toMatchObject({ state: 'done', firedCount: 1 });
  });

  it('never touches a schedule twice while its delivery is in flight', async () => {
    let release: (v: boolean) => void = () => {};
    const h = harness({
      deliver: () => new Promise<boolean>((r) => (release = r)),
    });
    arm(h);
    await h.tick(60_000);
    h.scheduler.evaluate();
    h.scheduler.evaluate();
    release(true);
    await flush();
    expect(h.fired).toHaveLength(1);
  });
});

describe('waiting for a PTY', () => {
  it('goes waiting instead of writing when the session is not live, and holds nextAt', async () => {
    const h = harness();
    arm(h);
    h.alive.delete('s1');
    await h.tick(60_000);
    expect(h.delivered).toHaveLength(0);
    expect(h.scheduler.list()[0]).toMatchObject({
      state: 'waiting',
      waitingSince: NOW + 60_000,
      nextAt: NOW + 60_000,
    });
    expect(h.fired).toHaveLength(0);
  });

  it('raises no further change once it is already waiting', async () => {
    const h = harness();
    arm(h);
    h.alive.delete('s1');
    await h.tick(60_000);
    const after = h.changes();
    h.scheduler.evaluate();
    h.scheduler.evaluate();
    expect(h.changes()).toBe(after);
  });

  it('arms no clock for a waiting schedule — it wakes on term:start', async () => {
    const h = harness();
    arm(h);
    h.alive.delete('s1');
    await h.tick(60_000);
    expect(h.nextWaitMs()).toBeNull();
  });

  it('delivers once, late, PTY_SETTLE_MS after that session starts', async () => {
    const h = harness();
    arm(h);
    h.alive.delete('s1');
    await h.tick(60_000);

    h.alive.add('s1');
    h.scheduler.onPtyStart('s1');
    expect(h.nextWaitMs()).toBe(PTY_SETTLE_MS);

    // A message written into a shell that has not printed its prompt is lost, so nothing goes
    // out before the settle window closes.
    await h.tick(PTY_SETTLE_MS - 1);
    expect(h.delivered).toHaveLength(0);

    await h.tick(1);
    expect(h.delivered).toEqual([{ sessionId: 's1', message: 'Continue' }]);
    expect(h.fired[0]).toMatchObject({ late: true, delivered: true });
    expect(h.scheduler.list()[0].state).toBe('done');
  });

  it('delivers a waiting schedule EXACTLY once even if term:start repeats', async () => {
    const h = harness();
    arm(h);
    h.alive.delete('s1');
    await h.tick(60_000);
    h.alive.add('s1');
    h.scheduler.onPtyStart('s1');
    h.scheduler.onPtyStart('s1');
    await h.tick(PTY_SETTLE_MS);
    await h.tick(PTY_SETTLE_MS);
    expect(h.delivered).toHaveLength(1);
  });

  it('skips a manual schedule that became deliverable past its 6 hour window', async () => {
    const h = harness();
    arm(h);
    h.alive.delete('s1');
    await h.tick(60_000);
    await h.tick(CATCHUP_MS.manual + 1);
    h.alive.add('s1');
    h.scheduler.onPtyStart('s1');
    await h.tick(PTY_SETTLE_MS);
    expect(h.delivered).toHaveLength(0);
    expect(h.fired[0]).toMatchObject({ delivered: false, reason: 'expired' });
    expect(h.scheduler.list()[0].state).toBe('done');
  });

  it('still delivers a limit schedule ten hours late — the lid-closed-overnight case', async () => {
    const h = harness();
    h.scheduler.armLimit('s1', NOW + 60_000);
    h.alive.delete('s1');
    await h.tick(2 * 60_000);
    await h.tick(10 * HOUR);
    h.alive.add('s1');
    h.scheduler.onPtyStart('s1');
    await h.tick(PTY_SETTLE_MS);
    expect(h.delivered).toEqual([{ sessionId: 's1', message: LIMIT_MESSAGE }]);
    expect(h.fired[0]).toMatchObject({ late: true, delivered: true });
  });
});

describe('the limit schedule', () => {
  it('arms Continue one minute past the reset', () => {
    const h = harness();
    const s = h.scheduler.armLimit('s1', NOW + HOUR);
    expect(s).not.toBeNull();
    expect(s).toMatchObject({ message: LIMIT_MESSAGE, origin: 'limit', kind: 'once' });
    expect(s?.nextAt).toBe(NOW + HOUR + 60_000);
  });

  it('REPLACES the session limit schedule rather than accumulating', () => {
    const h = harness();
    h.scheduler.armLimit('s1', NOW + HOUR);
    h.scheduler.armLimit('s1', NOW + 2 * HOUR);
    h.scheduler.armLimit('s1', NOW + 3 * HOUR);
    const limits = h.scheduler.list().filter((s) => s.origin === 'limit');
    expect(limits).toHaveLength(1);
    expect(limits[0].nextAt).toBe(NOW + 3 * HOUR + 60_000);
  });

  it('leaves manual schedules on the same session alone', () => {
    const h = harness();
    arm(h);
    h.scheduler.armLimit('s1', NOW + HOUR);
    expect(h.scheduler.list()).toHaveLength(2);
  });

  it('arms a reset that has already passed for immediate delivery, not the past', () => {
    const h = harness();
    const s = h.scheduler.armLimit('s1', NOW - HOUR);
    expect(s?.nextAt).toBe(NOW);
  });
});

describe('cancel, renew, send now', () => {
  it('cancel deletes the record — there is no cancelled state', () => {
    const h = harness();
    const r = arm(h);
    expect(r.ok && h.scheduler.cancel(r.schedule.id)).toBe(true);
    expect(h.scheduler.list()).toHaveLength(0);
    expect(h.nextWaitMs()).toBeNull();
  });

  it('cancel of an unknown id is a harmless false', () => {
    const h = harness();
    expect(h.scheduler.cancel('nope')).toBe(false);
  });

  it('renew resets firedCount and recomputes nextAt from now', async () => {
    const h = harness();
    const r = arm(h);
    if (!r.ok) return;
    await h.tick(60_000);
    expect(h.scheduler.list()[0].state).toBe('done');
    const renewed = h.scheduler.renewSchedule(r.schedule.id);
    expect(renewed.ok).toBe(true);
    expect(h.scheduler.list()[0]).toMatchObject({ state: 'armed', firedCount: 0 });
    expect(h.scheduler.list()[0].nextAt).toBe(h.now() + 60_000);
  });

  it('send now delivers immediately and moves neither firedCount nor nextAt', async () => {
    const h = harness();
    const r = arm(h);
    if (!r.ok) return;
    expect(await h.scheduler.sendNow(r.schedule.id)).toBe(true);
    expect(h.delivered).toEqual([{ sessionId: 's1', message: 'Continue' }]);
    expect(h.scheduler.list()[0]).toMatchObject({ firedCount: 0, nextAt: NOW + 60_000 });
    expect(h.fired).toHaveLength(0);
  });

  it('send now answers false for a session with no live PTY', async () => {
    const h = harness();
    const r = arm(h);
    if (!r.ok) return;
    h.alive.delete('s1');
    expect(await h.scheduler.sendNow(r.schedule.id)).toBe(false);
    expect(h.delivered).toHaveLength(0);
  });

  it('send once delivers without creating a schedule', async () => {
    const h = harness();
    expect(await h.scheduler.sendOnce('s1', 'ping\r\nnow')).toBe(true);
    expect(h.delivered).toEqual([{ sessionId: 's1', message: 'ping now' }]);
    expect(h.scheduler.list()).toHaveLength(0);
  });

  it('send once refuses an empty message rather than pressing a bare Enter', async () => {
    const h = harness();
    expect(await h.scheduler.sendOnce('s1', '   ')).toBe(false);
    expect(h.delivered).toHaveLength(0);
  });
});

describe('lifecycle', () => {
  it('drops a disposed session schedules and re-arms', () => {
    const h = harness();
    arm(h);
    h.scheduler.set({ sessionId: 's2', message: 'other', trigger: { kind: 'in', delayMs: HOUR } });
    h.scheduler.onSessionDisposed('s1');
    expect(h.scheduler.list().map((s) => s.sessionId)).toEqual(['s2']);
    expect(h.nextWaitMs()).toBe(HOUR);
  });

  it('load drops schedules whose session is gone, and never re-persists them', () => {
    const h = harness();
    const stored: TimedMessage[] = [
      {
        id: 'a',
        sessionId: 's1',
        message: 'Continue',
        kind: 'once',
        nextAt: NOW + HOUR,
        maxRepeats: 1,
        firedCount: 0,
        state: 'armed',
        origin: 'manual',
        createdAt: NOW,
      },
      {
        id: 'b',
        sessionId: 'gone',
        message: 'Continue',
        kind: 'once',
        nextAt: NOW + HOUR,
        maxRepeats: 1,
        firedCount: 0,
        state: 'armed',
        origin: 'manual',
        createdAt: NOW,
      },
    ];
    h.scheduler.load(stored);
    expect(h.scheduler.list().map((s) => s.id)).toEqual(['a']);
    expect(h.changes()).toBe(0);
  });

  it('a restored schedule whose moment passed while the app was closed waits, silently', async () => {
    const h = harness();
    h.alive.delete('s1');
    h.scheduler.load([
      {
        id: 'a',
        sessionId: 's1',
        message: 'Continue',
        kind: 'once',
        nextAt: NOW - 60_000,
        maxRepeats: 1,
        firedCount: 0,
        state: 'armed',
        origin: 'manual',
        createdAt: NOW - HOUR,
      },
    ]);
    await flush();
    expect(h.delivered).toHaveLength(0);
    expect(h.scheduler.list()[0].state).toBe('waiting');
  });

  it('stop clears the timer so no handle outlives the app', () => {
    const h = harness();
    arm(h);
    h.scheduler.stop();
    expect(h.nextWaitMs()).toBeNull();
  });

  it('advanceClock shifts the schedule clock and re-evaluates (the CONDUIT_E2E seam)', async () => {
    const h = harness();
    h.scheduler.set({
      sessionId: 's1',
      message: 'again',
      trigger: { kind: 'every', everyMs: 1000, maxRepeats: 3 },
    });
    for (let i = 0; i < 4; i++) {
      h.scheduler.advanceClock(1000);
      await flush();
    }
    expect(h.delivered).toHaveLength(3);
    expect(h.scheduler.list()[0].state).toBe('done');
  });

  it('a suspend past a fire delivers on resume rather than never', async () => {
    const h = harness({});
    arm(h);
    // setTimeout does not advance across a Windows suspend: the clock moved, the timer did not.
    await h.tick(0);
    h.scheduler.advanceClock(2 * HOUR);
    await flush();
    expect(h.delivered).toHaveLength(1);
    expect(h.fired[0].late).toBe(true);
  });

  it('clamps a very distant nextAt to the setTimeout ceiling and re-arms', () => {
    const h = harness();
    h.scheduler.set({
      sessionId: 's1',
      message: 'far',
      trigger: { kind: 'in', delayMs: 40 * 24 * HOUR },
    });
    expect(h.nextWaitMs()).toBe(2_147_483_647);
  });
});

/**
 * A harness whose deliver writes the text, yields, then writes the Enter — like the real one.
 * Writes are tagged with the session they landed in, so a cross-session test can read one PTY's
 * stream in isolation.
 */
function interleavingHarness() {
  let clock = NOW;
  let pending: { at: number; fn: () => void } | null = null;
  const alive = new Set<string>(['s1', 's2']);
  const entries: { sessionId: string; write: string }[] = [];
  let changes = 0;

  const scheduler = new TimerScheduler({
    now: () => clock,
    setTimer: (ms, fn) => {
      pending = { at: clock + ms, fn };
      return pending;
    },
    clearTimer: () => {
      pending = null;
    },
    isAlive: (id) => alive.has(id),
    deliver: async (sessionId, message) => {
      if (!alive.has(sessionId)) return false;
      entries.push({ sessionId, write: message });
      // The submit gap. Anything that starts a second delivery here corrupts the first.
      await Promise.resolve();
      await Promise.resolve();
      entries.push({ sessionId, write: 'CR' });
      return true;
    },
    sessionExists: () => true,
    onChange: () => {
      changes += 1;
    },
    onFired: () => {},
    minDelayMs: 0,
    minIntervalMs: 0,
  });

  return {
    scheduler,
    alive,
    entries,
    changes: () => changes,
    /** What ONE session's PTY received, in order. */
    writes: (sessionId = 's1') =>
      entries.filter((e) => e.sessionId === sessionId).map((e) => e.write),
    async tick(ms: number) {
      clock += ms;
      if (pending && pending.at <= clock) {
        const due = pending;
        pending = null;
        due.fn();
      }
      // Several microtask turns: enough for two chained deliveries to finish.
      for (let i = 0; i < 12; i++) await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      for (let i = 0; i < 12; i++) await Promise.resolve();
    },
  };
}

/**
 * A real delivery is TWO writes 120 ms apart (electron/main.ts `deliverTimedMessage`), so the
 * harness's atomic `deliver` fake cannot see the defect this covers: two schedules due at the
 * same instant on one session interleaving into `msgA msgB CR CR` — one garbled line, executed.
 *
 * The restart catch-up makes it deterministic rather than a race: every `waiting` schedule for a
 * session becomes deliverable at the same settle expiry.
 */
describe('one delivery at a time per session', () => {
  const armBoth = (h: ReturnType<typeof interleavingHarness>) => {
    h.scheduler.set({
      sessionId: 's1',
      message: 'first',
      trigger: { kind: 'in', delayMs: 60_000 },
    });
    h.scheduler.set({
      sessionId: 's1',
      message: 'second',
      trigger: { kind: 'in', delayMs: 60_000 },
    });
  };

  it('never interleaves two schedules that come due together', async () => {
    const h = interleavingHarness();
    armBoth(h);
    await h.tick(60_000);
    // Each message is immediately followed by ITS Enter. Interleaved, this reads
    // ['first', 'second', 'CR', 'CR'] — one line the shell would execute as "first second".
    expect(h.writes()).toEqual(['first', 'CR', 'second', 'CR']);
  });

  it('never interleaves the restart catch-up, where both become deliverable at once', async () => {
    const h = interleavingHarness();
    armBoth(h);
    h.alive.delete('s1');
    await h.tick(60_000);
    expect(h.writes()).toEqual([]);

    h.alive.add('s1');
    h.scheduler.onPtyStart('s1');
    await h.tick(PTY_SETTLE_MS);
    expect(h.writes()).toEqual(['first', 'CR', 'second', 'CR']);
  });

  it('queues Send now behind a fire already in flight', async () => {
    const h = interleavingHarness();
    h.scheduler.set({
      sessionId: 's1',
      message: 'scheduled',
      trigger: { kind: 'in', delayMs: 60_000 },
    });
    const sendNow = (async () => {
      await Promise.resolve();
      return h.scheduler.sendOnce('s1', 'by hand');
    })();
    await h.tick(60_000);
    await sendNow;
    expect(h.writes()).toEqual(['scheduled', 'CR', 'by hand', 'CR']);
  });

  it('sanitizes at the fire, so a hand-edited file cannot put ESC into the PTY', async () => {
    const h = interleavingHarness();
    h.scheduler.load([
      {
        id: 'tm-x',
        sessionId: 's1',
        message: 'go',
        kind: 'once',
        nextAt: NOW + 1000,
        maxRepeats: 1,
        firedCount: 0,
        state: 'armed',
        origin: 'manual',
        createdAt: NOW - 1000,
      },
    ]);
    // Reach past the loader the way a corrupt file or an older build would.
    const loaded = h.scheduler.list()[0] as { message: string };
    loaded.message = `go${String.fromCharCode(27)}[31m${String.fromCharCode(13)}now`;
    await h.tick(1000);
    expect(h.writes()[0]).not.toContain(String.fromCharCode(27));
    expect(h.writes()[0]).not.toContain(String.fromCharCode(13));
    expect(h.writes()).toEqual(['go[31m now', 'CR']);
  });
});

/**
 * Nothing serializes ACROSS sessions — `sessionQueue` and `settleUntil` are both keyed by session
 * id, and `evaluate()` walks every schedule in ONE synchronous pass. That is deliberate (two
 * PTYs are two independent shells), but it means one session's dead process, open settle window
 * or stalled write must never reach into another session's delivery.
 */
describe('parallel sessions', () => {
  const armFor = (h: ReturnType<typeof harness>, sessionId: string, message: string) =>
    h.scheduler.set({ sessionId, message, trigger: { kind: 'in', delayMs: 60_000 } });

  it('gives each session its OWN message when both come due in one pass', async () => {
    const h = harness();
    h.alive.add('s2');
    armFor(h, 's1', 'alpha');
    armFor(h, 's2', 'bravo');
    await h.tick(60_000);

    expect(h.delivered).toHaveLength(2);
    expect(h.delivered.filter((d) => d.sessionId === 's1')).toEqual([
      { sessionId: 's1', message: 'alpha' },
    ]);
    expect(h.delivered.filter((d) => d.sessionId === 's2')).toEqual([
      { sessionId: 's2', message: 'bravo' },
    ]);
    expect(h.fired.map((f) => `${f.sessionId}:${f.delivered}`).sort()).toEqual([
      's1:true',
      's2:true',
    ]);
    expect(h.scheduler.list().every((s) => s.state === 'done' && s.firedCount === 1)).toBe(true);
  });

  it('keeps each session PTY clean: message then ITS Enter, never the other session text', async () => {
    const h = interleavingHarness();
    h.scheduler.set({
      sessionId: 's1',
      message: 'alpha',
      trigger: { kind: 'in', delayMs: 60_000 },
    });
    h.scheduler.set({
      sessionId: 's2',
      message: 'bravo',
      trigger: { kind: 'in', delayMs: 60_000 },
    });
    await h.tick(60_000);

    // Across sessions the two deliveries DO overlap in time — two shells, no shared line — so
    // the assertion is per PTY: each got its own text and its own submit, and nothing else.
    expect(h.writes('s1')).toEqual(['alpha', 'CR']);
    expect(h.writes('s2')).toEqual(['bravo', 'CR']);
  });

  it('fires a live session even when a dead one is evaluated first', async () => {
    const h = harness();
    // s2 is known but has no PTY, and it is evaluated FIRST: the waiting branch must not
    // short-circuit the pass.
    armFor(h, 's2', 'bravo');
    armFor(h, 's1', 'alpha');
    await h.tick(60_000);

    expect(h.delivered).toEqual([{ sessionId: 's1', message: 'alpha' }]);
    expect(h.fired.map((f) => f.sessionId)).toEqual(['s1']);
    const held = h.scheduler.list().find((s) => s.sessionId === 's2');
    expect(held).toMatchObject({ state: 'waiting', nextAt: NOW + 60_000 });
  });

  it('does not hold one session behind another session settle window', async () => {
    const h = harness();
    h.alive.add('s2');
    armFor(h, 's1', 'alpha');
    armFor(h, 's2', 'bravo');
    await h.tick(59_000);
    // s1's PTY comes up a second before both are due, so only s1 owes a settle wait.
    h.scheduler.onPtyStart('s1');
    await h.tick(1_000);

    expect(h.delivered).toEqual([{ sessionId: 's2', message: 'bravo' }]);
    await h.tick(PTY_SETTLE_MS);
    expect(h.delivered).toEqual([
      { sessionId: 's2', message: 'bravo' },
      { sessionId: 's1', message: 'alpha' },
    ]);
  });

  it('sleeps until the settle expiry rather than spinning a zero-delay timer', async () => {
    const h = harness();
    armFor(h, 's1', 'alpha');
    await h.tick(59_000);
    h.scheduler.onPtyStart('s1');
    await h.tick(1_000);

    // Due, alive, but inside the settle window: evaluate() writes nothing and re-arms. Arming to
    // max(nextAt, now) === now would have setTimeout(0) call evaluate() straight back — a hot
    // loop on the main process for the rest of the window.
    expect(h.delivered).toHaveLength(0);
    expect(h.nextWaitMs()).toBe(PTY_SETTLE_MS - 1_000);
  });

  it('a stalled write on one session blocks only that session queue', async () => {
    let release: (v: boolean) => void = () => {};
    const stuck = new Promise<boolean>((r) => {
      release = r;
    });
    const seen: { sessionId: string; message: string }[] = [];
    const h = harness({
      deliver: async (sessionId, message) => {
        seen.push({ sessionId, message });
        return sessionId === 's1' ? stuck : true;
      },
    });
    h.alive.add('s2');
    armFor(h, 's1', 'alpha');
    armFor(h, 's2', 'bravo-one');
    armFor(h, 's2', 'bravo-two');
    await h.tick(60_000);

    // s2's own queue drains both of its schedules while s1's write is still in the PTY.
    expect(seen.map((d) => d.message)).toEqual(['alpha', 'bravo-one', 'bravo-two']);
    expect(h.fired.map((f) => f.sessionId)).toEqual(['s2', 's2']);

    release(true);
    await h.tick(0);
    expect(h.fired.map((f) => f.sessionId)).toEqual(['s2', 's2', 's1']);
    expect(h.fired.at(-1)).toMatchObject({ sessionId: 's1', delivered: true });
  });

  it('disposing one session leaves another session armed schedule alone', async () => {
    const h = harness();
    h.alive.add('s2');
    armFor(h, 's1', 'alpha');
    armFor(h, 's2', 'bravo');
    h.scheduler.onSessionDisposed('s1');
    await h.tick(60_000);

    expect(h.delivered).toEqual([{ sessionId: 's2', message: 'bravo' }]);
    expect(h.scheduler.list().map((s) => s.sessionId)).toEqual(['s2']);
  });
});
