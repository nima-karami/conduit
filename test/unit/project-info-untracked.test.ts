import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getProjectInfo } from '../../src/project-info';

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
