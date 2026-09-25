import { describe, expect, it, vi } from 'vitest';
import { activeCwd, gitRootForSession, sessionGitRoot } from '../../src/active-cwd';

describe('activeCwd', () => {
  it('returns cwd when cwd is present', () => {
    expect(activeCwd({ cwd: '/tmp/work', home: '/home/project' })).toBe('/tmp/work');
  });

  it('returns home when cwd is undefined', () => {
    expect(activeCwd({ cwd: undefined, home: '/home/project' })).toBe('/home/project');
  });

  it('returns home when cwd is empty string', () => {
    expect(activeCwd({ cwd: '', home: '/home/project' })).toBe('/home/project');
  });
});

describe('sessionGitRoot', () => {
  it('rev-parses the LIVE cwd, ignoring the pinned active repo', async () => {
    // The whole point of the fix: a terminal's resolution keys off cwd, NOT activeRepoRoot.
    const session = {
      cwd: '/repos/cwd-repo/sub',
      home: '/repos/proj',
      activeRepoRoot: '/repos/pinned',
    };
    const run = vi.fn().mockResolvedValue('/repos/cwd-repo\n');
    expect(await sessionGitRoot(session, run)).toBe('/repos/cwd-repo');
    expect(run).toHaveBeenCalledWith(['rev-parse', '--show-toplevel'], '/repos/cwd-repo/sub');
    // gitRootForSession, by contrast, DOES honor the pin — the two must diverge here.
    expect(gitRootForSession(session)).toBe('/repos/pinned');
  });

  it('normalizes backslashes in the cwd passed to git', async () => {
    const run = vi.fn().mockResolvedValue('C:/repos/app\n');
    await sessionGitRoot({ cwd: 'C:\\repos\\app\\sub', home: 'C:\\repos\\app' }, run);
    expect(run).toHaveBeenCalledWith(['rev-parse', '--show-toplevel'], 'C:/repos/app/sub');
  });

  it('falls back to the cwd when it is not inside a repo (empty rev-parse)', async () => {
    const run = vi.fn().mockResolvedValue('');
    expect(await sessionGitRoot({ cwd: '/tmp/loose', home: '/tmp/loose' }, run)).toBe('/tmp/loose');
  });

  it('falls back to home (via activeCwd) when cwd is unset', async () => {
    const run = vi.fn().mockResolvedValue('');
    expect(await sessionGitRoot({ home: '/home/proj' }, run)).toBe('/home/proj');
    expect(run).toHaveBeenCalledWith(['rev-parse', '--show-toplevel'], '/home/proj');
  });
});
