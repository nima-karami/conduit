import { describe, expect, it } from 'vitest';
import { parseResetText } from '../../src/reset-time';

const NOV13_1500_TORONTO = Date.UTC(2026, 10, 13, 20, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

describe('parseResetText — clock', () => {
  it('reads a 12-hour clock in the named zone to its next occurrence', () => {
    expect(parseResetText('11:10pm (America/Toronto)', 'clock', NOV13_1500_TORONTO)).toBe(
      Date.UTC(2026, 10, 14, 4, 10),
    );
    expect(parseResetText('3:45 PM (America/Toronto)', 'clock', NOV13_1500_TORONTO)).toBe(
      Date.UTC(2026, 10, 13, 20, 45),
    );
  });

  it('reads a 24-hour clock', () => {
    expect(parseResetText('23:10 (America/Toronto)', 'clock', NOV13_1500_TORONTO)).toBe(
      Date.UTC(2026, 10, 14, 4, 10),
    );
  });

  it('maps 12am to midnight and 12:30pm to half past noon', () => {
    expect(parseResetText('12am (America/Toronto)', 'clock', NOV13_1500_TORONTO)).toBe(
      Date.UTC(2026, 10, 14, 5, 0),
    );
    expect(parseResetText('12:30pm (America/Toronto)', 'clock', NOV13_1500_TORONTO)).toBe(
      Date.UTC(2026, 10, 14, 17, 30),
    );
  });

  it('refuses a countdown read as a wall clock', () => {
    expect(parseResetText('in 04:59', 'clock', NOV13_1500_TORONTO)).toBeNull();
    expect(parseResetText('in 4:59pm', 'clock', NOV13_1500_TORONTO)).toBeNull();
  });

  it('returns null when no time is readable or the time is impossible', () => {
    expect(parseResetText('later today', 'clock', NOV13_1500_TORONTO)).toBeNull();
    expect(parseResetText('25:99', 'clock', NOV13_1500_TORONTO)).toBeNull();
  });

  it('treats an abbreviation that is not an IANA id as no zone rather than failing', () => {
    expect(parseResetText('11:10pm (EDT)', 'clock', NOV13_1500_TORONTO)).not.toBeNull();
  });
});

describe('parseResetText — clock-or-date', () => {
  it('keeps the date in "Nov 18, 3pm" instead of resolving to today', () => {
    expect(
      parseResetText('Nov 18, 3pm (America/Toronto)', 'clock-or-date', NOV13_1500_TORONTO),
    ).toBe(Date.UTC(2026, 10, 18, 20, 0));
  });

  it('reads an ordinal day with a year and minutes', () => {
    expect(
      parseResetText(
        'Nov 18th, 2026 3:45 PM (America/Toronto)',
        'clock-or-date',
        NOV13_1500_TORONTO,
      ),
    ).toBe(Date.UTC(2026, 10, 18, 20, 45));
  });

  it('reads "November 18 at 3pm"', () => {
    expect(
      parseResetText('November 18 at 3pm (America/Toronto)', 'clock-or-date', NOV13_1500_TORONTO),
    ).toBe(Date.UTC(2026, 10, 18, 20, 0));
  });

  it('rolls the year over when the next occurrence is in January', () => {
    const lateDec = Date.UTC(2026, 11, 31, 20, 0, 0);
    expect(parseResetText('Jan 2, 3pm (America/Toronto)', 'clock-or-date', lateDec)).toBe(
      Date.UTC(2027, 0, 2, 20, 0),
    );
  });

  it('still reads a bare clock', () => {
    expect(parseResetText('11:10pm (America/Toronto)', 'clock-or-date', NOV13_1500_TORONTO)).toBe(
      Date.UTC(2026, 10, 14, 4, 10),
    );
  });

  it('refuses a date more than eight days ahead', () => {
    expect(
      parseResetText('Nov 22, 3pm (America/Toronto)', 'clock-or-date', NOV13_1500_TORONTO),
    ).toBeNull();
  });

  it('refuses a date more than a day in the past', () => {
    expect(
      parseResetText('Nov 11, 3pm (America/Toronto)', 'clock-or-date', NOV13_1500_TORONTO),
    ).toBeNull();
  });
});

describe('parseResetText — countdown', () => {
  it('adds the duration to now', () => {
    expect(parseResetText('4h 59m', 'countdown', NOV13_1500_TORONTO)).toBe(
      NOV13_1500_TORONTO + 4 * HOUR + 59 * MIN,
    );
    expect(parseResetText('59m', 'countdown', NOV13_1500_TORONTO)).toBe(
      NOV13_1500_TORONTO + 59 * MIN,
    );
    expect(parseResetText('2 hours', 'countdown', NOV13_1500_TORONTO)).toBe(
      NOV13_1500_TORONTO + 2 * HOUR,
    );
    expect(parseResetText('4:59', 'countdown', NOV13_1500_TORONTO)).toBe(
      NOV13_1500_TORONTO + 4 * HOUR + 59 * MIN,
    );
  });

  it('returns null for text that is not a duration', () => {
    expect(parseResetText('soon', 'countdown', NOV13_1500_TORONTO)).toBeNull();
  });

  it('refuses a duration beyond eight days', () => {
    expect(parseResetText('300 hours', 'countdown', NOV13_1500_TORONTO)).toBeNull();
  });
});
