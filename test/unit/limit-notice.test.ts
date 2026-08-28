import { describe, expect, it } from 'vitest';
import {
  decideLimitAction,
  type LimitEpisode,
  type LimitNotice,
  looksLikeLimitLine,
  OFFER_SUPPRESS_MS,
  parseResetClock,
  scanLimitNotice,
} from '../../src/limit-notice';

const TORONTO = 'America/Toronto';
/** 2026-08-28T15:00:00Z = 11:00 EDT. */
const NOW = Date.UTC(2026, 7, 28, 15, 0, 0);
/** 23:10 EDT on the same day. */
const RESET_2310 = Date.UTC(2026, 7, 29, 3, 10);

const tail = (...lines: string[]) => lines;

describe('parseResetClock', () => {
  it('reads 12-hour forms with and without minutes', () => {
    expect(parseResetClock('resets 11:10pm')).toEqual({ clock: '23:10' });
    expect(parseResetClock('resets 11pm')).toEqual({ clock: '23:00' });
    expect(parseResetClock('resets at 11:10 PM')).toEqual({ clock: '23:10' });
    expect(parseResetClock('resets at 7:05 a.m.')).toEqual({ clock: '07:05' });
  });

  it('reads a 24-hour form', () => {
    expect(parseResetClock('resets at 23:10')).toEqual({ clock: '23:10' });
    expect(parseResetClock('resets at 07:05')).toEqual({ clock: '07:05' });
  });

  it('maps noon and midnight the way a clock does, not the way arithmetic does', () => {
    expect(parseResetClock('resets 12am')).toEqual({ clock: '00:00' });
    expect(parseResetClock('resets 12:30pm')).toEqual({ clock: '12:30' });
  });

  it('picks up a parenthesised IANA zone, including a three-part one', () => {
    expect(parseResetClock('resets 11:10pm (America/Toronto)')).toEqual({
      clock: '23:10',
      zone: 'America/Toronto',
    });
    expect(parseResetClock('resets 23:10 (America/Argentina/Buenos_Aires)')).toEqual({
      clock: '23:10',
      zone: 'America/Argentina/Buenos_Aires',
    });
  });

  it('ignores a parenthesised abbreviation that is not an IANA id', () => {
    expect(parseResetClock('resets 11:10pm (EDT)')).toEqual({ clock: '23:10' });
  });

  it('returns null when nothing that could be a time is present', () => {
    expect(parseResetClock('resets later today')).toBeNull();
    expect(parseResetClock('resets at 25:99')).toBeNull();
  });

  it('ignores a time that appears BEFORE the reset anchor', () => {
    expect(parseResetClock('[14:32:07] limit reached — resets 23:10')).toEqual({ clock: '23:10' });
    expect(parseResetClock('[14:32:07] limit reached — resets soon')).toBeNull();
  });

  it('refuses a countdown', () => {
    expect(parseResetClock('resets in 04:59')).toBeNull();
    expect(parseResetClock('resets in 4:59pm')).toBeNull();
  });

  it('returns null for a line with no reset anchor at all', () => {
    expect(parseResetClock('the 23:10 build failed')).toBeNull();
  });
});

describe('scanLimitNotice — real wordings', () => {
  const cases: [string, string][] = [
    ["You've hit your session limit · resets 11:10pm (America/Toronto)", '23:10'],
    ['Claude usage limit reached. Your limit will reset at 11pm.', '23:00'],
    ['Session limit exceeded — resets at 23:10', '23:10'],
    ['You have reached your usage limit; it resets 11:10 PM', '23:10'],
  ];

  for (const [line, clock] of cases) {
    it(`matches: ${line}`, () => {
      const notice = scanLimitNotice(tail('...', 'working', line), NOW);
      expect(notice).not.toBeNull();
      expect(notice?.clock).toBe(clock);
      expect(notice?.line).toBe(line);
    });
  }

  it('resolves the reset instant through the parsed zone', () => {
    const notice = scanLimitNotice(
      tail("You've hit your session limit · resets 11:10pm (America/Toronto)"),
      NOW,
    );
    expect(notice?.resetAt).toBe(RESET_2310);
    expect(notice?.zone).toBe(TORONTO);
  });

  it('reads the notice out of a tail that carries ordinary output above it', () => {
    // Chunk reassembly is PtyHost's job and is tested there (test/unit/pty-host-io.test.ts) —
    // this function is handed lines and cannot see where a chunk ended.
    const notice = scanLimitNotice(
      tail('$ claude', 'Thinking…', "You've hit your session limit · resets 11:10pm"),
      NOW,
    );
    expect(notice?.clock).toBe('23:10');
  });

  it('takes the time AFTER the reset anchor, not the first one in the line', () => {
    // A log stamp in front of the notice is the common shape; reading it as the reset time would
    // arm hours early, in the middle of the working day.
    const notice = scanLimitNotice(
      tail('[14:32:07] Claude usage limit reached — resets 23:10'),
      NOW,
    );
    expect(notice?.clock).toBe('23:10');
  });

  it('matches only the LAST matching line when the footer redraws', () => {
    const notice = scanLimitNotice(
      tail('limit reached, resets 10:00pm', 'still working', 'usage limit reached, resets 11:10pm'),
      NOW,
    );
    expect(notice?.clock).toBe('23:10');
  });
});

