import { describe, expect, it } from 'vitest';
import { collapseWhitespace, computeFileReview } from '../../src/review-hunks';

const IGNORE = { ignoreWhitespace: true };

describe('collapseWhitespace', () => {
  it('collapses runs and trims the ends', () => {
    expect(collapseWhitespace('\tconst  a   =  1;  ')).toBe('const a = 1;');
  });

  it('keeps a token boundary — a+b is NOT a + b', () => {
    expect(collapseWhitespace('a+b')).not.toBe(collapseWhitespace('a + b'));
  });

  it('collapses a blank line to empty', () => {
    expect(collapseWhitespace('   \t ')).toBe('');
  });
});

describe('computeFileReview with ignoreWhitespace', () => {
  const head = 'function f() {\nreturn 1;\n}\n';
  const reindented = 'function f() {\n  return 1;\n}\n';

  it('reports an indent-only change by default', () => {
    const r = computeFileReview(head, reindented);
    expect(r.hunks.length).toBeGreaterThan(0);
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
  });

  it('reports NO hunks for an indent-only change when the option is on', () => {
    const r = computeFileReview(head, reindented, 3, undefined, IGNORE);
    expect(r.hunks).toEqual([]);
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
  });

  it('still reports a real change in a re-indented file, and only that change', () => {
    const work = 'function f() {\n  return 2;\n}\n';
    const r = computeFileReview(head, work, 3, undefined, IGNORE);
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
    const changed = r.hunks.flatMap((h) => h.lines).filter((l) => l.kind !== 'context');
    expect(changed.map((l) => l.text.trim())).toEqual(['return 1;', 'return 2;']);
  });

  it('renders the NEW side of a loosely-matched context line, not the old one', () => {
    const work = 'function f() {\n\t\treturn 1;\n}\nconst extra = 1;\n';
    const r = computeFileReview(head, work, 3, undefined, IGNORE);
    const context = r.hunks.flatMap((h) => h.lines).find((l) => l.text.includes('return 1;'));
    expect(context?.kind).toBe('context');
    expect(context?.text).toBe('\t\treturn 1;');
  });

  it('leaves a trailing-whitespace-only change invisible', () => {
    expect(computeFileReview('a\nb\n', 'a   \nb\n', 3, undefined, IGNORE).hunks).toEqual([]);
  });

  it('does not let a collapsed blank line swallow a real deletion', () => {
    const r = computeFileReview('a\n\nb\n', 'a\nb\n', 3, undefined, IGNORE);
    expect(r.removed).toBe(1);
  });

  it('honours the Lane A cell budget alongside the option', () => {
    const a = Array.from({ length: 600 }, (_, i) => `  a${i}`).join('\n');
    const b = Array.from({ length: 600 }, (_, i) => `\tb${i}`).join('\n');
    expect(computeFileReview(a, b, 3, 250_000, IGNORE).approx).toBe(true);
  });

  it('an unchanged file is unchanged either way', () => {
    expect(computeFileReview(head, head, 3, undefined, IGNORE).hunks).toEqual([]);
  });
});
