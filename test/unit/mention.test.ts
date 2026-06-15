import { describe, expect, it } from 'vitest';
import { formatMention, toRelative } from '../../webview/mention';

describe('toRelative', () => {
  it('returns the path relative to the project root (slash-normalised)', () => {
    expect(toRelative('C:\\dev\\conduit', 'C:\\dev\\conduit\\src\\app.ts')).toBe('src/app.ts');
    expect(toRelative('/home/me/proj', '/home/me/proj/a/b.ts')).toBe('a/b.ts');
  });

  it('is case-insensitive on the root prefix (Windows drives)', () => {
    expect(toRelative('C:\\Dev\\Conduit', 'c:\\dev\\conduit\\x.ts')).toBe('x.ts');
  });

  it('falls back to the basename when the file is outside the root', () => {
    expect(toRelative('C:\\dev\\conduit', 'D:\\other\\thing.ts')).toBe('thing.ts');
  });
});

describe('formatMention', () => {
  it('builds an @path#Lstart-Lend reference', () => {
    expect(formatMention('C:\\dev\\conduit', 'C:\\dev\\conduit\\src\\app.ts', 10, 20)).toBe(
      '@src/app.ts#L10-L20',
    );
  });

  it('collapses a single-line selection to #Ln', () => {
    expect(formatMention('/p', '/p/a.ts', 7, 7)).toBe('@a.ts#L7');
  });

  it('orders the range regardless of selection direction', () => {
    expect(formatMention('/p', '/p/a.ts', 20, 10)).toBe('@a.ts#L10-L20');
  });
});
