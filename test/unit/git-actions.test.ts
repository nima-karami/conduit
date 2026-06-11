import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGitArgs, type GitActionRequest, planGitAction } from '../../src/git-actions';

const ROOT = path.resolve('/work/repo');
const inside = (p: string) => path.join(ROOT, p);

function req(op: GitActionRequest['op'], p?: string): GitActionRequest {
  return { root: ROOT, op, path: p };
}

describe('buildGitArgs — per-file commands use arg arrays with -- separator', () => {
  it('stageFile → add -- <relpath>', () => {
    expect(buildGitArgs('stageFile', 'src/a.ts')).toEqual(['add', '--', 'src/a.ts']);
  });

  it('unstageFile → restore --staged -- <relpath>', () => {
    expect(buildGitArgs('unstageFile', 'src/a.ts')).toEqual([
      'restore',
      '--staged',
      '--',
      'src/a.ts',
    ]);
  });

  it('discardTracked → restore -- <relpath>', () => {
    expect(buildGitArgs('discardTracked', 'src/a.ts')).toEqual(['restore', '--', 'src/a.ts']);
  });

  it('stageAll → add -A (no path)', () => {
    expect(buildGitArgs('stageAll')).toEqual(['add', '-A']);
  });

  it('unstageAll → reset (legacy-compatible bulk unstage)', () => {
    expect(buildGitArgs('unstageAll')).toEqual(['reset']);
  });

  it('stashPush → stash push', () => {
    expect(buildGitArgs('stashPush')).toEqual(['stash', 'push']);
  });

  it('stashPop → stash pop', () => {
    expect(buildGitArgs('stashPop')).toEqual(['stash', 'pop']);
  });

  it('discardUntracked has no git args (handled as a file delete)', () => {
    expect(buildGitArgs('discardUntracked', 'x.ts')).toBeNull();
  });

  it('passes a path that looks like a flag verbatim after -- (never as an option)', () => {
    expect(buildGitArgs('stageFile', '--force')).toEqual(['add', '--', '--force']);
  });
});

describe('planGitAction — path containment + plan shape', () => {
  it('plans a git command for a per-file op inside the root', () => {
    const plan = planGitAction(req('stageFile', 'src/a.ts'));
    expect(plan).toEqual({ kind: 'git', args: ['add', '--', 'src/a.ts'] });
  });

  it('normalizes an absolute path inside the root to a repo-relative arg', () => {
    const plan = planGitAction(req('stageFile', inside('src/a.ts')));
    expect(plan).toEqual({ kind: 'git', args: ['add', '--', 'src/a.ts'] });
  });

  it('uses forward slashes in the relative arg even on win32-style input', () => {
    const plan = planGitAction(req('stageFile', 'src\\nested\\b.ts'));
    expect(plan.kind).toBe('git');
    if (plan.kind === 'git') expect(plan.args).toEqual(['add', '--', 'src/nested/b.ts']);
  });

  it('rejects a path escaping the root with ..', () => {
    const plan = planGitAction(req('stageFile', '../evil.ts'));
    expect(plan.kind).toBe('reject');
  });

  it('rejects an absolute path outside the root', () => {
    const plan = planGitAction(req('stageFile', path.resolve('/etc/passwd')));
    expect(plan.kind).toBe('reject');
  });

  it('rejects a per-file op with no path', () => {
    const plan = planGitAction(req('stageFile'));
    expect(plan.kind).toBe('reject');
  });

  it('plans a bulk op without a path check', () => {
    expect(planGitAction(req('stageAll'))).toEqual({ kind: 'git', args: ['add', '-A'] });
    expect(planGitAction(req('unstageAll'))).toEqual({ kind: 'git', args: ['reset'] });
    expect(planGitAction(req('stashPush'))).toEqual({ kind: 'git', args: ['stash', 'push'] });
  });

  it('plans discardUntracked as a delete of the contained path', () => {
    const plan = planGitAction(req('discardUntracked', 'junk.tmp'));
    expect(plan.kind).toBe('delete');
    if (plan.kind === 'delete') expect(plan.absPath).toBe(inside('junk.tmp'));
  });

  it('rejects discardUntracked that targets the repo root itself', () => {
    const plan = planGitAction(req('discardUntracked', '.'));
    expect(plan.kind).toBe('reject');
  });

  it('rejects discardUntracked escaping the root', () => {
    const plan = planGitAction(req('discardUntracked', '../outside.tmp'));
    expect(plan.kind).toBe('reject');
  });

  it('rejects an unknown op', () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing a runtime-invalid op
    const plan = planGitAction({ root: ROOT, op: 'nuke' as any });
    expect(plan.kind).toBe('reject');
  });
});
