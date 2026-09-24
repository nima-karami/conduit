import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildGitArgs,
  explainGitFailure,
  type GitActionRequest,
  planGitAction,
} from '../../src/git-actions';

const ROOT = path.resolve('/work/repo');
const inside = (p: string) => path.join(ROOT, p);

function req(op: GitActionRequest['op'], p?: string): GitActionRequest {
  return { root: ROOT, op, path: p };
}

describe('buildGitArgs — per-file commands use arg arrays with -- separator', () => {
  it('stageFile → add -- <relpath>', () => {
    expect(buildGitArgs('stageFile', 'src/a.ts')).toEqual([
      '--literal-pathspecs',
      'add',
      '--',
      'src/a.ts',
    ]);
  });

  it('unstageFile → restore --staged -- <relpath>', () => {
    expect(buildGitArgs('unstageFile', 'src/a.ts')).toEqual([
      '--literal-pathspecs',
      'restore',
      '--staged',
      '--',
      'src/a.ts',
    ]);
  });

  it('discardTracked → restore -- <relpath>', () => {
    expect(buildGitArgs('discardTracked', 'src/a.ts')).toEqual([
      '--literal-pathspecs',
      'restore',
      '--',
      'src/a.ts',
    ]);
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
    expect(buildGitArgs('stageFile', '--force')).toEqual([
      '--literal-pathspecs',
      'add',
      '--',
      '--force',
    ]);
  });
});

describe('planGitAction — path containment + plan shape', () => {
  it('plans a git command for a per-file op inside the root', () => {
    const plan = planGitAction(req('stageFile', 'src/a.ts'));
    expect(plan).toEqual({ kind: 'git', args: ['--literal-pathspecs', 'add', '--', 'src/a.ts'] });
  });

  it('normalizes an absolute path inside the root to a repo-relative arg', () => {
    const plan = planGitAction(req('stageFile', inside('src/a.ts')));
    expect(plan).toEqual({ kind: 'git', args: ['--literal-pathspecs', 'add', '--', 'src/a.ts'] });
  });

  it('uses forward slashes in the relative arg for host-separated input', () => {
    const plan = planGitAction(req('stageFile', path.join('src', 'nested', 'b.ts')));
    expect(plan.kind).toBe('git');
    if (plan.kind === 'git')
      expect(plan.args).toEqual(['--literal-pathspecs', 'add', '--', 'src/nested/b.ts']);
  });

  it.skipIf(path.sep !== '/')('keeps a backslash, an ordinary filename character on posix', () => {
    const name = `back${String.fromCharCode(92)}slash.txt`;
    expect(planGitAction(req('stageFile', name))).toEqual({
      kind: 'git',
      args: ['--literal-pathspecs', 'add', '--', name],
    });
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

// Review's bulk actions act on exactly the files it lists (mf-review QA finding 2).
describe('planGitAction — bulk op on an explicit path list', () => {
  const PATHSPEC = ['--pathspec-from-file=-', '--pathspec-file-nul'];

  it('stageAll with paths → literal add -A over a NUL list on stdin', () => {
    expect(
      planGitAction({
        root: ROOT,
        op: 'stageAll',
        paths: ['a.ts', inside(path.join('src', 'b[1].ts'))],
      }),
    ).toEqual({
      kind: 'git',
      args: ['--literal-pathspecs', 'add', '-A', ...PATHSPEC],
      stdin: 'a.ts\0src/b[1].ts',
    });
  });

  it('unstageAll with paths → literal reset over the same list', () => {
    expect(planGitAction({ root: ROOT, op: 'unstageAll', paths: ['a.ts'] })).toEqual({
      kind: 'git',
      args: ['--literal-pathspecs', 'reset', ...PATHSPEC],
      stdin: 'a.ts',
    });
  });

  it.each([
    ['an empty list', []],
    ['a path escaping the root', ['a.ts', '../evil.ts']],
    ['an absolute path outside the root', [path.resolve('/etc/passwd')]],
    ['the root itself', ['.']],
    ['a NUL inside a path', ['a.ts\0../evil.ts']],
    ['a non-string', [42]],
  ])('rejects %s', (_what, paths) => {
    expect(planGitAction({ root: ROOT, op: 'stageAll', paths: paths as string[] }).kind).toBe(
      'reject',
    );
  });

  it('rejects paths on a stash op', () => {
    expect(planGitAction({ root: ROOT, op: 'stashPush', paths: ['a.ts'] }).kind).toBe('reject');
  });
});

describe('explainGitFailure', () => {
  const LIST_ARGS = [
    '--literal-pathspecs',
    'add',
    '-A',
    '--pathspec-from-file=-',
    '--pathspec-file-nul',
  ];

  it('names the git version when a pre-2.25 git rejects --pathspec-from-file', () => {
    const stderr = "error: unknown option `pathspec-from-file=-'\nusage: git add [<options>]";
    expect(explainGitFailure(LIST_ARGS, stderr)).toBe(
      'Acting on a list of files needs git 2.25 or newer.',
    );
  });

  it("passes any other failure through as git's own message", () => {
    const stderr = "fatal: pathspec 'x' did not match any files";
    expect(explainGitFailure(LIST_ARGS, stderr)).toBe(stderr);
    expect(explainGitFailure(['add', '-A'], "error: unknown option `pathspec-from-file=-'")).toBe(
      "error: unknown option `pathspec-from-file=-'",
    );
  });
});
