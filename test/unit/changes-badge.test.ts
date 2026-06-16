import { describe, expect, it } from 'vitest';
import { changesBadgeClass } from '../../src/changes-badge';

describe('changesBadgeClass', () => {
  it('returns null when count is zero (no badge rendered)', () => {
    expect(changesBadgeClass(0, false)).toBeNull();
    expect(changesBadgeClass(0, true)).toBeNull();
  });

  it('returns the base class when the Changes tab is active (subtle, no emphasis)', () => {
    expect(changesBadgeClass(3, true)).toBe('rtab__badge');
  });

  it('returns the attention class when the Changes tab is NOT active', () => {
    expect(changesBadgeClass(3, false)).toBe('rtab__badge rtab__badge--attention');
  });

  it('applies attention for any non-zero count while inactive', () => {
    for (const count of [1, 5, 99]) {
      expect(changesBadgeClass(count, false)).toContain('rtab__badge--attention');
    }
  });

  it('never applies attention modifier when active', () => {
    for (const count of [1, 5, 99]) {
      expect(changesBadgeClass(count, true)).not.toContain('rtab__badge--attention');
    }
  });
});
