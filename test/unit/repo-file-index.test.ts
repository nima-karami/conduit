import { describe, expect, it } from 'vitest';
import { folderKey } from '../../src/folder-key';
import type { SearchHit } from '../../src/protocol';
import {
  createRepoFileIndex,
  LOOSE_FILE_CAP,
  type RepoFileIndexDeps,
} from '../../src/repo-file-index';

const repo = (root: string) => ({ key: folderKey(root), root });

function harness(
  listings: Record<string, string[] | null>,
  tree: { loose: string[]; dirs: string[] } = { loose: [], dirs: [] },
) {
  const listCalls: string[] = [];
  const walks: Array<{ root: string; cap: number; pruned: string[] }> = [];
  let releaseList: (() => void) | undefined;
  let listGate: Promise<void> | undefined;
  const deps: RepoFileIndexDeps = {
    async listRepo(root) {
      listCalls.push(root);
      if (listGate) await listGate;
      const rels = listings[root];
      return rels === null ? null : [...(rels ?? [])];
    },
    async walkLoose(root, prune, cap) {
      const pruned = tree.dirs.filter((d) => prune(`${root}/${d}`));
      walks.push({ root, cap, pruned });
      return tree.loose
        .filter((rel) => !pruned.some((d) => rel.startsWith(`${d}/`)))
        .map((rel): SearchHit => ({ rel, abs: `${root}/${rel}` }));
    },
  };
  const raw = createRepoFileIndex(deps);
  const index = {
    ...raw,
    build: async (root: string, repos: readonly { key: string; root: string }[]) =>
      (await raw.build(root, repos)).files,
  };
  return {
    index,
    raw,
    listings,
    tree,
    listCalls,
    walks,
    gateList() {
      listGate = new Promise<void>((r) => {
        releaseList = r;
      });
      return () => {
        listGate = undefined;
        releaseList?.();
      };
    },
  };
}

const rels = (files: ReadonlyArray<{ rel: string }>) => files.map((f) => f.rel).sort();

