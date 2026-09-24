import { describe, expect, it, vi } from 'vitest';
import { probeFolders } from '../../src/folder-probe';
import type { GitInfo } from '../../src/types';

type Probe = Parameters<typeof probeFolders>[1]['probe'];

const probe: Probe = async (raw) => {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return { reason: 'invalid-path' };
  if (raw.startsWith('/gone')) return { status: 'missing', stored: raw, key: raw };
  return { status: 'present', stored: raw.replace(/\/+$/, ''), key: raw, realKey: raw };
};

const git = (map: Record<string, GitInfo>) =>
  vi.fn(async (dir: string) => map[dir] ?? ({ kind: 'none' } as GitInfo));

describe('probeFolders', () => {
  it('present repo on a branch → exists + branch', async () => {
    const gitInfo = git({ '/a': { kind: 'branch', branch: 'main' } });
    expect(await probeFolders(['/a/'], { probe, gitInfo })).toEqual([
      { path: '/a/', exists: true, branch: 'main' },
    ]);
    expect(gitInfo).toHaveBeenCalledWith('/a');
  });

  it('detached → short sha, detached:true', async () => {
    const gitInfo = git({ '/d': { kind: 'detached', sha: 'abc1234' } });
    expect(await probeFolders(['/d'], { probe, gitInfo })).toEqual([
      { path: '/d', exists: true, branch: 'abc1234', detached: true },
    ]);
  });

  it('present non-repo → exists, no branch', async () => {
    expect(await probeFolders(['/plain'], { probe, gitInfo: git({}) })).toEqual([
      { path: '/plain', exists: true },
    ]);
  });

  it('missing and invalid → exists:false, gitInfo never called', async () => {
    const gitInfo = git({});
    expect(await probeFolders(['/gone/x', 'rel', 7, '/ok'], { probe, gitInfo })).toEqual([
      { path: '/gone/x', exists: false },
      { path: 'rel', exists: false },
      { path: '/ok', exists: true },
    ]);
    expect(gitInfo).toHaveBeenCalledTimes(1);
  });

  it('17 paths → 16 results', async () => {
    const paths = Array.from({ length: 17 }, (_, i) => `/p${i}`);
    const r = await probeFolders(paths, { probe, gitInfo: git({}) });
    expect(r).toHaveLength(16);
    expect(r.at(-1)?.path).toBe('/p15');
  });

  it('non-array → []', async () => {
    expect(await probeFolders('/a', { probe, gitInfo: git({}) })).toEqual([]);
    expect(await probeFolders(undefined, { probe, gitInfo: git({}) })).toEqual([]);
  });

  it('gitInfo rejects → exists, no branch', async () => {
    const gitInfo = vi.fn(async () => {
      throw new Error('git missing');
    });
    expect(await probeFolders(['/a'], { probe, gitInfo })).toEqual([{ path: '/a', exists: true }]);
  });
});
