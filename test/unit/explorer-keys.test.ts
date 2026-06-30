import { describe, expect, it } from 'vitest';
import { topLevelPaths } from '../../src/drop-intent';
import { nextVisiblePath, renameSelectionRange, validateName } from '../../webview/file-tree';

describe('renameSelectionRange — stem-only selection', () => {
  it('selects only the stem of a file with an extension', () => {
    expect(renameSelectionRange('component.tsx', 'file')).toEqual({ start: 0, end: 9 });
  });

  it('selects the whole name for a multi-dot file (last dot wins)', () => {
    expect(renameSelectionRange('a.test.ts', 'file')).toEqual({ start: 0, end: 6 });
  });

  it('selects the whole name for an extensionless file', () => {
    expect(renameSelectionRange('Makefile', 'file')).toEqual({ start: 0, end: 8 });
  });

  it('selects the whole name for a leading-dot dotfile', () => {
    expect(renameSelectionRange('.env', 'file')).toEqual({ start: 0, end: 4 });
  });

  it('selects the whole name for a folder (even with a dot)', () => {
    expect(renameSelectionRange('my.folder', 'dir')).toEqual({ start: 0, end: 9 });
  });
});

describe('validateName — reserved / invalid Windows names', () => {
  const siblings = ['src', 'README.md'];

  it('rejects reserved device names with or without extension', () => {
    expect(validateName('CON', siblings)).toBeTruthy();
    expect(validateName('con.txt', siblings)).toBeTruthy();
    expect(validateName('LPT1', siblings)).toBeTruthy();
    expect(validateName('aux', siblings)).toBeTruthy();
  });

  it('rejects invalid filename characters', () => {
    expect(validateName('a:b', siblings)).toBeTruthy();
    expect(validateName('a?b', siblings)).toBeTruthy();
    expect(validateName('a*b', siblings)).toBeTruthy();
    expect(validateName('a|b', siblings)).toBeTruthy();
  });

  it('rejects a trailing period', () => {
    expect(validateName('file.', siblings)).toBeTruthy();
  });

  it('still accepts an ordinary name and a dotfile', () => {
    expect(validateName('valid-name.ts', siblings)).toBeNull();
    expect(validateName('.env', siblings)).toBeNull();
    // "CONSTANTS" is not a reserved name — only the exact device stems are.
    expect(validateName('CONSTANTS.ts', siblings)).toBeNull();
  });
});

describe('nextVisiblePath — keyboard navigation', () => {
  const order = ['a', 'b', 'c'];

  it('moves down and up', () => {
    expect(nextVisiblePath(order, 'a', 'down')).toBe('b');
    expect(nextVisiblePath(order, 'b', 'up')).toBe('a');
  });

  it('clamps at the ends', () => {
    expect(nextVisiblePath(order, 'c', 'down')).toBe('c');
    expect(nextVisiblePath(order, 'a', 'up')).toBe('a');
  });

  it('jumps to first/last', () => {
    expect(nextVisiblePath(order, 'b', 'first')).toBe('a');
    expect(nextVisiblePath(order, 'b', 'last')).toBe('c');
  });

  it('seeds from the matching edge when current is absent', () => {
    expect(nextVisiblePath(order, null, 'down')).toBe('a');
    expect(nextVisiblePath(order, null, 'up')).toBe('c');
    expect(nextVisiblePath([], null, 'down')).toBeNull();
  });
});

describe('topLevelPaths — multi-drag de-dupe', () => {
  it('drops descendants of another selected path', () => {
    const sel = ['/r/src', '/r/src/a.ts', '/r/lib'];
    expect(topLevelPaths(sel).sort()).toEqual(['/r/lib', '/r/src']);
  });

  it('de-dupes exact duplicates', () => {
    expect(topLevelPaths(['/r/a', '/r/a'])).toEqual(['/r/a']);
  });

  it('keeps siblings that are not nested', () => {
    const sel = ['/r/a.ts', '/r/b.ts'];
    expect(topLevelPaths(sel).sort()).toEqual(['/r/a.ts', '/r/b.ts']);
  });

  it('handles Windows paths case-insensitively', () => {
    const sel = ['C:/R/Src', 'c:/r/src/a.ts'];
    expect(topLevelPaths(sel)).toEqual(['C:/R/Src']);
  });
});
