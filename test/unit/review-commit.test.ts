import { describe, expect, it } from 'vitest';
import type { FileDiffDTO } from '../../src/protocol';
import { commitChangesFromFiles, reviewSourceLabel } from '../../webview/review-commit';

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
