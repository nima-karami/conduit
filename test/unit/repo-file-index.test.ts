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
  listings: Record<string, string[]>,
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
      return [...(listings[root] ?? [])];
    },
    async walkLoose(root, prune, cap) {
      const pruned = tree.dirs.filter((d) => prune(`${root}/${d}`));
      walks.push({ root, cap, pruned });
      return tree.loose
        .filter((rel) => !pruned.some((d) => rel.startsWith(`${d}/`)))
        .map((rel): SearchHit => ({ rel, abs: `${root}/${rel}` }));
    },
  };
  return {
    index: createRepoFileIndex(deps),
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
    expect(await index.build('C:\\w', [])).toEqual([{ rel: 'docs/n.md', abs: 'C:/w/docs/n.md' }]);
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

  it('an empty listing is not cached (git may not have answered)', async () => {
    const h = harness({});
    await h.index.build('/w', [repo('/w/repoA')]);
    h.listings['/w/repoA'] = ['a.ts'];
    expect(rels(await h.index.build('/w', [repo('/w/repoA')]))).toEqual(['repoA/a.ts']);
    expect(h.listCalls).toEqual(['/w/repoA', '/w/repoA']);
  });

  it('a file listed by two nested repos appears once', async () => {
    const h = harness({ '/w/A': ['sub/x.ts', 'a.ts'], '/w/A/sub': ['x.ts'] });
    const files = await h.index.build('/w', [repo('/w/A'), repo('/w/A/sub')]);
    expect(rels(files)).toEqual(['A/a.ts', 'A/sub/x.ts']);
  });
});
