import { describe, expect, it } from 'vitest';
import {
  advanceAfterFire,
  buildSchedule,
  CATCHUP_MS,
  CLOCK_GRACE_MS,
  capError,
  catchUp,
  describeNext,
  formatDuration,
  LATE_GRACE_MS,
  MAX_CLOCK_AHEAD_MS,
  MAX_MESSAGE_CHARS,
  MAX_PER_SESSION,
  MAX_TOTAL,
  markWaiting,
  newTimedMessageId,
  nextFireAt,
  parseTimedMessagesFile,
  renew,
  resolveClockTime,
  sanitizeMessage,
  serializeTimedMessagesFile,
  type TimedMessage,
} from '../../src/timed-messages';

const TORONTO = 'America/Toronto';
const HOUR = 3_600_000;

/** A fixed, zone-independent instant to anchor the clock cases: 2026-08-28T15:00:00Z. */
const NOW = Date.UTC(2026, 7, 28, 15, 0, 0);

const schedule = (over: Partial<TimedMessage> = {}): TimedMessage => ({
  id: 'tm-1',
  sessionId: 's1',
  message: 'Continue',
  kind: 'once',
  nextAt: NOW,
  maxRepeats: 1,
  firedCount: 0,
  state: 'armed',
  origin: 'manual',
  createdAt: NOW - HOUR,
  ...over,
});

describe('sanitizeMessage', () => {
  it('collapses newlines, carriage returns and tabs into single spaces', () => {
    expect(sanitizeMessage('a\r\nb\tc\n\n d')).toBe('a b c d');
  });

  it('strips ESC and every other C0 control', () => {
    expect(sanitizeMessage('\u001b[31mred\u001b[0m\u0000 ok')).toBe('[31mred[0m ok');
  });

  it('strips C1 controls and DEL', () => {
    expect(sanitizeMessage('a\u0090b\u007fc')).toBe('abc');
  });

  it('trims and caps at 2000 characters', () => {
    const long = sanitizeMessage(`  ${'x'.repeat(MAX_MESSAGE_CHARS + 500)}  `);
    expect(long.length).toBe(MAX_MESSAGE_CHARS);
    expect(long.startsWith('x')).toBe(true);
  });

  it('reduces a whitespace-only message to the empty string', () => {
    expect(sanitizeMessage('\r\n\t   ')).toBe('');
  });

  it('leaves an ordinary message alone', () => {
    expect(sanitizeMessage('Continue')).toBe('Continue');
  });
});

describe('newTimedMessageId', () => {
  it('follows the review-notes id convention', () => {
    expect(newTimedMessageId(NOW, () => 0.5)).toMatch(/^tm-[0-9a-z]+-[0-9a-z]+$/);
  });

  it('is unique across calls at the same instant', () => {
    const a = newTimedMessageId(NOW, () => 0.123456);
    const b = newTimedMessageId(NOW, () => 0.987654);
    expect(a).not.toBe(b);
  });
});

