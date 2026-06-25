import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectRepos } from '../../src/repo-scan';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'reposcan-'));
}
function gitInit(dir: string) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
}

describe('detectRepos', () => {
  it('finds direct-child repos and names them relative to the opened root', async () => {
    const root = tmp();
    gitInit(join(root, 'repo-a'));
    gitInit(join(root, 'repo-b'));
    const repos = await detectRepos(root);
    expect(repos.map((r) => r.name).sort()).toEqual(['repo-a', 'repo-b']);
    expect(repos.every((r) => r.root.replace(/\\/g, '/').endsWith(r.name))).toBe(true);
  });

  it('includes the opened root itself when it is a repo, named "."', async () => {
    const root = tmp();
    gitInit(root);
    const repos = await detectRepos(root);
    expect(repos.map((r) => r.name)).toContain('.');
  });

  it('finds nested repos within the depth bound but not beyond it', async () => {
    const root = tmp();
    gitInit(join(root, 'group', 'repo-c')); // depth 2 — within 4
    gitInit(join(root, 'a', 'b', 'c', 'd', 'e', 'deep')); // depth 6 — beyond 4
    const repos = await detectRepos(root);
    const names = repos.map((r) => r.name.replace(/\\/g, '/'));
    expect(names).toContain('group/repo-c');
    expect(names.some((n) => n.endsWith('deep'))).toBe(false);
  });

  it('does not descend into a repo once found (no repos-inside-repos)', async () => {
    const root = tmp();
    gitInit(join(root, 'repo-a'));
    gitInit(join(root, 'repo-a', 'nested')); // should NOT be reported separately
    const repos = await detectRepos(root);
    const names = repos.map((r) => r.name.replace(/\\/g, '/'));
    expect(names).toContain('repo-a');
    expect(names).not.toContain('repo-a/nested');
  });

  it('skips node_modules and treats a .git FILE (submodule/worktree) as a repo', async () => {
    const root = tmp();
    mkdirSync(join(root, 'node_modules', 'pkg', '.git'), { recursive: true });
    const sub = join(root, 'submod');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, '.git'), 'gitdir: /elsewhere/.git/modules/submod');
    const repos = await detectRepos(root);
    const names = repos.map((r) => r.name.replace(/\\/g, '/'));
    expect(names).toContain('submod');
    expect(names.some((n) => n.startsWith('node_modules'))).toBe(false);
  });

  it('returns [] for a non-existent root and never throws on a symlink cycle', async () => {
    expect(await detectRepos(join(tmpdir(), 'does-not-exist-xyz-reposcan'))).toEqual([]);
    const root = tmp();
    gitInit(join(root, 'repo-a'));
    try {
      symlinkSync(root, join(root, 'loop'), 'dir'); // self-referential dir symlink
    } catch {
      return; // symlink may be unavailable (Windows w/o privilege) — cycle case skipped
    }
    const repos = await detectRepos(root);
    expect(repos.map((r) => r.name)).toContain('repo-a'); // terminated, no hang
  });
});
