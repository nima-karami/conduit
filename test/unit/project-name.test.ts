import { describe, expect, it } from 'vitest';
import { normalizeProjectName, renamedProjectName } from '../../src/project-name';

describe('normalizeProjectName', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeProjectName('  RMB   pipeline ')).toBe('RMB pipeline');
    expect(normalizeProjectName('a\t\nb')).toBe('a b');
  });

  it('empty, whitespace-only, 81 chars, non-string → null; 80 chars ok', () => {
    expect(normalizeProjectName('')).toBeNull();
    expect(normalizeProjectName('   ')).toBeNull();
    expect(normalizeProjectName('x'.repeat(81))).toBeNull();
    expect(normalizeProjectName(42)).toBeNull();
    expect(normalizeProjectName(undefined)).toBeNull();
    expect(normalizeProjectName('x'.repeat(80))).toBe('x'.repeat(80));
    expect(normalizeProjectName(`  ${'y'.repeat(80)}  `)).toBe('y'.repeat(80));
  });
});

describe('renamedProjectName', () => {
  it('renamedProjectName: unchanged → null, empty → null, changed → normalized', () => {
    expect(renamedProjectName('Alpha', 'Alpha')).toBeNull();
    expect(renamedProjectName('  Alpha  ', 'Alpha')).toBeNull();
    expect(renamedProjectName('', 'Alpha')).toBeNull();
    expect(renamedProjectName('   ', 'Alpha')).toBeNull();
    expect(renamedProjectName('x'.repeat(81), 'Alpha')).toBeNull();
    expect(renamedProjectName(' Alpha   2 ', 'Alpha')).toBe('Alpha 2');
  });
});
