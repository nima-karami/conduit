import { describe, expect, it } from 'vitest';
import { countLines, resolveLineCounts } from '../../src/project-info';

// ---------------------------------------------------------------------------
// countLines
// ---------------------------------------------------------------------------

describe('countLines', () => {
  it('returns 0 for an empty string', () => {
    expect(countLines('')).toBe(0);
  });

  it('counts a single line with no trailing newline', () => {
    expect(countLines('hello')).toBe(1);
  });

  it('counts a single line with a trailing newline', () => {
    expect(countLines('hello\n')).toBe(1);
  });

  it('counts multiple lines with a trailing newline', () => {
    expect(countLines('a\nb\nc\n')).toBe(3);
  });

  it('counts multiple lines without a trailing newline', () => {
    expect(countLines('a\nb\nc')).toBe(3);
  });

  it('counts a file that is just a single newline as 1 line', () => {
    // A file containing only "\n" has one (empty) line.
    expect(countLines('\n')).toBe(1);
  });

  it('handles CRLF line endings the same as LF', () => {
    // Each \n is one line boundary; \r is treated as content, not an extra line.
    expect(countLines('a\r\nb\r\nc\r\n')).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// resolveLineCounts
// ---------------------------------------------------------------------------

describe('resolveLineCounts — modified (M)', () => {
  it('returns numstat added/removed when numstat is present', () => {
    expect(resolveLineCounts('M', { added: 5, removed: 3 }, undefined, undefined)).toEqual({
      added: 5,
      removed: 3,
    });
  });

  it('falls back to 0/0 when numstat is absent', () => {
    expect(resolveLineCounts('M', undefined, undefined, undefined)).toEqual({
      added: 0,
      removed: 0,
    });
  });
});

describe('resolveLineCounts — added (A, staged new file)', () => {
  it('counts all lines as added; removed is 0', () => {
    expect(resolveLineCounts('A', undefined, 'line1\nline2\nline3\n', undefined)).toEqual({
      added: 3,
      removed: 0,
    });
  });

  it('handles empty file (0 added, 0 removed)', () => {
    expect(resolveLineCounts('A', undefined, '', undefined)).toEqual({ added: 0, removed: 0 });
  });

  it('ignores numstat when provided (file-content takes precedence for A)', () => {
    // numstat for a newly-staged file is sometimes absent; even if it is present
    // we always use the file content for 'A' entries so counts are consistent.
    expect(resolveLineCounts('A', { added: 0, removed: 0 }, 'x\ny\n', undefined)).toEqual({
      added: 2,
      removed: 0,
    });
  });

  it('handles undefined fileContent gracefully (treats as empty)', () => {
    expect(resolveLineCounts('A', undefined, undefined, undefined)).toEqual({
      added: 0,
      removed: 0,
    });
  });
});

describe('resolveLineCounts — untracked (U)', () => {
  it('counts all lines as added; removed is 0', () => {
    expect(resolveLineCounts('U', undefined, 'a\nb\n', undefined)).toEqual({
      added: 2,
      removed: 0,
    });
  });

  it('handles empty untracked file', () => {
    expect(resolveLineCounts('U', undefined, '', undefined)).toEqual({ added: 0, removed: 0 });
  });

  it('handles undefined fileContent gracefully', () => {
    expect(resolveLineCounts('U', undefined, undefined, undefined)).toEqual({
      added: 0,
      removed: 0,
    });
  });
});

describe('resolveLineCounts — deleted (D)', () => {
  it('counts all HEAD lines as removed; added is 0', () => {
    expect(resolveLineCounts('D', undefined, undefined, 'foo\nbar\nbaz\n')).toEqual({
      added: 0,
      removed: 3,
    });
  });

  it('handles a deleted file whose HEAD content was empty', () => {
    expect(resolveLineCounts('D', undefined, undefined, '')).toEqual({ added: 0, removed: 0 });
  });

  it('handles undefined headContent gracefully (treats as empty)', () => {
    expect(resolveLineCounts('D', undefined, undefined, undefined)).toEqual({
      added: 0,
      removed: 0,
    });
  });
});

describe('resolveLineCounts — binary (numstat dash tokens → 0/0 already parsed away)', () => {
  // The caller (parseNumstat) converts "-" tokens to 0. resolveLineCounts for 'M'
  // therefore receives { added: 0, removed: 0 } for binary files — no throw.
  it('does not throw and returns 0/0 for a binary-like numstat entry', () => {
    expect(() =>
      resolveLineCounts('M', { added: 0, removed: 0 }, undefined, undefined),
    ).not.toThrow();
    expect(resolveLineCounts('M', { added: 0, removed: 0 }, undefined, undefined)).toEqual({
      added: 0,
      removed: 0,
    });
  });
});
