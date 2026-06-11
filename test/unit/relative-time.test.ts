import { describe, expect, it } from 'vitest';
import { relativeTime } from '../../webview/relative-time';

describe('relativeTime', () => {
  const now = 1_000_000_000;

  it('returns "just now" at zero elapsed', () => {
    expect(relativeTime(now, now)).toBe('just now');
  });

  it('clamps a future timestamp to "just now" (no negatives)', () => {
    expect(relativeTime(now + 10_000, now)).toBe('just now');
  });

  it('shows seconds, then minutes, then hours, then days', () => {
    expect(relativeTime(now - 30 * 1000, now)).toBe('30s ago');
    expect(relativeTime(now - 1 * 60 * 1000, now)).toBe('1 min ago');
    expect(relativeTime(now - 5 * 60 * 1000, now)).toBe('5 mins ago');
    expect(relativeTime(now - 1 * 60 * 60 * 1000, now)).toBe('1 hr ago');
    expect(relativeTime(now - 3 * 60 * 60 * 1000, now)).toBe('3 hrs ago');
    expect(relativeTime(now - 2 * 24 * 60 * 60 * 1000, now)).toBe('2d ago');
  });
});
