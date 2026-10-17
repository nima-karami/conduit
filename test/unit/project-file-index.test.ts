import { describe, expect, it } from 'vitest';
import { FILE_INDEX_TTL_MS } from '../../src/file-index-ttl';
import type { GitListing } from '../../src/git-listing';
import { createProjectFileIndex } from '../../src/project-file-index';

function harness(listing: GitListing) {
  let t = 1000;
  const calls = { list: 0, walk: 0, build: 0 };
  const truncated: string[] = [];
  const meta = createProjectFileIndex({
    async listGit() {
      calls.list += 1;
      return listing;
    },
    async walk(root) {
      calls.walk += 1;
      return [{ rel: 'a.ts', abs: `${root}/a.ts` }];
    },
    repoIndex: {
      async build(root) {
        calls.build += 1;
        return { files: [{ rel: 'r/x.ts', abs: `${root}/r/x.ts` }], coveredRepos: ['/w/r'] };
      },
    },
    reposUnder: () => [{ key: '/w/r', root: '/w/r' }],
    onTruncated: (root) => truncated.push(root),
    clock: () => t,
  });
  return {
    meta,
    calls,
    truncated,
    advance(ms: number) {
      t += ms;
    },
  };
}

describe('createProjectFileIndex: a listing git could not give', () => {
  for (const kind of ['truncated', 'failed'] as const) {
    it(`a ${kind} listing falls back to the walk, cached for the TTL, then asks git again`, async () => {
      const h = harness({ kind });
      const first = await h.meta('/w');
      expect(first.files.map((f) => f.rel)).toEqual(['a.ts']);
      await h.meta('/w');
      await h.meta('/w');
      expect(h.calls).toEqual({ list: 1, walk: 1, build: 0 });
      h.advance(FILE_INDEX_TTL_MS + 1);
      await h.meta('/w');
      expect(h.calls).toEqual({ list: 2, walk: 2, build: 0 });
    });
  }

  it('a fresh ask still goes to git past the cached degraded result', async () => {
    const h = harness({ kind: 'truncated' });
    await h.meta('/w');
    await h.meta('/w', { fresh: true });
    expect(h.calls.list).toBe(2);
  });

  it("a non-git root's build is cached for the TTL", async () => {
    const h = harness({ kind: 'not-repo' });
    const first = await h.meta('/w');
    expect(first).toMatchObject({ capped: false, repoSet: '/w/r' });
    await h.meta('/w');
    expect(h.calls).toEqual({ list: 1, walk: 0, build: 1 });
  });

  it('a truncated listing is reported once per root, however often it recurs', async () => {
    const h = harness({ kind: 'truncated' });
    await h.meta('/w');
    h.advance(FILE_INDEX_TTL_MS + 1);
    await h.meta('/w');
    await h.meta('/w', { fresh: true });
    await h.meta('/v');
    expect(h.calls.list).toBe(4);
    expect(h.truncated).toEqual(['/w', '/v']);
  });

  it('a failed listing is not reported as truncated', async () => {
    const h = harness({ kind: 'failed' });
    await h.meta('/w');
    expect(h.truncated).toEqual([]);
  });

  // Plan 2026-10-16-terminal-path-links T3.4.
  it('covered: a listed git root is [root]', async () => {
    const h = harness({ kind: 'listed', rels: ['x.ts'] });
    expect((await h.meta('/w')).covered).toEqual(['/w']);
  });

  it('covered: a git listing that failed or was truncated falls back to the walk → []', async () => {
    for (const kind of ['failed', 'truncated'] as const) {
      expect((await harness({ kind }).meta('/w')).covered).toEqual([]);
    }
  });

  it('covered: a non-git root reports its build’s coveredRepos; scope everything → []', async () => {
    const h = harness({ kind: 'not-repo' });
    expect((await h.meta('/w')).covered).toEqual(['/w/r']);
    expect((await h.meta('/w')).covered).toEqual(['/w/r']);
    expect((await h.meta('/w', { scope: 'everything' })).covered).toEqual([]);
  });

  it('each scope has its own entry', async () => {
    const h = harness({ kind: 'not-repo' });
    await h.meta('/w');
    const everything = await h.meta('/w', { scope: 'everything' });
    expect(everything.files.map((f) => f.rel)).toEqual(['a.ts']);
    expect(h.calls).toEqual({ list: 2, walk: 1, build: 1 });
  });
});

// Review r2 stress: a burst of path-link resolves after the TTL lapsed built the index once per
// resolve, all at once.
describe('createProjectFileIndex: concurrent asks', () => {
  const listed: GitListing = { kind: 'listed', rels: ['a.ts'] };

  it('concurrent asks on a miss share one build', async () => {
    const h = harness(listed);
    const [a, b] = await Promise.all([h.meta('/w'), h.meta('/w')]);
    expect(h.calls.list).toBe(1);
    expect(b).toBe(a);
  });

  it('a fresh ask never joins a build already in flight', async () => {
    const h = harness(listed);
    await Promise.all([h.meta('/w'), h.meta('/w', { fresh: true })]);
    expect(h.calls.list).toBe(2);
  });

  it('a failed build is not shared with the next ask', async () => {
    let fail = true;
    const meta = createProjectFileIndex({
      async listGit() {
        if (fail) throw new Error('spawn failed');
        return listed;
      },
      async walk() {
        return [];
      },
      repoIndex: { build: async () => ({ files: [], coveredRepos: [] }) },
      reposUnder: () => [],
    });
    await expect(meta('/w')).rejects.toThrow('spawn failed');
    fail = false;
    expect((await meta('/w')).files.map((f) => f.rel)).toEqual(['a.ts']);
  });
});

describe('createProjectFileIndex: overlapping builds (review r3)', () => {
  const deps = (listGit: () => Promise<GitListing>) =>
    createProjectFileIndex({
      listGit,
      async walk() {
        return [];
      },
      repoIndex: { build: async () => ({ files: [], coveredRepos: [] }) },
      reposUnder: () => [],
    });

  it('a stale build finishing after a fresh one does not overwrite its listing', async () => {
    let releaseStale: (l: GitListing) => void = () => {};
    let calls = 0;
    const meta = deps(() => {
      calls += 1;
      if (calls === 1) return new Promise<GitListing>((r) => (releaseStale = r));
      return Promise.resolve({ kind: 'listed', rels: ['new.ts'] });
    });
    const stale = meta('/w');
    await meta('/w', { fresh: true });
    releaseStale({ kind: 'listed', rels: ['old.ts'] });
    await stale;
    expect((await meta('/w')).files.map((f) => f.rel)).toEqual(['new.ts']);
    expect(calls).toBe(2);
  });

  it('concurrent asks on a failing listing both reject, and git is asked once', async () => {
    let calls = 0;
    const meta = deps(async () => {
      calls += 1;
      throw new Error('spawn failed');
    });
    const results = await Promise.allSettled([meta('/w'), meta('/w')]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(calls).toBe(1);
  });
});