describe('createRepoFileIndex', () => {
  it('build unions repo listings with root-relative rels and loose files', async () => {
    const h = harness(
      { '/w/repoA': ['src/a.ts', '.gitignore'], '/w/tickets/T-1/repoB': ['b.ts'] },
      {
        loose: ['notes.md', 'repoA/dist/x.ts', 'tickets/readme.md'],
        dirs: ['repoA', 'tickets/T-1/repoB'],
      },
    );
    const files = await h.index.build('/w', [repo('/w/repoA'), repo('/w/tickets/T-1/repoB')]);
    expect(rels(files)).toEqual([
      'notes.md',
      'repoA/.gitignore',
      'repoA/src/a.ts',
      'tickets/T-1/repoB/b.ts',
      'tickets/readme.md',
    ]);
    expect(files.find((f) => f.rel === 'repoA/src/a.ts')?.abs).toBe('/w/repoA/src/a.ts');
    expect(files.find((f) => f.rel === 'notes.md')?.abs).toBe('/w/notes.md');
    expect(h.walks).toEqual([
      { root: '/w', cap: LOOSE_FILE_CAP, pruned: ['repoA', 'tickets/T-1/repoB'] },
    ]);
  });

  it('native separators in roots still give forward-slash rels and abs paths', async () => {
    const h = harness({ 'C:\\w\\repoA': ['src/a.ts'] });
    const files = await h.index.build('C:\\w', [repo('C:\\w\\repoA')]);
    expect(files).toEqual([{ rel: 'repoA/src/a.ts', abs: 'C:/w/repoA/src/a.ts' }]);
  });

  it('loose hits with OS separators come back forward-slash', async () => {
    const index = createRepoFileIndex({
      listRepo: async () => [],
      walkLoose: async () => [{ rel: 'docs/n.md', abs: 'C:\\w\\docs\\n.md' }],
    });
    expect((await index.build('C:\\w', [])).files).toEqual([
      { rel: 'docs/n.md', abs: 'C:/w/docs/n.md' },
    ]);
  });

  it('a repo is re-listed only after invalidateRepo(key)', async () => {
    const h = harness({ '/w/repoA': ['a.ts'], '/w/repoB': ['b.ts'] });
    const repos = [repo('/w/repoA'), repo('/w/repoB')];
    await h.index.build('/w', repos);
    await h.index.build('/w', repos);
    expect(h.listCalls.sort()).toEqual(['/w/repoA', '/w/repoB']);
    h.listCalls.length = 0;
    h.listings['/w/repoA'] = ['a.ts', 'new.ts'];
    h.index.invalidateRepo(folderKey('/w/repoA'));
    const files = await h.index.build('/w', repos);
    expect(h.listCalls).toEqual(['/w/repoA']);
    expect(rels(files)).toEqual(['repoA/a.ts', 'repoA/new.ts', 'repoB/b.ts']);
  });

  it('an invalidation during an in-flight listing is not lost', async () => {
    const h = harness({ '/w/repoA': ['a.ts'] });
    const release = h.gateList();
    const first = h.index.build('/w', [repo('/w/repoA')]);
    h.listings['/w/repoA'] = ['a.ts', 'late.ts'];
    h.index.invalidateRepo(folderKey('/w/repoA'));
    release();
    await first;
    const files = await h.index.build('/w', [repo('/w/repoA')]);
    expect(h.listCalls).toEqual(['/w/repoA', '/w/repoA']);
    expect(rels(files)).toEqual(['repoA/a.ts', 'repoA/late.ts']);
  });

  it('the loose walk re-runs only after invalidateLoose()', async () => {
    const h = harness({ '/w/repoA': ['a.ts'] }, { loose: ['notes.md'], dirs: ['repoA'] });
    const repos = [repo('/w/repoA')];
    await h.index.build('/w', repos);
    h.tree.loose.push('todo.md');
    expect(rels(await h.index.build('/w', repos))).toEqual(['notes.md', 'repoA/a.ts']);
    expect(h.walks).toHaveLength(1);
    h.index.invalidateLoose();
    expect(rels(await h.index.build('/w', repos))).toEqual(['notes.md', 'repoA/a.ts', 'todo.md']);
    expect(h.walks).toHaveLength(2);
    expect(h.listCalls).toEqual(['/w/repoA']);
  });

  it('a changed repo set re-walks the loose part (the old walk pruned different dirs)', async () => {
    const h = harness(
      { '/w/repoA': ['a.ts'] },
      { loose: ['notes.md', 'repoA/a.ts', 'repoA/dist/x.ts'], dirs: ['repoA'] },
    );
    expect(rels(await h.index.build('/w', []))).toEqual([
      'notes.md',
      'repoA/a.ts',
      'repoA/dist/x.ts',
    ]);
    expect(rels(await h.index.build('/w', [repo('/w/repoA')]))).toEqual(['notes.md', 'repoA/a.ts']);
    expect(h.walks).toHaveLength(2);
  });

  it('entries for repos no longer under root are dropped', async () => {
    const h = harness({ '/w/repoA': ['a.ts'], '/w/repoB': ['b.ts'], '/elsewhere/C': ['c.ts'] });
    await h.index.build('/w', [repo('/w/repoA'), repo('/w/repoB')]);
    const files = await h.index.build('/w', [repo('/w/repoA'), repo('/elsewhere/C')]);
    expect(rels(files)).toEqual(['repoA/a.ts']);
    h.listCalls.length = 0;
    await h.index.build('/w', [repo('/w/repoA'), repo('/w/repoB')]);
    expect(h.listCalls).toEqual(['/w/repoB']);
  });

  it('a root that is itself a repo has no loose part', async () => {
    const h = harness({ '/w': ['x.ts'] }, { loose: ['x.ts', 'y.log'], dirs: [] });
    expect(rels(await h.index.build('/w', [repo('/w')]))).toEqual(['x.ts']);
    expect(h.walks).toEqual([]);
  });

  it('an empty listing is an empty repo, cached like any other answer', async () => {
    const h = harness({ '/w/repoA': [] });
    expect(await h.raw.build('/w', [repo('/w/repoA')])).toEqual({
      files: [],
      coveredRepos: ['/w/repoA'],
    });
    await h.index.build('/w', [repo('/w/repoA')]);
    expect(h.listCalls).toEqual(['/w/repoA']);
  });

  it('a failed re-list keeps the last good listing and asks git again next build', async () => {
    const h = harness({ '/w/repoA': ['a.ts'] }, { loose: ['notes.md'], dirs: ['repoA'] });
    const repos = [repo('/w/repoA')];
    await h.index.build('/w', repos);
    h.index.invalidateRepo(folderKey('/w/repoA'));
    h.listings['/w/repoA'] = null;
    const failed = await h.raw.build('/w', repos);
    expect(rels(failed.files)).toEqual(['notes.md', 'repoA/a.ts']);
    // Still pruned from the loose walk: its last good listing stands in for it.
    expect(h.walks.every((w) => w.pruned.includes('repoA'))).toBe(true);
    h.listings['/w/repoA'] = ['a.ts', 'b.ts'];
    const retried = await h.raw.build('/w', repos);
    expect(rels(retried.files)).toEqual(['notes.md', 'repoA/a.ts', 'repoA/b.ts']);
    expect(h.listCalls).toEqual(['/w/repoA', '/w/repoA', '/w/repoA']);
  });

  it('a repo git never listed is walked, skipping the listed repos inside it', async () => {
    const calls: Array<{ root: string; pruned: boolean }> = [];
    const index = createRepoFileIndex({
      listRepo: async (root) => (root === '/w/A/inner' ? ['i.ts'] : null),
      async walkLoose(root, prune) {
        calls.push({ root, pruned: prune('/w/A/inner') });
        if (root === '/w/A') return [{ rel: 'a.ts', abs: '/w/A/a.ts' }];
        return [{ rel: 'notes.md', abs: '/w/notes.md' }];
      },
    });
    const built = await index.build('/w', [repo('/w/A'), repo('/w/A/inner')]);
    expect(rels(built.files)).toEqual(['A/a.ts', 'A/inner/i.ts', 'notes.md']);
    expect(calls).toEqual([
      { root: '/w', pruned: true },
      { root: '/w/A', pruned: true },
    ]);
  });

  it('a registered repo git calls not-a-repo is walked and never memoized', async () => {
    const walked: string[] = [];
    const index = createRepoFileIndex({
      listRepo: async (root) => (root === '/w/A' ? 'not-repo' : ['b.ts']),
      async walkLoose(root) {
        walked.push(root);
        return root === '/w/A' ? [{ rel: 'a.ts', abs: '/w/A/a.ts' }] : [];
      },
    });
    const built = await index.build('/w', [repo('/w/A'), repo('/w/B')]);
    expect(rels(built.files)).toEqual(['A/a.ts', 'B/b.ts']);
    // Walked again next build: a walk has no serial, so the union is never memoized over it.
    await index.build('/w', [repo('/w/A'), repo('/w/B')]);
    expect(walked.filter((r) => r === '/w/A')).toHaveLength(2);
  });

  it('a root that is itself a repo whose listing fails is walked', async () => {
    const h = harness({ '/w': null }, { loose: ['x.ts', 'gen/y.ts'], dirs: [] });
    const built = await h.raw.build('/w', [repo('/w')]);
    expect(rels(built.files)).toEqual(['gen/y.ts', 'x.ts']);
  });

  it('builds asking for the same repo at the same version share one ls-files', async () => {
    const h = harness({ '/w/repoA': ['a.ts'] });
    const release = h.gateList();
    const both = Promise.all([
      h.index.build('/w', [repo('/w/repoA')]),
      h.index.build('/w', [repo('/w/repoA')]),
    ]);
    release();
    const [one, two] = await both;
    expect(rels(one)).toEqual(['repoA/a.ts']);
    expect(rels(two)).toEqual(['repoA/a.ts']);
    expect(h.listCalls).toEqual(['/w/repoA']);
  });

  it('an unchanged build reuses the union; a re-list or re-walk rebuilds it', async () => {
    const h = harness({ '/w/repoA': ['a.ts'] }, { loose: ['notes.md'], dirs: ['repoA'] });
    const repos = [repo('/w/repoA')];
    const first = await h.index.build('/w', repos);
    expect(await h.index.build('/w', repos)).toBe(first);
    h.index.invalidateLoose();
    const rewalked = await h.index.build('/w', repos);
    expect(rewalked).not.toBe(first);
    h.index.invalidateRepo(folderKey('/w/repoA'));
    expect(await h.index.build('/w', repos)).not.toBe(rewalked);
  });

  it('retain forgets roots and repos no longer in use', async () => {
    const h = harness({ '/w/repoA': ['a.ts'] }, { loose: ['notes.md'], dirs: ['repoA'] });
    const repos = [repo('/w/repoA')];
    await h.index.build('/w', repos);
    h.index.retain(new Set([folderKey('/w')]), new Set([folderKey('/w/repoA')]));
    await h.index.build('/w', repos);
    expect(h.listCalls).toHaveLength(1);
    expect(h.walks).toHaveLength(1);
    h.index.retain(new Set(), new Set());
    await h.index.build('/w', repos);
    expect(h.listCalls).toHaveLength(2);
    expect(h.walks).toHaveLength(2);
  });

  it('a file listed by two nested repos appears once', async () => {
    const h = harness({ '/w/A': ['sub/x.ts', 'a.ts'], '/w/A/sub': ['x.ts'] });
    const files = await h.index.build('/w', [repo('/w/A'), repo('/w/A/sub')]);
    expect(rels(files)).toEqual(['A/a.ts', 'A/sub/x.ts']);
  });
});

