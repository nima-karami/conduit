import { describe, expect, it } from 'vitest';
import { folderKey } from '../../src/folder-key';
import { indexRemovals, staleIndexRoots } from '../../src/index-resync';
import { createRepoFileIndex } from '../../src/repo-file-index';

const repoSet = (repos: readonly { key: string }[]) => repos.map((r) => r.key).join('\n');

describe('staleIndexRoots', () => {
  it('a non-git root whose repo set changed is stale; a git root never is', () => {
    const indexed: Array<[string, { repoSet: string | null }]> = [
      ['/w', { repoSet: '' }],
      ['/v', { repoSet: '/v/a' }],
      ['/g', { repoSet: null }],
    ];
    const current: Record<string, string> = { '/w': '/w/a', '/v': '/v/a', '/g': '/g/x' };
    expect(staleIndexRoots(indexed, (r) => current[r] ?? '')).toEqual(['/w']);
  });
});

describe('indexRemovals', () => {
  it('sent files the selection lost leave; module resolutions stay', () => {
    const sent = new Set(['/w/a.ts', '/w/gen/y.ts', '/w/node_modules/p/index.d.ts']);
    const resolved = new Set(['/w/node_modules/p/index.d.ts']);
    expect(indexRemovals(sent, resolved, ['/w/a.ts'])).toEqual(['/w/gen/y.ts']);
  });
});

// search-scope review r1 SF: an index built before the first repo scan holds the repo's
// gitignored files (the loose walk saw them), and a top-up only adds. The ordering is forced
// here: the index builds with no repo registered, then the scan registers one.
describe('a TS index built before the repo scan', () => {
  it('goes stale when the scan registers the repo, and the re-sync takes gitignored files out', async () => {
    const disk = ['repoA/src/a.ts', 'repoA/gen/y.ts', 'notes.ts'];
    const index = createRepoFileIndex({
      listRepo: async (root) => (root === '/w/repoA' ? ['src/a.ts'] : null),
      walkLoose: async (root, prune) =>
        disk
          .filter((rel) => !(rel.startsWith('repoA/') && prune(`${root}/repoA`)))
          .map((rel) => ({ rel, abs: `${root}/${rel}` })),
    });
    let registered: Array<{ key: string; root: string }> = [];

    const before = await index.build('/w', registered);
    const state = {
      repoSet: repoSet(registered),
      sent: new Set(before.files.map((f) => f.abs)),
    };
    expect([...state.sent].sort()).toEqual([
      '/w/notes.ts',
      '/w/repoA/gen/y.ts',
      '/w/repoA/src/a.ts',
    ]);

    registered = [{ key: folderKey('/w/repoA'), root: '/w/repoA' }];
    const stale = staleIndexRoots([['/w', state]], () => repoSet(registered));
    expect(stale).toEqual(['/w']);

    const after = await index.build('/w', registered);
    const removed = indexRemovals(
      state.sent,
      new Set(),
      after.files.map((f) => f.abs),
    );
    expect(removed).toEqual(['/w/repoA/gen/y.ts']);
  });
});
