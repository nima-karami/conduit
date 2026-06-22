import { describe, expect, it } from 'vitest';
import type { RepoDTO } from '../../src/protocol';
import {
  filterExistingRepos,
  restoreRepos,
  serializeRepos,
  upsertRepo,
} from '../../src/repo-history';

const mk = (path: string, lastOpened = 1, lastAgentId?: string): RepoDTO => ({
  path,
  name: path.split(/[\\/]/).pop() || path,
  lastAgentId,
  lastOpened,
});

describe('repoHistory', () => {
  it('round-trips through serialize/restore', () => {
    const list = [mk('/a', 2, 'shell:pwsh'), mk('/b', 1)];
    expect(restoreRepos(serializeRepos(list))).toEqual(list);
  });

  it('restores [] for missing or malformed blobs', () => {
    expect(restoreRepos(undefined)).toEqual([]);
    expect(restoreRepos('not json')).toEqual([]);
    expect(restoreRepos(JSON.stringify({ version: 999, repos: [mk('/a')] }))).toEqual([]);
  });

  it('upsert moves an existing path to the front without duplicating', () => {
    const list = [mk('/a', 1), mk('/b', 2)];
    const next = upsertRepo(list, mk('/b', 5, 'shell:cmd'));
    expect(next.map((r) => r.path)).toEqual(['/b', '/a']);
    expect(next[0].lastAgentId).toBe('shell:cmd');
  });

  it('caps history at 20 most-recent entries', () => {
    let list: RepoDTO[] = [];
    for (let i = 0; i < 25; i++) list = upsertRepo(list, mk(`/r${i}`, i));
    expect(list).toHaveLength(20);
    expect(list[0].path).toBe('/r24'); // newest first
  });

  describe('filterExistingRepos', () => {
    it('drops entries whose path is not an existing directory, keeps the rest', () => {
      const list = [mk('/gone'), mk('/here'), mk('/also-gone')];
      const existing = new Set(['/here']);
      const out = filterExistingRepos(list, (p) => existing.has(p));
      expect(out.map((r) => r.path)).toEqual(['/here']);
    });

    it('is non-destructive — returns a new list, never mutates the input', () => {
      const list = [mk('/gone'), mk('/here')];
      const out = filterExistingRepos(list, (p) => p === '/here');
      expect(list).toHaveLength(2); // original untouched
      expect(out).toHaveLength(1);
    });

    it('keeps everything when the predicate is always true, drops all when always false', () => {
      const list = [mk('/a'), mk('/b')];
      expect(filterExistingRepos(list, () => true)).toHaveLength(2);
      expect(filterExistingRepos(list, () => false)).toHaveLength(0);
    });
  });
});