// Plan 2026-10-16-terminal-path-links T3.4: a repo is covered only when its own listing answered,
// is from this build, and was not walked — path links answer "not there" from covered repos only.
describe('createRepoFileIndex: coveredRepos', () => {
  it('composite: repo A listed, B not-repo, C failed (walked) → coveredRepos [A]', async () => {
    const index = createRepoFileIndex({
      listRepo: async (root) =>
        root === '\\w\\A' ? ['a.ts'] : root === '/w/B' ? 'not-repo' : null,
      walkLoose: async () => [],
    });
    const built = await index.build('/w', [repo('\\w\\A'), repo('/w/B'), repo('/w/C')]);
    expect(built.coveredRepos).toEqual(['/w/A']);
  });

  it('memo hit keeps coveredRepos', async () => {
    const h = harness({ '/w/repoA': ['a.ts'], '/w/repoB': ['b.ts'] });
    const repos = [repo('/w/repoA'), repo('/w/repoB')];
    const first = await h.raw.build('/w', repos);
    const second = await h.raw.build('/w', repos);
    expect(second.files).toBe(first.files);
    expect(first.coveredRepos).toEqual(['/w/repoA', '/w/repoB']);
    expect(second.coveredRepos).toEqual(first.coveredRepos);
  });

  it('a stale last-good listing is not covered, while its files are still present', async () => {
    const h = harness({ '/w/repoA': ['a.ts'] });
    const repos = [repo('/w/repoA')];
    await h.raw.build('/w', repos);
    h.raw.invalidateRepo(folderKey('/w/repoA'));
    h.listings['/w/repoA'] = null;
    const stale = await h.raw.build('/w', repos);
    expect(rels(stale.files)).toEqual(['repoA/a.ts']);
    expect(stale.coveredRepos).toEqual([]);
  });
});
