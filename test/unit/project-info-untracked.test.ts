import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getProjectInfo, gitChanges } from '../../src/project-info';

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
