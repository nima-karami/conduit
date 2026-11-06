import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runGitBin } from '../../src/git-exec';

const scratchRoot = join(tmpdir(), 'conduit-release-notes');
mkdirSync(scratchRoot, { recursive: true });
const trees: string[] = [];
const scriptPath = join(process.cwd(), 'tools', 'release-notes.mjs');
afterEach(() => {
  for (const tree of trees.splice(0)) rmSync(tree, { recursive: true, force: true });
});

describe('release-notes script', () => {
  it('fails before writing when the requested version is missing', () => {
    const dir = mkdtempSync(join(scratchRoot, 'release-notes-test-'));
    trees.push(dir);
    const changelog = join(dir, 'CHANGELOG.md');
    const output = join(dir, 'release-notes.md');
    writeFileSync(changelog, '## [Unreleased]\n\nUpcoming\n');
    const result = spawnSync(process.execPath, [scriptPath, 'v9.9.9', changelog, output], {
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('no non-empty section for 9.9.9');
    expect(existsSync(output)).toBe(false);
  });

  it.each(['', '   \n\n'])('fails before writing when the section body is empty (%j)', (body) => {
    const dir = mkdtempSync(join(scratchRoot, 'release-notes-test-'));
    trees.push(dir);
    const changelog = join(dir, 'CHANGELOG.md');
    const output = join(dir, 'release-notes.md');
    writeFileSync(changelog, `## [9.9.9] — 2026-11-03\n${body}`);
    const result = spawnSync(process.execPath, [scriptPath, 'v9.9.9', changelog, output], {
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('no non-empty section for 9.9.9');
    expect(existsSync(output)).toBe(false);
  });

  it('writes the exact section and a compare link to the previous release', async () => {
    const dir = mkdtempSync(join(scratchRoot, 'release-notes-git-'));
    trees.push(dir);
    const git = async (args: string[]) => {
      const result = await runGitBin('git', args, { cwd: dir, timeoutMs: 5000 });
      if (!result.ok) throw new Error(result.stderr || `git exited with ${result.code}`);
      return result.stdout;
    };
    await git(['init', '-b', 'main']);
    await git(['config', '--local', 'user.name', 'Release Notes Test']);
    await git(['config', '--local', 'user.email', 'release-notes-test@example.invalid']);
    writeFileSync(join(dir, 'seed.txt'), 'initial');
    await git(['add', 'seed.txt']);
    await git(['commit', '-m', 'initial']);
    await git(['tag', 'v1.2.0']);
    writeFileSync(join(dir, 'seed.txt'), 'release');
    await git(['commit', '-am', 'release']);
    await git(['tag', 'v1.3.0']);

    const changelog = join(dir, 'CHANGELOG.md');
    const output = join(dir, 'release-notes.md');
    const section = '## [1.3.0] — 2026-11-03\n\nAdded\n\n- A release feature';
    writeFileSync(changelog, `${section}\n\n## [1.2.0] — 2026-10-01\n\nOld notes`);
    const result = spawnSync(process.execPath, [scriptPath, 'v1.3.0', changelog, output], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe(
      'Added\n\n- A release feature\n\n[Full changelog](https://github.com/nima-karami/conduit/compare/v1.2.0...v1.3.0)\n',
    );
  });
});
