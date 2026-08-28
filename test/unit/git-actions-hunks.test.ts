import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildHunkPlan, type GitActionPlan, planGitAction } from '../../src/git-actions';
import type { HunkRange } from '../../src/hunk-patch';

const ROOT = path.resolve('/work/repo');
const RANGE: HunkRange = { new: [10, 12], old: [10, 11] };

const plan = (op: 'stageHunk' | 'unstageHunk' | 'discardHunk', p = 'src/a.ts'): GitActionPlan =>
  planGitAction({ root: ROOT, op, path: p, range: RANGE });

describe('buildHunkPlan', () => {
  it('reads index-to-worktree for a stage and applies to the index', () => {
    expect(buildHunkPlan('stageHunk', 'src/a.ts')).toEqual({
      diffArgs: [
        'diff',
        '--no-ext-diff',
        '--no-color',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        '-U3',
        '--',
        'src/a.ts',
      ],
      applyArgs: ['apply', '--cached', '--whitespace=nowarn'],
    });
  });

  it('reads HEAD-to-index for an unstage and reverses it in the index', () => {
    const { diffArgs, applyArgs } = buildHunkPlan('unstageHunk', 'src/a.ts');
    expect(diffArgs).toContain('--cached');
    expect(diffArgs.slice(-2)).toEqual(['--', 'src/a.ts']);
    expect(applyArgs).toEqual(['apply', '--cached', '--reverse', '--whitespace=nowarn']);
  });

  it('reads index-to-worktree for a discard and reverses it in the WORKTREE', () => {
    const { diffArgs, applyArgs } = buildHunkPlan('discardHunk', 'src/a.ts');
    expect(diffArgs).not.toContain('--cached');
    expect(applyArgs).toEqual(['apply', '--reverse', '--whitespace=nowarn']);
  });

  it('never passes a path or a dash to git apply — the patch arrives on stdin', () => {
    for (const op of ['stageHunk', 'unstageHunk', 'discardHunk'] as const) {
      expect(buildHunkPlan(op, 'src/a.ts').applyArgs).not.toContain('src/a.ts');
      expect(buildHunkPlan(op, 'src/a.ts').applyArgs).not.toContain('-');
    }
  });

  it('puts the pathspec after -- so a leading dash cannot be read as an option', () => {
    const { diffArgs } = buildHunkPlan('stageHunk', '--evil.ts');
    expect(diffArgs[diffArgs.length - 2]).toBe('--');
    expect(diffArgs[diffArgs.length - 1]).toBe('--evil.ts');
  });
});

describe('planGitAction for hunk ops', () => {
  it('yields a hunk plan carrying both arg arrays and the range', () => {
    expect(plan('stageHunk')).toEqual({
      kind: 'hunk',
      op: 'stageHunk',
      ...buildHunkPlan('stageHunk', 'src/a.ts'),
      range: RANGE,
    });
  });

  it('normalises a windows-style relative path to a posix pathspec', () => {
    const p = plan('stageHunk', 'src\\nested\\a.ts');
    expect(p.kind === 'hunk' && p.diffArgs[p.diffArgs.length - 1]).toBe('src/nested/a.ts');
  });

  it('accepts an absolute path inside the root', () => {
    const p = plan('discardHunk', path.join(ROOT, 'src', 'a.ts'));
    expect(p.kind === 'hunk' && p.diffArgs[p.diffArgs.length - 1]).toBe('src/a.ts');
  });

  it('rejects a path that escapes the root', () => {
    expect(plan('stageHunk', '../../etc/passwd')).toEqual({
      kind: 'reject',
      error: 'Refusing to act outside the repository: ../../etc/passwd',
    });
  });

  it('rejects a missing path', () => {
    expect(planGitAction({ root: ROOT, op: 'stageHunk', range: RANGE })).toEqual({
      kind: 'reject',
      error: 'No file path provided.',
    });
  });

  it('rejects a missing range — a hunk op without one would stage the whole file', () => {
    expect(planGitAction({ root: ROOT, op: 'stageHunk', path: 'src/a.ts' })).toEqual({
      kind: 'reject',
      error: 'No hunk range provided.',
    });
  });

  it('rejects a range that is empty on both sides', () => {
    expect(
      planGitAction({
        root: ROOT,
        op: 'stageHunk',
        path: 'src/a.ts',
        range: { new: [5, 4], old: [5, 4] },
      }),
    ).toEqual({ kind: 'reject', error: 'No hunk range provided.' });
  });

  it('leaves the existing per-file ops exactly as they were', () => {
    expect(planGitAction({ root: ROOT, op: 'stageFile', path: 'src/a.ts' })).toEqual({
      kind: 'git',
      args: ['add', '--', 'src/a.ts'],
    });
  });
});
