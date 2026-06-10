import { describe, it, expect } from 'vitest';
import { serializeRepos, restoreRepos, upsertRepo } from '../../src/repoHistory';
import type { RepoDTO } from '../../src/protocol';

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
});
