import { describe, expect, it, vi } from 'vitest';
import type { GitInterrogation } from '../../src/git-info';
import { createGitRefresher, interrogateRepos } from '../../src/repo-git-refresh';

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

describe('createGitRefresher', () => {
  type Target = { sessionId: string; roots: readonly string[] };
  const branch = (b: string): GitInterrogation => ({ info: { kind: 'branch', branch: b } });

  it('a slower, older refresh of the same session never overwrites a newer one', async () => {
    const gates: ReturnType<typeof deferred>[] = [];
    const applied: string[] = [];
    const refresher = createGitRefresher<Target>({
      interrogate: () => {
        const d = deferred();
        gates.push(d);
        return d.promise;
      },
      apply: (_t, results) => {
        applied.push(results[0].info.branch ?? '?');
      },
    });
    const older = refresher.refresh([{ sessionId: 's', roots: ['/ref'] }]);
    await flush();
    const newer = refresher.refresh([{ sessionId: 's', roots: ['/ref'] }]);
    await flush();
    gates[1].resolve(branch('feature'));
    await newer;
    gates[0].resolve(branch('main'));
    await older;
    expect(applied).toEqual(['feature']);
  });

  it("one session's newer refresh does not drop another session's result", async () => {
    const applied: string[] = [];
    const refresher = createGitRefresher<Target>({
      interrogate: async (root) => branch(root),
      apply: (t) => {
        applied.push(t.sessionId);
      },
    });
    await Promise.all([
      refresher.refresh([{ sessionId: 'a', roots: ['/a'] }]),
      refresher.refresh([{ sessionId: 'b', roots: ['/b'] }]),
    ]);
    expect(applied.sort()).toEqual(['a', 'b']);
  });

  it('a forgotten session drops its in-flight result', async () => {
    const gate = deferred();
    const apply = vi.fn();
    const refresher = createGitRefresher<Target>({ interrogate: () => gate.promise, apply });
    const run = refresher.refresh([{ sessionId: 's', roots: ['/r'] }]);
    await flush();
    refresher.forget('s');
    gate.resolve(branch('main'));
    await run;
    expect(apply).not.toHaveBeenCalled();
  });
});
