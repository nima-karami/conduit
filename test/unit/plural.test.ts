import { describe, expect, it } from 'vitest';
import { plural } from '../../src/plural';

describe('plural', () => {
  it('picks singular at 1 and the plural form otherwise', () => {
    expect(plural(1, 'file')).toBe('1 file');
    expect(plural(0, 'file')).toBe('0 files');
    expect(plural(3, 'file')).toBe('3 files');
    expect(plural(2, 'match', 'matches')).toBe('2 matches');
  });

  it('uses the explicit plural form only away from 1', () => {
    expect(plural(1, 'match', 'matches')).toBe('1 match');
  });
});
