import { describe, expect, it } from 'vitest';
import { plannedAttempts, repeatMatrix } from '../e2e/ci-repeat-plan.mjs';

describe('repeatMatrix', () => {
  it('repeat 20 → 8 shards × runs 3, each shard has all names', () => {
    const names = ['go-lsp', 'cwd'];
    const { shards } = repeatMatrix(names, 20);
    expect(shards).toHaveLength(8);
    expect(shards.every((s) => s.runs === 3)).toBe(true);
    expect(shards.every((s) => s.names.join(' ') === 'go-lsp cwd')).toBe(true);
    expect(shards.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(shards.map((s) => s.attemptBase)).toEqual([1, 4, 7, 10, 13, 16, 19, 22]);
  });

  it('repeat 3 → 3 shards × runs 1, attempts 1..3 unique per name', () => {
    const { shards } = repeatMatrix(['go-lsp'], 3);
    expect(shards).toHaveLength(3);
    expect(shards.every((s) => s.runs === 1)).toBe(true);
    expect(shards.every((s) => s.names.length === 1 && s.names[0] === 'go-lsp')).toBe(true);
    expect(plannedAttempts(shards)).toEqual([
      { name: 'go-lsp', shard: 1, attempt: 1 },
      { name: 'go-lsp', shard: 2, attempt: 2 },
      { name: 'go-lsp', shard: 3, attempt: 3 },
    ]);
  });
});
