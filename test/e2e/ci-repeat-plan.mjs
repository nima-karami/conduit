/**
 * Repeat-run shard matrix: each shard gets the full named list. Used by the `prepare` job of
 * .github/workflows/e2e.yml when `repeat` > 1. CON-143.
 */

export function repeatMatrix(names, repeat) {
  if (!names.length || repeat < 1) return { shards: [] };
  const shardCount = Math.min(repeat, 8);
  const runs = Math.ceil(repeat / shardCount);
  return {
    shards: Array.from({ length: shardCount }, (_, index) => ({
      index,
      names: [...names],
      runs,
    })),
  };
}
