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
      // Unique across shards so a 1-run matrix cannot collide in the merger.
      attemptBase: index * runs + 1,
    })),
  };
}

export function plannedAttempts(shards) {
  const out = [];
  for (const s of shards) {
    if (!s.runs) continue;
    const base = s.attemptBase ?? s.index * s.runs + 1;
    for (const name of s.names) {
      for (let i = 0; i < s.runs; i++) {
        out.push({ name, shard: s.index + 1, attempt: base + i });
      }
    }
  }
  return out;
}
