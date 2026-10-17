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
