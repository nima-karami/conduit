import { describe, expect, it } from 'vitest';
import type { CommitNode, FileDiffDTO } from '../../src/protocol';
import {
  commitChangesFromFiles,
  conciseSourceLabel,
  filterCommitsForPicker,
  isPastedSha,
  reviewSourceLabel,
} from '../../webview/review-commit';

const textDiff = (over: Partial<FileDiffDTO>): FileDiffDTO => ({
  path: 'x',
  head: '',
  work: '',
  binary: false,
  ...over,
});

describe('commitChangesFromFiles', () => {
  it('derives kind=A for an added file (empty head), counting added lines', () => {
    const [c] = commitChangesFromFiles([textDiff({ path: 'a.txt', head: '', work: 'one\ntwo\n' })]);
    expect(c.path).toBe('a.txt');
    expect(c.kind).toBe('A');
    expect(c.added).toBe(2);
    expect(c.removed).toBe(0);
    expect(c.staged).toBe(false);
  });

  it('derives kind=D for a deleted file (empty work), counting removed lines', () => {
    const [c] = commitChangesFromFiles([
      textDiff({ path: 'gone.txt', head: 'a\nb\nc\n', work: '' }),
    ]);
    expect(c.kind).toBe('D');
    expect(c.added).toBe(0);
    expect(c.removed).toBe(3);
  });

  it('derives kind=M for a modified file, counting both added and removed lines', () => {
    const [c] = commitChangesFromFiles([
      textDiff({ path: 'm.txt', head: 'a\nb\nc\n', work: 'a\nB\nc\nd\n' }),
    ]);
    expect(c.kind).toBe('M');
    expect(c.added).toBeGreaterThan(0);
    expect(c.removed).toBeGreaterThan(0);
  });

  it('uses image.status for image diffs and does not count text lines', () => {
    const img = textDiff({
      path: 'pic.png',
      image: { status: 'added', work: { dataUrl: 'data:', bytes: 1 } },
    });
    const [c] = commitChangesFromFiles([img]);
    expect(c.kind).toBe('A');
    expect(c.added).toBe(0);
    expect(c.removed).toBe(0);
  });

  it('treats binary files as zero-count modifications by default', () => {
    const [c] = commitChangesFromFiles([
      textDiff({ path: 'b.bin', head: 'x', work: 'y', binary: true }),
    ]);
    expect(c.kind).toBe('M');
    expect(c.added).toBe(0);
    expect(c.removed).toBe(0);
  });

  it('maps every file in order, one ChangeDTO per file', () => {
    const out = commitChangesFromFiles([
      textDiff({ path: 'a', head: '', work: 'x\n' }),
      textDiff({ path: 'b', head: 'y\n', work: '' }),
    ]);
    expect(out.map((c) => c.path)).toEqual(['a', 'b']);
  });
});

describe('reviewSourceLabel', () => {
  it('labels an absent source as the working tree', () => {
    expect(reviewSourceLabel(undefined)).toBe('Reviewing working tree');
  });

  it('labels a working source as the working tree', () => {
    expect(reviewSourceLabel({ kind: 'working' })).toBe('Reviewing working tree');
  });

  it('labels a commit source with its short sha and subject', () => {
    expect(
      reviewSourceLabel({ kind: 'commit', sha: 'abcdef1234567890', subject: 'Fix the thing' }),
    ).toBe('Reviewing commit abcdef1: Fix the thing');
  });

  it('omits the subject when none is given', () => {
    expect(reviewSourceLabel({ kind: 'commit', sha: 'abcdef1234567890' })).toBe(
      'Reviewing commit abcdef1',
    );
  });
});

describe('conciseSourceLabel', () => {
  it('labels an absent source as "Working tree"', () => {
    expect(conciseSourceLabel(undefined)).toBe('Working tree');
  });

  it('labels a working source as "Working tree"', () => {
    expect(conciseSourceLabel({ kind: 'working' })).toBe('Working tree');
  });

  it('labels a commit source as "<sha7> <subject>" (no truncation here)', () => {
    expect(
      conciseSourceLabel({ kind: 'commit', sha: 'abcdef1234567890', subject: 'Fix the thing' }),
    ).toBe('abcdef1 Fix the thing');
  });

  it('labels a commit source as just the sha7 when there is no subject', () => {
    expect(conciseSourceLabel({ kind: 'commit', sha: 'abcdef1234567890' })).toBe('abcdef1');
  });
});

const node = (over: Partial<CommitNode>): CommitNode => ({
  sha: '0000000000000000000000000000000000000000',
  parents: [],
  refs: [],
  author: 'Ada',
  date: 0,
  subject: 'subject',
  ...over,
});

describe('filterCommitsForPicker', () => {
  const commits = [
    node({ sha: 'aaaaaaa1111', subject: 'Add login form', author: 'Ada Lovelace' }),
    node({ sha: 'bbbbbbb2222', subject: 'Fix logout bug', author: 'Grace Hopper' }),
    node({ sha: 'ccccccc3333', subject: 'Refactor router', author: 'Ada Lovelace' }),
  ];

  it('returns everything for an empty / whitespace query', () => {
    expect(filterCommitsForPicker(commits, '')).toHaveLength(3);
    expect(filterCommitsForPicker(commits, '   ')).toHaveLength(3);
  });

  it('matches on a sha PREFIX (not a mid-sha substring)', () => {
    expect(filterCommitsForPicker(commits, 'aaa').map((c) => c.sha)).toEqual(['aaaaaaa1111']);
    expect(filterCommitsForPicker(commits, '1111')).toHaveLength(0);
  });

  it('matches on a subject substring, case-insensitively', () => {
    expect(filterCommitsForPicker(commits, 'LOGIN').map((c) => c.subject)).toEqual([
      'Add login form',
    ]);
  });

  it('matches on an author substring, case-insensitively', () => {
    expect(filterCommitsForPicker(commits, 'ada').map((c) => c.author)).toEqual([
      'Ada Lovelace',
      'Ada Lovelace',
    ]);
  });
});

describe('isPastedSha', () => {
  it('returns null below 7 hex chars', () => {
    expect(isPastedSha('abcdef')).toBeNull();
  });

  it('accepts exactly 7 hex chars (lowercased)', () => {
    expect(isPastedSha('ABCDEF1')).toBe('abcdef1');
  });

  it('accepts a full 40-char sha', () => {
    expect(isPastedSha('a'.repeat(40))).toBe('a'.repeat(40));
  });

  it('returns null above 40 chars', () => {
    expect(isPastedSha('a'.repeat(41))).toBeNull();
  });

  it('returns null for non-hex characters', () => {
    expect(isPastedSha('xyz1234')).toBeNull();
  });

  it('trims surrounding whitespace before testing', () => {
    expect(isPastedSha('  abcdef1234  ')).toBe('abcdef1234');
  });
});