describe('resolveClockTime', () => {
  it('resolves the next occurrence today in an explicit zone', () => {
    // 15:00Z on 2026-08-28 is 11:00 EDT; 23:10 EDT the same day is 03:10Z on the 29th.
    expect(resolveClockTime('23:10', TORONTO, NOW)).toBe(Date.UTC(2026, 7, 29, 3, 10));
  });

  it('rolls to tomorrow when the wall clock already passed', () => {
    // 10:00 EDT is 14:00Z — an hour before NOW, well outside the grace.
    expect(resolveClockTime('10:00', TORONTO, NOW)).toBe(Date.UTC(2026, 7, 29, 14, 0));
  });

  it('means NOW inside the two-minute backward grace', () => {
    const justPassed = Date.UTC(2026, 7, 28, 14, 59); // 10:59 EDT, one minute ago
    const t = resolveClockTime('10:59', TORONTO, NOW);
    expect(t).toBe(justPassed);
    expect(NOW - (t as number)).toBeLessThanOrEqual(CLOCK_GRACE_MS);
  });

  it('rolls to tomorrow one millisecond past the grace', () => {
    const now = Date.UTC(2026, 7, 28, 15, 0) + CLOCK_GRACE_MS + 1;
    expect(resolveClockTime('10:58', TORONTO, now)).toBe(Date.UTC(2026, 7, 29, 14, 58));
  });

  it('resolves a spring-forward gap to the instant the clock jumps to', () => {
    // 2026-03-08, America/Toronto: 02:00 EST becomes 03:00 EDT, so 02:30 never happens.
    const before = Date.UTC(2026, 2, 8, 5, 0); // 00:00 EST
    expect(resolveClockTime('02:30', TORONTO, before)).toBe(Date.UTC(2026, 2, 8, 7, 0));
  });

  it('resolves a fall-back ambiguity to the EARLIER instant', () => {
    // 2026-11-01, America/Toronto: 01:30 happens twice — 05:30Z (EDT) then 06:30Z (EST).
    const before = Date.UTC(2026, 10, 1, 4, 0); // 00:00 EDT
    expect(resolveClockTime('01:30', TORONTO, before)).toBe(Date.UTC(2026, 10, 1, 5, 30));
  });

  it('never resolves more than 25 hours ahead', () => {
    expect(MAX_CLOCK_AHEAD_MS).toBe(25 * HOUR);
    for (const clock of ['00:00', '06:30', '12:00', '18:45', '23:59']) {
      const t = resolveClockTime(clock, TORONTO, NOW);
      expect(t).not.toBeNull();
      expect((t as number) - NOW).toBeLessThanOrEqual(MAX_CLOCK_AHEAD_MS);
    }
  });

  it('falls back to the local zone for an unusable zone string', () => {
    // 'EDT' is an abbreviation, not an IANA id — Intl throws on it. CI is ubuntu, so the
    // assertion compares against the zone-less answer rather than a fixed instant.
    expect(resolveClockTime('23:10', 'EDT', NOW)).toBe(resolveClockTime('23:10', undefined, NOW));
  });

  it('returns null for a clock it cannot read', () => {
    expect(resolveClockTime('11pm', TORONTO, NOW)).toBeNull();
    expect(resolveClockTime('25:00', TORONTO, NOW)).toBeNull();
    expect(resolveClockTime('', TORONTO, NOW)).toBeNull();
  });
});

describe('nextFireAt', () => {
  it('resolves each trigger to an instant, and null for an unreadable clock', () => {
    expect(nextFireAt({ kind: 'in', delayMs: 60_000 }, NOW)).toBe(NOW + 60_000);
    expect(nextFireAt({ kind: 'every', everyMs: 2 * HOUR, maxRepeats: 3 }, NOW)).toBe(
      NOW + 2 * HOUR,
    );
    expect(nextFireAt({ kind: 'at', clock: '23:10', zone: TORONTO }, NOW)).toBe(
      Date.UTC(2026, 7, 29, 3, 10),
    );
    expect(nextFireAt({ kind: 'at', clock: 'noon' }, NOW)).toBeNull();
  });
});

