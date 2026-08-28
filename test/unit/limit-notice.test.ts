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

  it('reads a notice that arrived split across two chunks, because the TAIL is reassembled', () => {
    // The host feeds pty.tailLines(), which is derived from the accumulated tail — a notice
    // whose two halves came in different term:data chunks is one line by the time it is read.
    const notice = scanLimitNotice(
      tail('$ claude', "You've hit your session limit · resets 11:10pm"),
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

  it('does not match a real notice pushed out of the tail by later output', () => {
    // Only the last three non-empty lines are ever handed in — that is the whole gate.
    const lines = ['- const a = 1;', '+ const a = 2;', '  const b = 3;'];
    expect(scanLimitNotice(lines, NOW)).toBeNull();
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
