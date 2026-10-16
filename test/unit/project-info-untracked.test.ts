import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGit } from '../../src/git-exec';
import { getProjectInfo, gitChanges, readRepoChanges } from '../../src/project-info';

vi.mock('../../src/git-exec', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/git-exec')>();
  return { ...original, runGit: vi.fn(original.runGit) };
});

// Regression: a brand-new untracked folder must surface each file inside it as its
// own change, not collapse to a single `folder/` entry (git's default porcelain
// behavior). Drives the real `git` binary against a throwaway repo.
describe('getProjectInfo — untracked folder expansion', () => {
  let repo: string;

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-gitstatus-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(repo, 'README.md'), '# seed\n');
    git('add', '.');
    git('commit', '-q', '-m', 'seed');

    const newDir = path.join(repo, 'feature', 'nested');
    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(path.join(repo, 'feature', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(newDir, 'b.ts'), 'export const b = 2;\n');
  });

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('lists each file inside a new untracked folder, not just the folder', async () => {
    const { changes } = await getProjectInfo(repo);
    const untracked = changes
      .filter((c) => c.kind === 'U')
      .map((c) => c.path)
      .sort();

    expect(untracked).toEqual(['feature/a.ts', 'feature/nested/b.ts']);
    // The bare folder must never appear as a single collapsed entry.
    expect(untracked).not.toContain('feature/');
    expect(untracked).not.toContain('feature');
  });
});

it('preserves HEAD deletion counts after staged edits and staged deletions with replacements', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-deletion-counts-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repo,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    const originals = {
      'staged edit.txt': 'one\ntwo\n',
      'staged deletion.txt': 'one\ntwo\nthree',
      'empty.txt': '',
      'unicode-é.txt': 'one\r\ntwo',
    };
    for (const [name, content] of Object.entries(originals))
      fs.writeFileSync(path.join(repo, name), content);
    git('add', '.');
    git('commit', '-qm', 'seed');
    fs.writeFileSync(path.join(repo, 'staged edit.txt'), 'replacement\n');
    git('add', 'staged edit.txt');
    for (const name of Object.keys(originals)) fs.unlinkSync(path.join(repo, name));
    git('add', 'staged deletion.txt');
    fs.writeFileSync(path.join(repo, 'staged deletion.txt'), 'untracked replacement\n');
    const deleted = (await gitChanges(repo)).filter((change) => change.kind === 'D');
    expect(deleted.map((change) => [change.path, change.removed]).sort()).toEqual([
      ['empty.txt', 0],
      ['staged deletion.txt', 3],
      ['staged edit.txt', 2],
      ['unicode-é.txt', 2],
    ]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

describe('readRepoChanges', () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repo,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-readrepo-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
    git('add', '.');
    git('commit', '-qm', 'seed');
    return () => fs.rmSync(repo, { recursive: true, force: true });
  });

  it('lines:false runs exactly one git process and leaves added/removed 0', async () => {
    fs.writeFileSync(path.join(repo, 'new.txt'), 'a\nb\nc\n');
    fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\nmore\n');
    vi.mocked(runGit).mockClear();
    const r = await readRepoChanges(repo, { lines: false });
    expect(vi.mocked(runGit)).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changes.map((c) => [c.path, c.kind]).sort()).toEqual([
      ['new.txt', 'U'],
      ['seed.txt', 'M'],
    ]);
    expect(r.changes.every((c) => c.added === 0 && c.removed === 0)).toBe(true);
  });

  it('lines:true keeps the line counts', async () => {
    fs.writeFileSync(path.join(repo, 'new.txt'), 'a\nb\nc\n');
    const r = await readRepoChanges(repo, { lines: true });
    expect(r.ok && r.changes.find((c) => c.path === 'new.txt')?.added).toBe(3);
  });

  it('status failure surfaces a reason', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-norepo-'));
    // Stops discovery from finding a repo above the OS temp dir.
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(plain);
    try {
      expect(await readRepoChanges(plain, { lines: false })).toEqual({
        ok: false,
        reason: 'failed',
      });
    } finally {
      delete process.env.GIT_CEILING_DIRECTORIES;
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('trackedDirty ignores untracked-only', async () => {
    fs.writeFileSync(path.join(repo, 'new.txt'), 'x\n');
    const untrackedOnly = await readRepoChanges(repo, { lines: false });
    expect(untrackedOnly.ok && untrackedOnly.trackedDirty).toBe(false);
    fs.writeFileSync(path.join(repo, 'seed.txt'), 'changed\n');
    const modified = await readRepoChanges(repo, { lines: false });
    expect(modified.ok && modified.trackedDirty).toBe(true);
  });
});