describe('buildSchedule', () => {
  it('builds an In schedule at now + delay', () => {
    const r = buildSchedule(
      { sessionId: 's1', message: 'Continue', trigger: { kind: 'in', delayMs: 30 * 60_000 } },
      NOW,
      { id: 'tm-1' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.schedule).toMatchObject({
      id: 'tm-1',
      kind: 'once',
      maxRepeats: 1,
      firedCount: 0,
      state: 'armed',
      origin: 'manual',
      nextAt: NOW + 30 * 60_000,
    });
    expect(r.schedule.spec).toBeUndefined();
    expect(r.schedule.everyMs).toBeUndefined();
  });

  it('stores the wall-clock intent for an At schedule, which Renew needs', () => {
    const r = buildSchedule(
      {
        sessionId: 's1',
        message: 'Continue',
        trigger: { kind: 'at', clock: '23:10', zone: TORONTO },
      },
      NOW,
      { id: 'tm-2' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.schedule.spec).toEqual({ clock: '23:10', zone: TORONTO });
    expect(r.schedule.nextAt).toBe(Date.UTC(2026, 7, 29, 3, 10));
  });

  it('builds an interval schedule at now + everyMs with its repeat count', () => {
    const r = buildSchedule(
      {
        sessionId: 's1',
        message: 'Do this again',
        trigger: { kind: 'every', everyMs: 2 * HOUR, maxRepeats: 5 },
      },
      NOW,
      { id: 'tm-3' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.schedule).toMatchObject({ kind: 'interval', everyMs: 2 * HOUR, maxRepeats: 5 });
    expect(r.schedule.nextAt).toBe(NOW + 2 * HOUR);
  });

  it('sanitizes the message it stores', () => {
    const r = buildSchedule(
      { sessionId: 's1', message: 'go\r\nnow', trigger: { kind: 'in', delayMs: 60_000 } },
      NOW,
    );
    expect(r.ok && r.schedule.message).toBe('go now');
  });

  it('refuses a message that sanitizes to nothing', () => {
    const r = buildSchedule(
      { sessionId: 's1', message: '\r\n', trigger: { kind: 'in', delayMs: 60_000 } },
      NOW,
    );
    expect(r).toEqual({ ok: false, error: 'Type a message to send.' });
  });

  it('refuses a delay under the floor, and honours a lowered floor', () => {
    const input = {
      sessionId: 's1',
      message: 'go',
      trigger: { kind: 'in' as const, delayMs: 800 },
    };
    expect(buildSchedule(input, NOW).ok).toBe(false);
    expect(buildSchedule(input, NOW, { minDelayMs: 0 }).ok).toBe(true);
  });

  it('refuses an interval under a minute and a repeat count out of range', () => {
    expect(
      buildSchedule(
        {
          sessionId: 's1',
          message: 'go',
          trigger: { kind: 'every', everyMs: 1000, maxRepeats: 3 },
        },
        NOW,
      ).ok,
    ).toBe(false);
    expect(
      buildSchedule(
        {
          sessionId: 's1',
          message: 'go',
          trigger: { kind: 'every', everyMs: HOUR, maxRepeats: 0 },
        },
        NOW,
      ).ok,
    ).toBe(false);
    expect(
      buildSchedule(
        {
          sessionId: 's1',
          message: 'go',
          trigger: { kind: 'every', everyMs: HOUR, maxRepeats: 101 },
        },
        NOW,
      ).ok,
    ).toBe(false);
  });

  it('refuses an unreadable clock', () => {
    const r = buildSchedule(
      { sessionId: 's1', message: 'go', trigger: { kind: 'at', clock: 'half eleven' } },
      NOW,
    );
    expect(r.ok).toBe(false);
  });
});

describe('capError', () => {
  const on = (sessionId: string, id: string) => schedule({ id, sessionId });

  it('allows the third schedule on a session and refuses the fourth', () => {
    const three = [on('s1', 'a'), on('s1', 'b'), on('s1', 'c')];
    expect(capError(three.slice(0, 2), 's1', undefined)).toBeNull();
    expect(capError(three, 's1', undefined)).toBe(
      `${MAX_PER_SESSION} timed messages already on this session — cancel one first.`,
    );
  });

  it('does not count the schedule being edited against its own cap', () => {
    const three = [on('s1', 'a'), on('s1', 'b'), on('s1', 'c')];
    expect(capError(three, 's1', 'b')).toBeNull();
  });

  it('does not count done schedules', () => {
    const three = [
      on('s1', 'a'),
      on('s1', 'b'),
      schedule({ id: 'c', sessionId: 's1', state: 'done' }),
    ];
    expect(capError(three, 's1', undefined)).toBeNull();
  });

  it('refuses past the global total', () => {
    const many = Array.from({ length: MAX_TOTAL }, (_, i) => on(`s${i}`, `id${i}`));
    expect(capError(many, 'sNew', undefined)).toBe(
      `${MAX_TOTAL} timed messages already armed — cancel one first.`,
    );
  });
});

describe('catchUp', () => {
  it('waits while nextAt is still ahead', () => {
    expect(catchUp(schedule({ nextAt: NOW + 60_000 }), NOW)).toMatchObject({ action: 'wait' });
  });

  it('fires on time without marking late, right up to the grace', () => {
    expect(catchUp(schedule({ nextAt: NOW - 5 }), NOW)).toMatchObject({
      action: 'fire',
      late: false,
      slots: 1,
    });
    expect(catchUp(schedule({ nextAt: NOW - LATE_GRACE_MS }), NOW).late).toBe(false);
    expect(catchUp(schedule({ nextAt: NOW - LATE_GRACE_MS - 1 }), NOW).late).toBe(true);
  });

  it('fires late inside the manual window', () => {
    const d = catchUp(schedule({ nextAt: NOW - 5 * HOUR }), NOW);
    expect(d).toMatchObject({ action: 'fire', late: true, slots: 1 });
  });

  it('skips a manual schedule past its 6 hour window', () => {
    const d = catchUp(schedule({ nextAt: NOW - CATCHUP_MS.manual - 1 }), NOW);
    expect(d.action).toBe('skip');
  });

  it('delivers the lid-closed-overnight limit case and skips the same delay for manual', () => {
    const overnight = 10 * HOUR;
    expect(catchUp(schedule({ origin: 'limit', nextAt: NOW - overnight }), NOW)).toMatchObject({
      action: 'fire',
      late: true,
    });
    expect(catchUp(schedule({ origin: 'manual', nextAt: NOW - overnight }), NOW).action).toBe(
      'skip',
    );
  });

  it('skips a limit schedule past its 24 hour window', () => {
    expect(
      catchUp(schedule({ origin: 'limit', nextAt: NOW - CATCHUP_MS.limit - 1 }), NOW).action,
    ).toBe('skip');
  });

  it('collapses several elapsed interval slots into one delivery', () => {
    const s = schedule({
      kind: 'interval',
      everyMs: HOUR,
      maxRepeats: 10,
      nextAt: NOW - 3 * HOUR - 1,
    });
    expect(catchUp(s, NOW)).toMatchObject({ action: 'fire', slots: 4, late: true });
  });

  it('caps the collapsed slots at the repeats that remain', () => {
    const s = schedule({
      kind: 'interval',
      everyMs: HOUR,
      maxRepeats: 3,
      firedCount: 1,
      nextAt: NOW - 5 * HOUR,
    });
    expect(catchUp(s, NOW).slots).toBe(2);
  });

  it('never fires a schedule with no repeats left or one already done', () => {
    expect(catchUp(schedule({ maxRepeats: 1, firedCount: 1, nextAt: NOW - 1 }), NOW).action).toBe(
      'wait',
    );
    expect(catchUp(schedule({ state: 'done', nextAt: NOW - 1 }), NOW).action).toBe('wait');
  });

  it('marks a waiting schedule late however briefly it waited', () => {
    const s = schedule({ state: 'waiting', waitingSince: NOW - 1, nextAt: NOW - 1 });
    expect(catchUp(s, NOW)).toMatchObject({ action: 'fire', late: true });
  });

  it('treats a waiting schedule as due — the window is applied when it becomes deliverable', () => {
    const s = schedule({ state: 'waiting', waitingSince: NOW - HOUR, nextAt: NOW - HOUR });
    expect(catchUp(s, NOW)).toMatchObject({ action: 'fire', late: true });
  });
});

describe('advanceAfterFire', () => {
  it('marks a once schedule done and records the fire', () => {
    const next = advanceAfterFire(schedule(), NOW, { slots: 1, late: false, delivered: true });
    expect(next).toMatchObject({ firedCount: 1, state: 'done' });
    expect(next.lastFire).toEqual({ at: NOW, late: false, delivered: true });
  });

  it('re-arms an interval at nextAt + slots * everyMs', () => {
    const s = schedule({ kind: 'interval', everyMs: HOUR, maxRepeats: 3, nextAt: NOW - 2 * HOUR });
    const next = advanceAfterFire(s, NOW, { slots: 3, late: true, delivered: true });
    // 3 slots consumed of 3 → done, and nextAt is never moved past the end.
    expect(next).toMatchObject({ firedCount: 3, state: 'done' });

    const partial = advanceAfterFire(
      schedule({ kind: 'interval', everyMs: HOUR, maxRepeats: 5, nextAt: NOW - 1 }),
      NOW,
      { slots: 1, late: false, delivered: true },
    );
    expect(partial).toMatchObject({ firedCount: 1, state: 'armed', nextAt: NOW - 1 + HOUR });
  });

  it('advances past NOW when several slots elapsed, so it cannot re-fire immediately', () => {
    const s = schedule({
      kind: 'interval',
      everyMs: HOUR,
      maxRepeats: 10,
      nextAt: NOW - 3 * HOUR - 1,
    });
    const next = advanceAfterFire(s, NOW, { slots: 4, late: true, delivered: true });
    expect(next.nextAt).toBeGreaterThan(NOW);
  });

  it('records a failure reason and clears the waiting marker', () => {
    const s = schedule({ state: 'waiting', waitingSince: NOW - HOUR });
    const next = advanceAfterFire(s, NOW, {
      slots: 1,
      late: true,
      delivered: false,
      reason: 'noSession',
    });
    expect(next.lastFire).toEqual({ at: NOW, late: true, delivered: false, reason: 'noSession' });
    expect(next.waitingSince).toBeUndefined();
    expect(next.state).toBe('done');
  });
});

describe('markWaiting', () => {
  it('stamps waitingSince with the missed nextAt', () => {
    const s = schedule({ nextAt: NOW - HOUR });
    const w = markWaiting(s, s.nextAt);
    expect(w).toMatchObject({ state: 'waiting', waitingSince: NOW - HOUR, nextAt: NOW - HOUR });
  });

  it('is idempotent, so a re-evaluation raises no change', () => {
    const w = markWaiting(schedule(), NOW);
    expect(markWaiting(w, NOW)).toBe(w);
  });
});

describe('renew', () => {
  it('re-resolves the stored wall clock for an At schedule rather than adding an offset', () => {
    const s = schedule({
      spec: { clock: '23:10', zone: TORONTO },
      nextAt: NOW - 5 * HOUR,
      firedCount: 1,
      state: 'done',
      lastFire: { at: NOW - 5 * HOUR, late: false, delivered: true },
    });
    const r = renew(s, NOW);
    expect(r).not.toBeNull();
    expect(r).toMatchObject({
      nextAt: Date.UTC(2026, 7, 29, 3, 10),
      firedCount: 0,
      state: 'armed',
    });
    // The receipt survives: the row's "Last sent" is the user's only record of the fire.
    expect(r?.lastFire).toEqual(s.lastFire);
  });

  it('restarts an interval at now + everyMs', () => {
    const s = schedule({
      kind: 'interval',
      everyMs: 2 * HOUR,
      maxRepeats: 5,
      firedCount: 5,
      state: 'done',
    });
    expect(renew(s, NOW)).toMatchObject({ nextAt: NOW + 2 * HOUR, firedCount: 0, state: 'armed' });
  });

  it('restarts a plain delay at its original distance from creation', () => {
    const s = schedule({
      createdAt: NOW - 4 * HOUR,
      nextAt: NOW - 3 * HOUR,
      state: 'done',
      firedCount: 1,
    });
    expect(renew(s, NOW)?.nextAt).toBe(NOW + HOUR);
  });

  it('drops the waiting marker', () => {
    const s = schedule({ state: 'waiting', waitingSince: NOW - HOUR });
    expect(renew(s, NOW)?.waitingSince).toBeUndefined();
  });
});

describe('formatDuration / describeNext', () => {
  const at = () => '11:10 PM';

  it('formats short forms', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(4 * 60_000)).toBe('4m');
    expect(formatDuration(2 * HOUR)).toBe('2h');
    expect(formatDuration(2 * HOUR + 12 * 60_000)).toBe('2h 12m');
    expect(formatDuration(30 * HOUR)).toBe('1d');
  });

  it('counts down under an hour and names the clock time beyond it', () => {
    expect(describeNext(schedule({ nextAt: NOW + 4 * 60_000 }), NOW, at)).toBe('in 4m');
    expect(describeNext(schedule({ nextAt: NOW + 4 * HOUR }), NOW, at)).toBe('at 11:10 PM');
  });

  it('says Waiting and the completed count instead of a countdown', () => {
    expect(describeNext(schedule({ state: 'waiting' }), NOW, at)).toBe('Waiting');
    expect(describeNext(schedule({ state: 'done', firedCount: 3, maxRepeats: 3 }), NOW, at)).toBe(
      'Sent 3 of 3',
    );
  });

  it('says due now for a schedule whose moment has passed', () => {
    expect(describeNext(schedule({ nextAt: NOW - 1 }), NOW, at)).toBe('due now');
  });
});

describe('the persisted file', () => {
  it('round-trips armed and waiting schedules', () => {
    const file = {
      version: 1 as const,
      schedules: [schedule(), schedule({ id: 'tm-2', state: 'waiting' as const })],
    };
    expect(parseTimedMessagesFile(serializeTimedMessagesFile(file)).schedules).toHaveLength(2);
  });

  it('drops done schedules on write — they exist only for the rest of the run', () => {
    const file = {
      version: 1 as const,
      schedules: [schedule(), schedule({ id: 'tm-2', state: 'done' as const })],
    };
    const back = parseTimedMessagesFile(serializeTimedMessagesFile(file));
    expect(back.schedules.map((s) => s.id)).toEqual(['tm-1']);
  });

  it('treats an absent, corrupt or foreign-version file as empty', () => {
    expect(parseTimedMessagesFile(undefined).schedules).toEqual([]);
    expect(parseTimedMessagesFile('{oops').schedules).toEqual([]);
    expect(parseTimedMessagesFile('[]').schedules).toEqual([]);
    expect(
      parseTimedMessagesFile(JSON.stringify({ version: 2, schedules: [schedule()] })).schedules,
    ).toEqual([]);
  });

  it('drops entries that are not schedules and caps the total', () => {
    const junk = JSON.stringify({
      version: 1,
      schedules: [schedule(), { id: 'x' }, null, 'nope'],
    });
    expect(parseTimedMessagesFile(junk).schedules).toHaveLength(1);

    const flood = JSON.stringify({
      version: 1,
      schedules: Array.from({ length: MAX_TOTAL + 5 }, (_, i) => schedule({ id: `tm-${i}` })),
    });
    expect(parseTimedMessagesFile(flood).schedules).toHaveLength(MAX_TOTAL);
  });
});
