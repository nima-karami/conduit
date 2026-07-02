import { describe, expect, it } from 'vitest';
import { parseBlamePorcelain } from '../../src/git-blame';

/** One committed line group in `git blame --porcelain` form. Metadata is emitted only on
 *  a sha's FIRST appearance; pass `headerOnly` for a repeated line of an already-seen sha. */
function group(opts: {
  sha: string;
  finalLine: number;
  origLine?: number;
  count?: number;
  content: string;
  headerOnly?: boolean;
  author?: string;
  authorTime?: number;
  summary?: string;
}): string {
  const orig = opts.origLine ?? opts.finalLine;
  const header =
    opts.count !== undefined
      ? `${opts.sha} ${orig} ${opts.finalLine} ${opts.count}`
      : `${opts.sha} ${orig} ${opts.finalLine}`;
  const lines = [header];
  if (!opts.headerOnly) {
    lines.push(
      `author ${opts.author ?? 'Ada Lovelace'}`,
      'author-mail <ada@example.com>',
      `author-time ${opts.authorTime ?? 1700000000}`,
      'author-tz +0000',
      `committer ${opts.author ?? 'Ada Lovelace'}`,
      'committer-mail <ada@example.com>',
      `committer-time ${opts.authorTime ?? 1700000000}`,
      'committer-tz +0000',
      `summary ${opts.summary ?? 'Add the thing'}`,
      'filename file.ts',
    );
  }
  lines.push(`\t${opts.content}`);
  return `${lines.join('\n')}\n`;
}

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const ZERO = '0'.repeat(40);

describe('parseBlamePorcelain', () => {
  it('parses a single committed line with its header fields', () => {
    const out = group({ sha: SHA_A, finalLine: 1, count: 1, content: 'const x = 1;' });
    const lines = parseBlamePorcelain(out);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      line: 1,
      sha: SHA_A,
      author: 'Ada Lovelace',
      authorTime: 1700000000,
      summary: 'Add the thing',
    });
  });

  it('attaches cached header fields to every line of a sha seen only once', () => {
    // Second line of SHA_A carries only the header + tab content — metadata must be reused.
    const out =
      group({ sha: SHA_A, finalLine: 1, count: 2, content: 'line one' }) +
      group({ sha: SHA_A, finalLine: 2, origLine: 2, content: 'line two', headerOnly: true });
    const lines = parseBlamePorcelain(out);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({
      line: 2,
      sha: SHA_A,
      author: 'Ada Lovelace',
      authorTime: 1700000000,
      summary: 'Add the thing',
    });
  });

  it('keeps distinct fields for interleaved shas and honors a later re-appearance', () => {
    const out =
      group({
        sha: SHA_A,
        finalLine: 1,
        count: 1,
        content: 'a1',
        author: 'Ada',
        summary: 'first',
        authorTime: 1000,
      }) +
      group({
        sha: SHA_B,
        finalLine: 2,
        count: 1,
        content: 'b1',
        author: 'Babbage',
        summary: 'second',
        authorTime: 2000,
      }) +
      group({ sha: SHA_A, finalLine: 3, origLine: 9, content: 'a2', headerOnly: true });
    const lines = parseBlamePorcelain(out);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ sha: SHA_A, author: 'Ada', summary: 'first' });
    expect(lines[1]).toMatchObject({ sha: SHA_B, author: 'Babbage', summary: 'second' });
    // The re-appearing SHA_A line reuses SHA_A's cached fields, not SHA_B's.
    expect(lines[2]).toMatchObject({ sha: SHA_A, author: 'Ada', summary: 'first', line: 3 });
  });

  it('marks the all-zero sha / "Not Committed Yet" author as uncommitted', () => {
    const out = group({
      sha: ZERO,
      finalLine: 1,
      count: 1,
      content: 'new stuff',
      author: 'Not Committed Yet',
      summary: 'Version of file.ts from file.ts',
    });
    const lines = parseBlamePorcelain(out);
    expect(lines[0].uncommitted).toBe(true);
    expect(lines[0].sha).toBe(ZERO);
    expect(lines[0].author).toBe('Not Committed Yet');
  });

  it('does not set uncommitted for ordinary committed lines', () => {
    const out = group({ sha: SHA_A, finalLine: 1, count: 1, content: 'x' });
    expect(parseBlamePorcelain(out)[0].uncommitted).toBeUndefined();
  });

  it('uses the mailmap-resolved author name from the author line', () => {
    // git applies .mailmap before emitting porcelain, so whatever the author line says wins.
    const out = group({
      sha: SHA_A,
      finalLine: 1,
      count: 1,
      content: 'x',
      author: 'Real Name',
    });
    expect(parseBlamePorcelain(out)[0].author).toBe('Real Name');
  });

  it('returns an empty array for empty input', () => {
    expect(parseBlamePorcelain('')).toEqual([]);
  });

  it('preserves summaries and content containing spaces and tabs', () => {
    const out = group({
      sha: SHA_A,
      finalLine: 1,
      count: 1,
      content: 'a\tb  c',
      summary: 'fix: handle a\ttab in subject',
    });
    const parsed = parseBlamePorcelain(out);
    expect(parsed[0].summary).toBe('fix: handle a\ttab in subject');
  });
});
