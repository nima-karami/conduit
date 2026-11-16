import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UNMERGED } from '../../src/file-service';
import { runGit } from '../../src/git-exec';
import { createGitShow } from '../../src/git-show';

// Real repos, not a stubbed runner: the contract under test is what `git` itself returns.
// Spawned through runGit like every other git call in the app.
async function git(cwd: string, ...args: string[]): Promise<void> {
  const r = await runGit(
    ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args],
    { cwd },
  );
  if (!r.ok) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

let repo: string;

beforeAll(async () => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'git-show-')));
  await git(repo, 'init', '-q');
  mkdirSync(join(repo, 'nested', 'deep'), { recursive: true });
  writeFileSync(join(repo, 'nested', 'deep', 'a.txt'), 'committed text\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-q', '-m', 'init');
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('createGitShow', () => {
  it('gitShow returns the committed HEAD text of a path', async () => {
    const api = createGitShow();
    const abs = join(repo, 'nested', 'deep', 'a.txt');
    expect(await api.gitShow(abs, 'head')).toBe('committed text\n');
    expect(await api.gitShow(abs)).toBe('committed text\n');
  });

  it('gitShow of a path HEAD does not hold returns the empty "absent" result', async () => {
    const api = createGitShow();
    expect(await api.gitShow(join(repo, 'missing.txt'), 'head')).toBe('');
  });

  it('gitShowBuffer of a path HEAD does not hold returns null', async () => {
    const api = createGitShow();
    expect(await api.gitShowBuffer(join(repo, 'missing.png'), 'head')).toBeNull();
  });

  it('gitShowBuffer returns the raw committed bytes', async () => {
    const api = createGitShow();
    const buf = await api.gitShowBuffer(join(repo, 'nested', 'deep', 'a.txt'), 'head');
    expect(Buffer.isBuffer(buf) && buf.toString('utf8')).toBe('committed text\n');
  });

  it('gitShow of an index path that is not unmerged returns the empty result', async () => {
    const api = createGitShow();
    expect(await api.gitShow(join(repo, 'missing.txt'), 'index')).toBe('');
    expect(await api.gitShowBuffer(join(repo, 'missing.txt'), 'index')).toBeNull();
  });

  it('repoTopLevel of a nested directory is the repo root', async () => {
    const api = createGitShow();
    expect(await api.repoTopLevel(join(repo, 'nested', 'deep'))).toBe(repo);
  });

  it('repoTopLevel of a directory outside any repo is the empty string', async () => {
    const api = createGitShow();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'git-show-out-')));
    try {
      expect(await api.repoTopLevel(outside)).toBe('');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('headShaFor returns the HEAD sha', async () => {
    const api = createGitShow();
    const head = await runGit(['rev-parse', 'HEAD'], { cwd: repo });
    expect(await api.headShaFor(repo)).toBe(head.stdout.trim());
  });

  it('a conflicted index path reports UNMERGED, not an empty blob', async () => {
    const api = createGitShow();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'git-show-merge-')));
    try {
      await git(dir, 'init', '-q');
      writeFileSync(join(dir, 'c.txt'), 'base\n');
      await git(dir, 'add', '.');
      await git(dir, 'commit', '-q', '-m', 'base');
      await git(dir, 'checkout', '-q', '-b', 'other');
      writeFileSync(join(dir, 'c.txt'), 'theirs\n');
      await git(dir, 'commit', '-q', '-am', 'theirs');
      await git(dir, 'checkout', '-q', '-');
      writeFileSync(join(dir, 'c.txt'), 'ours\n');
      await git(dir, 'commit', '-q', '-am', 'ours');
      // A conflicting merge exits non-zero by design; git still needs an identity to start it.
      const merge = await runGit(
        ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'merge', 'other'],
        { cwd: dir },
      );
      expect(merge.ok).toBe(false);
      expect(await api.gitShow(join(dir, 'c.txt'), 'index')).toBe(UNMERGED);
      expect(await api.gitShowBuffer(join(dir, 'c.txt'), 'index')).toBe(UNMERGED);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
