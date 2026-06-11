import { describe, expect, it } from 'vitest';
import { validateName } from '../../webview/file-tree';

describe('validateName — UI-side name validation', () => {
  const siblings = ['src', 'README.md', 'package.json'];

  it('accepts a fresh, valid name', () => {
    expect(validateName('newfile.ts', siblings)).toBeNull();
  });

  it('rejects an empty name', () => {
    expect(validateName('', siblings)).toBeTruthy();
    expect(validateName('   ', siblings)).toBeTruthy();
  });

  it('rejects dot and dot-dot', () => {
    expect(validateName('.', siblings)).toBeTruthy();
    expect(validateName('..', siblings)).toBeTruthy();
  });

  it('rejects a forward-slash separator', () => {
    expect(validateName('a/b.ts', siblings)).toBeTruthy();
  });

  it('rejects a back-slash separator', () => {
    expect(validateName('a\\b.ts', siblings)).toBeTruthy();
  });

  it('rejects a collision with a loaded sibling', () => {
    expect(validateName('README.md', siblings)).toBeTruthy();
  });

  it('rejects a case-insensitive collision (win32 semantics)', () => {
    expect(validateName('readme.md', siblings)).toBeTruthy();
  });

  it('accepts re-confirming the same name on rename (self excluded)', () => {
    expect(validateName('README.md', siblings, 'README.md')).toBeNull();
  });

  it('still rejects a collision with a DIFFERENT sibling during rename', () => {
    expect(validateName('package.json', siblings, 'README.md')).toBeTruthy();
  });

  it('trims surrounding whitespace before checking', () => {
    expect(validateName('  README.md  ', siblings)).toBeTruthy();
  });
});
