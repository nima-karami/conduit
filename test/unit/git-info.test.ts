import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetGitAvailableForTest, getGitInfo } from '../../src/git-info';

/**
 * Host integration test for getGitInfo. Each case seeds a throwaway git repo in the
 * OS temp dir (NEVER the project repo) into a known state — branch, detached, bare,
 * unborn, worktree, dirty, mid-rebase — and asserts the derived GitInfo. Skips
 * entirely if git is unavailable.
 */

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const GIT_AVAILABLE = hasGit();
const d = GIT_AVAILABLE ? describe : describe.skip;

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
}

function gitInit(root: string, branch = 'main'): void {
  // -b may be unsupported on very old git; fall back to symbolic-ref afterwards.
  try {
    execFileSync('git', ['init', '-b', branch], { cwd: root, stdio: 'ignore' });
  } catch {
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], {
      cwd: root,
      stdio: 'ignore',
    });
  }
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root, stdio: 'ignore' });
}

function commit(root: string, file = 'a.txt', body = 'one\n', msg = 'init'): void {
  fs.writeFileSync(path.join(root, file), body);
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', msg], { cwd: root, stdio: 'ignore' });
}

const tmps: string[] = [];
function mkTmp(): string {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-gitinfo-'));
  tmps.push(p);
  return p;
}

d('getGitInfo (real git on scratch repos)', () => {
  beforeEach(() => {
    __resetGitAvailableForTest();
  });

  afterEach(() => {
    for (const p of tmps.splice(0)) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  });

  it('reports the current branch on a normal repo', async () => {
    const root = mkTmp();
    gitInit(root, 'main');
    commit(root);
    const info = await getGitInfo(root);
    expect(info.kind).toBe('branch');
    expect(info.branch).toBe('main');
    expect(info.unborn).toBeFalsy();
    expect(info.dirty).toBe(false);
  });

  it('reports a dirty working tree with a dirty flag', async () => {
    const root = mkTmp();
    gitInit(root, 'main');
    commit(root);
    fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n');
    const info = await getGitInfo(root);
    expect(info.kind).toBe('branch');
    expect(info.dirty).toBe(true);
  });

  it('reports an unborn HEAD (fresh init, zero commits) as a branch', async () => {
    const root = mkTmp();
    gitInit(root, 'main');
    const info = await getGitInfo(root);
    expect(info.kind).toBe('branch');
    expect(info.branch).toBe('main');
    expect(info.unborn).toBe(true);
  });

  it('reports a detached HEAD with a 7-char short SHA', async () => {
    const root = mkTmp();
    gitInit(root, 'main');
    commit(root);
    const sha = git(root, ['rev-parse', 'HEAD']);
    git(root, ['checkout', '--detach', sha]);
    const info = await getGitInfo(root);
    expect(info.kind).toBe('detached');
    expect(info.sha).toBeDefined();
    expect(info.sha?.length).toBe(7);
    expect(sha.startsWith(info.sha ?? '')).toBe(true);
    expect(info.branch).toBeUndefined();
  });

  it('reports a bare repo as kind:bare with no branch/dirty/op', async () => {
    const root = mkTmp();
    execFileSync('git', ['init', '--bare'], { cwd: root, stdio: 'ignore' });
    const info = await getGitInfo(root);
    expect(info.kind).toBe('bare');
    expect(info.branch).toBeUndefined();
    expect(info.sha).toBeUndefined();
    expect(info.dirty).toBeUndefined();
    expect(info.operation).toBeUndefined();
  });

  it('reports a non-git directory as kind:none', async () => {
    const root = mkTmp();
    const info = await getGitInfo(root);
    expect(info.kind).toBe('none');
  });

  it('detects a linked worktree and labels it by basename', async () => {
    const root = mkTmp();
    gitInit(root, 'main');
    commit(root);
    git(root, ['branch', 'feature']);
    const wt = path.join(root, '..', `wt-${path.basename(root)}-feat`);
    git(root, ['worktree', 'add', wt, 'feature']);
    tmps.push(wt);
    const info = await getGitInfo(wt);
    expect(info.kind).toBe('branch');
    expect(info.branch).toBe('feature');
    expect(info.isWorktree).toBe(true);
    expect(info.worktreeName).toBe(path.basename(wt));
  });

  it('does not flag the main working tree as a worktree', async () => {
    const root = mkTmp();
    gitInit(root, 'main');
    commit(root);
    const info = await getGitInfo(root);
    expect(info.isWorktree).toBeFalsy();
  });

  it('detects a mid-rebase operation', async () => {
    const root = mkTmp();
    gitInit(root, 'main');
    commit(root, 'a.txt', 'l1\n', 'c1');
    // Build a conflict so an interactive-less rebase stops mid-operation.
    commit(root, 'a.txt', 'l1\nmain\n', 'c2-main');
    git(root, ['checkout', '-b', 'topic', 'HEAD~1']);
    commit(root, 'a.txt', 'l1\ntopic\n', 'c2-topic');
    let stopped = false;
    try {
      execFileSync('git', ['rebase', 'main'], { cwd: root, stdio: 'ignore' });
    } catch {
      stopped = true; // rebase halted on the conflict — exactly what we want
    }
    expect(stopped).toBe(true);
    const info = await getGitInfo(root);
    expect(info.operation).toBe('rebase');
    // Abort so cleanup doesn't trip over an in-progress rebase.
    try {
      execFileSync('git', ['rebase', '--abort'], { cwd: root, stdio: 'ignore' });
    } catch {
      /* ignore */
    }
  });

  it('resolves to kind:none on a git timeout (0 ms budget)', async () => {
    const root = mkTmp();
    gitInit(root, 'main');
    commit(root);
    const info = await getGitInfo(root, { timeoutMs: 1 });
    expect(info.kind).toBe('none');
  });

  it('caches gitAvailable=false after git is not found (no re-spawn)', async () => {
    const root = mkTmp();
    gitInit(root, 'main');
    commit(root);
    // Force the "git not found" path via an explicit override, then confirm the
    // process-level cache short-circuits the next call to kind:none.
    const info = await getGitInfo(root, { gitBin: 'definitely-not-a-real-git-binary-xyz' });
    expect(info.kind).toBe('none');
    // Subsequent calls (even with a real git) stay none until reset.
    const info2 = await getGitInfo(root);
    expect(info2.kind).toBe('none');
    __resetGitAvailableForTest();
    const info3 = await getGitInfo(root);
    expect(info3.kind).toBe('branch');
  });
});
