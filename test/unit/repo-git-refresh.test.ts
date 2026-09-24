import { describe, expect, it, vi } from 'vitest';
import type { GitInterrogation } from '../../src/git-info';
import { interrogateRepos } from '../../src/repo-git-refresh';

const flush = () => new Promise((r) => setTimeout(r, 0));

function deferred() {
  let resolve!: (v: GitInterrogation) => void;
  const promise = new Promise<GitInterrogation>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('interrogateRepos', () => {
  it('keeps input order', async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const run = interrogateRepos(['/a', '/b', '/c'], (root) => {
      const d = deferred();
      gates.set(root, d);
      return d.promise;
    });
    await flush();
    gates.get('/c')?.resolve({ info: { kind: 'branch', branch: 'c' }, headPath: '/c/.git/HEAD' });
    gates.get('/a')?.resolve({ info: { kind: 'branch', branch: 'a' } });
    gates.get('/b')?.resolve({ info: { kind: 'detached', sha: 'bbbbbbb' } });
    expect(await run).toEqual([
      { root: '/a', info: { kind: 'branch', branch: 'a' } },
      { root: '/b', info: { kind: 'detached', sha: 'bbbbbbb' } },
      { root: '/c', info: { kind: 'branch', branch: 'c' }, headPath: '/c/.git/HEAD' },
    ]);
  });

  it('a throw becomes kind none, others unaffected', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await interrogateRepos(['/ok', '/bad'], async (root) => {
      if (root === '/bad') throw new Error('boom');
      return { info: { kind: 'branch', branch: 'main' }, headPath: '/ok/.git/HEAD' };
    });
    expect(out).toEqual([
      { root: '/ok', info: { kind: 'branch', branch: 'main' }, headPath: '/ok/.git/HEAD' },
      { root: '/bad', info: { kind: 'none' } },
    ]);
    log.mockRestore();
  });

  it('never more than 4 in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const roots = Array.from({ length: 10 }, (_, i) => `/r${i}`);
    const out = await interrogateRepos(roots, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await flush();
      inFlight--;
      return { info: { kind: 'none' } };
    });
    expect(out).toHaveLength(10);
    expect(peak).toBe(4);
  });
});