describe('scanLimitNotice — what must NOT match', () => {
  const negatives: [string, string][] = [
    ['a real notice that has scrolled away behind diff output', '+  const retries = 3;'],
    ['a comment about a limit with no limit anchor', '+  // the limit resets nightly at 23:10'],
    [
      'an unrelated sentence carrying limit, reset and a time',
      'Please reset your password before the 12:30 deadline; there is no limit',
    ],
    ['a limit with no reset anchor', 'You have hit the limit of open files'],
    ['every anchor but no parseable time', 'Session limit reached — resets later'],
    ['a word that merely contains limit', 'rate limiter tripped; counters reset at 12:30'],
  ];

  for (const [label, line] of negatives) {
    it(`does not match ${label}`, () => {
      expect(scanLimitNotice(tail('x', 'y', line), NOW)).toBeNull();
    });
  }

  it('does not read a COUNTDOWN as a wall clock', () => {
    // "resets in 4:59" is redrawn every second. Read as a clock it arms, then supersedes itself
    // a second later with a new resetAt — a new schedule and a new toast on every tick.
    expect(scanLimitNotice(tail('Session limit reached — resets in 04:59'), NOW)).toBeNull();
    expect(scanLimitNotice(tail('usage limit hit; resets in 12 minutes'), NOW)).toBeNull();
  });

  it('does not match a real notice pushed out of the tail by later output', () => {
    // The tail the host hands in is the WHOLE gate, so the case worth pinning is a tail that
    // once held a notice and no longer does. PtyHost's own test drives the eviction; here the
    // point is that these three lines carry nothing to match.
    const scrolledPast = ['- const a = 1;', '+ const a = 2;', '  const b = 3;'];
    expect(scanLimitNotice(scrolledPast, NOW)).toBeNull();
    // …and the same notice IS a match while it is still in the tail, so the negative above is
    // about the tail's contents rather than about the matcher never matching.
    expect(scanLimitNotice(["You've hit your session limit · resets 11:10pm"], NOW)).not.toBeNull();
  });

  it('returns null for an empty tail', () => {
    expect(scanLimitNotice([], NOW)).toBeNull();
  });
});

describe('decideLimitAction', () => {
  const notice: LimitNotice = {
    resetAt: RESET_2310,
    clock: '23:10',
    zone: TORONTO,
    line: "You've hit your session limit · resets 11:10pm",
  };
  const other: LimitNotice = { ...notice, resetAt: RESET_2310 + 3_600_000, clock: '00:10' };
  const episode = (over: Partial<LimitEpisode> = {}): LimitEpisode => ({
    resetAt: RESET_2310,
    resolved: false,
    at: NOW,
    ...over,
  });

  it('does nothing at all when the mode is off', () => {
    expect(decideLimitAction(undefined, notice, 'off', NOW)).toBe('ignore');
    expect(decideLimitAction(episode(), other, 'off', NOW)).toBe('ignore');
  });

  it('arms a first notice under arm, and offers under offer', () => {
    expect(decideLimitAction(undefined, notice, 'arm', NOW)).toBe('arm');
    expect(decideLimitAction(undefined, notice, 'offer', NOW)).toBe('offer');
  });

  it('ignores a redraw of the same episode', () => {
    expect(decideLimitAction(episode(), notice, 'arm', NOW)).toBe('ignore');
    expect(decideLimitAction(episode(), notice, 'offer', NOW)).toBe('ignore');
  });

  it('supersedes when a different reset time appears', () => {
    expect(decideLimitAction(episode(), other, 'arm', NOW)).toBe('arm');
    expect(decideLimitAction(episode(), other, 'offer', NOW)).toBe('offer');
  });

  it('keeps a dismissed offer quiet for thirty minutes, then offers again', () => {
    const dismissed = episode({ resolved: true, at: NOW });
    expect(decideLimitAction(dismissed, notice, 'offer', NOW + OFFER_SUPPRESS_MS - 1)).toBe(
      'ignore',
    );
    expect(decideLimitAction(dismissed, notice, 'offer', NOW + OFFER_SUPPRESS_MS)).toBe('offer');
  });

  it('never re-arms a resolved episode under arm — the user cancelled it on purpose', () => {
    expect(
      decideLimitAction(episode({ resolved: true }), notice, 'arm', NOW + OFFER_SUPPRESS_MS),
    ).toBe('ignore');
  });
});

describe('looksLikeLimitLine', () => {
  it('is true for a notice whose time did not parse — the one debug-log case', () => {
    expect(looksLikeLimitLine('Session limit reached — resets later')).toBe(true);
    expect(looksLikeLimitLine('You have hit your usage limit; it resets soon')).toBe(true);
  });

  it('is false for a line missing any one of the three anchors', () => {
    expect(looksLikeLimitLine('You have hit the limit of open files')).toBe(false);
    expect(looksLikeLimitLine('the limit resets nightly')).toBe(false);
    expect(looksLikeLimitLine('usage reached, resets soon')).toBe(false);
  });

  it('is false for ordinary output', () => {
    expect(looksLikeLimitLine('$ npm run verify')).toBe(false);
  });
});
